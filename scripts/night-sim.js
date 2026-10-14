// Headless checks for Dead of Night's simulation (public/js/night/sim) —
// no browser, no three.js. Run: node scripts/night-sim.js
import assert from 'assert/strict';
import { World, C } from '../public/js/night/sim/world.js';
import { DINER } from '../public/js/night/sim/maps.js';
import { Zombies, ZT } from '../public/js/night/sim/zombies.js';
import { Game } from '../public/js/night/sim/game.js';
import { emptyInput } from '../public/js/night/sim/player.js';
import { botInput } from '../public/js/night/sim/bot.js';
import { WEAPONS, falloff, newWeapon, statsOf, RARITY } from '../public/js/night/sim/weapons.js';
import { zombieHp, roundTotal, WIN_ROUND, rankOf, xpForRank } from '../public/js/night/sim/classic.js';
import { ZTYPES, S as ZS } from '../public/js/night/sim/zombies.js';
import { generateWorld } from '../public/js/night/sim/regions.js';
import { DAY_SECS, MISSIONS } from '../public/js/night/sim/survival.js';
import { PIECES as PIECESx } from '../public/js/night/sim/shelter.js';

let passed = 0;
const ok = label => { passed++; console.log(`✓ ${label}`); };
const DT = 1 / 30;

// --- map --------------------------------------------------------------
{
  const w = new World(DINER);
  assert.ok(w.windows.length >= 6 && w.spawns.length >= 6 && w.starts.length >= 1);
  const f = w.flow([w.starts[0]]);
  for (const [x, z] of w.spawns) assert.notEqual(f.dist[w.idx(x, z)], 0xffffffff, `spawn ${x},${z} unreachable`);
  for (const W of w.windows) assert.notEqual(f.dist[w.idx(W.out[0], W.out[1])], 0xffffffff);
  // Every interior floor cell is reachable by the player once doors open.
  for (const d of Object.values(w.doors)) w.openDoor(d.id);
  const g = w.flow([w.starts[0]]);
  for (let z = 0; z < w.h; z++) for (let x = 0; x < w.w; x++) {
    if (w.cell(x, z) === C.FLOOR) assert.notEqual(g.dist[w.idx(x, z)], 0xffffffff, `floor ${x},${z} unreachable`);
  }
  // Bullets: through a window gap, not through a wall.
  const W0 = w.windows[0];
  const ix = W0.in[0] + 0.5, iz = W0.in[1] + 0.5, dx = W0.out[0] - W0.in[0], dz = W0.out[1] - W0.in[1];
  assert.equal(w.raycast(ix, 1.5, iz, dx, 0, dz, 3), null, 'window gap should let bullets through');
  assert.ok(w.raycast(ix, 0.5, iz, dx, 0, dz, 3), 'sill should stop a low shot');
  ok(`${DINER.name}: ${w.windows.length} windows, ${w.spawns.length} spawns, every spawn and room reachable`);
}

// --- weapons ------------------------------------------------------------
{
  const hp1 = zombieHp(1);
  const P = WEAPONS.pistol;
  assert.equal(Math.ceil(hp1 / (P.dmg * falloff(P, 5))), 4, 'pistol: 4 body shots on round 1');
  assert.equal(Math.ceil(hp1 / (P.dmg * P.head)), 2, 'pistol: 2 headshots on round 1');
  const S = WEAPONS.shotgun;
  assert.ok(S.dmg * S.pellets * falloff(S, 3) >= zombieHp(4), 'shotgun point-blank one-shots through round 4');
  assert.ok(roundTotal(2) > roundTotal(1) && zombieHp(12) > zombieHp(11));
  ok('weapon damage bands: pistol 4 body / 2 head on round 1, shotgun one-shots early rounds');
}

// --- an idle survivor gets found ----------------------------------------
{
  const game = new Game({ world: new World(DINER), seed: 3 });
  let over = null, hurt = 0;
  for (let t = 0; t < 240 && !over; t += DT) {
    game.step(DT, [emptyInput()]);
    for (const e of game.drain()) { if (e.e === 'gameover') over = e; if (e.e === 'hurt') hurt++; }
  }
  assert.ok(hurt > 0, 'zombies never reached the player');
  assert.ok(over, 'standing still never ended the game');
  ok(`idle survivor overrun after ${hurt} hits (round ${over.round}) — zombies breach windows and path in`);
}

// --- economy: doors, wall-buys, ammo, repairs ----------------------------
{
  const game = new Game({ world: new World(DINER), seed: 5 });
  const P = game.players[0];
  P.points = 3000;
  const door = Object.values(game.world.doors)[0];
  const [dx, dz] = door.cells[0];
  P.x = dx - 0.5; P.z = dz + 0.5; // stand beside the door
  const press = () => { const i = emptyInput(); i.xPressed = true; i.x = true; game.step(DT, [i]); game.step(DT, [emptyInput()]); };
  press();
  assert.ok(door.open, 'door did not open');
  assert.equal(P.points, 3000 - door.cost);
  const b = game.world.wallbuys.find(w => w.weapon === 'smg');
  P.x = b.x + 0.5 + b.face[0]; P.z = b.y + 0.5 + b.face[1];
  press();
  assert.equal(P.weapon.id, 'smg', 'wall-buy did not hand over the SMG');
  P.weapon.reserve = 0;
  press();
  assert.equal(P.weapon.reserve, WEAPONS.smg.reserve, 'ammo refill failed');
  // Board repair: break a window, hold X beside it.
  const W0 = game.world.windows[0];
  game.world.setBoards(0, 2);
  P.x = W0.in[0] + 0.5; P.z = W0.in[1] + 0.5;
  const before = P.points;
  for (let t = 0; t < 3; t += DT) { const i = emptyInput(); i.x = true; game.step(DT, [i]); }
  assert.ok(W0.boards > 2 && P.points > before, 'holding X did not rebuild boards for points');
  ok(`economy: door −${door.cost}, SMG wall-buy, ammo refill, board repair +${P.points - before} pts`);
}

// --- the autopilot survives the opening rounds ---------------------------
let botResult;
{
  const game = new Game({ world: new World(DINER), seed: 11 });
  const P = game.players[0];
  const home = [P.x, P.z];
  let t = 0;
  for (; t < 900 && game.mode.round < 4 && !P.down; t += DT) {
    game.step(DT, [botInput(game, P, home)]);
    game.drain();
  }
  assert.ok(!P.down, `bot went down on round ${game.mode.round}`);
  assert.ok(game.mode.round >= 4, `bot stalled on round ${game.mode.round} (${game.zombies.alive} alive, ${game.mode.toSpawn} queued)`);
  botResult = { round: game.mode.round, kills: P.kills, heads: P.heads, points: P.points, weapon: P.weapon.id, t };
  ok(`autopilot cleared rounds 1–3 in ${Math.round(t)}s sim time: ${P.kills} kills, ${P.heads} headshots, ${P.points} pts, holding ${P.weapon.id}`);
}

// --- determinism (co-op replays and tests depend on it) ------------------
{
  const run = () => {
    const game = new Game({ world: new World(DINER), seed: 11 });
    const P = game.players[0];
    const home = [P.x, P.z];
    for (let t = 0; t < 120; t += DT) { game.step(DT, [botInput(game, P, home)]); game.drain(); }
    return JSON.stringify([P.x.toFixed(4), P.kills, P.points, game.mode.round, game.zombies.alive]);
  };
  assert.equal(run(), run());
  ok('same seed, same inputs -> same match');
}

// --- sim cost with a full horde -----------------------------------------
{
  const game = new Game({ world: new World(DINER), seed: 2 });
  game.mode.phase = 'over'; // no director; place the horde by hand
  for (let k = 0; k < 28; k++) {
    const [x, z] = game.world.spawns[k % game.world.spawns.length];
    game.zombies.spawn(k % 3 ? ZT.walker : ZT.runner, x + 0.5, z + 0.5, 1e6, 1.2, k / 28);
  }
  game.world.windows.forEach((_, i) => game.world.setBoards(i, 0));
  const P = game.players[0];
  P.god = true;
  const t0 = performance.now();
  const N = 900;
  for (let k = 0; k < N; k++) { game.step(DT, [emptyInput()]); game.drain(); }
  const ms = (performance.now() - t0) / N;
  assert.ok(ms < 2, `sim step too slow: ${ms.toFixed(3)} ms`);
  ok(`sim step with 28 zombies: ${ms.toFixed(3)} ms on this machine (Pi 4 ≈ 5–8× slower)`);
}

// ---------------------------------------------------------------- phase 3
const fresh = (seed = 21, modeOpts = {}) => {
  const game = new Game({ world: new World(DINER), seed, modeOpts });
  game.mode.phase = 'between'; game.mode.timer = 999; // director idle unless a test wants it
  return game;
};
const at = (P, x, z) => { P.x = x; P.z = z; };
const pressX = game => { const i = emptyInput(); i.xPressed = true; i.x = true; game.step(DT, [i]); game.step(DT, [emptyInput()]); };
const run = (game, secs, inp = () => emptyInput()) => { for (let t = 0; t < secs; t += DT) game.step(DT, [inp()]); };
const evs = game => game.drain();

{ // perks, crate, Forge, gunsmith rank gate
  const game = fresh(), P = game.players[0], W = game.world;
  P.points = 50000;
  const m = W.machines.find(k => k.perk === 'ironhide');
  for (const d of Object.values(W.doors)) W.openDoor(d.id);
  at(P, m.x + 0.5, m.y + 1.5); pressX(game);
  assert.ok(P.perks.has('ironhide') && P.maxHp === 250, 'Iron Hide not applied');
  const crate = W.machines.find(k => k.kind === 'crate');
  at(P, crate.x + 0.5, crate.y + 1.5); pressX(game);
  assert.equal(game.mode.crate.state, 'rolling');
  run(game, 3.2);
  assert.equal(game.mode.crate.state, 'offer');
  const offered = game.mode.crate.weapon;
  pressX(game);
  assert.ok(P.weapons.some(w => w.id === offered), 'crate weapon not taken');
  P.cur = P.weapons.findIndex(w => w.id === offered);
  const tier0 = P.weapon.tier;
  if (tier0 < RARITY.length - 1) { assert.ok(game.mode.forgeUpgrade(P)); assert.equal(P.weapon.tier, tier0 + 1); }
  const tier1 = P.weapon.tier;
  P.cur = 0; // pistol
  game.mode.rank = 1;
  assert.ok(!game.mode.gunsmith(P, 'muzzle', 'suppressor'), 'rank-5 attachment allowed at rank 1');
  assert.ok(game.mode.gunsmith(P, 'mag', 'extmag'), 'extended mag refused');
  assert.equal(statsOf(P.weapon, P.perks).mag, 12, 'extended mag should give 12 rounds');
  ok(`perks, crate (${offered}), Forge tier ${tier0}→${tier1}, gunsmith gated by rank`);
}

{ // trap, frag, noisemaker decoy
  const game = fresh(), P = game.players[0], W = game.world, Z = game.zombies;
  P.points = 5000;
  W.openDoor(1);
  const tr = W.traps[0];
  at(P, tr.lever.x + 0.5 + tr.lever.face[0] * 0.8, tr.lever.y + 0.5 + tr.lever.face[1] * 0.8);
  pressX(game);
  assert.ok(tr.active > 0, 'trap did not switch on');
  const zi = Z.spawn(ZT.walker, tr.cells[0][0] + 0.5, tr.cells[0][1] + 0.5, 500, 1);
  Z.state[zi] = ZS.CHASE; Z.y[zi] = 0;
  run(game, 0.3);
  assert.ok(!Z.isLive(zi), 'trap did not kill');
  // Frag at the feet of three zombies.
  at(P, 20.5, 17.5);
  const ids = [0, 1, 2].map(k => { const i = Z.spawn(ZT.walker, 24 + k * 0.5, 17.5, 150, 0.01); Z.state[i] = ZS.CHASE; Z.y[i] = 0; return i; });
  game.explode(24.5, 0.3, 17.5, 4.5, 420, 0, 'frag');
  assert.ok(ids.every(i => !Z.isLive(i)), 'frag left survivors');
  // Noisemaker: zombies chase it instead of the player.
  P.tactical = { id: 'noisemaker', n: 1 };
  P.yaw = Math.PI / 2; P.pitch = 0.2; // throw west
  const i2 = emptyInput(); i2.tactical = true; game.step(DT, [i2]);
  run(game, 2);
  assert.equal(game.equipment.decoys.length, 1, 'noisemaker never became a decoy');
  assert.equal(game.targets(), game.equipment.decoys);
  run(game, 6);
  assert.equal(game.equipment.decoys.length, 0, 'noisemaker never went off');
  ok('electric trap kills, frag clears a cluster, noisemaker pulls the horde then detonates');
}

{ // armour, AP, penetration, burst
  const game = fresh(), P = game.players[0], Z = game.zombies;
  const a = Z.spawn(ZT.armored, 25, 17.5, 500, 0.01);
  const plain = Z.damage(a, 100, true).kill;
  assert.ok(!plain && Z.hp[a] > 400, 'helmet did not soak a headshot');
  const b = Z.spawn(ZT.armored, 26, 17.5, 500, 0.01);
  Z.damage(b, 100, true, -1, 'gun', 2);
  assert.ok(Z.hp[b] <= 400, 'AP did not pierce');
  Z.clear();
  // Sniper through two zombies in a line.
  at(P, 13.5, 17.5); P.yaw = -Math.PI / 2; P.pitch = 0; // look east (+x)
  P.weapons = [newWeapon('sniper', true)]; P.cur = 0; P.act = 'idle';
  const z1 = Z.spawn(ZT.walker, 16.5, 17.5, 5000, 0.01), z2 = Z.spawn(ZT.walker, 18.5, 17.5, 5000, 0.01);
  for (const i of [z1, z2]) { Z.state[i] = ZS.CHASE; Z.y[i] = 0; Z.yaw[i] = 0; }
  P.ads = 1;
  const f = emptyInput(); f.firePressed = true; f.fire = true; f.ads = true; f.assist = 'off';
  game.step(DT, [f]);
  assert.ok(Z.hp[z1] < 5000 && Z.hp[z2] < 5000, 'sniper round did not penetrate');
  // Burst rifle: one pull, three rounds.
  P.weapons = [newWeapon('br', true)]; P.cur = 0; P.act = 'idle'; P.fireCd = 0;
  const shots = P.shots;
  game.step(DT, [f]);
  run(game, 0.5, () => { const i = emptyInput(); i.ads = true; i.assist = 'off'; return i; });
  assert.equal(P.shots - shots, 3, 'burst fired ' + (P.shots - shots));
  ok('helmets soak, AP pierces, the Longbow goes through two, the Bulldog fires 3-round bursts');
}

{ // specials do their thing
  const game = fresh(), P = game.players[0], Z = game.zombies;
  P.god = true; at(P, 20.5, 17.5);
  const mk = (type, x, z) => { const i = Z.spawn(ZT[type], x, z, 1e5, ZTYPES[ZT[type]].speed[0]); Z.state[i] = ZS.CHASE; Z.y[i] = 0; Z.cd2[i] = 0; return i; };
  mk('spitter', 28.5, 17.5); mk('brute', 26.5, 14.5); mk('screamer', 14.5, 14.5);
  const seen = new Set();
  for (let t = 0; t < 10; t += DT) { game.step(DT, [emptyInput()]); for (const e of game.drain()) seen.add(e.e); }
  for (const e of ['spit', 'charge', 'scream']) assert.ok(seen.has(e), `no ${e}`);
  Z.clear();
  at(P, 20.5, 17.5); P.vx = P.vz = 0; // the brute's charge shoved us
  const ex = mk('exploder', 21.5, 17.5);
  let boom = false;
  for (let t = 0; t < 4 && !boom; t += DT) { game.step(DT, [emptyInput()]); boom = game.drain().some(e => e.e === 'boom' && e.kind === 'exploder'); }
  assert.ok(boom && !Z.isLive(ex), 'exploder never blew');
  ok('spitter spits, brute charges, screamer screams, exploder detonates at your feet');
}

{ // boss round
  const game = new Game({ world: new World(DINER), seed: 4, modeOpts: { startRound: 10 } });
  const P = game.players[0]; P.god = true;
  run(game, 12);
  const bi = game.mode.boss;
  assert.ok(bi >= 0 && ZTYPES[game.zombies.type[bi]].id === 'warden', 'no Warden on round 10');
  const pts = P.points;
  game.zombies.damage(bi, 1e9, false, 0, 'gun');
  game.step(DT, [emptyInput()]);
  assert.ok(P.points >= pts + 1000 && game.mode.drops.some(d => d.kind === 'maxammo'), 'boss kill paid nothing');
  ok('round 10 brings the Warden; killing it pays 1000 and drops Max Ammo');
}

{ // power-ups, Second Wind, standard victory, ranks
  const game = fresh(), P = game.players[0], W = game.world;
  P.weapon.reserve = 0;
  game.mode._drop('maxammo', P.x, P.z);
  game.step(DT, [emptyInput()]);
  assert.ok(P.weapon.reserve > 0, 'max ammo not applied');
  W.setBoards(0, 0); game.mode._drop('carpenter', P.x, P.z); game.step(DT, [emptyInput()]);
  assert.equal(W.windows[0].boards, 6);
  P.addPerk('secondwind');
  P.hurt(1000, game);
  run(game, 3.5);
  assert.ok(!P.down && !P.perks.has('secondwind'), 'Second Wind did not revive');
  const g2 = new Game({ world: new World(DINER), seed: 5, modeOpts: { startRound: WIN_ROUND, standard: true } });
  g2.mode.phase = 'wave'; g2.mode.round = WIN_ROUND; g2.mode.toSpawn = 0;
  g2.step(DT, [emptyInput()]);
  assert.ok(g2.drain().some(e => e.e === 'victory'), 'no victory at round 30');
  assert.equal(rankOf(0), 1); assert.equal(rankOf(xpForRank(5)), 5); assert.equal(rankOf(xpForRank(5) - 1), 4);
  ok('Max Ammo and Carpenter work, Second Wind revives once, Standard ends at round 30, ranks add up');
}

// ---------------------------------------------------------------- phase 4
{ // world generation
  const a = generateWorld(9), b = generateWorld(9), c = generateWorld(10);
  const sum = d => d.cells.reduce((s, v, i) => (s + v * (i % 97 + 1)) % 1000003, 0);
  assert.equal(sum(a), sum(b), 'same seed, different county');
  assert.notEqual(sum(a), sum(c));
  const w = new World(a);
  const full = w.flow([w.starts[0]]);
  const reach = (x, z) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => full.dist[w.idx(Math.floor(x) + dx, Math.floor(z) + dz)] !== 0xffffffff);
  for (const [k, p] of Object.entries(a.pois)) assert.ok(reach(p.x, p.z), `POI ${k} unreachable`);
  const bad = a.containers.filter(c => !reach(c.x + 0.5, c.z + 0.5)).length;
  assert.ok(bad <= a.containers.length * 0.02, `${bad} containers unreachable`);
  for (const M of MISSIONS) if (M.poi) assert.ok(a.pois[M.poi], `mission ${M.id} has no ${M.poi}`);
  ok(`Hollis County: ${a.w}×${a.h} m, ${a.containers.length} containers, ${a.zones.length} infected zones, ${Object.keys(a.pois).length} named places, deterministic`);
}

const owGame = (seed = 9, save = null) => new Game({ world: new World(generateWorld(seed)), mode: 'world', seed, modeOpts: { seed, save } });

{ // the local horde: spawns out of sight, capped, returns home when left
  const game = owGame(), P = game.players[0], Z = game.zombies, M = game.mode;
  game.zcap = 20;
  // Walk to Main Street (busy) and stand there a while.
  const town = game.world.regions.find(r => r.type === 'town');
  P.x = town.x + 0.5; P.z = town.z + 4.5; P.god = true;
  run(game, 25);
  assert.ok(Z.alive > 4 && Z.alive <= 20, `ambient count ${Z.alive}`);
  const near = M._nearRegions(P).map(r => r.id);
  const popBefore = near.reduce((a, id) => a + M.pop[id], 0);
  // Teleport far away: what was around town goes back to town.
  const far = game.world.regions.find(r => r.rx === 0 && r.rz === 5);
  P.x = far.x; P.z = far.z;
  run(game, 3);
  const popAfter = near.reduce((a, id) => a + M.pop[id], 0);
  assert.ok(popAfter > popBefore, 'despawned zombies did not return to their regions');
  ok(`ambient zombies capped at 20; walking away returned ${popAfter - popBefore} of them to Main Street's population`);
}

{ // loot, mission 1, noise, sleep, save/load
  const game = owGame(), P = game.players[0], W = game.world, M = game.mode;
  P.god = true;
  // Search three containers.
  const near = W.containers.slice().sort((a, b) => Math.hypot(a.x - P.x, a.z - P.z) - Math.hypot(b.x - P.x, b.z - P.z));
  let searched = 0;
  for (const c of near) {
    if (searched >= 3) break;
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dz]) => W.open(c.x + dx, c.z + dz));
    if (!spot) continue;
    P.x = c.x + spot[0] + 0.5; P.z = c.z + spot[1] + 0.5;
    const before = M.mState.searched || 0;
    for (let t = 0; t < 1.2; t += DT) { const i = emptyInput(); i.x = true; game.step(DT, [i]); }
    if ((M.mState.searched || 0) > before) searched++;
  }
  run(game, 1);
  assert.equal(searched, 3, 'could not search 3 containers');
  assert.ok(M.mission >= 1, 'Stock up did not complete');
  // Gunfire wakes a wandering zombie 20 m away.
  const zi = game.zombies.spawn(ZT.walker, P.x + 20, P.z, 999, 1, 0.3, { rise: false, aware: false });
  if (zi >= 0) {
    game.zombies.state[zi] = ZS.WANDER;
    M.onEvent({ e: 'shot', p: 0, noise: 1 });
    assert.notEqual(game.zombies.state[zi], ZS.WANDER, 'shot did not wake it');
  }
  // Sleep through the night.
  M.time = 0.9;
  game.zombies.clear();
  const bed = W.beds[0];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1]]) {
    P.x = bed.x + dx + 0.5; P.z = bed.z + dz + 0.5;
    if (W.open(Math.floor(P.x), Math.floor(P.z)) && M.interactTarget(P)?.kind === 'bed') break;
  }
  assert.equal(M.interactTarget(P)?.kind, 'bed', 'no spot by the bed');
  const dayBefore = M.day;
  pressX(game);
  assert.ok(!M.night && M.day === dayBefore + 1, 'sleeping did not bring the morning');
  // Save and load.
  P.inv.wood = 7; P.ammo.rifle = 33;
  const save = JSON.parse(JSON.stringify(M.serialize()));
  const g2 = owGame(9, save), P2 = g2.players[0];
  assert.equal(g2.mode.day, M.day); assert.equal(P2.inv.wood, 7); assert.equal(P2.ammo.rifle, 33);
  assert.equal(g2.mode.mission, M.mission); assert.equal(g2.mode.looted.size, M.looted.size);
  assert.ok(Math.abs(P2.x - P.x) < 1e-6);
  ok(`survival: 3 searches finish "Stock up", gunfire wakes wanderers, sleep skips to day ${M.day}, save/load round-trips (${JSON.stringify(save).length} bytes)`);
}

{ // hordes walk in when you're near, cost of a busy open-world step
  const game = owGame(), P = game.players[0], M = game.mode;
  P.god = true; game.zcap = 28;
  M.hordes = [{ x: P.x + 30, z: P.z + 6, n: 15, tx: P.x, tz: P.z, active: false }];
  run(game, 8);
  assert.ok(M.hordes.length === 0 || M.hordes[0].n < 15, 'horde never materialised');
  for (let k = game.zombies.alive; k < 28; k++) {
    const at = M._ringCell(P, 6, 30); if (at) game.zombies.spawn(ZT.walker, at[0], at[1], 1e6, 1.1, k / 28, { rise: false });
  }
  const t0 = performance.now(), N = 600;
  for (let k = 0; k < N; k++) { game.step(DT, [emptyInput()]); game.drain(); }
  const ms = (performance.now() - t0) / N;
  assert.ok(ms < 3, `open-world step too slow: ${ms.toFixed(3)} ms`);
  ok(`horde materialised near the player; open-world step with ${game.zombies.alive} zombies: ${ms.toFixed(3)} ms`);
}
void DAY_SECS;

// ---------------------------------------------------------------- phase 5
const shGame = (seed = 9, save = null) => new Game({ world: new World(generateWorld(seed)), mode: 'shelter', seed, modeOpts: { seed, save } });

{ // building, tiers, the weakest wall, climbers
  const game = shGame(), P = game.players[0], W = game.world, M = game.mode, Sh = M.shelter;
  P.god = true;
  const home = W.home;
  // Find a clear 1×9 strip of ground on the plot to wall off.
  let row = null;
  for (let z = home.z0 + 2; z < home.z1 - 2 && !row; z++) {
    for (let x = home.x0 + 2; x < home.x1 - 10; x++) {
      let ok = true;
      for (let k = 0; k < 9; k++) if (W.cell(x + k, z) !== C.GROUND) ok = false;
      if (ok) { row = [x, z]; break; }
    }
  }
  assert.ok(row, 'no clear ground on the plot');
  assert.ok(Sh.canPlace('wall', home.x0 - 5, home.z0 - 5), 'building outside the plot was allowed');
  const wood = Sh.stash.wood;
  const walls = [];
  for (let k = 0; k < 9; k++) walls.push(Sh.place('wall', row[0] + k, row[1]));
  assert.ok(walls.every(Boolean) && Sh.stash.wood === wood - 36, 'walls not built / wood not spent');
  assert.equal(W.cell(row[0], row[1]), C.STRUCT);
  assert.ok(!W.open(row[0], row[1], true) && !W.open(row[0], row[1], false), 'a wall let something through');
  // Upgrades need Workshop II.
  assert.ok(!Sh.improve(walls[0].id));
  Sh.tech = 2; Sh.stash.metal = 50;
  assert.ok(Sh.improve(walls[0].id) && walls[0].tier === 1 && walls[0].maxHp === PIECESx.wall.hp[1]);
  // A zombie on one side, the player on the other: it tears the weakest piece.
  walls[4].hp = 30;
  P.x = row[0] + 4.5; P.z = row[1] - 3.5;
  const zi = game.zombies.spawn(ZT.walker, row[0] + 4.5, row[1] + 3.5, 1e6, 1.2, 0.5, { rise: false });
  let hit = false;
  for (let t = 0; t < 25 && !hit; t += DT) { game.step(DT, [emptyInput()]); hit = game.drain().some(e => e.e === 'destroyed'); }
  assert.ok(hit, 'zombie never broke through');
  assert.equal(W.cell(row[0] + 4, row[1]), C.GROUND, 'the broken wall is still in the grid');
  game.zombies.clear();
  // A climber vaults a wooden wall: shut the player in a ring of walls.
  for (const p of Sh.pieces) if (p) Sh.demolish(p.id);
  let rx = 0, rz = 0;
  find: for (let z = home.z0 + 3; z < home.z1 - 9; z++) for (let x = home.x0 + 3; x < home.x1 - 3; x++) {
    let ok = true;
    for (let dz = -2; dz <= 8 && ok; dz++) for (let dx = -2; dx <= 2; dx++) if (W.cell(x + dx, z + dz) !== C.GROUND) { ok = false; break; }
    if (ok) { rx = x; rz = z; break find; }
  }
  assert.ok(rx, 'no room on the plot for the ring');
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) === 2 && W.cell(rx + dx, rz + dz) === C.GROUND) Sh.stash.wood += 4, Sh.place('wall', rx + dx, rz + dz);
  }
  P.x = rx + 0.5; P.z = rz + 0.5;
  const ci = game.zombies.spawn(ZT.climber, rx + 0.5, rz + 6.5, 1e6, 1.8, 0.5, { rise: false });
  let vault = false;
  for (let t = 0; t < 12 && !vault; t += DT) { game.step(DT, [emptyInput()]); vault = game.drain().some(e => e.e === 'vault'); }
  assert.ok(vault, 'climber never vaulted');
  void ci; void zi;
  ok('building costs materials and stays on the plot; tiers need Workshop II; the horde breaks the weakest wall; climbers vault wood');
}

{ // turrets need fuel + ammo, raids come at night, crafting, save/load
  const game = shGame(), P = game.players[0], W = game.world, M = game.mode, Sh = M.shelter;
  P.god = true;
  const home = W.home;
  Sh.tech = 2; Sh.stash = { wood: 99, metal: 99, parts: 99, components: 99, cloth: 20, fuel: 0 };
  const spot = () => { for (let z = home.z0 + 1; z < home.z1; z++) for (let x = home.x0 + 1; x < home.x1; x++) if (!Sh.canPlace('turret', x, z)) return [x, z]; };
  const [tx, tz] = spot();
  const tur = Sh.place('turret', tx, tz);
  const [gx, gz] = spot();
  Sh.place('generator', gx, gz);
  const zi = game.zombies.spawn(ZT.walker, tx + 4.5, tz + 0.5, 50, 0.01, 0.5, { rise: false });
  run(game, 1);
  assert.ok(game.zombies.isLive(zi), 'turret fired without power');
  Sh.fuel = 4; Sh._power();
  assert.ok(tur.powered, 'turret unpowered with fuel in');
  run(game, 2);
  assert.ok(!game.zombies.isLive(zi), 'powered turret did not kill');
  // Crafting: ammo, then Workshop III.
  const light = P.ammo.light;
  assert.ok(Sh.craft('light', P) && P.ammo.light === light + 30);
  assert.ok(Sh.craft('tech3', P) && Sh.tech === 3);
  // Night raid.
  P.x = home.x + 0.5; P.z = home.z + 0.5;
  game.zcap = 20;
  M.time = 0.7795; // a moment before dusk (0.78)
  run(game, 2);
  assert.ok(Sh.raid, 'no raid scheduled at dusk');
  Sh.raid.t = Sh.raid.delay;
  let raided = false;
  for (let t = 0; t < 20 && !raided; t += DT) { game.step(DT, [emptyInput()]); raided = game.drain().some(e => e.e === 'raid'); }
  run(game, 10);
  let raiders = 0;
  for (let i = 0; i < game.zombies.n; i++) if (game.zombies.isLive(i) && M.tag[i] === -4) raiders++;
  assert.ok(raided && raiders > 0, 'raid never arrived');
  // Save and load: the base comes back.
  const pieces = Sh.count();
  const save = JSON.parse(JSON.stringify(M.serialize()));
  const g2 = shGame(9, save);
  assert.equal(g2.mode.shelter.count(), pieces, 'base not restored');
  assert.equal(g2.world.cell(tx, tz), C.STRUCT);
  assert.equal(g2.mode.shelter.tech, 3);
  ok(`turrets need fuel and ammo; crafting (ammo, Workshop III); a dusk raid of ${Sh.raid?.n ?? '—'} arrives; ${pieces} pieces survive save/load`);
}

console.log(`\nAll ${passed} Dead of Night sim checks passed.`);
