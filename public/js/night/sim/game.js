// One running match: world + survivors + zombies + equipment + the mode's
// rules, advanced by step(dt, inputs). Everything that happens is pushed
// to `events` (shots, hits, blasts, rounds…) for the renderer, the audio
// and the HUD to consume; the sim itself never touches the screen.
import { Zombies, ZTYPES, ZT } from './zombies.js';
import { Player, emptyInput } from './player.js';
import { Equipment } from './equipment.js';
import { Classic } from './classic.js';
import { Survival } from './survival.js';
import { Shelter } from './shelter.js';

export const MODES = { classic: Classic, world: Survival, shelter: (g, o) => new Survival(g, { ...o, shelter: Shelter }) };

// Small, fast, seedable PRNG (tests and co-op replays need determinism).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDLE = emptyInput();

export class Game {
  constructor({ world, zombies = new Zombies(48), seats = [{ name: 'Survivor' }], mode = 'classic', modeOpts = {}, seed = 1 }) {
    this.world = world;
    this.zombies = zombies;
    world.reset();
    zombies.clear();
    this.rng = mulberry32(seed);
    this.time = 0;
    this.events = [];
    this.zcap = 20;
    this.instakill = false;
    this.pointsMul = 1;
    this.equipment = new Equipment(this);
    const starts = world.starts;
    this.players = seats.map((s, i) => {
      const [sx, sz] = starts[i % starts.length];
      return new Player(i, s.name, sx + 0.5 + (i % 2) * 0.8, sz + 0.5 + (i >> 1) * 0.8, 0);
    });
    const M = MODES[mode];
    this.mode = M.prototype ? new M(this, modeOpts) : M(this, modeOpts);
    this._flow = null; this._flowKey = ''; this._flowT = -1;
  }

  ev(e) { this.events.push(e); }

  // Who zombies chase: a live noisemaker beats every survivor.
  targets() { return this.equipment.decoys.length ? this.equipment.decoys : this.players; }

  // The shared field toward every target. Rebuilt when someone changes cell
  // or the map's passability changes (at most 5×/s), and once a second
  // regardless so board counts feed into the routing.
  flowField() {
    const cells = [];
    let key = this.world.version + ':';
    for (const p of this.targets()) {
      if (p.down) continue;
      const cx = Math.floor(p.x), cz = Math.floor(p.z);
      cells.push([cx, cz]);
      key += cx + ',' + cz + ';';
    }
    for (const c of this.mode.extraTargets?.() || []) { cells.push(c); key += c + ';'; }
    const age = this.time - this._flowT;
    // Open world: only a 64-cell window around the targets is solved (the
    // rest of the county doesn't need paths), and a bit less often.
    let win = null, minAge = 0.2;
    if (this.world.openWorld && cells.length) {
      const xs = cells.map(c => c[0]), zs = cells.map(c => c[1]);
      win = [Math.min(...xs) - 32, Math.min(...zs) - 32, Math.max(...xs) + 32, Math.max(...zs) + 32];
      minAge = 0.33;
    }
    if (!this._flow || (key !== this._flowKey && age > minAge) || age > 1) {
      this._flow = this.world.flow(cells, win);
      this._flowKey = key;
      this._flowT = this.time;
    }
    return this._flow;
  }

  step(dt, inputs = []) {
    this.time += dt;
    for (let i = 0; i < this.players.length; i++) this.players[i].step(dt, inputs[i] || IDLE, this);
    this.equipment.step(dt);
    const zev = this._zev || (this._zev = []);
    zev.length = 0;
    const targets = this.targets();
    this.zombies.step(dt, this.world, this.flowField(), targets, zev, this.rng);
    for (const e of zev) this._zombieEvent(e, targets);
    // Deaths from any cause (guns, blasts, fire, traps, self-destruct).
    const Z = this.zombies;
    while (Z.deaths.length) {
      const d = Z.deaths.shift();
      const T = ZTYPES[d.type];
      this.ev({ e: 'kill', p: d.owner, z: d.i, head: d.head, how: d.how, type: T.id, x: d.x, zz: d.z });
      if (T.explode) this.explode(d.x, 1.0, d.z, T.explode.radius, T.explode.zdmg, d.owner, 'exploder', T.explode.dmg);
    }
    this._bleed();
    for (let k = this._scored || 0; k < this.events.length; k++) this.mode.onEvent?.(this.events[k]);
    this._scored = this.events.length;
    this.mode.step(dt);
  }

  _zombieEvent(e, targets) {
    const Z = this.zombies;
    switch (e.e) {
      case 'swipe': {
        if (targets !== this.players) return; // clawing at a noisemaker
        const P = this.players[e.p];
        if (!P || P.down) return;
        P.hurt(e.dmg, this);
        if (e.knock) {
          const dx = P.x - Z.x[e.z], dz = P.z - Z.z[e.z], d = Math.hypot(dx, dz) || 1;
          P.vx += dx / d * 7; P.vz += dz / d * 7;
        }
        this.ev({ e: 'hurt', p: e.p, dmg: e.dmg, z: e.z });
        return;
      }
      case 'spit': {
        const dx = e.tx - e.x, dy = e.ty - e.y, dz = e.tz - e.zz, d = Math.hypot(dx, dz) || 1;
        // Lob: aim a little high so the arc lands on the target.
        const speed = 13, flight = d / speed;
        this.equipment.launch('acid', -1, e.x, e.y, e.zz, dx / d, (dy + 0.5 * 9.8 * 0.6 * flight * flight) / (speed * flight), dz / d, speed, { dmg: e.dmg });
        this.ev(e);
        return;
      }
      case 'scream':
        for (let i = 0; i < Z.n; i++) {
          if (Z.isLive(i) && Math.hypot(Z.x[i] - e.x, Z.z[i] - e.zz) < e.r) Z.buffT[i] = e.buff;
        }
        this.ev(e);
        return;
      case 'selfdestruct': {
        const T = ZTYPES[Z.type[e.z]];
        // The death handler runs the blast; nothing else to do here.
        this.ev({ e: 'fuseBlow', z: e.z, type: T.id });
        return;
      }
      case 'slam':
        for (const P of this.players) {
          if (P.down) continue;
          const d = Math.hypot(P.x - e.x, P.z - e.zz);
          if (d < e.r) { P.hurt(Math.round(e.dmg * (1 - d / e.r * 0.5)), this); this.ev({ e: 'hurt', p: P.seat, dmg: e.dmg, z: e.z }); }
        }
        this.ev(e);
        return;
      case 'summon': this.mode.summon?.(e.x, e.zz, e.z); this.ev(e); return;
      default: this.ev(e);
    }
  }

  // A blast at (x, y, z): zombies take `zdmg` scaled by the mode (falling
  // off to half at the edge, armour ignored); survivors take `pdmg` at
  // most — your own grenades sting, other players' don't.
  explode(x, y, z, r, zdmg, owner, kind, pdmg = 45) {
    const Z = this.zombies;
    const scale = kind === 'exploder' ? 1 : this.mode.scale();
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      const d = Math.hypot(Z.x[i] - x, Z.z[i] - z);
      if (d > r) continue;
      const res = Z.damage(i, (this.instakill ? 1e9 : zdmg * scale) * (1 - 0.5 * d / r), false, owner, 'blast', 2);
      if (!res.kill) Z.flinch[i] = 1;
    }
    for (const P of this.players) {
      if (P.down) continue;
      if (owner >= 0 && owner !== P.seat) continue;
      const d = Math.hypot(P.x - x, P.z - z);
      if (d < r) {
        const dmg = Math.round(pdmg * (1 - d / r));
        if (dmg > 2) { P.hurt(dmg, this); this.ev({ e: 'hurt', p: P.seat, dmg, blast: true }); }
      }
    }
    this.ev({ e: 'boom', x, y, z, r, kind });
  }

  // ------------------------------------------------------------- co-op
  // Hold X by a downed teammate to get them up (Second Wind halves it);
  // left alone they bleed out after 30 s.
  reviveTarget(P) {
    if (this.players.length < 2) return null;
    for (const Q of this.players) {
      if (Q !== P && Q.down && !Q.dead && Math.hypot(Q.x - P.x, Q.z - P.z) < 1.7) {
        return { kind: 'revive', seat: Q.seat, label: `Hold to revive ${Q.name}`, afford: true, hold: true };
      }
    }
    return null;
  }
  reviveStep(P, t, dt) {
    const Q = this.players[t.seat];
    if (!Q?.down || Q.dead) return;
    const need = P.perks.has('secondwind') ? 1.5 : 3;
    P._reviveT = (P._reviveT || 0) + dt;
    P.searching = P._reviveT / need;
    if (P._reviveT < need) return;
    P._reviveT = 0; P.searching = 0;
    Q.revive(this, 0.5);
    P.xp += 50;
    this.ev({ e: 'revived', p: Q.seat, by: P.seat });
  }
  _bleed() {
    if (this.players.length < 2) return;
    for (const P of this.players) {
      if (P.down && !P.dead && P.downT > 30) { P.dead = true; this.ev({ e: 'bledout', p: P.seat }); }
    }
  }

  // Hand the accumulated events to the presentation layer.
  drain() {
    const e = this.events;
    this.events = [];
    this._scored = 0;
    return e;
  }
}

export { ZT };
