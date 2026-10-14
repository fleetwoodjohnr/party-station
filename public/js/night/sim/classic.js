// Mode A — Classic wave survival. Rounds of zombies that grow in number,
// health and speed; points for every hit and kill; boarded windows to
// rebuild, doors to buy open, guns on the walls. The live-zombie cap comes
// from the quality governor (game.zcap): a slow screen gets the same
// zombies per round, just fed in at a gentler pace.
import { MAX_BOARDS } from './world.js';
import { WEAPONS } from './weapons.js';
import { ZT, ZTYPES } from './zombies.js';

export const START_POINTS = 500;
const PTS = { hit: 10, kill: 60, head: 100, melee: 130, board: 10 };
const BOARD_EVERY = 0.7, REPAIR_CAP = 500;

export function zombieHp(round) {
  return round < 10 ? 150 + 100 * (round - 1) : Math.round(950 * Math.pow(1.1, round - 9));
}
export function roundTotal(round, players = 1) {
  const solo = Math.round(6 + round * 2.4 + round * round * 0.18);
  return Math.round(solo * (1 + 0.5 * (players - 1)));
}
export function runnerChance(round) { return round < 3 ? 0 : Math.min(0.75, (round - 2) * 0.1); }
function spawnGap(round) { return Math.max(0.45, 2.0 * Math.pow(0.93, round - 1)); }

export class Classic {
  constructor(game, { startRound = 1 } = {}) {
    this.game = game;
    this.id = 'classic';
    this.round = startRound - 1;
    this.phase = 'pre';      // pre -> wave -> between -> wave ... -> over
    this.timer = 5;
    this.toSpawn = 0; this.spawnT = 0; this.spawned = 0;
    this.repairPts = new Map();
    for (const p of game.players) p.points = START_POINTS;
  }

  // What the HUD shows for objectives / Select.
  status() {
    const g = this.game;
    return {
      round: this.round, phase: this.phase, timer: this.timer,
      left: this.toSpawn + g.zombies.alive,
      doors: Object.values(g.world.doors).map(d => ({ name: d.name, cost: d.cost, open: d.open })),
    };
  }

  step(dt) {
    const g = this.game;
    if (this.phase === 'over') return;
    if (g.players.every(p => p.down)) {
      this.phase = 'over';
      g.ev({ e: 'gameover', round: this.round });
      return;
    }
    if (this.phase === 'pre' || this.phase === 'between') {
      this.timer -= dt;
      if (this.timer <= 0) this._startRound();
      return;
    }
    // wave
    this.spawnT -= dt;
    const cap = Math.min(g.zcap, 24 + 6 * (g.players.length - 1));
    if (this.toSpawn > 0 && this.spawnT <= 0 && g.zombies.alive < cap) {
      if (this._spawnOne()) { this.toSpawn--; this.spawnT = spawnGap(this.round); }
      else this.spawnT = 0.5;
    }
    this._recycleStragglers(dt);
    if (this.toSpawn === 0 && g.zombies.alive === 0) {
      this.phase = 'between';
      this.timer = 9;
      g.ev({ e: 'roundEnd', round: this.round });
    }
  }

  _startRound() {
    const g = this.game;
    this.round++;
    this.phase = 'wave';
    this.toSpawn = roundTotal(this.round, g.players.length);
    this.spawnT = 1.5;
    this.repairPts.clear();
    g.ev({ e: 'roundStart', round: this.round });
  }

  // Rise from one of the spawn points nearest (by path) to the players.
  _spawnOne() {
    const g = this.game, W = g.world;
    const flow = g.flowField();
    const cands = W.spawns
      .map(([x, z]) => ({ x, z, d: flow.dist[W.idx(x, z)] }))
      .filter(c => c.d !== 0xffffffff)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    if (!cands.length) return false;
    const c = cands[Math.floor(g.rng() * cands.length)];
    const run = g.rng() < runnerChance(this.round);
    const type = run ? ZT.runner : ZT.walker;
    const T = ZTYPES[type];
    const speedMul = 1 + Math.min(0.7, (this.round - 1) * 0.045);
    const speed = (T.speed[0] + g.rng() * (T.speed[1] - T.speed[0])) * (run ? 1 : speedMul);
    const i = g.zombies.spawn(type, c.x + 0.3 + g.rng() * 0.4, c.z + 0.3 + g.rng() * 0.4,
      zombieHp(this.round) * T.hp, speed, g.rng());
    if (i >= 0) g.ev({ e: 'spawn', z: i });
    return i >= 0;
  }

  // A zombie stuck far from everyone for a long time is quietly put back
  // in the queue so a round can't stall on it.
  _recycleStragglers(dt) {
    const g = this.game, Z = g.zombies;
    this._strag ||= new Float32Array(Z.n);
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) { this._strag[i] = 0; continue; }
      let near = Infinity;
      for (const p of g.players) near = Math.min(near, Math.hypot(p.x - Z.x[i], p.z - Z.z[i]));
      this._strag[i] = near > 18 ? this._strag[i] + dt : 0;
      if (this._strag[i] > 25) {
        Z.state[i] = 0; Z.alive--; this._strag[i] = 0;
        this.toSpawn++;
      }
    }
  }

  // Points from the shooting and stabbing.
  onEvent(ev) {
    const g = this.game;
    const P = g.players[ev.p];
    if (ev.e === 'hit' && P) {
      const pts = ev.kill ? (ev.melee ? PTS.melee : ev.head ? PTS.head : PTS.kill) : PTS.hit;
      this.award(P, pts);
    }
  }

  award(P, n) {
    P.points += n;
    this.game.ev({ e: 'points', p: P.seat, n });
  }

  // --------------------------------------------------------- interaction
  interactTarget(P) {
    const g = this.game, W = g.world;
    let best = null, bd = Infinity;
    const consider = (d, t) => { if (d < bd) { bd = d; best = t; } };
    for (let wi = 0; wi < W.windows.length; wi++) {
      const w = W.windows[wi];
      const d = Math.hypot(P.x - (w.in[0] + 0.5), P.z - (w.in[1] + 0.5));
      if (d < 1.4 && w.boards < MAX_BOARDS) consider(d, { kind: 'repair', wi, label: 'Hold to rebuild the barricade' });
    }
    for (const door of Object.values(W.doors)) {
      if (door.open) continue;
      for (const [x, z] of door.cells) {
        const d = Math.hypot(P.x - (x + 0.5), P.z - (z + 0.5));
        if (d < 1.9) consider(d + 0.1, { kind: 'door', id: door.id, cost: door.cost, label: `Open ${door.name}`, afford: P.points >= door.cost });
      }
    }
    for (const b of W.wallbuys) {
      const fx = b.x + 0.5 + b.face[0] * 0.5, fz = b.y + 0.5 + b.face[1] * 0.5;
      const d = Math.hypot(P.x - fx, P.z - fz);
      if (d > 1.6) continue;
      const Wd = WEAPONS[b.weapon];
      const owned = P.weapons.find(w => w.id === b.weapon);
      if (owned) {
        const full = owned.reserve >= Wd.reserve && owned.mag >= Wd.mag;
        consider(d, { kind: 'ammo', weapon: b.weapon, cost: Wd.ammoCost, label: full ? `${Wd.name} ammo is full` : `${Wd.name} ammo`, afford: !full && P.points >= Wd.ammoCost, full });
      } else {
        consider(d, { kind: 'buy', weapon: b.weapon, cost: Wd.cost, label: `Buy ${Wd.name}`, afford: P.points >= Wd.cost });
      }
    }
    return best;
  }

  interact(P, t, dt, pressed) {
    const g = this.game, W = g.world;
    if (t.kind === 'repair') {
      P._repairT = (P._repairT || 0) + dt;
      if (P._repairT < BOARD_EVERY) return;
      P._repairT = 0;
      const w = W.windows[t.wi];
      if (w.boards >= MAX_BOARDS) return;
      W.setBoards(t.wi, w.boards + 1);
      g.ev({ e: 'repair', w: t.wi, p: P.seat });
      const got = this.repairPts.get(P.seat) || 0;
      if (got < REPAIR_CAP) { this.repairPts.set(P.seat, got + PTS.board); this.award(P, PTS.board); }
      return;
    }
    if (!pressed) return;
    if (!t.afford) { g.ev({ e: 'denied', p: P.seat }); return; }
    if (t.kind === 'door') {
      P.points -= t.cost;
      W.openDoor(t.id);
      g.ev({ e: 'door', id: t.id, p: P.seat, n: -t.cost });
    } else if (t.kind === 'buy') {
      P.points -= t.cost;
      P.give(t.weapon, g);
      g.ev({ e: 'buy', p: P.seat, w: t.weapon, n: -t.cost });
    } else if (t.kind === 'ammo') {
      P.points -= t.cost;
      const wpn = P.weapons.find(w => w.id === t.weapon);
      wpn.reserve = WEAPONS[t.weapon].reserve;
      wpn.mag = WEAPONS[t.weapon].mag;
      g.ev({ e: 'buy', p: P.seat, w: t.weapon, ammo: true, n: -t.cost });
    }
  }
}

