// Weapons as data. Every gun shares one firing model (hitscan pellets in a
// spread cone, damage falloff, headshot multiplier, recoil that mostly
// recovers) — a new weapon is a table row, not code. Viewmodels are built
// from `model` by the renderer. Angles in radians, times in seconds.

export const WEAPONS = {
  pistol: {
    name: 'P9 Sidearm', cls: 'pistol', model: 'pistol', sound: 'pistol',
    dmg: 40, head: 2.6, pellets: 1, rpm: 420, auto: false,
    mag: 8, reserve: 80, start: 40, reload: 1.35, emptyReload: 1.6,
    spread: { hip: 0.03, ads: 0.004, move: 0.02, bloom: 0.012, max: 0.08 },
    recoil: { v: 0.024, h: 0.007, recover: 9 },
    range: [14, 40], minDmg: 0.6, adsTime: 0.16, zoom: 1.2, mobility: 1.0,
  },
  smg: {
    name: 'Vandal SMG', cls: 'smg', model: 'smg', sound: 'smg',
    dmg: 70, head: 2.0, pellets: 1, rpm: 760, auto: true,
    mag: 32, reserve: 192, reload: 2.1, emptyReload: 2.5,
    spread: { hip: 0.045, ads: 0.012, move: 0.025, bloom: 0.006, max: 0.09 },
    recoil: { v: 0.012, h: 0.009, recover: 11 },
    range: [12, 30], minDmg: 0.55, adsTime: 0.2, zoom: 1.25, mobility: 1.0,
    cost: 1000, ammoCost: 500,
  },
  shotgun: {
    name: 'Pump-12', cls: 'shotgun', model: 'shotgun', sound: 'shotgun',
    dmg: 60, head: 1.4, pellets: 8, rpm: 72, auto: false,
    mag: 6, reserve: 48, shell: 0.48, shellStart: 0.35,
    spread: { hip: 0.11, ads: 0.075, move: 0.02, bloom: 0, max: 0.13 },
    recoil: { v: 0.07, h: 0.02, recover: 7 },
    range: [5, 16], minDmg: 0.25, adsTime: 0.24, zoom: 1.15, mobility: 0.92,
    cost: 1500, ammoCost: 750,
  },
};

// The knife (R3 / melee): a short frontal cone, with a lunge onto a target
// just out of reach. Fixed damage, so it falls off naturally as rounds
// raise zombie health.
export const KNIFE = { dmg: 150, reach: 1.9, lunge: 3.2, cone: 0.72, time: 0.55, hitAt: 0.14 };

export function newWeapon(id, full = false) {
  const W = WEAPONS[id];
  return { id, mag: W.mag, reserve: full ? W.reserve : (W.start ?? W.reserve) };
}

// Damage at distance d after falloff (linear between range[0] and range[1]).
export function falloff(W, d) {
  const [a, b] = W.range;
  if (d <= a) return 1;
  if (d >= b) return W.minDmg;
  return 1 - (1 - W.minDmg) * (d - a) / (b - a);
}

// Current cone half-angle for a weapon given ADS blend, movement fraction
// and accumulated bloom.
export function spreadOf(W, ads, moving, bloom) {
  const s = W.spread;
  return Math.min(s.max, s.hip + (s.ads - s.hip) * ads + s.move * moving * (1 - ads * 0.7) + bloom);
}

// A unit direction inside a cone around (yaw, pitch). rng() in [0,1).
export function coneDir(yaw, pitch, spread, rng, out = [0, 0, 0]) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // forward, right, up for yaw-0-looks-down-minus-z
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, rz = -sy;
  const ux = sy * sp, uy = cp, uz = cy * sp;
  const r = spread * Math.sqrt(rng()), a = rng() * Math.PI * 2;
  const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
  let dx = fx + rx * ox + ux * oy, dy = fy + uy * oy, dz = fz + rz * ox + uz * oy;
  const l = Math.hypot(dx, dy, dz);
  out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
  return out;
}
