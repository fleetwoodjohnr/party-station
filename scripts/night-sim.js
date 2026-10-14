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

console.log(`\nAll ${passed} Dead of Night sim checks passed.`);
