// Zombie pool + AI manager. Struct-of-arrays in typed arrays, a fixed pool
// (no allocation while playing), one shared flow field for pathing, and
// update rates that drop with distance. The renderer reads these arrays
// directly. Pure JS: runs in Node for tests and on a co-op host.
import { C } from './world.js';

// Per-type tuning. hp is a multiplier on the mode's per-round health;
// speed is [min, max] m/s before the mode's round scaling; dmg per swipe.
// size scales the body (renderer + hitboxes); headY is the head centre;
// body is the [low, high] of the torso hitbox (unscaled). Behaviour flags
// switch on the special abilities in _special().
export const ZTYPES = [
  { id: 'walker', hp: 1, speed: [0.85, 1.25], dmg: 34, reach: 1.05, r: 0.3, size: 1, headY: 1.62, headR: 0.17, body: [0.25, 1.45] },
  { id: 'runner', hp: 0.85, speed: [3.0, 3.6], dmg: 30, reach: 1.05, r: 0.3, size: 0.97, headY: 1.58, headR: 0.17, body: [0.25, 1.41] },
  { id: 'crawler', hp: 0.8, speed: [0.9, 1.4], dmg: 25, reach: 0.95, r: 0.3, size: 1, headY: 0.42, headR: 0.17, body: [0.02, 0.45], crawl: true },
  { id: 'armored', hp: 1.1, speed: [0.9, 1.3], dmg: 38, reach: 1.05, r: 0.32, size: 1.03, headY: 1.62, headR: 0.17, body: [0.25, 1.45], armor: { helmet: 0.9, vest: 1.2 } },
  { id: 'brute', hp: 4.5, speed: [1.0, 1.2], dmg: 70, reach: 1.5, r: 0.5, size: 1.45, headY: 1.62, headR: 0.17, body: [0.25, 1.45], charge: true, boards: 3 },
  { id: 'spitter', hp: 0.9, speed: [1.1, 1.5], dmg: 20, reach: 1.05, r: 0.3, size: 0.95, headY: 1.62, headR: 0.17, body: [0.25, 1.45], spit: { min: 5, max: 12, cd: 3.4, dmg: 18 } },
  { id: 'screamer', hp: 0.7, speed: [1.7, 2.1], dmg: 15, reach: 1.0, r: 0.28, size: 0.92, headY: 1.62, headR: 0.17, body: [0.25, 1.45], scream: { radius: 11, cd: 9, buff: 6 } },
  { id: 'exploder', hp: 1.3, speed: [0.8, 1.0], dmg: 0, reach: 1.6, r: 0.42, size: 1.12, headY: 1.62, headR: 0.17, body: [0.2, 1.5], explode: { radius: 3.6, dmg: 55, zdmg: 600 } },
  { id: 'warden', hp: 22, speed: [1.35, 1.5], dmg: 75, reach: 1.9, r: 0.65, size: 2.0, headY: 1.62, headR: 0.18, body: [0.2, 1.45], charge: true, boards: 99, boss: { slam: 4.6, slamDmg: 60, slamCd: 7, summonCd: 18 } },
  { id: 'climber', hp: 0.7, speed: [1.6, 2.0], dmg: 28, reach: 1.0, r: 0.28, size: 0.9, headY: 1.58, headR: 0.16, body: [0.25, 1.4], climb: true },
];
export const ZT = Object.fromEntries(ZTYPES.map((t, i) => [t.id, i]));

export const S = { FREE: 0, RISE: 1, CHASE: 2, BREACH: 3, ATTACK: 4, CLIMB: 5, DYING: 6, CHARGE: 7, SPIT: 8, SCREAM: 9, FUSE: 10, SLAM: 11, WANDER: 12 };
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
    this.cd2 = f();        // special-ability cooldown
    this.cd3 = f();        // boss summon cooldown
    this.walk = f();       // walk-cycle phase (renderer)
    this.flinch = f();     // recent-hit wobble (renderer)
    this.acc = f();        // dt accumulated while skipped by the LOD tiers
    this.helmet = f(); this.vest = f();         // armour hit points
    this.slowT = f(); this.buffT = f();         // stun / screamer frenzy timers
    this.burnT = f(); this.burnDps = f();
    this.burnBy = new Int8Array(n);
    this.chX = f(); this.chZ = f();             // charge heading
    this.homeX = f(); this.homeZ = f();         // where an unaware zombie drifts around
    this.senseT = f();                          // next awareness check
    this.sight = 15;                            // metres a zombie notices you from (mode sets it)
    this.win = new Int16Array(n).fill(-1);       // window being torn (-2: climbing over a wall)
    this.sid = new Int32Array(n).fill(-1);       // shelter piece being torn
    this.target = new Int8Array(n);
    this.headKill = new Uint8Array(n); // died to a headshot (renderer pops the head)
    this.seed = new Uint32Array(n);    // per-zombie variety (skin, gait)
    this.alive = 0;
    this.frame = 0;
    this.deaths = [];  // {i, owner, head, how, type, x, z} — drained by the game
  }

  clear() { this.state.fill(S.FREE); this.alive = 0; this.deaths.length = 0; }

  // Lowest free slot (deterministic, so tests and co-op replay match).
  spawn(type, x, z, hp, speed, rngv = 0.5, { rise = true, aware = true } = {}) {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] !== S.FREE) continue;
      const T = ZTYPES[type];
      this.state[i] = rise ? S.RISE : aware ? S.CHASE : S.WANDER;
      this.type[i] = type;
      this.x[i] = x; this.z[i] = z; this.y[i] = rise ? -1.7 * T.size : 0;
      this.homeX[i] = x; this.homeZ[i] = z; this.senseT[i] = rngv;
      this.yaw[i] = rngv * Math.PI * 2;
      this.hp[i] = this.maxHp[i] = hp;
      this.speed[i] = speed;
      this.t[i] = 0; this.cd[i] = 0; this.acc[i] = 0;
      this.cd2[i] = 2 + rngv * 3; this.cd3[i] = 8;
      this.walk[i] = rngv * 6; this.flinch[i] = 0;
      this.helmet[i] = T.armor ? hp * T.armor.helmet : 0;
      this.vest[i] = T.armor ? hp * T.armor.vest : 0;
      this.slowT[i] = 0; this.buffT[i] = 0; this.burnT[i] = 0; this.burnDps[i] = 0; this.burnBy[i] = -1;
      this.win[i] = -1; this.sid[i] = -1; this.target[i] = 0; this.headKill[i] = 0;
      this.seed[i] = (rngv * 4294967295) >>> 0;
      this.alive++;
      return i;
    }
    return -1;
  }

  isLive(i) { const s = this.state[i]; return s !== S.FREE && s !== S.DYING; }

  // Ray vs every live zombie: head sphere, then body cylinder. Returns the
  // nearest hit within maxT as { i, t, head } or null. `skip` = a Set of
  // zombies already hit by this bullet (penetration).
  hitTest(ox, oy, oz, dx, dy, dz, maxT, skip = null) {
    let best = null;
    for (let i = 0; i < this.n; i++) {
      if (!this.isLive(i) || (this.state[i] === S.RISE && this.y[i] < -0.8) || skip?.has(i)) continue;
      const T = ZTYPES[this.type[i]];
      const zx = this.x[i], zy = this.y[i], zz = this.z[i];
      const sz = T.size;
      // Head sphere.
      const hy = zy + T.headY * sz;
      const hr = T.headR * sz * 1.15; // a little forgiving on a TV
      let lx = ox - zx, ly = oy - hy, lz = oz - zz;
      if (T.crawl) { lx -= -Math.sin(this.yaw[i]) * 0.55; lz -= -Math.cos(this.yaw[i]) * 0.55; }
      const b = lx * dx + ly * dy + lz * dz;
      const c = lx * lx + ly * ly + lz * lz - hr * hr;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < maxT && (!best || t < best.t)) best = { i, t, head: true };
      }
      // Body: vertical cylinder over the type's torso band.
      const r = T.r * sz * (T.crawl ? 1.6 : 1.1);
      const a2 = dx * dx + dz * dz;
      if (a2 < 1e-9) continue;
      const bx = ox - zx, bz = oz - zz;
      const b2 = bx * dx + bz * dz;
      const c2 = bx * bx + bz * bz - r * r;
      const d2 = b2 * b2 - a2 * c2;
      if (d2 < 0) continue;
      const t2 = (-b2 - Math.sqrt(d2)) / a2;
      if (t2 <= 0 || t2 >= maxT || (best && t2 >= best.t)) continue;
      const yy = oy + dy * t2 - zy;
      if (yy > T.body[0] * sz && yy < T.body[1] * sz) best = { i, t: t2, head: false };
    }
    return best;
  }

  // Apply damage. Armour soaks first (helmet for headshots, vest for the
  // body); armorMul > 1 (AP rounds) punches straight through. Returns
  // { kill, armor: 'helmet'|'vest'|null when a plate just broke }.
  damage(i, amount, head = false, owner = -1, how = 'gun', armorMul = 1) {
    if (!this.isLive(i)) return { kill: false };
    let broke = null;
    if (armorMul < 2) {
      const plate = head ? this.helmet : this.vest;
      if (plate[i] > 0) {
        const soak = Math.min(plate[i], amount * (head ? 0.75 : 0.6));
        plate[i] -= soak * armorMul;
        amount -= soak;
        if (plate[i] <= 0) { plate[i] = 0; broke = head ? 'helmet' : 'vest'; }
      }
    }
    this.hp[i] -= amount;
    this.flinch[i] = 1;
    this.alert(i);
    if (this.hp[i] > 0) return { kill: false, armor: broke };
    this._die(i, owner, head, how);
    return { kill: true, armor: broke };
  }

  _die(i, owner, head, how) {
    this.state[i] = S.DYING;
    this.t[i] = 0;
    this.headKill[i] = head ? 1 : 0;
    this.deaths.push({ i, owner, head, how, type: this.type[i], x: this.x[i], z: this.z[i] });
  }

  // Something gave the player away (sight, a gunshot, being shot).
  alert(i) {
    if (this.state[i] === S.WANDER) { this.state[i] = S.CHASE; this.t[i] = 0; }
  }
  // A noise at (x, z) heard out to r metres wakes every zombie in range.
  noise(x, z, r) {
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] === S.WANDER && (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2 < r * r) this.alert(i);
    }
  }

  // Set alight (incendiary rounds, molotov fire): keeps the hottest burn.
  ignite(i, dps, dur, owner) {
    if (!this.isLive(i)) return;
    if (dps >= this.burnDps[i] || this.burnT[i] <= 0) { this.burnDps[i] = dps; this.burnBy[i] = owner; }
    this.burnT[i] = Math.max(this.burnT[i], dur);
  }

  // One simulation step. `players` = [{x, z, y, down}] (or decoys), `flow`
  // from world.flow(), `ev` = event sink (array). Distant zombies are only
  // stepped every few frames (with their accumulated dt) — far away the
  // difference is invisible and it keeps big hordes affordable.
  step(dt, world, flow, players, ev, rng) {
    this.frame++;
    const N = this.n;
    for (let i = 0; i < N; i++) {
      const st = this.state[i];
      if (st === S.FREE) continue;
      // Burning ticks every frame regardless of LOD.
      if (this.burnT[i] > 0 && st !== S.DYING) {
        this.burnT[i] -= dt;
        this.hp[i] -= this.burnDps[i] * dt;
        if (this.hp[i] <= 0) { this._die(i, this.burnBy[i], false, 'burn'); continue; }
      }
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
      const special = this.state[i] >= S.CHARGE && this.state[i] <= S.SLAM; // mid-ability: full rate
      const every = special || bd < 225 ? 1 : bd < 1225 ? 3 : 8;
      if ((this.frame + i) % every !== 0) continue;
      const h = Math.min(this.acc[i], 0.25);
      this.acc[i] = 0;
      this.target[i] = best;
      this.flinch[i] = Math.max(0, this.flinch[i] - h * 4);
      this.slowT[i] = Math.max(0, this.slowT[i] - h);
      this.buffT[i] = Math.max(0, this.buffT[i] - h);
      this.cd2[i] -= h; this.cd3[i] -= h;
      this._think(i, h, world, flow, best >= 0 ? players[best] : null, ev, rng, Math.sqrt(bd));
    }
    this._separate(world);
  }

  _speed(i) {
    let s = this.speed[i];
    if (this.flinch[i] > 0.5) s *= 0.45;
    if (this.slowT[i] > 0) s *= 0.3;
    if (this.buffT[i] > 0) s *= 1.35;
    return s;
  }

  _think(i, h, world, flow, P, ev, rng, dist) {
    const T = ZTYPES[this.type[i]];
    this.t[i] += h;
    this.cd[i] = Math.max(0, this.cd[i] - h);
    switch (this.state[i]) {
      case S.WANDER: {
        // Unaware: shuffle around home until something gives you away.
        this.senseT[i] -= h;
        if (P && this.senseT[i] <= 0) {
          this.senseT[i] = 0.5;
          if (dist < this.sight && world.sees(this.x[i], 1.5, this.z[i], P.x, (P.y || 0) + 1.5, P.z)) { this.alert(i); return; }
        }
        if (this.t[i] > 3 + (this.seed[i] % 5)) {
          this.t[i] = 0;
          const a = (rng ? rng() : 0.5) * Math.PI * 2;
          this.chX[i] = this.homeX[i] + Math.cos(a) * 5; this.chZ[i] = this.homeZ[i] + Math.sin(a) * 5;
        }
        if (this.chX[i] || this.chZ[i]) {
          this._face(i, this.chX[i], this.chZ[i], h);
          this._moveToward(i, this.chX[i], this.chZ[i], 0.45 * h, world);
          this.walk[i] += h * 1.2;
        }
        return;
      }
      case S.RISE:
        this.y[i] = Math.min(0, -1.7 * T.size + this.t[i] / RISE_T * 1.7 * T.size);
        if (this.t[i] >= RISE_T) { this.state[i] = S.CHASE; this.t[i] = 0; this.y[i] = 0; }
        return;
      case S.BREACH: {
        if (this.sid[i] >= 0) {
          // Tearing at a shelter wall / gate / turret.
          const p = world.pieces?.[this.sid[i]];
          if (!p) { this.sid[i] = -1; this.state[i] = S.CHASE; this.t[i] = 0; return; }
          this._face(i, p.x + 0.5, p.z + 0.5, h);
          if (this.t[i] >= 1.0 * (this.slowT[i] > 0 ? 2 : 1)) {
            this.t[i] = 0;
            ev.push({ e: 'structHit', sid: p.id, dmg: T.dmg * (T.boards || 1), z: i });
          }
          return;
        }
        const W = world.windows[this.win[i]];
        if (!W || W.boards === 0) { this._enterWindow(i, W); return; }
        this._face(i, W.x + 0.5, W.y + 0.5, h);
        if (this.t[i] >= BOARD_T * (this.slowT[i] > 0 ? 2.5 : 1)) {
          this.t[i] = 0;
          world.setBoards(this.win[i], W.boards - (T.boards || 1));
          ev.push({ e: 'board', w: this.win[i], n: W.boards, z: i });
          if (W.boards === 0) this._enterWindow(i, W);
        }
        return;
      }
      case S.CLIMB: {
        if (this.win[i] === -2) {
          // Over a wooden wall: straight across to the far side.
          const tx = this.chX[i], tz = this.chZ[i];
          this._face(i, tx, tz, h);
          this._moveToward(i, tx, tz, 1.4 * h, world);
          this.y[i] = Math.sin(Math.min(1, this.t[i] / 1.4) * Math.PI) * 1.6;
          if ((this.x[i] - tx) ** 2 + (this.z[i] - tz) ** 2 < 0.05 || this.t[i] > 2.5) {
            this.state[i] = S.CHASE; this.t[i] = 0; this.y[i] = 0; this.win[i] = -1;
          }
          return;
        }
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
        if (this.t[i] >= WINDUP * (this.slowT[i] > 0 ? 2 : 1)) {
          if (P && !P.down && !P.decoy && (P.x - this.x[i]) ** 2 + (P.z - this.z[i]) ** 2 < (T.reach + 0.35) ** 2
            && Math.abs((P.y || 0) - this.y[i]) < 1.2) {
            ev.push({ e: 'swipe', z: i, p: this.target[i], dmg: T.dmg });
          } else {
            ev.push({ e: 'whiff', z: i });
          }
          this.cd[i] = SWING_CD;
          this.state[i] = S.CHASE; this.t[i] = 0;
        }
        return;
      case S.CHARGE: {
        // Straight-line rush; slams whoever it runs into.
        const step = this._speed(i) * 2.8 * h;
        const ox = this.x[i], oz = this.z[i];
        this._moveToward(i, ox + this.chX[i], oz + this.chZ[i], step, world);
        this.walk[i] += h * 9;
        const blocked = Math.hypot(this.x[i] - ox, this.z[i] - oz) < step * 0.3;
        if (P && !P.decoy && (P.x - this.x[i]) ** 2 + (P.z - this.z[i]) ** 2 < (T.reach + 0.3) ** 2) {
          ev.push({ e: 'swipe', z: i, p: this.target[i], dmg: Math.round(T.dmg * 1.3), knock: true });
          this.state[i] = S.CHASE; this.t[i] = 0; this.cd[i] = 1.5;
        } else if (this.t[i] > 1.4 || blocked) { this.state[i] = S.CHASE; this.t[i] = 0; }
        return;
      }
      case S.SPIT:
        if (P) this._face(i, P.x, P.z, h);
        if (this.t[i] >= 0.65) {
          if (P && !P.decoy) ev.push({ e: 'spit', z: i, x: this.x[i], y: 1.5, zz: this.z[i], tx: P.x, ty: (P.y || 0) + 1.2, tz: P.z, dmg: T.spit.dmg });
          this.state[i] = S.CHASE; this.t[i] = 0; this.cd2[i] = T.spit.cd;
        }
        return;
      case S.SCREAM:
        if (this.t[i] >= 1.1) {
          ev.push({ e: 'scream', z: i, x: this.x[i], zz: this.z[i], r: T.scream.radius, buff: T.scream.buff });
          this.state[i] = S.CHASE; this.t[i] = 0; this.cd2[i] = T.scream.cd;
        }
        return;
      case S.FUSE:
        if (this.t[i] >= 0.75) {
          this.hp[i] = 0;
          this._die(i, -1, false, 'self');
          ev.push({ e: 'selfdestruct', z: i });
        }
        return;
      case S.SLAM:
        if (this.t[i] >= 0.9) {
          ev.push({ e: 'slam', z: i, x: this.x[i], zz: this.z[i], r: T.boss.slam, dmg: T.boss.slamDmg });
          this.state[i] = S.CHASE; this.t[i] = 0; this.cd2[i] = T.boss.slamCd;
        }
        return;
    }
    // CHASE
    if (!P) return; // nobody to chase (everyone down): stand and sway
    if (this._special(i, T, P, dist, world, ev, rng)) return;
    const dx = P.x - this.x[i], dz = P.z - this.z[i];
    const d2 = dx * dx + dz * dz;
    if (d2 < (T.reach) ** 2 && this.cd[i] <= 0 && !P.decoy) {
      if (T.explode) { this.state[i] = S.FUSE; this.t[i] = 0; ev.push({ e: 'fuse', z: i }); return; }
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
      const nx = flow.stamp[ci] === flow.gen ? flow.next[ci] : -1;
      if (nx >= 0) {
        const ncx = nx % world.w, ncz = (nx - ncx) / world.w;
        const piece = world.cell(ncx, ncz) === C.STRUCT ? world.pieceAt(ncx, ncz) : null;
        if (piece && !piece.def.passZ) {
          if (Math.hypot(this.x[i] - (ncx + 0.5), this.z[i] - (ncz + 0.5)) < 1.05 + T.r) {
            const beyond = flow.stamp[nx] === flow.gen ? flow.next[nx] : -1;
            if (T.climb && piece.tier === 0 && piece.def.climbable && beyond >= 0) {
              const bx = beyond % world.w, bz = (beyond - bx) / world.w;
              this.win[i] = -2; this.chX[i] = bx + 0.5; this.chZ[i] = bz + 0.5;
              this.state[i] = S.CLIMB; this.t[i] = 0;
              ev.push({ e: 'vault', z: i });
            } else if (T.explode) {
              this.state[i] = S.FUSE; this.t[i] = 0; ev.push({ e: 'fuse', z: i });
            } else {
              this.sid[i] = piece.id; this.state[i] = S.BREACH; this.t[i] = rng ? rng() * 0.5 : 0;
            }
            return;
          }
          tx = ncx + 0.5; tz = ncz + 0.5;
        } else if (world.cell(ncx, ncz) === C.WINDOW) {
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
          const nn = flow.stamp[nx] === flow.gen ? flow.next[nx] : -1;
          if (nn >= 0) {
            const mx = nn % world.w, mz = (nn - mx) / world.w;
            if (world.cell(mx, mz) !== C.WINDOW && world.sees(this.x[i], 0.5, this.z[i], mx + 0.5, 0.5, mz + 0.5)) {
              tx = mx + 0.5; tz = mz + 0.5;
            }
          }
        }
      }
    }
    // Ranged specials hang back instead of closing in.
    if ((T.spit || T.scream) && dist < (T.spit ? T.spit.min : 6) && world.sees(this.x[i], 1.5, this.z[i], P.x, 1.5, P.z)) {
      tx = this.x[i] - dx; tz = this.z[i] - dz;
    }
    this._face(i, tx, tz, h);
    this._moveToward(i, tx, tz, this._speed(i) * h, world);
    this.walk[i] += h * this._speed(i) * (T.crawl ? 1.6 : 2.6);
  }

  // Special abilities; true when one fired (and took over this tick).
  _special(i, T, P, dist, world, ev) {
    if (this.cd2[i] > 0 || P.decoy || this.slowT[i] > 0) return false;
    const sees = () => world.sees(this.x[i], 1.4, this.z[i], P.x, 1.4, P.z);
    if (T.boss && dist < T.boss.slam - 0.8) {
      this.state[i] = S.SLAM; this.t[i] = 0; ev.push({ e: 'slamWindup', z: i }); return true;
    }
    if (T.boss && this.cd3[i] <= 0) { this.cd3[i] = T.boss.summonCd; ev.push({ e: 'summon', z: i, x: this.x[i], zz: this.z[i] }); }
    if (T.charge && dist > 3.5 && dist < 9 && sees()) {
      const d = dist || 1;
      this.chX[i] = (P.x - this.x[i]) / d; this.chZ[i] = (P.z - this.z[i]) / d;
      this.state[i] = S.CHARGE; this.t[i] = 0; this.cd2[i] = T.boss ? 9 : 7;
      ev.push({ e: 'charge', z: i });
      return true;
    }
    if (T.spit && dist >= T.spit.min - 1 && dist <= T.spit.max && sees()) {
      this.state[i] = S.SPIT; this.t[i] = 0; ev.push({ e: 'spitWindup', z: i }); return true;
    }
    if (T.scream && dist < 15 && sees()) {
      this.state[i] = S.SCREAM; this.t[i] = 0; ev.push({ e: 'screamWindup', z: i }); return true;
    }
    return false;
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
    const skip = s => s === S.FREE || s === S.DYING || s === S.RISE || s === S.CLIMB;
    for (let i = 0; i < N; i++) {
      const si = this.state[i];
      if (skip(si)) continue;
      const ri = ZTYPES[this.type[i]].r;
      for (let j = i + 1; j < N; j++) {
        const sj = this.state[j];
        if (skip(sj)) continue;
        const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i];
        const rj = ZTYPES[this.type[j]].r;
        const min = (ri + rj) * 0.92;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2), push = (min - d) * 0.5;
        const ux = dx / d, uz = dz / d;
        // A zombie busy at a window holds its spot; big ones shove small ones.
        const hold = s => (s === S.BREACH || s === S.ATTACK || s === S.SLAM ? 0.15 : 1);
        const wi = hold(si) * Math.min(1.5, rj / ri), wj = hold(sj) * Math.min(1.5, ri / rj);
        p.x = this.x[i] - ux * push * wi; p.z = this.z[i] - uz * push * wi;
        world.collide(p, ri, true);
        this.x[i] = p.x; this.z[i] = p.z;
        p.x = this.x[j] + ux * push * wj; p.z = this.z[j] + uz * push * wj;
        world.collide(p, rj, true);
        this.x[j] = p.x; this.z[j] = p.z;
      }
    }
  }
}
