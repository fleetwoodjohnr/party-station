// Weapons as data. Every gun shares one firing model (hitscan pellets in a
// spread cone, damage falloff, headshot multiplier, recoil that mostly
// recovers; a projectile for launchers) — a new weapon is a table row, not
// code. A weapon *instance* adds rarity tier and attachments, and
// statsOf() folds those (plus perks) into the effective numbers the
// player fires with. Angles in radians, times in seconds.

// ammo: light | rifle | shells | explosive (scavenged separately in the
// open world; Classic just refills per gun).
export const WEAPONS = {
  pistol: {
    name: 'P9 Sidearm', cls: 'pistol', model: 'pistol', sound: 'pistol', ammo: 'light',
    dmg: 40, head: 2.6, pellets: 1, rpm: 420, auto: false,
    mag: 8, reserve: 80, start: 40, reload: 1.35, emptyReload: 1.6,
    spread: { hip: 0.03, ads: 0.004, move: 0.02, bloom: 0.012, max: 0.08 },
    recoil: { v: 0.024, h: 0.007, recover: 9 },
    range: [14, 40], minDmg: 0.6, adsTime: 0.16, zoom: 1.2, mobility: 1.0,
  },
  revolver: {
    name: 'Warden .44', cls: 'pistol', model: 'revolver', sound: 'revolver', ammo: 'light',
    dmg: 160, head: 2.5, pellets: 1, rpm: 150, auto: false,
    mag: 6, reserve: 48, reload: 2.6, emptyReload: 2.6,
    spread: { hip: 0.035, ads: 0.003, move: 0.02, bloom: 0.02, max: 0.08 },
    recoil: { v: 0.07, h: 0.015, recover: 7 },
    range: [20, 45], minDmg: 0.7, adsTime: 0.18, zoom: 1.25, mobility: 1.0, pen: 1,
  },
  smg: {
    name: 'Vandal SMG', cls: 'smg', model: 'smg', sound: 'smg', ammo: 'light',
    dmg: 70, head: 2.0, pellets: 1, rpm: 760, auto: true,
    mag: 32, reserve: 192, reload: 2.1, emptyReload: 2.5,
    spread: { hip: 0.045, ads: 0.012, move: 0.025, bloom: 0.006, max: 0.09 },
    recoil: { v: 0.012, h: 0.009, recover: 11 },
    range: [12, 30], minDmg: 0.55, adsTime: 0.2, zoom: 1.25, mobility: 1.0,
    cost: 1000, ammoCost: 500,
  },
  pdw: {
    name: 'Hornet PDW', cls: 'smg', model: 'pdw', sound: 'smg', ammo: 'light',
    dmg: 58, head: 2.0, pellets: 1, rpm: 950, auto: true,
    mag: 40, reserve: 240, reload: 2.0, emptyReload: 2.3,
    spread: { hip: 0.04, ads: 0.014, move: 0.02, bloom: 0.005, max: 0.085 },
    recoil: { v: 0.01, h: 0.011, recover: 12 },
    range: [10, 26], minDmg: 0.5, adsTime: 0.17, zoom: 1.2, mobility: 1.05,
  },
  ar: {
    name: 'Ranger AR', cls: 'ar', model: 'ar', sound: 'rifle', ammo: 'rifle',
    dmg: 95, head: 2.2, pellets: 1, rpm: 650, auto: true,
    mag: 30, reserve: 210, reload: 2.3, emptyReload: 2.7,
    spread: { hip: 0.05, ads: 0.006, move: 0.03, bloom: 0.005, max: 0.09 },
    recoil: { v: 0.016, h: 0.008, recover: 10 },
    range: [25, 55], minDmg: 0.7, adsTime: 0.24, zoom: 1.35, mobility: 0.96,
    cost: 1500, ammoCost: 750,
  },
  kestrel: {
    name: 'Kestrel AR', cls: 'ar', model: 'ar', sound: 'rifle', ammo: 'rifle',
    dmg: 78, head: 2.2, pellets: 1, rpm: 820, auto: true,
    mag: 32, reserve: 224, reload: 2.1, emptyReload: 2.5,
    spread: { hip: 0.048, ads: 0.008, move: 0.028, bloom: 0.006, max: 0.09 },
    recoil: { v: 0.014, h: 0.01, recover: 11 },
    range: [22, 50], minDmg: 0.68, adsTime: 0.22, zoom: 1.3, mobility: 0.98,
  },
  br: {
    name: 'Bulldog BR', cls: 'ar', model: 'br', sound: 'rifle', ammo: 'rifle',
    dmg: 130, head: 2.3, pellets: 1, rpm: 900, auto: false, burst: 3, burstGap: 0.28,
    mag: 30, reserve: 180, reload: 2.4, emptyReload: 2.8,
    spread: { hip: 0.05, ads: 0.004, move: 0.03, bloom: 0.004, max: 0.08 },
    recoil: { v: 0.014, h: 0.006, recover: 10 },
    range: [30, 60], minDmg: 0.75, adsTime: 0.25, zoom: 1.4, mobility: 0.95,
  },
  shotgun: {
    name: 'Pump-12', cls: 'shotgun', model: 'shotgun', sound: 'shotgun', ammo: 'shells',
    dmg: 60, head: 1.4, pellets: 8, rpm: 72, auto: false,
    mag: 6, reserve: 48, shell: 0.48, shellStart: 0.35,
    spread: { hip: 0.11, ads: 0.075, move: 0.02, bloom: 0, max: 0.13 },
    recoil: { v: 0.07, h: 0.02, recover: 7 },
    range: [5, 16], minDmg: 0.25, adsTime: 0.24, zoom: 1.15, mobility: 0.92,
    cost: 1500, ammoCost: 750,
  },
  autoshotgun: {
    name: 'Reaper Auto-12', cls: 'shotgun', model: 'autoshotgun', sound: 'shotgun', ammo: 'shells',
    dmg: 48, head: 1.4, pellets: 7, rpm: 300, auto: true,
    mag: 10, reserve: 60, reload: 2.8, emptyReload: 3.1,
    spread: { hip: 0.1, ads: 0.08, move: 0.02, bloom: 0.01, max: 0.14 },
    recoil: { v: 0.05, h: 0.02, recover: 8 },
    range: [5, 14], minDmg: 0.25, adsTime: 0.26, zoom: 1.15, mobility: 0.9,
  },
  sawnoff: {
    name: 'Coach Twin', cls: 'shotgun', model: 'sawnoff', sound: 'shotgun', ammo: 'shells',
    dmg: 75, head: 1.3, pellets: 10, rpm: 400, auto: false,
    mag: 2, reserve: 40, reload: 1.9, emptyReload: 1.9,
    spread: { hip: 0.13, ads: 0.1, move: 0.015, bloom: 0, max: 0.15 },
    recoil: { v: 0.09, h: 0.03, recover: 7 },
    range: [4, 11], minDmg: 0.2, adsTime: 0.18, zoom: 1.1, mobility: 1.02,
  },
  dmr: {
    name: 'DMR-14', cls: 'marksman', model: 'dmr', sound: 'marksman', ammo: 'rifle',
    dmg: 260, head: 2.5, pellets: 1, rpm: 280, auto: false,
    mag: 15, reserve: 90, reload: 2.6, emptyReload: 3.0,
    spread: { hip: 0.06, ads: 0.002, move: 0.03, bloom: 0.015, max: 0.09 },
    recoil: { v: 0.035, h: 0.008, recover: 8 },
    range: [40, 80], minDmg: 0.8, adsTime: 0.3, zoom: 2.0, mobility: 0.93, pen: 1,
  },
  sniper: {
    name: 'Longbow', cls: 'sniper', model: 'sniper', sound: 'sniper', ammo: 'rifle',
    dmg: 900, head: 3, pellets: 1, rpm: 50, auto: false,
    mag: 5, reserve: 30, reload: 3.2, emptyReload: 3.6,
    spread: { hip: 0.08, ads: 0.0005, move: 0.04, bloom: 0, max: 0.1 },
    recoil: { v: 0.08, h: 0.01, recover: 5 },
    range: [80, 120], minDmg: 0.9, adsTime: 0.38, zoom: 4.0, mobility: 0.9, pen: 3, scope: true,
  },
  lmg: {
    name: 'Anvil LMG', cls: 'lmg', model: 'lmg', sound: 'rifle', ammo: 'rifle',
    dmg: 110, head: 2.0, pellets: 1, rpm: 600, auto: true,
    mag: 100, reserve: 400, reload: 5.5, emptyReload: 6.0,
    spread: { hip: 0.06, ads: 0.01, move: 0.035, bloom: 0.004, max: 0.1 },
    recoil: { v: 0.014, h: 0.012, recover: 9 },
    range: [30, 60], minDmg: 0.7, adsTime: 0.35, zoom: 1.35, mobility: 0.85,
  },
  launcher: {
    name: 'Thumper', cls: 'explosive', model: 'launcher', sound: 'launcher', ammo: 'explosive',
    dmg: 650, head: 1, pellets: 1, rpm: 60, auto: false, projectile: { speed: 28, radius: 4.2, arc: true },
    mag: 1, reserve: 20, reload: 2.2, emptyReload: 2.2,
    spread: { hip: 0.02, ads: 0.004, move: 0.02, bloom: 0, max: 0.05 },
    recoil: { v: 0.06, h: 0.01, recover: 6 },
    range: [999, 999], minDmg: 1, adsTime: 0.3, zoom: 1.2, mobility: 0.9,
  },
};

// Melee weapons replace the knife (R3); a fixed amount of damage, so they
// fall off naturally as rounds raise zombie health.
export const MELEE = {
  knife: { name: 'Knife', dmg: 150, reach: 1.9, lunge: 3.2, cone: 0.72, time: 0.55, hitAt: 0.14 },
  machete: { name: 'Machete', dmg: 450, reach: 2.2, lunge: 3.4, cone: 0.66, time: 0.5, hitAt: 0.16, cost: 2000 },
};
export const KNIFE = MELEE.knife;

// Attachments: slot, the classes that take it, the rank that unlocks it,
// and multipliers (m) / adders (a) on dotted stat paths.
export const SLOTS = ['optic', 'mag', 'barrel', 'stock', 'grip', 'muzzle', 'ammo'];
const LONG = ['ar', 'marksman', 'sniper', 'lmg'];
const ALLGUNS = ['pistol', 'smg', 'ar', 'shotgun', 'marksman', 'sniper', 'lmg'];
export const ATTACHMENTS = {
  reddot: { slot: 'optic', name: 'Red dot', rank: 1, cls: ALLGUNS, m: { adsTime: 0.9, 'spread.ads': 0.8 } },
  holo: { slot: 'optic', name: 'Holo sight', rank: 4, cls: ['smg', 'ar', 'shotgun', 'lmg'], m: { 'spread.ads': 0.7 }, a: { zoom: 0.25 } },
  scope4: { slot: 'optic', name: '4× scope', rank: 7, cls: LONG, m: { 'spread.ads': 0.4, adsTime: 1.3 }, a: { zoom: 1.6 }, scope: true },
  extmag: { slot: 'mag', name: 'Extended mag', rank: 1, cls: ALLGUNS, m: { mag: 1.5, reload: 1.12, emptyReload: 1.12 } },
  fastmag: { slot: 'mag', name: 'Fast mag', rank: 6, cls: ALLGUNS, m: { reload: 0.7, emptyReload: 0.7, shell: 0.7 } },
  longbarrel: { slot: 'barrel', name: 'Long barrel', rank: 5, cls: ALLGUNS, m: { 'range.0': 1.3, 'range.1': 1.3, mobility: 0.97 }, a: { minDmg: 0.1 } },
  shortbarrel: { slot: 'barrel', name: 'Short barrel', rank: 8, cls: ALLGUNS, m: { 'spread.hip': 0.75, 'range.0': 0.8, 'range.1': 0.8 } },
  tacstock: { slot: 'stock', name: 'Tactical stock', rank: 4, cls: ['smg', 'ar', 'shotgun', 'marksman', 'lmg'], m: { 'recoil.v': 0.8, adsTime: 0.9 } },
  nostock: { slot: 'stock', name: 'No stock', rank: 9, cls: ['smg', 'ar', 'shotgun'], m: { mobility: 1.08, 'recoil.v': 1.15 } },
  vgrip: { slot: 'grip', name: 'Vertical grip', rank: 3, cls: ['smg', 'ar', 'shotgun', 'lmg'], m: { 'recoil.v': 0.75 } },
  agrip: { slot: 'grip', name: 'Angled grip', rank: 6, cls: ['smg', 'ar', 'shotgun', 'lmg', 'marksman'], m: { adsTime: 0.85 } },
  suppressor: { slot: 'muzzle', name: 'Suppressor', rank: 5, cls: ['pistol', 'smg', 'ar', 'marksman', 'sniper'], m: { dmg: 0.95, noise: 0.3 } },
  compensator: { slot: 'muzzle', name: 'Compensator', rank: 8, cls: ['pistol', 'smg', 'ar', 'lmg'], m: { 'recoil.v': 0.7, 'recoil.h': 0.7 } },
  hollow: { slot: 'ammo', name: 'Hollow points', rank: 10, cls: ALLGUNS, m: { dmg: 1.15, armorMul: 0.7 } },
  ap: { slot: 'ammo', name: 'AP rounds', rank: 11, cls: ALLGUNS, a: { pen: 1 }, set: { armorMul: 2 } },
  incendiary: { slot: 'ammo', name: 'Incendiary', rank: 13, cls: ALLGUNS, set: { burn: 40 } },
};

// Rarity: damage and ammo up, plus pre-fitted attachments from the mystery
// crate. The Forge raises a gun one tier at a time.
export const RARITY = [
  { name: 'Common', color: '#c8c8c8', dmg: 1, ammo: 1, slots: 0 },
  { name: 'Uncommon', color: '#5fd46b', dmg: 1.15, ammo: 1.1, slots: 1 },
  { name: 'Rare', color: '#4f9dff', dmg: 1.32, ammo: 1.2, slots: 2 },
  { name: 'Epic', color: '#b46bff', dmg: 1.52, ammo: 1.35, slots: 3 },
  { name: 'Legendary', color: '#ffb52e', dmg: 1.75, ammo: 1.5, slots: 4, rpm: 1.1, burn: 30 },
];

// Perks (machines in Classic).
export const PERKS = {
  ironhide: { name: 'Iron Hide', cost: 2500, color: '#d23a3a', desc: 'Max health 250' },
  quickhands: { name: 'Quick Hands', cost: 3000, color: '#3ec46d', desc: 'Reload twice as fast' },
  secondwind: { name: 'Second Wind', cost: 500, color: '#4fb4ff', desc: 'Get back up when you go down (solo, 3 times)' },
  doubletap: { name: 'Double Tap', cost: 2000, color: '#ffb52e', desc: 'Fire 33% faster, 20% more damage' },
  steadyaim: { name: 'Steady Aim', cost: 1500, color: '#e8e8e8', desc: 'Aim faster, tighter hip fire' },
  stamina: { name: 'Stamina Brew', cost: 2000, color: '#ff8a3a', desc: 'Move 12% faster, swap faster' },
};
export const MAX_PERKS = 4;

export function newWeapon(id, full = false, tier = 0, att = {}) {
  const w = { id, tier, att: { ...att }, mag: 0, reserve: 0 };
  const S = statsOf(w);
  w.mag = S.mag;
  w.reserve = full ? S.reserve : (WEAPONS[id].start ?? S.reserve);
  return w;
}

function setPath(o, path, fn) {
  const k = path.split('.');
  let t = o;
  for (let i = 0; i < k.length - 1; i++) t = t[k[i]];
  t[k.at(-1)] = fn(t[k.at(-1)] ?? 0);
}

// Effective stats of a weapon instance (+ the holder's perks). Cached on
// the instance by a key of everything that feeds it.
export function statsOf(w, perks = null) {
  const key = `${w.id}|${w.tier}|${Object.values(w.att || {}).join(',')}|${perks ? [...perks].join(',') : ''}`;
  if (w._sk === key) return w._s;
  const B = WEAPONS[w.id];
  const S = structuredClone(B);
  S.noise = 1; S.armorMul = 1; S.burn = 0; S.pen = B.pen || 0;
  for (const id of Object.values(w.att || {})) {
    const A = ATTACHMENTS[id];
    if (!A) continue;
    for (const [p, v] of Object.entries(A.m || {})) setPath(S, p, x => x * v);
    for (const [p, v] of Object.entries(A.a || {})) setPath(S, p, x => x + v);
    Object.assign(S, A.set || {});
    if (A.scope) S.scope = true;
  }
  const R = RARITY[w.tier || 0];
  S.dmg *= R.dmg;
  S.reserve = Math.round(S.reserve * R.ammo);
  if (R.rpm) S.rpm *= R.rpm;
  if (R.burn) S.burn = Math.max(S.burn, R.burn);
  S.mag = Math.max(1, Math.round(S.mag));
  if (perks?.has('quickhands')) { S.reload *= 0.5; if (S.emptyReload) S.emptyReload *= 0.5; if (S.shell) S.shell *= 0.5; }
  if (perks?.has('doubletap')) { S.rpm *= 1.33; S.dmg *= 1.2; }
  if (perks?.has('steadyaim')) { S.adsTime *= 0.6; S.spread.hip *= 0.6; }
  if (perks?.has('stamina')) S.mobility *= 1.12;
  S.rarity = R;
  w._sk = key; w._s = S;
  return S;
}

// Display name with rarity, e.g. "Rare Ranger AR".
export function weaponName(w) {
  return (w.tier ? RARITY[w.tier].name + ' ' : '') + WEAPONS[w.id].name;
}

export function canFit(weaponId, attId) {
  const A = ATTACHMENTS[attId];
  return !!A && A.cls.includes(WEAPONS[weaponId].cls);
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
  const dx = fx + rx * ox + ux * oy, dy = fy + uy * oy, dz = fz + rz * ox + uz * oy;
  const l = Math.hypot(dx, dy, dz);
  out[0] = dx / l; out[1] = dy / l; out[2] = dz / l;
  return out;
}

// Mystery-crate weapon pool and rarity odds (percent per tier).
export const CRATE_POOL = ['revolver', 'pdw', 'kestrel', 'br', 'autoshotgun', 'sawnoff', 'dmr', 'sniper', 'lmg', 'launcher', 'ar', 'smg', 'shotgun'];
export const CRATE_ODDS = [50, 28, 14, 6, 2];
