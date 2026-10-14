// Mode A — Classic wave survival. Rounds of zombies that grow in number,
// health, speed and variety; a boss every tenth round; points for every
// hit and kill spent on doors, guns on the walls, perk machines, the
// mystery crate and the Forge. The live-zombie cap comes from the quality
// governor (game.zcap): a slow screen gets the same zombies per round,
// just fed in at a gentler pace. Standard ends at round 30; Endless never.
import { MAX_BOARDS } from './world.js';
import { WEAPONS, MELEE, PERKS, MAX_PERKS, RARITY, ATTACHMENTS, CRATE_POOL, CRATE_ODDS, canFit, statsOf } from './weapons.js';
import { EQUIP } from './equipment.js';
import { ZT, ZTYPES } from './zombies.js';

export const START_POINTS = 500;
const PTS = { hit: 10, gun: 60, head: 100, melee: 130, blast: 50, burn: 50, trap: 40, self: 0 };
const BOARD_EVERY = 0.7, REPAIR_CAP = 500;
const CRATE_COST = 950, FORGE_COST = 5000, GUNSMITH_COST = 250;
export const WIN_ROUND = 30;
const POWERUPS = [['maxammo', 30], ['instakill', 20], ['doublepts', 25], ['carpenter', 15], ['nuke', 10]];

export function zombieHp(round) {
  return round < 10 ? 150 + 100 * (round - 1) : Math.round(950 * Math.pow(1.1, round - 9));
}
export function roundTotal(round, players = 1) {
  const solo = Math.round(6 + round * 2.4 + round * round * 0.18);
  return Math.round(solo * (1 + 0.5 * (players - 1)));
}
export function runnerChance(round) { return round < 3 ? 0 : Math.min(0.75, (round - 2) * 0.1); }
function spawnGap(round) { return Math.max(0.45, 2.0 * Math.pow(0.93, round - 1)); }
export const isBossRound = r => r > 0 && r % 10 === 0;

// Special zombies join as the rounds climb: [type, from round, share].
const SPECIALS = [['crawler', 4, 0.08], ['armored', 6, 0.1], ['exploder', 7, 0.06], ['spitter', 8, 0.06], ['screamer', 9, 0.04], ['brute', 12, 0.04]];

// XP: rank n needs 1000·n^1.5 in total (rank 1 = 0 XP).
export const xpForRank = n => (n <= 1 ? 0 : Math.round(1000 * Math.pow(n - 1, 1.5)));
export const rankOf = xp => { let n = 1; while (xp >= xpForRank(n + 1)) n++; return n; };

export class Classic {
  constructor(game, { startRound = 1, standard = false, rank = 1 } = {}) {
    this.game = game;
    this.id = 'classic';
    this.standard = standard;
    this.rank = rank;
    this.round = startRound - 1;
    this.phase = 'pre';      // pre -> wave -> between -> wave ... -> over | won
    this.timer = 5;
    this.toSpawn = 0; this.spawnT = 0;
    this.repairPts = new Map();
    this.drops = [];          // power-ups on the floor: {kind, x, z, t}
    this.dropsThisRound = 0;
    this.timed = {};          // power-up -> seconds left
    this.crate = { state: 'idle', t: 0 };
    this.boss = -1;
    this.bossPending = 0;
    for (const p of game.players) p.points = START_POINTS;
  }

  // Explosives and fire keep up with zombie health.
  scale() { return Math.max(1, zombieHp(Math.max(1, this.round)) / 300); }

  // What the HUD shows for objectives / Select.
  status() {
    const g = this.game;
    return {
      round: this.round, phase: this.phase, timer: this.timer, standard: this.standard,
      left: this.toSpawn + g.zombies.alive + this.bossPending,
      doors: Object.values(g.world.doors).map(d => ({ name: d.name, cost: d.cost, open: d.open })),
    };
  }

  step(dt) {
    const g = this.game;
    if (this.phase === 'over' || this.phase === 'won') return;
    this._secondWind(dt);
    if (g.players.every(p => p.down && !p._swPending)) {
      this.phase = 'over';
      g.ev({ e: 'gameover', round: this.round });
      return;
    }
    this._timed(dt);
    this._drops(dt);
    this._traps(dt);
    this._crate(dt);
    if (this.phase === 'pre' || this.phase === 'between') {
      this.timer -= dt;
      if (this.timer <= 0) this._startRound();
      return;
    }
    // wave
    if (this.bossPending > 0) {
      this.bossPending -= dt;
      if (this.bossPending <= 0) { this.bossPending = 0; this._spawnBoss(); }
    }
    this.spawnT -= dt;
    const cap = Math.min(g.zcap, 24 + 6 * (g.players.length - 1));
    if (this.toSpawn > 0 && this.spawnT <= 0 && g.zombies.alive < cap) {
      if (this._spawnOne(this._pickType())) { this.toSpawn--; this.spawnT = spawnGap(this.round); }
      else this.spawnT = 0.5;
    }
    this._recycleStragglers(dt);
    if (this.toSpawn === 0 && this.bossPending === 0 && g.zombies.alive === 0) {
      this.phase = 'between';
      this.timer = 9;
      for (const P of g.players) { P.xp += 20 * this.round; g.ev({ e: 'xp', p: P.seat, n: 20 * this.round, why: 'Round survived' }); }
      g.ev({ e: 'roundEnd', round: this.round });
      if (this.standard && this.round >= WIN_ROUND) {
        this.phase = 'won';
        g.ev({ e: 'victory', round: this.round });
      }
    }
  }

  _startRound() {
    const g = this.game;
    this.round++;
    this.phase = 'wave';
    const boss = isBossRound(this.round);
    this.toSpawn = Math.round(roundTotal(this.round, g.players.length) * (boss ? 0.5 : 1));
    this.spawnT = 1.5;
    this.dropsThisRound = 0;
    this.repairPts.clear();
    if (boss) this.bossPending = 4;
    // Grenades and claymores come back each round.
    for (const P of g.players) {
      if (P.lethal) P.lethal.n = Math.min(EQUIP[P.lethal.id].max, P.lethal.n + 2);
      if (P.tactical) P.tactical.n = Math.min(EQUIP[P.tactical.id].max, P.tactical.n + 1);
    }
    g.ev({ e: 'roundStart', round: this.round, boss });
  }

  _pickType() {
    const g = this.game, r = this.round;
    let x = g.rng();
    for (const [id, from, share] of SPECIALS) {
      if (r < from) continue;
      if (id === 'brute' && this._count(ZT.brute) >= 2) continue;
      if (x < share) return ZT[id];
      x -= share;
    }
    return g.rng() < runnerChance(r) ? ZT.runner : ZT.walker;
  }

  _count(type) {
    const Z = this.game.zombies;
    let n = 0;
    for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && Z.type[i] === type) n++;
    return n;
  }

  // Rise from one of the spawn points nearest (by path) to the players.
  _spawnOne(type, at = null) {
    const g = this.game, W = g.world;
    let c = at;
    if (!c) {
      const flow = g.flowField();
      const cands = W.spawns
        .map(([x, z]) => ({ x, z, d: flow.dist[W.idx(x, z)] }))
        .filter(k => k.d !== 0xffffffff)
        .sort((a, b) => a.d - b.d)
        .slice(0, 4);
      if (!cands.length) return false;
      c = cands[Math.floor(g.rng() * cands.length)];
    }
    const T = ZTYPES[type];
    const speedMul = type === ZT.walker ? 1 + Math.min(0.7, (this.round - 1) * 0.045) : 1;
    const speed = (T.speed[0] + g.rng() * (T.speed[1] - T.speed[0])) * speedMul;
    const i = g.zombies.spawn(type, c.x + 0.3 + g.rng() * 0.4, c.z + 0.3 + g.rng() * 0.4,
      zombieHp(this.round) * T.hp, speed, g.rng());
    if (i >= 0) g.ev({ e: 'spawn', z: i, type: T.id });
    return i >= 0 ? i : false;
  }

  _spawnBoss() {
    const i = this._spawnOne(ZT.warden);
    if (i === false) { this.bossPending = 1; return; }
    this.boss = i;
    this.game.ev({ e: 'boss', z: i });
  }

  // The Warden calls up a few walkers around itself.
  summon(x, z) {
    const g = this.game, W = g.world;
    for (let k = 0; k < 4; k++) {
      const a = g.rng() * Math.PI * 2;
      const cx = Math.floor(x + Math.cos(a) * 2.5), cz = Math.floor(z + Math.sin(a) * 2.5);
      if (W.open(cx, cz, true)) this._spawnOne(ZT.walker, { x: cx, z: cz });
    }
  }

  // A zombie stuck far from everyone for a long time is quietly put back
  // in the queue so a round can't stall on it.
  _recycleStragglers(dt) {
    const g = this.game, Z = g.zombies;
    this._strag ||= new Float32Array(Z.n);
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i) || i === this.boss) { this._strag[i] = 0; continue; }
      let near = Infinity;
      for (const p of g.players) near = Math.min(near, Math.hypot(p.x - Z.x[i], p.z - Z.z[i]));
      this._strag[i] = near > 18 ? this._strag[i] + dt : 0;
      if (this._strag[i] > 25) {
        Z.state[i] = 0; Z.alive--; this._strag[i] = 0;
        this.toSpawn++;
      }
    }
  }

  // ------------------------------------------------------------- scoring
  onEvent(ev) {
    const g = this.game;
    const P = g.players[ev.p];
    if (ev.e === 'hit' && P && !ev.kill) this.award(P, PTS.hit);
    if (ev.e === 'kill') {
      if (ev.z === this.boss) this._bossDown(ev);
      if (P) {
        const pts = ev.how === 'gun' && ev.head ? PTS.head : (PTS[ev.how] ?? PTS.gun);
        if (pts) this.award(P, pts);
        const xp = 10 + (ev.head ? 5 : 0) + (ev.how === 'melee' ? 5 : 0);
        P.xp += xp;
      }
      // Lucky drop.
      if (ev.how !== 'trap' && ev.how !== 'self' && this.dropsThisRound < 4 && g.rng() < 0.025) {
        this.dropsThisRound++;
        this._drop(this._pickDrop(), ev.x, ev.zz);
      }
    }
    if (ev.e === 'down') {
      const D = g.players[ev.p];
      if (D && g.players.length === 1 && D.perks.has('secondwind') && (D._swUses || 0) < 3) {
        D._swPending = 3;
      }
    }
  }

  _bossDown(ev) {
    const g = this.game;
    this.boss = -1;
    for (const P of g.players) {
      this.award(P, 1000);
      P.xp += 500;
      g.ev({ e: 'xp', p: P.seat, n: 500, why: 'Warden down' });
    }
    this._drop('maxammo', ev.x, ev.zz);
    g.ev({ e: 'bossDown' });
  }

  award(P, n) {
    n = Math.round(n * this.game.pointsMul);
    P.points += n;
    this.game.ev({ e: 'points', p: P.seat, n });
  }

  // Solo Second Wind: back on your feet three seconds later, horde shoved
  // back, perk used up (buy it again).
  _secondWind(dt) {
    const g = this.game, Z = g.zombies;
    for (const P of g.players) {
      if (!P._swPending) continue;
      P._swPending -= dt;
      if (P._swPending > 0) continue;
      P._swPending = 0;
      P._swUses = (P._swUses || 0) + 1;
      P.perks.delete('secondwind');
      P.revive(g, 1);
      for (let i = 0; i < Z.n; i++) {
        if (!Z.isLive(i)) continue;
        const dx = Z.x[i] - P.x, dz = Z.z[i] - P.z, d = Math.hypot(dx, dz);
        if (d < 4 && d > 0.01) { const p = { x: Z.x[i] + dx / d * (4 - d), z: Z.z[i] + dz / d * (4 - d) }; g.world.collide(p, 0.3, true); Z.x[i] = p.x; Z.z[i] = p.z; Z.flinch[i] = 1; }
      }
      g.ev({ e: 'secondwind', p: P.seat });
    }
  }

  // ------------------------------------------------------------ power-ups
  _pickDrop() {
    const g = this.game, total = POWERUPS.reduce((a, [, w]) => a + w, 0);
    let x = g.rng() * total;
    for (const [k, w] of POWERUPS) { if (x < w) return k; x -= w; }
    return 'maxammo';
  }
  _drop(kind, x, z) { this.drops.push({ kind, x, z, t: 0 }); this.game.ev({ e: 'drop', kind, x, z }); }

  _drops(dt) {
    const g = this.game;
    for (let k = this.drops.length - 1; k >= 0; k--) {
      const d = this.drops[k];
      d.t += dt;
      const P = g.players.find(p => !p.down && Math.hypot(p.x - d.x, p.z - d.z) < 1.2);
      if (P) { this.drops.splice(k, 1); this._power(d.kind, P); continue; }
      if (d.t > 26) this.drops.splice(k, 1);
    }
  }

  _power(kind, P) {
    const g = this.game, Z = g.zombies, W = g.world;
    switch (kind) {
      case 'maxammo':
        for (const Q of g.players) {
          for (const w of Q.weapons) w.reserve = statsOf(w, Q.perks).reserve;
          if (Q.lethal) Q.lethal.n = EQUIP[Q.lethal.id].max;
          if (Q.tactical) Q.tactical.n = EQUIP[Q.tactical.id].max;
        }
        break;
      case 'instakill': this.timed.instakill = 30; g.instakill = true; break;
      case 'doublepts': this.timed.doublepts = 30; g.pointsMul = 2; break;
      case 'carpenter':
        W.windows.forEach((_, i) => W.setBoards(i, MAX_BOARDS));
        for (const Q of g.players) this.award(Q, 200);
        break;
      case 'nuke':
        for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && i !== this.boss) Z.damage(i, 1e9, false, -1, 'nuke');
        for (const Q of g.players) this.award(Q, 400);
        break;
    }
    g.ev({ e: 'power', kind, p: P.seat });
  }

  _timed(dt) {
    const g = this.game;
    for (const k of Object.keys(this.timed)) {
      this.timed[k] -= dt;
      if (this.timed[k] > 0) continue;
      delete this.timed[k];
      if (k === 'instakill') g.instakill = false;
      if (k === 'doublepts') g.pointsMul = 1;
      g.ev({ e: 'powerEnd', kind: k });
    }
  }

  // --------------------------------------------------------------- traps
  _traps(dt) {
    const g = this.game, Z = g.zombies;
    for (const t of g.world.traps) {
      if (t.cool > 0) t.cool -= dt;
      if (t.active <= 0) continue;
      t.active -= dt;
      if (t.active <= 0) { t.active = 0; t.cool = t.cooldown; g.ev({ e: 'trapOff', id: t.id }); continue; }
      const inside = (x, z) => t.cells.some(([cx, cz]) => Math.floor(x) === cx && Math.floor(z) === cz);
      for (let i = 0; i < Z.n; i++) {
        if (Z.isLive(i) && i !== this.boss && inside(Z.x[i], Z.z[i])) Z.damage(i, 1e9, false, t.owner, 'trap');
      }
      for (const P of g.players) {
        if (P.down || !inside(P.x, P.z)) continue;
        P._trapT = (P._trapT || 0) + dt;
        if (P._trapT > 0.4) { P._trapT = 0; P.hurt(12, g); g.ev({ e: 'hurt', p: P.seat, dmg: 12, zap: true }); }
      }
    }
  }

  // ---------------------------------------------------------- mystery crate
  _crate(dt) {
    const c = this.crate, g = this.game;
    if (c.state === 'idle') return;
    c.t += dt;
    if (c.state === 'rolling' && c.t >= 3) {
      c.state = 'offer'; c.t = 0;
      g.ev({ e: 'crateOffer', w: c.weapon, tier: c.tier });
    } else if (c.state === 'offer' && c.t >= 9) {
      c.state = 'idle';
      g.ev({ e: 'crateGone' });
    }
  }

  _rollCrate(P) {
    const g = this.game;
    const owned = new Set(P.weapons.map(w => w.id));
    const pool = CRATE_POOL.filter(id => !owned.has(id));
    const weapon = pool[Math.floor(g.rng() * pool.length)];
    let x = g.rng() * 100, tier = 0;
    for (let k = 0; k < CRATE_ODDS.length; k++) { if (x < CRATE_ODDS[k]) { tier = k; break; } x -= CRATE_ODDS[k]; }
    // Pre-fitted attachments: one per rarity slot, random fitting ones.
    const att = {};
    const fits = Object.keys(ATTACHMENTS).filter(a => canFit(weapon, a));
    for (let k = 0; k < RARITY[tier].slots && fits.length; k++) {
      const a = fits.splice(Math.floor(g.rng() * fits.length), 1)[0];
      if (!att[ATTACHMENTS[a].slot]) att[ATTACHMENTS[a].slot] = a;
    }
    this.crate = { state: 'rolling', t: 0, weapon, tier, att, owner: P.seat };
    g.ev({ e: 'crateRoll', p: P.seat });
  }

  // ---------------------------------------------- the Forge and gunsmith
  forgeUpgrade(P) {
    const w = P.weapon;
    if (w.tier >= RARITY.length - 1 || P.points < FORGE_COST) return false;
    P.points -= FORGE_COST;
    w.tier++;
    w.reserve = statsOf(w, P.perks).reserve;
    w.mag = statsOf(w, P.perks).mag;
    this.game.ev({ e: 'forged', p: P.seat, tier: w.tier, n: -FORGE_COST });
    return true;
  }
  // Fit (or with null, remove) an attachment the player's rank has unlocked.
  gunsmith(P, slot, attId) {
    const w = P.weapon;
    if (P.points < GUNSMITH_COST) return false;
    if (attId && (!canFit(w.id, attId) || ATTACHMENTS[attId].slot !== slot || ATTACHMENTS[attId].rank > this.rank)) return false;
    if ((w.att[slot] || null) === (attId || null)) return false;
    P.points -= GUNSMITH_COST;
    if (attId) w.att[slot] = attId; else delete w.att[slot];
    w.mag = Math.min(w.mag, statsOf(w, P.perks).mag);
    this.game.ev({ e: 'gunsmith', p: P.seat, slot, att: attId, n: -GUNSMITH_COST });
    return true;
  }
  static get FORGE_COST() { return FORGE_COST; }
  static get GUNSMITH_COST() { return GUNSMITH_COST; }

  // --------------------------------------------------------- interaction
  interactTarget(P) {
    const g = this.game, W = g.world;
    let best = null, bd = Infinity;
    const consider = (d, t) => { if (d < bd) { bd = d; best = t; } };
    const near = (x, z, r) => { const d = Math.hypot(P.x - x, P.z - z); return d < r ? d : -1; };
    for (let wi = 0; wi < W.windows.length; wi++) {
      const w = W.windows[wi];
      const d = near(w.in[0] + 0.5, w.in[1] + 0.5, 1.4);
      if (d >= 0 && w.boards < MAX_BOARDS) consider(d, { kind: 'repair', wi, label: 'Hold to rebuild the barricade' });
    }
    for (const door of Object.values(W.doors)) {
      if (door.open) continue;
      for (const [x, z] of door.cells) {
        const d = near(x + 0.5, z + 0.5, 1.9);
        if (d >= 0) consider(d + 0.1, { kind: 'door', id: door.id, cost: door.cost, label: `Open ${door.name}`, afford: P.points >= door.cost });
      }
    }
    for (const b of W.wallbuys) {
      const d = near(b.x + 0.5 + b.face[0] * 0.5, b.y + 0.5 + b.face[1] * 0.5, 1.6);
      if (d < 0) continue;
      if (b.weapon) {
        const Wd = WEAPONS[b.weapon];
        const owned = P.weapons.find(w => w.id === b.weapon);
        if (owned) {
          const S = statsOf(owned, P.perks);
          const full = owned.reserve >= S.reserve && owned.mag >= S.mag;
          consider(d, { kind: 'ammo', weapon: b.weapon, cost: Wd.ammoCost, label: full ? `${Wd.name} ammo is full` : `${Wd.name} ammo`, afford: !full && P.points >= Wd.ammoCost, full });
        } else consider(d, { kind: 'buy', weapon: b.weapon, cost: Wd.cost, label: `Buy ${Wd.name}`, afford: P.points >= Wd.cost });
      } else if (b.melee) {
        const M = MELEE[b.melee];
        const own = P.meleeId === b.melee;
        consider(d, { kind: 'melee', melee: b.melee, cost: own ? 0 : M.cost, label: own ? `${M.name} in hand` : `Buy ${M.name}`, afford: !own && P.points >= M.cost, full: own });
      } else if (b.equip) {
        const E = EQUIP[b.equip];
        const slot = E.slot === 'lethal' ? P.lethal : P.tactical;
        const full = slot?.id === b.equip && slot.n >= E.max;
        consider(d, { kind: 'equip', equip: b.equip, cost: E.cost, label: full ? `${E.name} full` : `${E.name}${slot?.id === b.equip ? ' refill' : ''}`, afford: !full && P.points >= E.cost, full });
      }
    }
    for (const m of W.machines) {
      const d = near(m.x + 0.5, m.y + 0.5, 1.7);
      if (d < 0) continue;
      if (m.kind === 'perk') {
        const K = PERKS[m.perk];
        const cost = m.perk === 'secondwind' && g.players.length > 1 ? 1500 : K.cost;
        const own = P.perks.has(m.perk), full = !own && P.perks.size >= MAX_PERKS;
        consider(d, { kind: 'perk', perk: m.perk, cost, label: own ? `${K.name} — yours` : full ? `${K.name} — perk limit reached` : `${K.name}: ${K.desc}`, afford: !own && !full && P.points >= cost, full: own || full });
      } else if (m.kind === 'crate') {
        const c = this.crate;
        if (c.state === 'idle') consider(d, { kind: 'crate', cost: CRATE_COST, label: 'Mystery crate — a random weapon', afford: P.points >= CRATE_COST });
        else if (c.state === 'offer' && c.owner === P.seat) {
          const name = (c.tier ? RARITY[c.tier].name + ' ' : '') + WEAPONS[c.weapon].name;
          consider(d, { kind: 'crateTake', label: `Take the ${name}`, afford: true, tier: c.tier });
        } else consider(d, { kind: 'busy', label: c.state === 'rolling' ? 'The crate is deciding…' : 'Someone else’s pick', afford: false, full: true });
      } else if (m.kind === 'forge') {
        consider(d, { kind: 'forge', label: 'The Forge — upgrade and customise', afford: true });
      }
    }
    for (const t of W.traps) {
      const d = near(t.lever.x + 0.5 + t.lever.face[0] * 0.5, t.lever.y + 0.5 + t.lever.face[1] * 0.5, 1.5);
      if (d < 0) continue;
      const doorOpen = !t.door || W.doors[t.door]?.open;
      const ready = doorOpen && t.active <= 0 && t.cool <= 0;
      const label = !doorOpen ? 'Electric trap — no power' : t.active > 0 ? 'Electric trap — live!' : t.cool > 0 ? `Electric trap — recharging (${Math.ceil(t.cool)}s)` : 'Electric trap';
      consider(d, { kind: 'trap', id: t.id, cost: ready ? t.cost : 0, label, afford: ready && P.points >= t.cost, full: !ready });
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
      if (got < REPAIR_CAP) { this.repairPts.set(P.seat, got + PTS.hit); this.award(P, PTS.hit); }
      return;
    }
    if (!pressed) return;
    if (t.kind === 'forge') { g.ev({ e: 'openForge', p: P.seat }); return; }
    if (t.kind === 'crateTake') {
      const c = this.crate;
      P.give(c.weapon, g, c.tier, c.att);
      this.crate = { state: 'idle', t: 0 };
      g.ev({ e: 'crateTaken', p: P.seat });
      return;
    }
    if (t.kind === 'busy' || t.full) { g.ev({ e: 'denied', p: P.seat, quiet: true }); return; }
    if (!t.afford) { g.ev({ e: 'denied', p: P.seat }); return; }
    P.points -= t.cost;
    switch (t.kind) {
      case 'door': W.openDoor(t.id); g.ev({ e: 'door', id: t.id, p: P.seat, n: -t.cost }); break;
      case 'buy': P.give(t.weapon, g); g.ev({ e: 'buy', p: P.seat, w: t.weapon, n: -t.cost }); break;
      case 'ammo': {
        const wpn = P.weapons.find(w => w.id === t.weapon);
        const S = statsOf(wpn, P.perks);
        wpn.reserve = S.reserve; wpn.mag = S.mag;
        g.ev({ e: 'buy', p: P.seat, w: t.weapon, ammo: true, n: -t.cost });
        break;
      }
      case 'melee': P.meleeId = t.melee; g.ev({ e: 'buy', p: P.seat, melee: t.melee, n: -t.cost }); break;
      case 'equip': {
        const E = EQUIP[t.equip];
        const key = E.slot === 'lethal' ? 'lethal' : 'tactical';
        if (P[key]?.id === t.equip) P[key].n = E.max; else P[key] = { id: t.equip, n: E.max };
        g.ev({ e: 'buy', p: P.seat, equip: t.equip, n: -t.cost });
        break;
      }
      case 'perk': P.addPerk(t.perk); g.ev({ e: 'perk', p: P.seat, perk: t.perk, n: -t.cost }); break;
      case 'crate': this._rollCrate(P); g.ev({ e: 'points', p: P.seat, n: -t.cost }); break;
      case 'trap': {
        const tr = W.traps.find(x => x.id === t.id);
        tr.active = tr.dur; tr.owner = P.seat;
        g.ev({ e: 'trapOn', id: t.id, p: P.seat, n: -t.cost });
        break;
      }
    }
  }
}

