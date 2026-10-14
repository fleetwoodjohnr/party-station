// Modes B and C — survival in Hollis County. The world is big but the sim
// is local: zombies exist only in a ring around the players (spawned out
// of sight from each region's remaining population, returned to it when
// left far behind); hordes are a handful of numbers walking the map that
// turn into real zombies only near a player; infected zones fill up when
// approached. Days and nights, hunger and thirst, loot, missions, and a
// save that captures all of it. Shelter mode (shelter.js) layers building
// and raids on top via `this.shelter`.
import { ZT, ZTYPES, S as ZS } from './zombies.js';
import { rollLoot, take, ITEMS, CONTAINER_NAMES, lootLabel } from './loot.js';
import { newWeapon, WEAPONS } from './weapons.js';
import { RS } from './regions.js';
import { MAX_HP } from './player.js';

export const DAY_SECS = 960;          // one in-game day, in real seconds
const DAWN = 0.25, DUSK = 0.78;
const SEARCH_T = 0.8, LOOT_RESPAWN_DAYS = 3;

// The story: a chain of jobs radioed in from the farm, then repeatables.
export const MISSIONS = [
  { id: 'supplies', title: 'Stock up', brief: 'Search 3 containers around Maple Street.', kind: 'search', count: 3, reward: { xp: 300, items: { meds: 1 } } },
  { id: 'ridge', title: 'Reach out', brief: 'Get to the Ridge Outpost and use the radio.', kind: 'radio', poi: 'ridge', reward: { xp: 400, ammo: { rifle: 60 } } },
  { id: 'fuel', title: 'Fuel run', brief: 'Carry 4 cans of fuel.', kind: 'carry', item: 'fuel', count: 4, reward: { xp: 400, items: { components: 3 } } },
  { id: 'armory', title: 'Checkpoint armory', brief: 'Search the armory rack at the Checkpoint.', kind: 'loot', poi: 'armory', reward: { xp: 500 } },
  { id: 'clearTown', title: 'Main Street', brief: 'Clear the infected zone on Main Street.', kind: 'clear', region: 'town', reward: { xp: 700, items: { parts: 4 } } },
  { id: 'pharmacy', title: 'Medicine', brief: 'Clean out the pharmacy on Main Street.', kind: 'loot', poi: 'pharmacy', reward: { xp: 500 } },
  { id: 'kilo', title: 'Hold Kilo', brief: 'Call in from Kilo Outpost, then hold it for 90 seconds.', kind: 'defend', poi: 'kilo', secs: 90, reward: { xp: 900, ammo: { rifle: 90, shells: 20 } } },
  { id: 'manifest', title: 'The manifest', brief: 'Find the shipping manifest in the Warehouse District.', kind: 'loot', poi: 'manifest', reward: { xp: 600 } },
  { id: 'plant', title: 'The rendering plant', brief: 'Clear the infected zone at the Rendering Plant.', kind: 'clear', region: 'industrial', reward: { xp: 900, items: { components: 6 } } },
  { id: 'echo', title: 'Echo', brief: 'Reach Echo Outpost in the far south-east and use the radio.', kind: 'radio', poi: 'echo', reward: { xp: 700 } },
  { id: 'night', title: 'Long night', brief: 'Survive a whole night — dusk to dawn.', kind: 'night', reward: { xp: 1000, items: { food: 2, water: 2 } } },
  { id: 'exodus', title: 'Exodus', brief: 'Bring 10 fuel and 5 medkits to the Checkpoint armory.', kind: 'deliver', poi: 'armory', need: { fuel: 10, meds: 5 }, reward: { xp: 2000 } },
];

export class Survival {
  constructor(game, { save = null, seed = 1, shelter = null } = {}) {
    this.game = game;
    this.id = 'world';
    this.seed = seed;
    const W = game.world;
    this.day = 1; this.time = 0.3;
    this.pop = W.regions.map(r => r.density);
    this.origin = new Int16Array(game.zombies.n).fill(-1);   // region a live zombie came from
    this.tag = new Int16Array(game.zombies.n).fill(-1);      // zone id / -2 horde / -3 defend wave
    this.looted = new Map();     // container id -> day searched
    this.leftover = new Map();   // container id -> loot that didn't fit
    this.zonesCleared = new Set();
    this.zoneOn = new Map();     // zone id -> remaining to kill (while active)
    this.hordes = [];
    this.mission = 0; this.mState = {};
    this.explored = new Uint8Array(48 * 48);
    this.packs = [];
    this.timers = { amb: 0, horde: 0, zone: 0, miss: 0, map: 0, save: 120, needs: 0 };
    this.nightStart = -1;
    for (const P of game.players) {
      P.points = 0;
      P.ammo = { light: 40, rifle: 0, shells: 0, explosive: 0 };
      P.inv = { food: 2, water: 2, meds: 1 };
      P.found = [];
      P.hunger = 100; P.thirst = 100;
      P.lethal = { id: 'frag', n: 1 };
    }
    this.shelter = shelter ? new shelter(this) : null;
    if (this.shelter) this.id = 'shelter';
    if (save) this.load(save);
    else this._spawnHorde(3);
  }

  // ---------------------------------------------------------------- time
  get night() { return this.time < DAWN || this.time > DUSK; }
  clock() {
    const m = Math.floor(this.time * 24 * 60);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  // 0 at night … 1 at noon, and how dusky it is (for the sky tint).
  daylight() {
    const k = Math.max(0, Math.sin((this.time - 0.22) / 0.6 * Math.PI));
    const dusk = Math.max(0, 1 - Math.min(Math.abs(this.time - DUSK), Math.abs(this.time - DAWN)) / 0.05);
    return [Math.min(1, k * 1.3), dusk];
  }
  scale() { return 1 + (this.day - 1) * 0.25; }
  hpFor(type, zone = false) { return (150 + 60 * (this.day - 1)) * ZTYPES[type].hp * (zone ? 1.25 : 1); }

  status() {
    const g = this.game, P = g.players[0], M = this.currentMission();
    return {
      day: this.day, clock: this.clock(), night: this.night, phase: 'world',
      region: g.world.regionAt(P.x, P.z)?.name || '',
      mission: M ? { title: M.title, brief: M.brief, progress: this.missionProgress(M) } : null,
      target: M ? this.missionTarget(M) : null,
    };
  }

  step(dt) {
    const g = this.game;
    const before = this.night;
    this.time += dt / DAY_SECS;
    if (this.time >= 1) { this.time -= 1; this._newDay(); }
    if (!before && this.night) this._dusk();
    if (before && !this.night) this._dawn();
    g.zombies.sight = this.night ? 10 : 17;
    for (const k of Object.keys(this.timers)) this.timers[k] -= dt;
    if (this.timers.needs <= 0) { this.timers.needs = 1; this._needs(1); }
    if (this.timers.amb <= 0) { this.timers.amb = 0.4; this._ambient(); }
    if (this.timers.horde <= 0) { this.timers.horde = 1; this._hordes(1); }
    if (this.timers.zone <= 0) { this.timers.zone = 0.5; this._zones(); }
    if (this.timers.miss <= 0) { this.timers.miss = 0.5; this._missions(0.5); }
    if (this.timers.map <= 0) { this.timers.map = 0.5; this._explore(); }
    if (this.timers.save <= 0) { this.timers.save = 120; g.ev({ e: 'autosave' }); }
    this._downs(dt);
    this.shelter?.step(dt);
  }

  _newDay() {
    this.day++;
    const W = this.game.world;
    W.regions.forEach((r, i) => { this.pop[i] = Math.min(r.density, this.pop[i] + Math.ceil(r.density * 0.4)); });
    for (const [id, d] of this.looted) if (this.day - d >= LOOT_RESPAWN_DAYS) { this.looted.delete(id); this.leftover.delete(id); }
    this.game.ev({ e: 'newDay', day: this.day });
  }
  _dusk() {
    this.nightStart = this.day;
    this._spawnHorde(1, 10 + this.day * 2, true);
    this.game.ev({ e: 'dusk', day: this.day });
    this.shelter?.dusk();
  }
  _dawn() {
    this.game.ev({ e: 'dawn', day: this.day });
    if (this.nightStart >= 0 && this.game.players.some(p => !p.down)) this.mState.survivedNight = true;
    this.shelter?.dawn();
  }

  // Hunger and thirst tick down; empty means no healing and slow damage.
  _needs(dt) {
    const g = this.game;
    for (const P of g.players) {
      if (P.down) continue;
      P.hunger = Math.max(0, P.hunger - dt * 100 / (DAY_SECS * 2));
      P.thirst = Math.max(0, P.thirst - dt * 100 / (DAY_SECS * 1.4));
      P.starving = P.hunger <= 0 || P.thirst <= 0;
      if (P.starving) { P.lastHurt = g.time; P._starveT = (P._starveT || 0) + dt; if (P._starveT > 5) { P._starveT = 0; P.hurt(4, g); } }
    }
  }

  // ------------------------------------------------------- the local horde
  _nearRegions(P, r = 96) {
    return this.game.world.regions.filter(R => Math.hypot(R.x - P.x, R.z - P.z) < r + RS * 0.7);
  }

  _pickType(region, night, zone = false) {
    const g = this.game, x = g.rng();
    const t = region?.type;
    if (zone && x < 0.25) return [ZT.armored, ZT.spitter, ZT.exploder, ZT.screamer][Math.floor(g.rng() * 4)];
    if (t === 'military' && x < 0.3) return ZT.armored;
    if (t === 'industrial' && x < 0.12) return ZT.exploder;
    if (t === 'industrial' && x < 0.22) return ZT.spitter;
    if (t === 'town' && x < 0.06) return ZT.screamer;
    if (this.day >= 3 && x > 0.97) return ZT.brute;
    if (this.day >= 2 && x > 0.9) return ZT.crawler;
    return g.rng() < (night ? 0.35 : 0.08) + Math.min(0.2, this.day * 0.02) ? ZT.runner : ZT.walker;
  }

  // During a raid the farm itself is a target (shelter.js).
  extraTargets() { return this.shelter?.extraTargets() || []; }

  // An open cell 26–42 m from P that P can't see, or null.
  _ringCell(P, lo = 26, hi = 42) {
    const g = this.game, W = g.world;
    const [ex, ey, ez] = P.eyePos();
    for (let k = 0; k < 8; k++) {
      const a = g.rng() * Math.PI * 2, d = lo + g.rng() * (hi - lo);
      const x = Math.floor(P.x + Math.cos(a) * d), z = Math.floor(P.z + Math.sin(a) * d);
      if (!W.open(x, z, true) || this.shelter?.inPlot(x, z)) continue;
      if (W.sees(ex, ey, ez, x + 0.5, 1.5, z + 0.5) && !(this.night && d > 32)) continue;
      return [x + 0.5, z + 0.5];
    }
    return null;
  }

  _spawnAt(type, x, z, { aware = false, origin = -1, tag = -1, zone = false } = {}) {
    const g = this.game, T = ZTYPES[type];
    const speed = (T.speed[0] + g.rng() * (T.speed[1] - T.speed[0])) * (this.night && type === ZT.walker ? 1.15 : 1);
    const i = g.zombies.spawn(type, x, z, this.hpFor(type, zone), speed, g.rng(), { rise: false, aware });
    if (i >= 0) { this.origin[i] = origin; this.tag[i] = tag; }
    return i;
  }

  _ambient() {
    const g = this.game, Z = g.zombies;
    const P = g.players.find(p => !p.down);
    if (!P) return;
    // Despawn whatever's been left far behind; it rejoins its region.
    for (let i = 0; i < Z.n; i++) {
      if (!Z.isLive(i)) continue;
      let near = Infinity;
      for (const Q of g.players) near = Math.min(near, Math.hypot(Q.x - Z.x[i], Q.z - Z.z[i]));
      const far = Z.state[i] === ZS.WANDER ? 58 : 80;
      if (near > far && this.tag[i] !== -3) {
        Z.state[i] = ZS.FREE; Z.alive--;
        if (this.origin[i] >= 0) this.pop[this.origin[i]]++;
        if (this.tag[i] >= 0 && this.zoneOn.has(this.tag[i])) this.zoneOn.set(this.tag[i], this.zoneOn.get(this.tag[i]) + 1);
        if (this.tag[i] === -2 && this.hordes[0]) this.hordes[0].n++;
        this.origin[i] = -1; this.tag[i] = -1;
      }
    }
    // Top up from the populations of nearby regions.
    let want = 0;
    for (const R of this._nearRegions(P)) want += this.pop[R.id] * Math.max(0, 1 - Math.hypot(R.x - P.x, R.z - P.z) / 140);
    want = Math.min(g.zcap - 3, Math.round(want * 0.45 * (this.night ? 1.5 : 1)));
    if (this.shelter?.raid) want = 0; // raids own the zombie budget
    if (Z.alive >= want) return;
    const at = this._ringCell(P);
    if (!at) return;
    const R = g.world.regionAt(at[0], at[1]);
    if (!R || this.pop[R.id] <= 0) return;
    if (this._spawnAt(this._pickType(R, this.night), at[0], at[1], { aware: this.night && g.rng() < 0.3, origin: R.id }) >= 0) this.pop[R.id]--;
  }

  _spawnHorde(k, size = 0, hunting = false) {
    const g = this.game, W = g.world;
    const busy = W.regions.filter(r => r.type !== 'forest' && r.type !== 'home');
    for (let j = 0; j < k; j++) {
      const R = busy[Math.floor(g.rng() * busy.length)];
      const P = g.players[0];
      const T = hunting ? W.regionAt(P.x, P.z) : busy[Math.floor(g.rng() * busy.length)];
      this.hordes.push({ x: R.x, z: R.z, n: size || 12 + Math.floor(g.rng() * 10), tx: T.x, tz: T.z, active: false });
    }
  }

  _hordes(dt) {
    const g = this.game, Z = g.zombies;
    const P = g.players.find(p => !p.down);
    for (let k = this.hordes.length - 1; k >= 0; k--) {
      const H = this.hordes[k];
      const d = P ? Math.hypot(H.x - P.x, H.z - P.z) : Infinity;
      if (!H.active) {
        const dx = H.tx - H.x, dz = H.tz - H.z, l = Math.hypot(dx, dz);
        if (l < 4) {
          const busy = g.world.regions.filter(r => r.type !== 'forest');
          const R = busy[Math.floor(g.rng() * busy.length)];
          H.tx = R.x; H.tz = R.z;
        } else { H.x += dx / l * 1.1 * dt; H.z += dz / l * 1.1 * dt; }
        if (d < 50) { H.active = true; g.ev({ e: 'horde', n: H.n, x: H.x, z: H.z }); }
      }
      if (H.active) {
        // Members walk out of the dark a few at a time.
        for (let s = 0; s < 3 && H.n > 0 && Z.alive < g.zcap; s++) {
          const a = g.rng() * Math.PI * 2, r = 3 + g.rng() * 5;
          const x = Math.floor(H.x + Math.cos(a) * r), z = Math.floor(H.z + Math.sin(a) * r);
          if (!g.world.open(x, z, true)) continue;
          if (this._spawnAt(this._pickType(g.world.regionAt(x, z), this.night), x + 0.5, z + 0.5, { aware: true, tag: -2 }) >= 0) H.n--;
        }
        if (H.n <= 0) this.hordes.splice(k, 1);
        else if (d > 110) H.active = false;
      }
    }
  }

  // Infected zones: fill when you get close, cleared when emptied.
  _zones() {
    const g = this.game, W = g.world, Z = g.zombies;
    const P = g.players.find(p => !p.down);
    if (!P) return;
    for (const zn of W.zones) {
      if (this.zonesCleared.has(zn.id)) continue;
      const d = Math.hypot(zn.x - P.x, zn.z - P.z);
      if (!this.zoneOn.has(zn.id) && d < zn.r + 26) {
        const count = Math.round(5 * zn.boost);
        this.zoneOn.set(zn.id, count);
        g.ev({ e: 'zoneEnter', id: zn.id, name: zn.name });
      }
      if (!this.zoneOn.has(zn.id)) continue;
      // Keep up to 8 of the zone's remaining zombies on the ground.
      let live = 0;
      for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && this.tag[i] === zn.id) live++;
      const left = this.zoneOn.get(zn.id);
      if (left > 0 && live < 8 && Z.alive < g.zcap) {
        for (let k = 0; k < 6; k++) {
          const a = g.rng() * Math.PI * 2, r = g.rng() * zn.r;
          const x = Math.floor(zn.x + Math.cos(a) * r), z = Math.floor(zn.z + Math.sin(a) * r);
          if (!W.open(x, z, true)) continue;
          if (this._spawnAt(this._pickType(W.regionAt(x, z), this.night, true), x + 0.5, z + 0.5, { tag: zn.id, zone: true, aware: d < zn.r + 10 }) >= 0) {
            this.zoneOn.set(zn.id, left - 1);
          }
          break;
        }
      }
      if (left <= 0 && live === 0) {
        this.zoneOn.delete(zn.id);
        this.zonesCleared.add(zn.id);
        for (const Q of g.players) { Q.xp += 300; g.ev({ e: 'xp', p: Q.seat, n: 300, why: 'Zone cleared' }); }
        take(P, [{ item: 'components', n: 3 }, { ammo: 'rifle', n: 40 }]);
        g.ev({ e: 'zoneCleared', id: zn.id, name: zn.name });
      } else if (d > zn.r + 80) {
        // Walked away: the zone keeps its numbers for next time.
        this.zoneOn.set(zn.id, left + live);
        for (let i = 0; i < Z.n; i++) if (Z.isLive(i) && this.tag[i] === zn.id) { Z.state[i] = ZS.FREE; Z.alive--; this.tag[i] = -1; }
        this.zoneOn.delete(zn.id);
      }
    }
  }

  _explore() {
    for (const P of this.game.players) {
      const cx = Math.floor(P.x / 8), cz = Math.floor(P.z / 8);
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < 48 && z < 48 && dx * dx + dz * dz <= 10) this.explored[z * 48 + x] = 1;
      }
    }
  }

  // Solo: going down is a trip back to the farm; your pack stays where
  // you fell (map-marked) for you to collect.
  _downs(dt) {
    const g = this.game;
    for (const P of g.players) {
      if (!P.down) continue;
      P._respawnT = (P._respawnT || 0) + dt;
      if (g.players.length > 1 && g.players.some(q => !q.down)) continue; // co-op: wait for a revive
      if (P._respawnT < 4) continue;
      P._respawnT = 0;
      const pack = { x: P.x, z: P.z, inv: { ...P.inv }, day: this.day };
      if (Object.values(pack.inv).some(n => n > 0)) this.packs.push(pack);
      P.inv = {};
      const [sx, sz] = g.world.starts[0];
      P.x = sx + 0.5; P.z = sz + 0.5;
      P.hunger = Math.max(P.hunger, 50); P.thirst = Math.max(P.thirst, 50);
      P.revive(g, 1);
      g.ev({ e: 'respawn', p: P.seat, pack: !!this.packs.length });
    }
  }

  // ------------------------------------------------------------- events
  onEvent(ev) {
    const g = this.game;
    if (ev.e === 'kill') {
      const P = g.players[ev.p];
      if (P) P.xp += 10 + (ev.head ? 5 : 0) + (ev.how === 'melee' ? 5 : 0);
      this.origin[ev.z] = -1;
      if (this.mState.defending) this.mState.defendKills = (this.mState.defendKills || 0) + 1;
      this.tag[ev.z] = -1;
    }
    if (ev.e === 'shot') {
      // Gunfire carries: wakes zombies nearby and turns hordes your way.
      const P = g.players[ev.p];
      const r = 38 * (ev.noise ?? 1);
      g.zombies.noise(P.x, P.z, r);
      for (const H of this.hordes) if (Math.hypot(H.x - P.x, H.z - P.z) < r * 3.5) { H.tx = P.x; H.tz = P.z; }
    }
    if (ev.e === 'boom') g.zombies.noise(ev.x, ev.z, 45);
    this.shelter?.onEvent(ev);
  }

  // --------------------------------------------------------- interaction
  interactTarget(P) {
    const g = this.game, W = g.world;
    let best = null, bd = 1.7;
    const consider = (d, t) => { if (d < bd) { bd = d; best = t; } };
    const M = this.currentMission();
    for (const c of W.containers) {
      const d = Math.hypot(P.x - (c.x + 0.5), P.z - (c.z + 0.5));
      if (d > 1.7) continue;
      const missionHere = M && M.poi && W.pois[M.poi]?.container === c.id;
      if (missionHere && (M.kind === 'radio' || M.kind === 'defend' || M.kind === 'deliver')) {
        const label = M.kind === 'deliver' ? `Hand over the supplies (${Object.entries(M.need).map(([k, n]) => `${n} ${ITEMS[k].name.toLowerCase()}`).join(', ')})` : 'Use the radio';
        consider(d - 0.3, { kind: 'mission', id: c.id, label, afford: true });
        continue;
      }
      const empty = this.looted.has(c.id) && !this.leftover.get(c.id)?.length;
      consider(d, { kind: 'search', id: c.id, label: empty ? `${CONTAINER_NAMES[c.kind]} — empty` : `Search ${CONTAINER_NAMES[c.kind].toLowerCase()}`, afford: !empty, full: empty, hold: true });
    }
    for (const [k, p] of this.packs.entries()) {
      const d = Math.hypot(P.x - p.x, P.z - p.z);
      consider(d, { kind: 'pack', idx: k, label: 'Pick up your pack', afford: true });
    }
    for (const b of W.beds) {
      const d = Math.hypot(P.x - (b.x + 0.5), P.z - (b.z + 0.5));
      consider(d, { kind: 'bed', label: this.night ? 'Sleep until morning' : 'Sleep (only at night)', afford: this.night, full: !this.night });
    }
    if (this.shelter) best = this.shelter.interactTarget(P, best, bd) || best;
    return best;
  }

  interact(P, t, dt, pressed) {
    const g = this.game;
    if (this.shelter && this.shelter.interact(P, t, dt, pressed)) return;
    if (t.kind === 'search') {
      if (t.full) return;
      P._searchT = (P._searchT || 0) + dt;
      P.searching = P._searchT / SEARCH_T;
      if (P._searchT < SEARCH_T) return;
      P._searchT = 0; P.searching = 0;
      const c = g.world.containers.find(k => k.id === t.id);
      const loot = this.looted.has(c.id) ? this.leftover.get(c.id) || [] : rollLoot(c.kind, g.rng, this.day);
      const left = take(P, loot);
      this.looted.set(c.id, this.day);
      this.leftover.set(c.id, left);
      this.mState.searched = (this.mState.searched || 0) + 1;
      this.mState.lootedIds ||= [];
      this.mState.lootedIds.push(c.id);
      g.ev({ e: 'loot', p: P.seat, items: loot.filter(l => !left.includes(l)).map(lootLabel), full: left.length > 0, kind: c.kind });
      return;
    }
    if (!pressed) return;
    if (t.kind === 'pack') {
      const pack = this.packs[t.idx];
      take(P, Object.entries(pack.inv).map(([item, n]) => ({ item, n })));
      this.packs.splice(t.idx, 1);
      g.ev({ e: 'loot', p: P.seat, items: ['Your pack'], kind: 'pack' });
    } else if (t.kind === 'bed') {
      if (!this.night) { g.ev({ e: 'denied', p: P.seat, quiet: true }); return; }
      const Z = g.zombies;
      for (let i = 0; i < Z.n; i++) {
        if (Z.isLive(i) && Z.state[i] !== ZS.WANDER && Math.hypot(Z.x[i] - P.x, Z.z[i] - P.z) < 25) { g.ev({ e: 'noSleep', p: P.seat }); return; }
      }
      if (this.time > DUSK) this._newDay();
      this.time = DAWN + 0.02;
      this._dawn();
      P.hp = P.maxHp;
      g.ev({ e: 'slept', p: P.seat, day: this.day });
      g.ev({ e: 'autosave' });
    } else if (t.kind === 'mission') {
      this._missionAction(P);
    }
  }

  useItem(P, item) {
    const g = this.game;
    if (!(P.inv[item] > 0)) return false;
    if (item === 'food') { if (P.hunger > 95) return false; P.hunger = Math.min(100, P.hunger + 35); }
    else if (item === 'water') { if (P.thirst > 95) return false; P.thirst = Math.min(100, P.thirst + 40); }
    else if (item === 'meds') { if (P.hp >= P.maxHp) return false; P.hp = Math.min(P.maxHp, P.hp + 60); }
    else return false;
    P.inv[item]--;
    g.ev({ e: 'used', p: P.seat, item });
    return true;
  }

  // A found gun goes into the current slot (or the empty second one).
  equipFound(P, k) {
    const f = P.found[k];
    if (!f) return false;
    if (f.gun) {
      const w = newWeapon(f.gun, false, f.tier);
      w.reserve = 0;
      if (P.weapons.length < 2) { P.weapons.push(w); P.cur = 1; } else P.weapons[P.cur] = w;
      P.act = 'raise'; P.actT = 0;
      this.game.ev({ e: 'weapon', p: P.seat, w: f.gun });
    } else if (f.att) {
      const W = WEAPONS[P.weapon.id];
      const A = f.att;
      if (!W) return false;
      P.weapon.att[this._attSlot(A)] = A;
      this.game.ev({ e: 'gunsmith', p: P.seat, att: A, n: 0 });
    }
    P.found.splice(k, 1);
    return true;
  }
  _attSlot(id) { return { reddot: 'optic', holo: 'optic', scope4: 'optic', extmag: 'mag', fastmag: 'mag', longbarrel: 'barrel', shortbarrel: 'barrel', tacstock: 'stock', nostock: 'stock', vgrip: 'grip', agrip: 'grip', suppressor: 'muzzle', compensator: 'muzzle', hollow: 'ammo', ap: 'ammo', incendiary: 'ammo' }[id]; }

  // ------------------------------------------------------------ missions
  currentMission() {
    if (this.mission < MISSIONS.length) return MISSIONS[this.mission];
    return this.repeatable || (this.repeatable = this._repeatable());
  }
  _repeatable() {
    const g = this.game;
    const zones = g.world.zones.filter(z => !this.zonesCleared.has(z.id));
    if (zones.length && g.rng() < 0.6) {
      const z = zones[Math.floor(g.rng() * zones.length)];
      return { id: 'rep-clear-' + z.id, title: 'Clean sweep', brief: `Clear the infected zone at ${z.name}.`, kind: 'clear', zoneId: z.id, reward: { xp: 600, items: { components: 4 } } };
    }
    const item = ['fuel', 'meds', 'food', 'metal'][Math.floor(g.rng() * 4)];
    return { id: 'rep-supply-' + item, title: 'Supply run', brief: `Bring 3 ${ITEMS[item].name.toLowerCase()} to the farmhouse radio.`, kind: 'deliver', poi: 'farm', need: { [item]: 3 }, reward: { xp: 500 } };
  }
  _zoneFor(M) {
    const W = this.game.world;
    if (M.zoneId != null) return W.zones.find(z => z.id === M.zoneId);
    const home = W.home;
    return W.zones.filter(z => W.regions[z.region].type === M.region)
      .sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z))[0];
  }
  missionTarget(M) {
    const W = this.game.world;
    if (M.poi) return W.pois[M.poi] ? { x: W.pois[M.poi].x, z: W.pois[M.poi].z, name: W.pois[M.poi].name } : null;
    if (M.kind === 'clear') { const z = this._zoneFor(M); return z ? { x: z.x, z: z.z, name: z.name } : null; }
    if (M.kind === 'search') { const r = W.regions.find(q => q.type === 'neighborhood'); return { x: r.x, z: r.z, name: r.name }; }
    return null;
  }
  missionProgress(M) {
    const P = this.game.players[0];
    if (M.kind === 'search') return `${Math.min(M.count, (this.mState.searched || 0))}/${M.count}`;
    if (M.kind === 'carry') return `${Math.min(M.count, P.inv[M.item] || 0)}/${M.count}`;
    if (M.kind === 'defend' && this.mState.defending) return `${Math.ceil(this.mState.defendT)}s`;
    if (M.kind === 'deliver') return Object.entries(M.need).map(([k, n]) => `${Math.min(n, P.inv[k] || 0)}/${n} ${ITEMS[k].name.toLowerCase()}`).join(' · ');
    return '';
  }
  _missions(dt) {
    const g = this.game, M = this.currentMission(), P = g.players[0];
    if (!M) return;
    let done = false;
    switch (M.kind) {
      case 'search': done = (this.mState.searched || 0) >= M.count; break;
      case 'carry': done = (P.inv[M.item] || 0) >= M.count; break;
      case 'loot': done = (this.mState.lootedIds || []).includes(g.world.pois[M.poi]?.container); break;
      case 'clear': { const z = this._zoneFor(M); done = !z || this.zonesCleared.has(z.id); break; }
      case 'night': done = !!this.mState.survivedNight && this.mState.nightArmed; if (this.night) this.mState.nightArmed = true; break;
      case 'defend':
        if (this.mState.defending) {
          this.mState.defendT -= dt;
          const poi = g.world.pois[M.poi];
          // Waves come at you while you hold.
          if (g.zombies.alive < Math.min(g.zcap, 14)) {
            const at = this._ringCell(P, 18, 30);
            if (at) this._spawnAt(g.rng() < 0.3 ? ZT.runner : ZT.walker, at[0], at[1], { aware: true, tag: -3 });
          }
          if (Math.hypot(P.x - poi.x, P.z - poi.z) > 18) { this.mState.defending = false; g.ev({ e: 'missionFail', title: M.title, why: 'You left the outpost' }); }
          else if (this.mState.defendT <= 0) done = true;
        }
        break;
    }
    if (done) this._complete(M);
  }
  _missionAction(P) {
    const g = this.game, M = this.currentMission();
    if (M.kind === 'radio') this._complete(M);
    else if (M.kind === 'defend' && !this.mState.defending) {
      this.mState.defending = true; this.mState.defendT = M.secs;
      g.ev({ e: 'missionNote', text: `Hold the outpost for ${M.secs} seconds!` });
    } else if (M.kind === 'deliver') {
      if (Object.entries(M.need).every(([k, n]) => (P.inv[k] || 0) >= n)) {
        for (const [k, n] of Object.entries(M.need)) P.inv[k] -= n;
        this._complete(M);
      } else g.ev({ e: 'missionNote', text: 'Not enough supplies yet' });
    }
  }
  _complete(M) {
    const g = this.game;
    for (const P of g.players) {
      P.xp += M.reward.xp || 0;
      take(P, [...Object.entries(M.reward.items || {}).map(([item, n]) => ({ item, n })),
        ...Object.entries(M.reward.ammo || {}).map(([ammo, n]) => ({ ammo, n }))]);
    }
    g.ev({ e: 'missionDone', title: M.title, xp: M.reward.xp, final: M.id === 'exodus' });
    this.mState = { lootedIds: this.mState.lootedIds };
    if (this.mission < MISSIONS.length) this.mission++;
    else this.repeatable = null;
  }

  // ---------------------------------------------------------------- save
  serialize() {
    const g = this.game, P = g.players[0];
    return {
      v: 1, mode: this.id, seed: this.seed, day: this.day, time: this.time, savedAt: Date.now(),
      pop: this.pop, looted: [...this.looted], leftover: [...this.leftover].filter(([, l]) => l.length),
      zones: [...this.zonesCleared], mission: this.mission, mState: this.mState,
      explored: Array.from(this.explored).join(''), packs: this.packs,
      hordes: this.hordes.map(H => ({ x: H.x, z: H.z, n: H.n, tx: H.tx, tz: H.tz })),
      player: {
        x: P.x, z: P.z, yaw: P.yaw, hp: P.hp, maxHp: P.maxHp, cur: P.cur, meleeId: P.meleeId,
        weapons: P.weapons.map(w => ({ id: w.id, tier: w.tier, att: w.att, mag: w.mag })),
        ammo: P.ammo, inv: P.inv, found: P.found, hunger: P.hunger, thirst: P.thirst,
        lethal: P.lethal, tactical: P.tactical, perks: [...P.perks], xpBanked: (P.xpBanked || 0) + P.xp,
      },
      shelter: this.shelter?.serialize() || null,
    };
  }
  load(s) {
    const g = this.game, P = g.players[0];
    Object.assign(this, { day: s.day, time: s.time, mission: s.mission, mState: s.mState || {} });
    if (s.pop?.length === this.pop.length) this.pop = s.pop;
    this.looted = new Map(s.looted || []);
    this.leftover = new Map(s.leftover || []);
    this.zonesCleared = new Set(s.zones || []);
    if (s.explored) for (let i = 0; i < Math.min(s.explored.length, this.explored.length); i++) this.explored[i] = s.explored.charCodeAt(i) === 49 ? 1 : 0;
    this.packs = s.packs || [];
    this.hordes = (s.hordes || []).map(H => ({ ...H, active: false }));
    const q = s.player;
    if (q) {
      Object.assign(P, { x: q.x, z: q.z, yaw: q.yaw, hp: q.hp, maxHp: q.maxHp || MAX_HP, meleeId: q.meleeId || 'knife',
        ammo: q.ammo, inv: q.inv, found: q.found || [], hunger: q.hunger, thirst: q.thirst, lethal: q.lethal, tactical: q.tactical });
      P.weapons = q.weapons.map(w => { const n = newWeapon(w.id, false, w.tier, w.att); n.mag = w.mag; n.reserve = 0; return n; });
      P.cur = Math.min(q.cur || 0, P.weapons.length - 1);
      P.perks = new Set(q.perks || []);
    }
    this.shelter?.load(s.shelter);
  }
}
