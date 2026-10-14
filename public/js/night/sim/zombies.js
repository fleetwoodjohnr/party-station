// Zombie pool + AI manager. Struct-of-arrays in typed arrays, a fixed pool
// (no allocation while playing), one shared flow field for pathing, and
// update rates that drop with distance. The renderer reads these arrays
// directly. Pure JS: runs in Node for tests and on a co-op host.
import { C } from './world.js';

// Per-type tuning. hp is a multiplier on the mode's per-round health;
// speed is [min, max] m/s before the mode's round scaling; dmg per swipe.
// size scales the body (renderer + hitboxes); headY is the head centre.
export const ZTYPES = [
  { id: 'walker', hp: 1, speed: [0.85, 1.25], dmg: 34, reach: 1.05, r: 0.3, size: 1, headY: 1.62, headR: 0.17, color: 0x6f8a62, cloth: 0x4a4a5c },
  { id: 'runner', hp: 0.85, speed: [3.0, 3.6], dmg: 30, reach: 1.05, r: 0.3, size: 0.97, headY: 1.58, headR: 0.17, color: 0x8a9a6a, cloth: 0x6b3a3a },
];
export const ZT = Object.fromEntries(ZTYPES.map((t, i) => [t.id, i]));

export const S = { FREE: 0, RISE: 1, CHASE: 2, BREACH: 3, ATTACK: 4, CLIMB: 5, DYING: 6 };
const RISE_T = 1.1, DIE_T = 1.4, BOARD_T = 1.2, WINDUP = 0.42, SWING_CD = 0.95;

export class Zombies {
  constructor(n = 48) {
    this.n = n;
    const f = () => new Float32Array(n);
    this.state = new Uint8Array(n);
    this.type = new Uint8Array(n);
    this.x = f(); this.z = f(); this.y = f(); this.yaw = f();
    this.hp = f(); this.maxHp = f(); this.speed = f();
    this.t = f();          // time in current state
    this.cd = f();         // attack cooldown
    this.walk = f();       // walk-cycle phase (renderer)
    this.flinch = f();     // recent-hit wobble (renderer)
    this.acc = f();        // dt accumulated while skipped by the LOD tiers
    this.win = new Int16Array(n).fill(-1);
    this.target = new Int8Array(n);
    this.headKill = new Uint8Array(n); // died to a headshot (renderer pops the head)
    this.seed = new Uint32Array(n);    // per-zombie variety (skin, gait)
    this.alive = 0;
    this.frame = 0;
  }

  clear() { this.state.fill(S.FREE); this.alive = 0; }

  // Lowest free slot (deterministic, so tests and co-op replay match).
  spawn(type, x, z, hp, speed, rngv = 0.5) {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== S.FREE) continue;
      this.state[i] = S.RISE;
      this.type[i] = type;
      this.x[i] = x; this.z[i] = z; this.y[i] = -1.7;
      this.yaw[i] = rngv * Math.PI * 2;
      this.hp[i] = this.maxHp[i] = hp;
      this.speed[i] = speed;
      this.t[i] = 0; this.cd[i] = 0; this.acc[i] = 0;
      this.walk[i] = rngv * 6; this.flinch[i] = 0;
      this.win[i] = -1; this.target[i] = 0; this.headKill[i] = 0;
      this.seed[i] = (rngv * 4294967295) >>> 0;
      this.alive++;
      return i;
    }
    return -1;
  }

  isLive(i) { const s = this.state[i]; return s !== S.FREE && s !== S.DYING; }

  // Ray vs every live zombie: head sphere, then body cylinder. Returns the
  // nearest hit within maxT as { i, t, head } or null.
  hitTest(ox, oy, oz, dx, dy, dz, maxT) {
    let best = null;
    for (let i = 0; i < this.n; i++) {
      if (!this.isLive(i) || this.state[i] === S.RISE && this.y[i] < -0.8) continue;
      const T = ZTYPES[this.type[i]];
      const zx = this.x[i], zy = this.y[i], zz = this.z[i];
      // Head sphere.
      const hy = zy + T.headY * T.size;
      const hr = T.headR * T.size * 1.15; // a little forgiving on a TV
      const lx = ox - zx, ly = oy - hy, lz = oz - zz;
      const b = lx * dx + ly * dy + lz * dz;
      const c = lx * lx + ly * ly + lz * lz - hr * hr;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < maxT && (!best || t < best.t)) best = { i, t, head: true };
      }
      // Body: vertical cylinder from the knees to the shoulders.
      const r = T.r * T.size * 1.1;
      const a2 = dx * dx + dz * dz;
      if (a2 < 1e-9) continue;
      const b2 = lx * dx + lz * dz;
      const c2 = lx * lx + lz * lz - r * r;
      const d2 = b2 * b2 - a2 * c2;
      if (d2 < 0) continue;
      const t2 = (-b2 - Math.sqrt(d2)) / a2;
      if (t2 <= 0 || t2 >= maxT || (best && t2 >= best.t)) continue;
      const yy = oy + dy * t2 - zy;
      if (yy > 0.25 * T.size && yy < (T.headY - T.headR) * T.size) best = { i, t: t2, head: false };
    }
    return best;
  }

  // Returns true when this hit killed.
  damage(i, amount, head = false) {
    if (!this.isLive(i)) return false;
    this.hp[i] -= amount;
    this.flinch[i] = 1;
    if (this.hp[i] > 0) return false;
    this.state[i] = S.DYING;
    this.t[i] = 0;
    this.headKill[i] = head ? 1 : 0;
    return true;
  }

  // One simulation step. `players` = [{x, z, y, down}], `flow` from
  // world.flow(), `ev` = event sink (array). Distant zombies are only
  // stepped every few frames (with their accumulated dt) — far away the
  // difference is invisible and it keeps big hordes affordable.
  step(dt, world, flow, players, ev, rng) {
    this.frame++;
    const N = this.n;
    for (let i = 0; i < N; i++) {
      const st = this.state[i];
      if (st === S.FREE) continue;
      this.acc[i] += dt;
      if (st === S.DYING) {
        this.t[i] += this.acc[i]; this.acc[i] = 0;
        if (this.t[i] > DIE_T) { this.state[i] = S.FREE; this.alive--; }
        continue;
      }
      // Nearest standing player decides the LOD tier and the target.
      let best = -1, bd = Infinity;
      for (let p = 0; p < players.length; p++) {
        const P = players[p];
        if (P.down) continue;
        const d = (P.x - this.x[i]) ** 2 + (P.z - this.z[i]) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      const every = bd < 225 ? 1 : bd < 1225 ? 3 : 8;
      if ((this.frame + i) % every !== 0) continue;
      const h = Math.min(this.acc[i], 0.25);
      this.acc[i] = 0;
      this.target[i] = best;
      this.flinch[i] = Math.max(0, this.flinch[i] - h * 4);
      this._think(i, h, world, flow, best >= 0 ? players[best] : null, ev, rng);
    }
    this._separate(world);
  }

  _think(i, h, world, flow, P, ev, rng) {
    const T = ZTYPES[this.type[i]];
    this.t[i] += h;
    this.cd[i] = Math.max(0, this.cd[i] - h);
    switch (this.state[i]) {
      case S.RISE:
        this.y[i] = Math.min(0, -1.7 + this.t[i] / RISE_T * 1.7);
        if (this.t[i] >= RISE_T) { this.state[i] = S.CHASE; this.t[i] = 0; this.y[i] = 0; }
        return;
      case S.BREACH: {
        const W = world.windows[this.win[i]];
        if (!W || W.boards === 0) { this._enterWindow(i, W); return; }
        this._face(i, W.x + 0.5, W.y + 0.5, h);
        if (this.t[i] >= BOARD_T) {
          this.t[i] = 0;
          world.setBoards(this.win[i], W.boards - 1);
          ev.push({ e: 'board', w: this.win[i], n: W.boards, z: i });
          if (W.boards === 0) this._enterWindow(i, W);
        }
        return;
      }
      case S.CLIMB: {
        // Hauling itself over the sill: slow, straight through.
        const W = world.windows[this.win[i]];
        const tx = W.in[0] + 0.5, tz = W.in[1] + 0.5;
        this._face(i, tx, tz, h);
        this._moveToward(i, tx, tz, 0.9 * h, world);
        this.y[i] = Math.sin(Math.min(1, this.t[i] / 1.2) * Math.PI) * 0.5;
        if ((this.x[i] - tx) ** 2 + (this.z[i] - tz) ** 2 < 0.04 || this.t[i] > 2.5) {
          this.state[i] = S.CHASE; this.t[i] = 0; this.y[i] = 0; this.win[i] = -1;
        }
        return;
      }
      case S.ATTACK:
        if (P) this._face(i, P.x, P.z, h);
        if (this.t[i] >= WINDUP) {
          if (P && !P.down && (P.x - this.x[i]) ** 2 + (P.z - this.z[i]) ** 2 < (T.reach + 0.35) ** 2
            && Math.abs((P.y || 0) - this.y[i]) < 1.2) {
            ev.push({ e: 'swipe', z: i, p: this.target[i], dmg: T.dmg });
          } else {
            ev.push({ e: 'whiff', z: i });
          }
          this.cd[i] = SWING_CD;
          this.state[i] = S.CHASE; this.t[i] = 0;
        }
        return;
    }
    // CHASE
    if (!P) return; // nobody to chase (everyone down): stand and sway
    const dx = P.x - this.x[i], dz = P.z - this.z[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < (T.reach) ** 2 && this.cd[i] <= 0) {
      this.state[i] = S.ATTACK; this.t[i] = 0;
      ev.push({ e: 'windup', z: i });
      return;
    }
    const cx = Math.floor(this.x[i]), cz = Math.floor(this.z[i]);
    const ci = cz * world.w + cx;
    const pcx = Math.floor(P.x), pcz = Math.floor(P.z);
    let tx = P.x, tz = P.z;
    // Same or neighbouring cell: go straight for the player. Otherwise
    // follow the field one cell ahead (aiming at that cell's centre).
    if (Math.abs(pcx - cx) > 1 || Math.abs(pcz - cz) > 1) {
      const nx = flow.next[ci];
      if (nx >= 0) {
        const ncx = nx % world.w, ncz = (nx - ncx) / world.w;
        if (world.cell(ncx, ncz) === C.WINDOW) {
          const wi = world.win[nx];
          const W = world.windows[wi];
          // Walk to the outside sill first, then tear or climb.
          const sx = W.out[0] + 0.5, sz = W.out[1] + 0.5;
          if ((this.x[i] - sx) ** 2 + (this.z[i] - sz) ** 2 < 0.2 || (cx === W.out[0] && cz === W.out[1])) {
            this.win[i] = wi;
            if (W.boards > 0) { this.state[i] = S.BREACH; this.t[i] = rng ? rng() * 0.5 : 0; }
            else this._enterWindow(i, W);
            return;
          }
          tx = sx; tz = sz;
        } else {
          tx = ncx + 0.5; tz = ncz + 0.5;
          // Look one more step ahead so corners are cut smoothly.
          const nn = flow.next[nx];
          if (nn >= 0) {
            const mx = nn % world.w, mz = (nn - mx) / world.w;
            if (world.cell(mx, mz) !== C.WINDOW && world.sees(this.x[i], 0.5, this.z[i], mx + 0.5, 0.5, mz + 0.5)) {
              tx = mx + 0.5; tz = mz + 0.5;
            }
          }
        }
      }
    }
    this._face(i, tx, tz, h);
    this._moveToward(i, tx, tz, this.speed[i] * (this.flinch[i] > 0.5 ? 0.45 : 1) * h, world);
    this.walk[i] += h * this.speed[i] * 2.6;
  }

  _enterWindow(i, W) {
    this.state[i] = S.CLIMB; this.t[i] = 0;
    if (W) { this.x[i] = W.x + 0.5 + (W.out[0] - W.x) * 0.45; this.z[i] = W.y + 0.5 + (W.out[1] - W.y) * 0.45; }
  }

  _face(i, tx, tz, h) {
    const want = Math.atan2(tx - this.x[i], tz - this.z[i]);
    let d = want - this.yaw[i];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw[i] += Math.max(-6 * h, Math.min(6 * h, d));
  }

  _moveToward(i, tx, tz, step, world) {
    const dx = tx - this.x[i], dz = tz - this.z[i];
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return;
    const s = Math.min(step, d);
    const p = this._p || (this._p = { x: 0, z: 0 });
    p.x = this.x[i] + dx / d * s; p.z = this.z[i] + dz / d * s;
    if (this.state[i] !== S.CLIMB) world.collide(p, ZTYPES[this.type[i]].r, true);
    this.x[i] = p.x; this.z[i] = p.z;
  }

  // Keep bodies from stacking. ponytail: O(n²) over the pool (≤48 → ~1k
  // pair checks); swap for a spatial hash if the pool ever grows past ~100.
  _separate(world) {
    const N = this.n, p = this._p || (this._p = { x: 0, z: 0 });
    for (let i = 0; i < N; i++) {
      const si = this.state[i];
      if (si === S.FREE || si === S.DYING || si === S.RISE || si === S.CLIMB) continue;
      for (let j = i + 1; j < N; j++) {
        const sj = this.state[j];
        if (sj === S.FREE || sj === S.DYING || sj === S.RISE || sj === S.CLIMB) continue;
        const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i];
        const min = 0.55;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (min - d) * 0.5;
        const ux = dx / d, uz = dz / d;
        // A zombie busy at a window holds its spot; the other gives way.
        const wi = si === S.BREACH || si === S.ATTACK ? 0.15 : 1;
        const wj = sj === S.BREACH || sj === S.ATTACK ? 0.15 : 1;
        p.x = this.x[i] - ux * push * wi; p.z = this.z[i] - uz * push * wi;
        world.collide(p, ZTYPES[this.type[i]].r, true);
        this.x[i] = p.x; this.z[i] = p.z;
        p.x = this.x[j] + ux * push * wj; p.z = this.z[j] + uz * push * wj;
        world.collide(p, ZTYPES[this.type[j]].r, true);
        this.x[j] = p.x; this.z[j] = p.z;
      }
    }
  }
}
