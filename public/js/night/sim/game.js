// One running match: world + survivors + zombies + the mode's rules,
// advanced by step(dt, inputs). Everything that happens is pushed to
// `events` (shots, hits, boards, rounds…) for the renderer, the audio and
// the HUD to consume; the sim itself never touches the screen.
import { Zombies } from './zombies.js';
import { Player, emptyInput } from './player.js';
import { Classic } from './classic.js';

export const MODES = { classic: Classic };

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
    const starts = world.starts;
    this.players = seats.map((s, i) => {
      const [sx, sz] = starts[i % starts.length];
      return new Player(i, s.name, sx + 0.5 + (i % 2) * 0.8, sz + 0.5 + (i >> 1) * 0.8, 0);
    });
    this.mode = new MODES[mode](this, modeOpts);
    this._flow = null; this._flowKey = ''; this._flowT = -1;
  }

  ev(e) { this.events.push(e); }

  // The shared field toward every standing player. Rebuilt when someone
  // changes cell or the map's passability changes (at most 5×/s), and once
  // a second regardless so board counts feed into the routing.
  flowField() {
    const targets = [];
    let key = this.world.version + ':';
    for (const p of this.players) {
      if (p.down) continue;
      const cx = Math.floor(p.x), cz = Math.floor(p.z);
      targets.push([cx, cz]);
      key += cx + ',' + cz + ';';
    }
    const age = this.time - this._flowT;
    if (!this._flow || (key !== this._flowKey && age > 0.2) || age > 1) {
      this._flow = this.world.flow(targets);
      this._flowKey = key;
      this._flowT = this.time;
    }
    return this._flow;
  }

  step(dt, inputs = []) {
    this.time += dt;
    for (let i = 0; i < this.players.length; i++) this.players[i].step(dt, inputs[i] || IDLE, this);
    const zev = this._zev || (this._zev = []);
    zev.length = 0;
    this.zombies.step(dt, this.world, this.flowField(), this.players, zev, this.rng);
    for (const e of zev) {
      if (e.e === 'swipe') {
        const P = this.players[e.p];
        if (P && !P.down) { P.hurt(e.dmg, this); this.ev({ e: 'hurt', p: e.p, dmg: e.dmg, z: e.z }); }
      } else this.ev(e);
    }
    for (let k = this._scored || 0; k < this.events.length; k++) this.mode.onEvent?.(this.events[k]);
    this._scored = this.events.length;
    this.mode.step(dt);
  }

  // Hand the accumulated events to the presentation layer.
  drain() {
    const e = this.events;
    this.events = [];
    this._scored = 0;
    return e;
  }
}
