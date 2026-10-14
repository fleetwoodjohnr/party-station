// Headless checks for Dead of Night's simulation (public/js/night/sim) —
// no browser, no three.js. Run: node scripts/night-sim.js
import assert from 'assert/strict';
import { World, C } from '../public/js/night/sim/world.js';
import { DINER } from '../public/js/night/sim/maps.js';
import { Zombies, ZT } from '../public/js/night/sim/zombies.js';
import { Game } from '../public/js/night/sim/game.js';
import { emptyInput } from '../public/js/night/sim/player.js';
import { botInput } from '../public/js/night/sim/bot.js';
import { WEAPONS, falloff } from '../public/js/night/sim/weapons.js';
import { zombieHp, roundTotal } from '../public/js/night/sim/classic.js';

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

console.log(`\nAll ${passed} Dead of Night sim checks passed.`);
