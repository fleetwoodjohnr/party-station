// Co-op over the Party Station server. One TV — the host's — runs the
// game; every other screen in the session renders snapshots of it and
// sends its own player's input. Movement and aim are predicted on the
// screen that owns the player (it sends its pose); the host resolves
// shots, damage, points, loot and building, so there is one truth.
// ~15 snapshots/s host → clients, ~30 inputs/s client → host, all relayed
// by server/lobby.js (which checks a screen only drives its own seats).
import { emptyInput } from './sim/player.js';
import { newWeapon } from './sim/weapons.js';
import { PIECES } from './sim/shelter.js';

// Buttons: held ones as-is, presses latched until the next send so a tap
// between packets is never lost.
const HELD = { fire: 1, ads: 2, x: 4 };
const EDGE = { firePressed: 8, jump: 16, crouch: 32, sprint: 64, xPressed: 128, swap: 256, melee: 512, lethal: 1024, tactical: 2048, heal: 4096 };
const r2 = v => Math.round(v * 100) / 100;

// Events the clients need to hear about (sounds, effects, HUD).
const FWD = new Set(['shot', 'hit', 'impact', 'board', 'repair', 'windup', 'hurt', 'boom', 'fire', 'splat', 'stun', 'throw', 'place', 'bounce',
  'spit', 'screamWindup', 'scream', 'charge', 'fuse', 'slamWindup', 'slam', 'boss', 'bossDown', 'points', 'buy', 'perk', 'door', 'denied',
  'crateRoll', 'crateOffer', 'crateGone', 'crateTaken', 'openForge', 'forged', 'gunsmith', 'trapOn', 'drop', 'power', 'powerEnd', 'secondwind',
  'weapon', 'swap', 'reload', 'reloaded', 'shell', 'knife', 'roundStart', 'roundEnd', 'victory', 'gameover', 'down', 'revived',
  'loot', 'used', 'zoneEnter', 'zoneCleared', 'horde', 'dusk', 'dawn', 'missionDone', 'missionNote', 'missionFail', 'respawn', 'slept', 'noSleep',
  'built', 'upgraded', 'repaired', 'buildDenied', 'destroyed', 'turret', 'turretDry', 'powerOut', 'fueled', 'shock', 'stashed', 'crafted', 'openBench',
  'raidSoon', 'raid', 'raidOver', 'vault', 'climb', 'xp']);

// ------------------------------------------------------------------ host
export class HostNet {
  constructor(game, send) {
    this.game = game;
    this.send = send;
    this.latest = new Map(); // seat -> last input packet
    this.edges = new Map();  // seat -> latched presses
    this.acts = [];
    this.t = 0;
    this.events = [];
    this.pieceSig = '';
    this.meta = null; // { kind, seed, run, standard } — tells clients what to load
  }

  onMsg(m) {
    if (m.t === 'relayInput') {
      this.latest.set(m.seat, m.d);
      this.edges.set(m.seat, (this.edges.get(m.seat) || 0) | (m.d.i & ~7));
    } else if (m.t === 'relayAct') this.acts.push({ seat: m.seat, d: m.d });
  }

  // The remote player's input for this step, with its predicted pose
  // applied first (they own their movement).
  inputFor(seat) {
    const P = this.game.players[seat];
    const d = this.latest.get(seat);
    const inp = emptyInput();
    if (!P || !d) return inp;
    P.remote = true;
    const [x, z, y, yaw, pitch, vx, vz, eye, crouch, sprint] = d.p;
    // Trust, but not blindly: a pose more than a few metres from where the
    // host has them (respawn, revive, knockback) is ignored for a beat.
    if (Math.hypot(x - P.x, z - P.z) < 4 || P._poseReset > 1) { P.x = x; P.z = z; P._poseReset = 0; } else P._poseReset = (P._poseReset || 0) + 0.033;
    P.y = P.onTower ? P.y : y; P.yaw = yaw; P.pitch = pitch; P.vx = vx; P.vz = vz; P.eye = eye;
    P.crouched = !!crouch; P.sprinting = !!sprint;
    P.speedFrac = Math.min(1, Math.hypot(vx, vz) / 6.1);
    const bits = d.i | (this.edges.get(seat) || 0);
    this.edges.set(seat, 0);
    for (const [k, b] of Object.entries(HELD)) inp[k] = !!(bits & b);
    for (const [k, b] of Object.entries(EDGE)) inp[k] = !!(bits & b);
    inp.assist = 'off'; // already applied to the pose on their screen
    return inp;
  }

  // Menu-ish actions from remote players (Forge, workbench, building…).
  drainActs(apply) { for (const a of this.acts.splice(0)) apply(a.seat, a.d); }

  collect(events) { for (const e of events) if (FWD.has(e.e)) this.events.push(e); }

  tick(dt) {
    this.t += dt;
    if (this.t < 1 / 15) return;
    this.t = 0;
    this.send('relayState', -1, this.snapshot());
    this.events = [];
  }

  snapshot() {
    const g = this.game, Z = g.zombies, M = g.mode;
    const players = g.players.map(P => ({
      x: r2(P.x), z: r2(P.z), y: r2(P.y), yaw: r2(P.yaw), pitch: r2(P.pitch), hp: Math.round(P.hp), maxHp: P.maxHp,
      down: P.down ? 1 : 0, downT: r2(P.downT), dead: P.dead ? 1 : 0, cur: P.cur, act: P.act, actT: r2(P.actT), ads: r2(P.ads),
      eye: r2(P.eye), crouch: P.crouched ? 1 : 0, sf: r2(P.speedFrac), sp: r2(P.stepPhase), kick: r2(P.kick),
      w: P.weapons.map(w => [w.id, w.tier, w.att, w.mag, w.reserve]), pts: P.points, kills: P.kills, heads: P.heads, xp: P.xp,
      perks: [...P.perks], lethal: P.lethal, tactical: P.tactical, melee: P.meleeId,
      ammo: P.ammo, inv: P.inv, found: P.found, hunger: P.hunger, thirst: P.thirst, searching: r2(P.searching || 0), tower: P.onTower ? P.onTower.id : -1,
    }));
    const z = [];
    for (let i = 0; i < Z.n; i++) {
      if (Z.state[i] === 0) continue;
      z.push([i, Z.type[i], Z.state[i], r2(Z.x[i]), r2(Z.z[i]), r2(Z.y[i]), r2(Z.yaw[i]), r2(Z.walk[i]), r2(Z.flinch[i]), r2(Z.t[i]),
        Z.helmet[i] > 0 ? 1 : 0, Z.vest[i] > 0 ? 1 : 0, Z.headKill[i], Z.burnT[i] > 0 ? 1 : 0, Z.seed[i], Math.round(Z.hp[i]), Math.round(Z.maxHp[i])]);
    }
    const W = g.world;
    const snap = { meta: this.meta, t: r2(g.time), players, z, ev: this.events,
      w: { b: W.windows.map(w => w.boards), d: Object.values(W.doors).filter(d => d.open).map(d => d.id), tr: W.traps.map(t => [r2(t.active), r2(t.cool)]) },
      eq: { pr: g.equipment.projectiles.map(p => [p.kind, r2(p.x), r2(p.y), r2(p.z), r2(p.t)]),
        ar: g.equipment.areas.map(a => [a.kind, r2(a.x), r2(a.z), a.r, r2(a.t), a.dur]), cl: g.equipment.claymores.map(c => [r2(c.x), r2(c.z), r2(c.yaw)]) },
      inst: g.instakill ? 1 : 0, pm: g.pointsMul };
    if (M.id === 'classic') {
      snap.m = { round: M.round, phase: M.phase, timer: r2(M.timer), toSpawn: M.toSpawn, boss: M.boss, bossPending: M.bossPending,
        timed: M.timed, drops: M.drops.map(d => ({ kind: d.kind, x: r2(d.x), z: r2(d.z), t: r2(d.t) })), crate: M.crate };
    } else {
      snap.m = { day: M.day, time: r2(M.time * 1000) / 1000, mission: M.mission, mState: { searched: M.mState.searched, defending: M.mState.defending, defendT: M.mState.defendT },
        zc: [...M.zonesCleared], looted: M.looted.size, packs: M.packs };
      if (M.shelter) {
        const Sh = M.shelter;
        const sig = Sh.pieces.map(p => (p ? `${p.id}:${p.tier}:${Math.round(p.hp / 20)}` : '')).join(',');
        snap.m.sh = { stash: Sh.stash, stashAmmo: Sh.stashAmmo, tech: Sh.tech, fuel: r2(Sh.fuel), power: Sh.power, raid: Sh.raid && { started: Sh.raid.started, n: Sh.raid.n } };
        if (sig !== this.pieceSig || Math.random() < 0.05) {
          this.pieceSig = sig;
          snap.m.sh.pieces = Sh.pieces.filter(Boolean).map(p => [p.id, p.type, p.x, p.z, p.rot, p.tier, Math.round(p.hp), p.maxHp, r2(p.yaw || 0), p.powered ? 1 : 0]);
        }
      }
    }
    return snap;
  }
}

// Host side of the menu actions (a client sends these instead of calling).
export function applyAct(game, P, d) {
  const M = game.mode, Sh = M.shelter;
  switch (d.a) {
    case 'forge': return !!M.forgeUpgrade?.(P);
    case 'gunsmith': return !!M.gunsmith?.(P, d.slot, d.att);
    case 'craft': return !!Sh?.craft(d.id, P);
    case 'craftAtt': return !!Sh?.craftAttachment(d.id, P, d.xp);
    case 'place': return !!Sh?.place(d.type, d.x, d.z, d.rot);
    case 'improve': return !!Sh?.improve(d.sid);
    case 'demolish': Sh?.demolish(d.sid); return true;
    case 'use': return !!M.useItem?.(P, d.item);
    case 'equip': return !!M.equipFound?.(P, d.k);
  }
  return false;
}

// ---------------------------------------------------------------- client
export class ClientNet {
  constructor(game, seat, send) {
    this.game = game;
    this.seat = seat;
    this.send = send;
    this.snaps = [];   // [{at, s}] newest last
    this.t = 0;
    this.edges = 0;
    this.pending = []; // host events not yet handled
    // A client never changes the world itself: its interactions, throws
    // and hits go to the host, who answers in the next snapshot.
    game.mode.interact = () => {};
    game.equipment.throwFrom = () => false;
    game.zombies.damage = (i, amt, head) => { game.zombies.flinch[i] = 1; return { kill: false, armor: null, predicted: true, head }; };
  }

  onMsg(m) {
    if (m.t !== 'relayState') return;
    this.snaps.push({ at: performance.now(), s: m.d });
    if (this.snaps.length > 3) this.snaps.shift();
    this.pending.push(...m.d.ev);
  }
  get ready() { return this.snaps.length > 0; }

  // Interpolate ~100 ms in the past between the two snapshots around it.
  apply(now) {
    if (!this.snaps.length) return;
    const g = this.game, Z = g.zombies, rt = now - 100;
    let a = this.snaps[0], b = this.snaps.at(-1);
    for (let k = 0; k < this.snaps.length - 1; k++) if (this.snaps[k + 1].at >= rt) { a = this.snaps[k]; b = this.snaps[k + 1]; break; }
    const f = b.at > a.at ? Math.max(0, Math.min(1, (rt - a.at) / (b.at - a.at))) : 1;
    const S = b.s;
    const lerp = (x, y) => x + (y - x) * f;
    const ang = (x, y) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * f;
    // Zombies.
    const prev = new Map(a.s.z.map(r => [r[0], r]));
    Z.state.fill(0);
    Z.alive = 0;
    for (const r of S.z) {
      const [i, type, state, x, z, y, yaw, walk, flinch, t, helm, vest, headKill, burn, seed, hp, maxHp] = r;
      const p = prev.get(i) || r;
      Z.type[i] = type; Z.state[i] = state;
      Z.x[i] = lerp(p[3], x); Z.z[i] = lerp(p[4], z); Z.y[i] = lerp(p[5], y); Z.yaw[i] = ang(p[6], yaw);
      Z.walk[i] = lerp(p[7], walk); Z.flinch[i] = Math.max(Z.flinch[i] * 0.9, flinch); Z.t[i] = t;
      Z.helmet[i] = helm; Z.vest[i] = vest; Z.headKill[i] = headKill; Z.burnT[i] = burn; Z.seed[i] = seed;
      Z.hp[i] = hp; Z.maxHp[i] = maxHp;
      if (state !== 6) Z.alive++;
    }
    // Players: teammates interpolated; ours keeps its own motion.
    S.players.forEach((q, k) => {
      const P = g.players[k], qa = a.s.players[k] || q;
      if (!P) return;
      if (k !== this.seat) {
        P.x = lerp(qa.x, q.x); P.z = lerp(qa.z, q.z); P.y = lerp(qa.y, q.y); P.yaw = ang(qa.yaw, q.yaw); P.pitch = lerp(qa.pitch, q.pitch);
        P.eye = q.eye; P.crouched = !!q.crouch; P.speedFrac = q.sf; P.stepPhase = q.sp; P.kick = q.kick; P.ads = q.ads;
        P.act = q.act; P.actT = q.actT;
      } else if (Math.hypot(q.x - P.x, q.z - P.z) > 4) { P.x = q.x; P.z = q.z; } // respawned / revived elsewhere
      P.hp = q.hp; P.maxHp = q.maxHp; P.down = !!q.down; P.downT = q.downT; P.dead = !!q.dead;
      P.points = q.pts; P.kills = q.kills; P.heads = q.heads; P.xp = q.xp;
      P.perks = new Set(q.perks); P.lethal = q.lethal; P.tactical = q.tactical; P.meleeId = q.melee;
      P.ammo = q.ammo; P.inv = q.inv; P.found = q.found || []; P.hunger = q.hunger; P.thirst = q.thirst; P.searching = q.searching;
      // Weapons: rebuild only on change (statsOf caches per instance).
      const key = JSON.stringify(q.w.map(w => [w[0], w[1], w[2]]));
      if (P._wkey !== key) {
        P._wkey = key;
        P.weapons = q.w.map(([id, tier, att]) => newWeapon(id, false, tier, att));
      }
      q.w.forEach((w, j) => { if (P.weapons[j]) { P.weapons[j].mag = w[3]; P.weapons[j].reserve = w[4]; } });
      if (k !== this.seat || P.weapons.length <= P.cur) P.cur = q.cur;
    });
    // World and mode.
    const W = g.world;
    S.w.b.forEach((n, i) => { if (W.windows[i]) W.setBoards(i, n); });
    for (const d of Object.values(W.doors)) { const open = S.w.d.includes(d.id); if (open !== d.open) { d.open = open; W.version++; } }
    S.w.tr.forEach(([act, cool], i) => { if (W.traps[i]) { W.traps[i].active = act; W.traps[i].cool = cool; } });
    const E = g.equipment;
    E.projectiles = S.eq.pr.map(([kind, x, y, z, t]) => ({ kind, x, y, z, t }));
    E.areas = S.eq.ar.map(([kind, x, z, r, t, dur]) => ({ kind, x, z, r, t, dur }));
    E.claymores = S.eq.cl.map(([x, z, yaw]) => ({ x, z, yaw }));
    g.instakill = !!S.inst; g.pointsMul = S.pm;
    const M = g.mode;
    if (M.id === 'classic') Object.assign(M, S.m);
    else {
      Object.assign(M, { day: S.m.day, time: S.m.time, mission: S.m.mission, packs: S.m.packs });
      Object.assign(M.mState, S.m.mState);
      M.zonesCleared = new Set(S.m.zc);
      if (M.shelter && S.m.sh) {
        const Sh = M.shelter;
        Object.assign(Sh, { stash: S.m.sh.stash, stashAmmo: S.m.sh.stashAmmo, tech: S.m.sh.tech, fuel: S.m.sh.fuel, power: S.m.sh.power });
        Sh.raid = S.m.sh.raid;
        if (S.m.sh.pieces) this._pieces(S.m.sh.pieces);
      }
    }
    g.time = S.t;
  }

  _pieces(list) {
    const Sh = this.game.mode.shelter, W = this.game.world;
    const want = new Map(list.map(r => [r[0], r]));
    for (const p of Sh.pieces) if (p && !want.has(p.id)) { Sh.pieces[p.id] = undefined; W.setStruct(p.x, p.z, null); }
    for (const [id, type, x, z, rot, tier, hp, maxHp, yaw, powered] of list) {
      let p = Sh.pieces[id];
      if (!p) { p = { id, type, def: PIECES[type], x, z, rot, cd: 0 }; Sh.pieces[id] = p; W.setStruct(x, z, p); }
      Object.assign(p, { tier, hp, maxHp, yaw, powered: !!powered });
    }
  }

  // Our input + pose to the host, ~30/s; presses latched in between.
  sendInput(inp, P, dt) {
    for (const [k, b] of Object.entries(EDGE)) if (inp[k]) this.edges |= b;
    this.t += dt;
    if (this.t < 1 / 30) return;
    this.t = 0;
    let bits = this.edges;
    for (const [k, b] of Object.entries(HELD)) if (inp[k]) bits |= b;
    this.edges = 0;
    this.send('relayInput', this.seat, { i: bits, p: [r2(P.x), r2(P.z), r2(P.y), r2(P.yaw), r2(P.pitch), r2(P.vx), r2(P.vz), r2(P.eye), P.crouched ? 1 : 0, P.sprinting ? 1 : 0] });
  }
  act(d) { this.send('relayAct', this.seat, d); }

  // Host events for the presentation layer. Our own shots (and their
  // misses) were already shown when we pulled the trigger.
  drainEvents() {
    const out = this.pending.filter(e => !(e.p === this.seat && (e.e === 'shot' || e.e === 'impact' || (e.e === 'hit' && !e.kill))));
    this.pending = [];
    return out;
  }
}
