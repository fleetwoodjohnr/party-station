// Mode C — the shelter at Hollis Farm, layered on the open world
// (survival.js). Build on the farm plot with resources you scavenge:
// walls and gates in three tiers, sandbags, spike strips, a watchtower,
// turrets and an electric shocker that need a fuelled generator, storage,
// a workbench (crafting + tech), a medbay. Every night a raid comes for
// the farm in a different pattern; zombies path to the weakest point and
// tear at it, climbers vault wooden walls, brutes hit three times as hard,
// exploders blow up on contact. Everything persists in the world save.
import { C } from './world.js';
import { ZT, S as ZS } from './zombies.js';
import { ITEMS } from './loot.js';
import { statsOf, ATTACHMENTS, RARITY } from './weapons.js';
import { rankOf } from './classic.js';

// h: solid height; passP/passZ: walk-through for players / zombies;
// tier: tech level needed; power: draw (negative = supplies).
export const PIECES = {
  wall: { name: 'Wall', h: 3.2, hp: [300, 750, 1600], tier: 1, climbable: true, cost: [{ wood: 4 }, { metal: 4, wood: 1 }, { metal: 6, components: 2 }] },
  gate: { name: 'Gate', h: 3.2, hp: [260, 650, 1400], tier: 1, passP: true, climbable: true, cost: [{ wood: 6 }, { metal: 5, wood: 1 }, { metal: 7, components: 2 }] },
  sandbags: { name: 'Sandbags', h: 1.2, hp: [900], tier: 1, cost: [{ cloth: 3, wood: 1 }] },
  spikes: { name: 'Spike strip', h: 0.3, hp: [220], tier: 1, passZ: true, cost: [{ wood: 3 }] },
  tower: { name: 'Watchtower', h: 3.0, hp: [700], tier: 1, cost: [{ wood: 10, metal: 1 }] },
  storage: { name: 'Storage', h: 1.0, hp: [400], tier: 1, cost: [{ wood: 6 }] },
  workbench: { name: 'Workbench', h: 1.0, hp: [400], tier: 1, cost: [{ wood: 6, metal: 2 }] },
  generator: { name: 'Generator', h: 1.5, hp: [500], tier: 2, power: -4, cost: [{ metal: 8, parts: 2, components: 4 }] },
  turret: { name: 'Turret', h: 1.6, hp: [450], tier: 2, power: 1, cost: [{ metal: 6, parts: 4, components: 3 }] },
  shocker: { name: 'Shocker', h: 1.0, hp: [350], tier: 2, power: 1, cost: [{ metal: 3, components: 3 }] },
  medbay: { name: 'Medbay', h: 1.8, hp: [400], tier: 3, power: 1, cost: [{ metal: 4, components: 6, meds: 2 }] },
};
export const PIECE_ORDER = Object.keys(PIECES);
export const MAX_PIECES = 400;
const TIER_NAMES = ['Wood', 'Metal', 'Reinforced'];

// Workbench recipes. `give` adds items, ammo or equipment.
export const RECIPES = [
  { id: 'light', name: 'Light ammo ×30', need: { metal: 1, components: 1 }, give: { ammo: { light: 30 } } },
  { id: 'rifle', name: 'Rifle ammo ×30', need: { metal: 2, components: 1 }, give: { ammo: { rifle: 30 } } },
  { id: 'shells', name: 'Shells ×12', need: { metal: 1, cloth: 1, components: 1 }, give: { ammo: { shells: 12 } } },
  { id: 'meds', name: 'Medkit', need: { cloth: 2, components: 1 }, give: { items: { meds: 1 } } },
  { id: 'frag', name: 'Frag grenade', need: { metal: 1, components: 2 }, give: { lethal: 'frag' } },
  { id: 'molotov', name: 'Molotov', need: { fuel: 1, cloth: 1 }, give: { lethal: 'molotov' } },
  { id: 'claymore', name: 'Claymore', need: { metal: 2, components: 2 }, tier: 2, give: { lethal: 'claymore' } },
  { id: 'upgrade', name: 'Upgrade the gun in hand', need: null, give: { upgrade: true } },
  { id: 'tech2', name: 'Workshop II — metal, turrets, generator, shocker', need: { components: 10, parts: 6 }, give: { tech: 2 } },
  { id: 'tech3', name: 'Workshop III — reinforced walls, medbay, claymores', need: { components: 20, parts: 12, metal: 10 }, give: { tech: 3 }, tier: 2 },
];

const PATTERNS = ['one side', 'a pincer', 'every side', 'specials'];
const DAY_HOURS_SECS = 960 / 24; // real seconds per in-game hour

export class Shelter {
  constructor(sv) {
    this.sv = sv;
    this.game = sv.game;
    const home = this.game.world.home;
    this.plot = { x0: home.x0, z0: home.z0, x1: home.x1, z1: home.z1 };
    this.core = { x: home.x, z: home.z };
    this.pieces = [];          // by id (holes where demolished)
    this.nextId = 0;
    this.stash = { wood: 40, metal: 10, cloth: 6, components: 4 };
    this.stashAmmo = { light: 60, rifle: 0, shells: 0 };
    this.tech = 1;
    this.fuel = 0;             // generator fuel in hours
    this.raid = null;          // {n, pattern, spawned, live}
    this.raids = 0;
    this.power = { supply: 0, draw: 0 };
  }

  // ------------------------------------------------------------- building
  inPlot(x, z) { const p = this.plot; return x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1; }
  count() { let n = 0; for (const p of this.pieces) if (p) n++; return n; }

  // Resources come out of the pack first, then the stash.
  have(need) {
    const P = this.game.players[0];
    return Object.entries(need).every(([k, n]) => (P.inv[k] || 0) + (this.stash[k] || 0) >= n);
  }
  spend(need) {
    const P = this.game.players[0];
    for (const [k, n0] of Object.entries(need)) {
      let n = n0;
      const fromPack = Math.min(n, P.inv[k] || 0);
      P.inv[k] = (P.inv[k] || 0) - fromPack; n -= fromPack;
      this.stash[k] = (this.stash[k] || 0) - n;
    }
  }

  canPlace(type, x, z) {
    const D = PIECES[type], W = this.game.world;
    if (!D) return 'Unknown piece';
    if (D.tier > this.tech) return `Needs Workshop ${'I'.repeat(D.tier)}`;
    if (!this.inPlot(x, z)) return 'Build inside the farm plot';
    const c = W.cell(x, z);
    if (c !== C.GROUND && c !== C.FLOOR) return 'Something is in the way';
    for (const P of this.game.players) if (Math.floor(P.x) === x && Math.floor(P.z) === z) return 'You’re standing there';
    const Z = this.game.zombies;
    for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && Math.floor(Z.x[i]) === x && Math.floor(Z.z[i]) === z) return 'A zombie is standing there';
    if (this.count() >= MAX_PIECES) return 'The plot is full';
    if (!this.have(D.cost[0])) return 'Not enough materials';
    return null;
  }

  place(type, x, z, rot = 0) {
    const why = this.canPlace(type, x, z);
    if (why) { this.game.ev({ e: 'buildDenied', why }); return null; }
    const D = PIECES[type];
    this.spend(D.cost[0]);
    return this._add({ type, x, z, rot, tier: 0, hp: D.hp[0] });
  }
  _add({ type, x, z, rot = 0, tier = 0, hp }) {
    const D = PIECES[type];
    const piece = { id: this.nextId++, type, def: D, x, z, rot, tier, hp: hp ?? D.hp[tier], maxHp: D.hp[tier], cd: 0, yaw: 0 };
    this.pieces[piece.id] = piece;
    this.game.world.setStruct(x, z, piece);
    this._power();
    this.game.ev({ e: 'built', sid: piece.id, type, x, z });
    return piece;
  }

  // Next tier (walls and gates) or a top-up repair.
  upgradeCost(p) {
    if (p.hp < p.maxHp) return { kind: 'repair', need: this._repairNeed(p) };
    const D = p.def;
    if (p.tier + 1 < D.hp.length && this.tech > p.tier + 1) return { kind: 'upgrade', need: D.cost[p.tier + 1] };
    return null;
  }
  _repairNeed(p) {
    const frac = 1 - p.hp / p.maxHp;
    const base = p.def.cost[p.tier];
    const need = {};
    for (const [k, n] of Object.entries(base)) need[k] = Math.max(1, Math.ceil(n * frac * 0.6));
    return need;
  }
  improve(sid) {
    const p = this.pieces[sid];
    if (!p) return false;
    const u = this.upgradeCost(p);
    if (!u || !this.have(u.need)) { this.game.ev({ e: 'buildDenied', why: u ? 'Not enough materials' : 'Nothing to do' }); return false; }
    this.spend(u.need);
    if (u.kind === 'repair') p.hp = p.maxHp;
    else { p.tier++; p.maxHp = p.def.hp[p.tier]; p.hp = p.maxHp; }
    this.game.world.version++;
    this.game.ev({ e: u.kind === 'repair' ? 'repaired' : 'upgraded', sid, tier: p.tier });
    return true;
  }
  demolish(sid, refund = true) {
    const p = this.pieces[sid];
    if (!p) return;
    if (refund) for (const [k, n] of Object.entries(p.def.cost[p.tier])) this.stash[k] = (this.stash[k] || 0) + Math.floor(n / 2);
    this.pieces[sid] = undefined;
    this.game.world.setStruct(p.x, p.z, null);
    this._power();
    this.game.ev({ e: 'destroyed', sid, type: p.type, x: p.x, z: p.z, demolished: refund });
  }

  damage(sid, dmg) {
    const p = this.pieces[sid];
    if (!p) return;
    p.hp -= dmg;
    this.game.ev({ e: 'pieceHit', sid, x: p.x, z: p.z });
    if (p.hp <= 0) this.demolish(sid, false);
    else if (Math.random() < 0.1) this.game.world.version++; // weaker walls draw the horde
  }

  // Generators make power while there's fuel; consumers take it in order
  // (turrets first, then shockers, then the medbay).
  _power() {
    let supply = 0, draw = 0;
    for (const p of this.pieces) {
      if (!p) continue;
      if (p.def.power < 0) supply += this.fuel > 0 ? -p.def.power : 0;
    }
    for (const p of this.pieces) {
      if (!p || !(p.def.power > 0)) continue;
      p.powered = draw + p.def.power <= supply;
      if (p.powered) draw += p.def.power;
    }
    this.power = { supply, draw };
  }

  // -------------------------------------------------------------- the loop
  onEvent(ev) {
    if (ev.e === 'structHit') this.damage(ev.sid, ev.dmg);
  }

  step(dt) {
    const g = this.game;
    // Fuel: one can is ~4 in-game hours for the whole farm.
    const gens = this.pieces.filter(p => p?.type === 'generator').length;
    if (gens && this.fuel > 0) {
      this.fuel -= dt / (DAY_HOURS_SECS) * gens;
      if (this.fuel <= 0) { this.fuel = 0; this._power(); g.ev({ e: 'powerOut' }); }
    }
    if (gens && this.fuel <= 0 && (this.stash.fuel || 0) > 0) { this.stash.fuel--; this.fuel += 4; this._power(); }
    for (const p of this.pieces) {
      if (!p) continue;
      p.cd -= dt;
      if (p.type === 'turret' && p.powered) this._turret(p);
      if (p.type === 'spikes' || (p.type === 'shocker' && p.powered)) this._trap(p, dt);
    }
    this._raid(dt);
    // Watchtower: up there you're out of reach.
    for (const P of g.players) {
      if (!P.onTower) continue;
      const t = this.pieces[P.onTower.id];
      if (!t || P.down) { P.onTower = null; P.y = 0; P.grounded = false; continue; }
      P.y = t.def.h; P.grounded = true; P.vy = 0;
      P.x = Math.max(t.x + 0.25, Math.min(t.x + 0.75, P.x));
      P.z = Math.max(t.z + 0.25, Math.min(t.z + 0.75, P.z));
    }
  }

  _turret(p) {
    if (p.cd > 0) return;
    const g = this.game, Z = g.zombies, W = g.world;
    const ox = p.x + 0.5, oz = p.z + 0.5, oy = 1.75; // the gun sits on top, above its own cell
    let best = -1, bd = 14;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i) || Z.state[i] === ZS.RISE) continue;
      const d = Math.hypot(Z.x[i] - ox, Z.z[i] - oz);
      if (d < bd && W.sees(ox, oy, oz, Z.x[i], 1.2, Z.z[i])) { bd = d; best = i; }
    }
    if (best < 0) { p.cd = 0.4; return; }
    if ((this.stashAmmo.light || 0) <= 0) { p.cd = 2; if (!p.dry) { p.dry = true; g.ev({ e: 'turretDry', sid: p.id }); } return; }
    p.dry = false;
    this.stashAmmo.light--;
    p.cd = 0.2;
    p.yaw = Math.atan2(-(Z.x[best] - ox), -(Z.z[best] - oz));
    const hit = g.rng() < 0.7;
    if (hit) Z.damage(best, 45 * this.sv.scale(), g.rng() < 0.15, -1, 'turret');
    g.ev({ e: 'turret', sid: p.id, x: ox, y: oy, z: oz, tx: Z.x[best], ty: 1.2, tz: Z.z[best], hit });
  }

  _trap(p, dt) {
    const g = this.game, Z = g.zombies;
    const shock = p.type === 'shocker';
    const r = shock ? 1.6 : 0.75;
    let any = false;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      if (Math.hypot(Z.x[i] - (p.x + 0.5), Z.z[i] - (p.z + 0.5)) > r) continue;
      Z.damage(i, (shock ? 160 : 55) * this.sv.scale() * dt, false, -1, 'trap');
      Z.slowT[i] = Math.max(Z.slowT[i], 0.5);
      any = true;
    }
    if (any && !shock) { p.hp -= 6 * dt; if (p.hp <= 0) this.demolish(p.id, false); }
    if (any && shock && p.cd <= 0) { p.cd = 0.25; g.ev({ e: 'shock', x: p.x + 0.5, z: p.z + 0.5 }); }
  }

  // ---------------------------------------------------------------- raids
  dusk() {
    // The raid lands a couple of in-game hours after dark.
    const pattern = this.raids < 1 ? 0 : (this.raids % PATTERNS.length);
    this.raid = { delay: 2 * DAY_HOURS_SECS, pattern, n: Math.min(60, 8 + this.sv.day * 4), spawned: 0, started: false, t: 0 };
    this.game.ev({ e: 'raidSoon', pattern: PATTERNS[pattern] });
  }
  dawn() {
    if (this.raid?.started) this._raidOver(true);
    this.raid = null;
  }
  _raid(dt) {
    const R = this.raid, g = this.game, Z = g.zombies;
    if (!R) return;
    R.t += dt;
    if (!R.started) {
      if (R.t < R.delay) return; // about two hours after dusk
      R.started = true;
      this.raids++;
      g.ev({ e: 'raid', pattern: PATTERNS[R.pattern], n: R.n });
    }
    // Feed the raid in from its side(s), within the zombie cap — raiders
    // come first: a stray wanderer is sent back to its region to make room.
    const sides = [[[1, 0]], [[1, 0], [-1, 0]], [[1, 0], [-1, 0], [0, 1], [0, -1]], [[0, 1], [0, -1]]][R.pattern];
    R.cool = (R.cool || 0) - dt;
    if (R.spawned < R.n && R.cool <= 0 && Z.alive >= g.zcap) this._makeRoom();
    if (R.spawned < R.n && R.cool <= 0 && Z.alive < g.zcap) {
      R.cool = 0.5;
      const [dx, dz] = sides[R.spawned % sides.length];
      const a = (g.rng() - 0.5) * 1.2;
      const cx = this.core.x + (dx * Math.cos(a) - dz * Math.sin(a)) * 40, cz = this.core.z + (dz * Math.cos(a) + dx * Math.sin(a)) * 40;
      const x = Math.floor(cx), z = Math.floor(cz);
      if (g.world.open(x, z, true)) {
        let type = g.rng() < 0.3 + this.sv.day * 0.03 ? ZT.runner : ZT.walker;
        const sp = g.rng();
        if (R.pattern === 3 || this.sv.day >= 3) {
          if (sp < 0.15) type = ZT.climber; else if (sp < 0.22) type = ZT.brute; else if (sp < 0.3) type = ZT.exploder;
        }
        if (this.sv._spawnAt(type, x + 0.5, z + 0.5, { aware: true, tag: -4 }) >= 0) R.spawned++;
      }
    }
    if (R.spawned >= R.n) {
      let live = 0;
      for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && this.sv.tag[i] === -4) live++;
      if (live === 0) { this._raidOver(false); this.raid = null; }
    }
  }
  _makeRoom() {
    const g = this.game, Z = g.zombies, sv = this.sv;
    let far = -1, fd = -1;
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i) || sv.tag[i] === -4) continue;
      const d = Math.hypot(Z.x[i] - this.core.x, Z.z[i] - this.core.z);
      if (d > fd) { fd = d; far = i; }
    }
    if (far < 0) return;
    Z.state[far] = ZS.FREE; Z.alive--;
    if (sv.origin[far] >= 0) sv.pop[sv.origin[far]]++;
    sv.origin[far] = -1; sv.tag[far] = -1;
  }

  _raidOver(dawn) {
    const g = this.game;
    for (const P of g.players) { P.xp += 200 + this.sv.day * 50; g.ev({ e: 'xp', p: P.seat, n: 200 + this.sv.day * 50, why: 'Raid survived' }); }
    this.stash.parts = (this.stash.parts || 0) + 2;
    g.ev({ e: 'raidOver', dawn, standing: this.count() });
  }
  // During a raid the farm itself is a target, so the horde comes for your
  // walls even while you're out scavenging.
  extraTargets() { return this.raid?.started ? [[Math.floor(this.core.x), Math.floor(this.core.z)]] : []; }

  // ---------------------------------------------------------- interaction
  interactTarget(P, best, bd) {
    for (const p of this.pieces) {
      if (!p) continue;
      const d = Math.hypot(P.x - (p.x + 0.5), P.z - (p.z + 0.5));
      if (d > 1.6 || d > bd) continue;
      if (p.type === 'storage') { best = { kind: 'stash', sid: p.id, label: 'Storage — drop off everything you carry', afford: true }; bd = d; }
      if (p.type === 'workbench') { best = { kind: 'bench', sid: p.id, label: 'Workbench — craft', afford: true }; bd = d; }
      if (p.type === 'medbay') { best = { kind: 'medbay', sid: p.id, label: p.powered ? 'Medbay — patch up' : 'Medbay — no power', afford: p.powered && P.hp < P.maxHp, full: !p.powered }; bd = d; }
      if (p.type === 'generator') { best = { kind: 'fuel', sid: p.id, label: `Generator — ${Math.ceil(this.fuel)}h of fuel (add a can)`, afford: (P.inv.fuel || 0) + (this.stash.fuel || 0) > 0 }; bd = d; }
      if (p.type === 'tower') { best = { kind: 'tower', sid: p.id, label: P.onTower ? 'Climb down' : 'Climb the watchtower', afford: true }; bd = d; }
    }
    return best;
  }
  interact(P, t, dt, pressed) {
    const g = this.game;
    if (!['stash', 'bench', 'medbay', 'fuel', 'tower'].includes(t.kind)) return false;
    if (!pressed) return true;
    if (t.kind === 'stash') {
      for (const k of Object.keys(ITEMS)) if (!['food', 'water', 'meds'].includes(k) && P.inv[k] > 0) { this.stash[k] = (this.stash[k] || 0) + P.inv[k]; P.inv[k] = 0; }
      for (const k of ['light', 'rifle', 'shells']) {
        // Keep two magazines' worth on you; the rest feeds the turrets.
        const keep = 60;
        if ((P.ammo[k] || 0) > keep && k === 'light') { this.stashAmmo.light += P.ammo.light - keep; P.ammo.light = keep; }
      }
      g.ev({ e: 'stashed', p: P.seat });
    } else if (t.kind === 'bench') g.ev({ e: 'openBench', p: P.seat });
    else if (t.kind === 'medbay') { if (t.afford) { P.hp = P.maxHp; g.ev({ e: 'used', p: P.seat, item: 'meds' }); } }
    else if (t.kind === 'fuel') {
      if ((P.inv.fuel || 0) > 0) P.inv.fuel--; else if ((this.stash.fuel || 0) > 0) this.stash.fuel--; else return true;
      this.fuel += 4; this._power();
      g.ev({ e: 'fueled', hours: Math.ceil(this.fuel) });
    } else if (t.kind === 'tower') {
      P.onTower = P.onTower ? null : this.pieces[t.sid];
      if (!P.onTower) { P.y = 0.01; P.grounded = false; P.vy = 0; P.x = this.pieces[t.sid].x + 0.5; P.z = this.pieces[t.sid].z + 1.6; }
      g.ev({ e: 'climb', p: P.seat, up: !!P.onTower });
    }
    return true;
  }

  // ------------------------------------------------------------ crafting
  canCraft(r, P) {
    if (r.tier && this.tech < r.tier) return `Needs Workshop ${'I'.repeat(r.tier)}`;
    if (r.give.tech && this.tech >= r.give.tech) return 'Already built';
    if (r.give.upgrade) {
      const w = P.weapon;
      if (w.tier >= RARITY.length - 1) return 'Fully upgraded';
      return this.have(this.upgradeNeed(w)) ? null : 'Not enough materials';
    }
    return this.have(r.need) ? null : 'Not enough materials';
  }
  upgradeNeed(w) { return { parts: 4 * (w.tier + 1), components: 2 * (w.tier + 1) }; }
  craft(id, P) {
    const g = this.game, r = RECIPES.find(x => x.id === id);
    if (!r || this.canCraft(r, P)) return false;
    if (r.give.upgrade) {
      this.spend(this.upgradeNeed(P.weapon));
      P.weapon.tier++;
      P.weapon.mag = statsOf(P.weapon, P.perks).mag;
    } else this.spend(r.need);
    for (const [k, n] of Object.entries(r.give.ammo || {})) P.ammo[k] = (P.ammo[k] || 0) + n;
    for (const [k, n] of Object.entries(r.give.items || {})) P.inv[k] = (P.inv[k] || 0) + n;
    if (r.give.lethal) {
      if (P.lethal?.id === r.give.lethal) P.lethal.n++;
      else P.lethal = { id: r.give.lethal, n: 1 };
    }
    if (r.give.tech) this.tech = r.give.tech;
    g.ev({ e: 'crafted', p: P.seat, name: r.name });
    return true;
  }
  // Attachments you've unlocked by rank, made from parts.
  craftAttachment(id, P, careerXp) {
    const A = ATTACHMENTS[id];
    if (!A || A.rank > rankOf(careerXp)) return false;
    const need = { parts: 3, components: 2 };
    if (!this.have(need)) return false;
    this.spend(need);
    P.found.push({ att: id });
    this.game.ev({ e: 'crafted', p: P.seat, name: A.name });
    return true;
  }

  // ---------------------------------------------------------------- save
  serialize() {
    return {
      pieces: this.pieces.filter(Boolean).map(p => ({ type: p.type, x: p.x, z: p.z, rot: p.rot, tier: p.tier, hp: Math.round(p.hp) })),
      stash: this.stash, stashAmmo: this.stashAmmo, tech: this.tech, fuel: this.fuel, raids: this.raids,
    };
  }
  load(s) {
    if (!s) return;
    Object.assign(this, { stash: s.stash || this.stash, stashAmmo: s.stashAmmo || this.stashAmmo, tech: s.tech || 1, fuel: s.fuel || 0, raids: s.raids || 0 });
    for (const p of s.pieces || []) if (PIECES[p.type]) this._add(p);
  }
}

export { TIER_NAMES, PATTERNS };
