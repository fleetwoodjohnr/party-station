// Autopilot survivor: drives a Player through the same Input a controller
// would. Used by the headless tests (scripts/night-sim.js) and the Pi bench
// (scene=classic), so both exercise the real game, not a mock.
import { emptyInput } from './player.js';
import { ZTYPES } from './zombies.js';
import { MAX_BOARDS } from './world.js';

export function botInput(game, P, home = null) {
  const inp = emptyInput();
  inp.assist = 'off';
  if (P.down) return inp;
  const Z = game.zombies, W = game.world;
  const [ex, ey, ez] = P.eyePos();
  // Nearest visible zombie.
  let t = -1, td = Infinity;
  for (let i = 0; i < Z.n; i++) {
    if (!Z.isLive(i) || Z.y[i] < -0.5) continue;
    const d = Math.hypot(Z.x[i] - P.x, Z.z[i] - P.z);
    if (d < td && d < 30 && W.sees(ex, ey, ez, Z.x[i], Z.y[i] + 1.4, Z.z[i])) { td = d; t = i; }
  }
  const wpn = P.weapon;
  if (t >= 0) {
    const T = ZTYPES[Z.type[t]];
    const tx = Z.x[t] - ex, ty = Z.y[t] + T.headY * T.size - 0.05 - ey, tz = Z.z[t] - ez;
    const d = Math.hypot(tx, ty, tz);
    let dyaw = Math.atan2(-tx, -tz) - P.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const dpitch = Math.asin(ty / d) - P.pitch;
    const turn = 0.12;
    inp.lookX = -Math.max(-turn, Math.min(turn, dyaw));
    inp.lookY = -Math.max(-turn, Math.min(turn, dpitch));
    const onTarget = Math.abs(dyaw) < 0.025 && Math.abs(dpitch) < 0.025;
    inp.ads = td > 3;
    if (td < 1.5 && (wpn.mag === 0 || game.rng() < 0.3)) inp.melee = true;
    else if (onTarget && wpn.mag > 0) { inp.fire = true; inp.firePressed = !P._botFired; }
    P._botFired = inp.firePressed;
    if (td < 2.6) inp.my = 0.8; // back off a step
  } else {
    // Quiet moment: reload, rebuild a window, drift home, buy the SMG.
    if (wpn.mag < (P.W.mag >> 1) && wpn.reserve > 0) inp.xPressed = !P.prompt && !P._botX;
    const need = P.prompt?.kind === 'repair' && W.windows[P.prompt.wi].boards < MAX_BOARDS;
    if (need) inp.x = true;
    else if (W.wallbuys[0] && ((P.points >= 1000 && P.weapons.length < 2)
      || (P.weapons.length > 1 && wpn.reserve < P.W.mag * 2 && P.points >= 500))) {
      // Buy the SMG, then come back to the same wall for ammo.
      const b = W.wallbuys[0];
      goTo(inp, P, b.x + 0.5 + b.face[0], b.y + 0.5 + b.face[1]);
      if (P.prompt?.kind === 'buy' || (P.prompt?.kind === 'ammo' && P.prompt.afford)) inp.xPressed = !P._botX;
      if (P.weapons.length > 1 && wpn.id !== b.weapon && !P._botSwap) inp.swap = true;
      P._botSwap = inp.swap;
    } else if (home) goTo(inp, P, home[0], home[1]);
    P._botX = inp.xPressed;
  }
  return inp;
}

function goTo(inp, P, x, z) {
  const dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz);
  if (d < 0.6) return;
  // World direction -> stick: right = (cos, -sin), forward = (-sin, -cos).
  const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  inp.mx = (dx * cy - dz * sy) / d;
  inp.my = -(-dx * sy - dz * cy) / d;
}
