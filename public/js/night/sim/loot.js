// Items, loot tables and the carry-weight inventory for the survival modes
// (Open World and Shelter). Resources stack; ammo goes into per-type pools
// the guns draw from; found guns and attachments are single items.
import { WEAPONS, ATTACHMENTS, RARITY } from './weapons.js';

export const ITEMS = {
  wood: { name: 'Wood', w: 1 },
  metal: { name: 'Scrap metal', w: 1.5 },
  parts: { name: 'Weapon parts', w: 0.5 },
  components: { name: 'Components', w: 0.3 },
  cloth: { name: 'Cloth', w: 0.2 },
  fuel: { name: 'Fuel can', w: 2 },
  food: { name: 'Canned food', w: 0.5, use: 'eat' },
  water: { name: 'Water', w: 0.5, use: 'drink' },
  meds: { name: 'Medkit', w: 0.5, use: 'heal' },
};
export const AMMO_TYPES = { light: 'Light ammo', rifle: 'Rifle ammo', shells: 'Shells', explosive: 'Grenades' };
export const CARRY = 60;

// Container kinds: [item, chance, min, max] rows; 'ammo:type' fills the
// pool; 'gun' rolls a weapon; 'att' rolls an attachment.
const T = {
  cabinet: [['food', 0.5, 1, 2], ['water', 0.5, 1, 2], ['meds', 0.25, 1, 1], ['cloth', 0.5, 1, 3], ['components', 0.3, 1, 2], ['ammo:light', 0.35, 8, 20]],
  fridge: [['food', 0.8, 1, 3], ['water', 0.7, 1, 3]],
  toolbox: [['metal', 0.7, 1, 4], ['parts', 0.5, 1, 3], ['components', 0.6, 1, 3], ['fuel', 0.2, 1, 1]],
  car: [['fuel', 0.45, 1, 2], ['cloth', 0.4, 1, 2], ['parts', 0.3, 1, 2], ['ammo:light', 0.3, 6, 16], ['water', 0.25, 1, 1]],
  shelf: [['wood', 0.5, 2, 5], ['metal', 0.4, 1, 3], ['food', 0.4, 1, 3], ['water', 0.4, 1, 3], ['components', 0.35, 1, 3]],
  locker: [['ammo:rifle', 0.6, 15, 40], ['ammo:shells', 0.35, 6, 14], ['meds', 0.35, 1, 1], ['gun', 0.18, 1, 1], ['att', 0.25, 1, 1]],
  ammo: [['ammo:light', 0.7, 20, 50], ['ammo:rifle', 0.6, 20, 50], ['ammo:shells', 0.5, 8, 20], ['ammo:explosive', 0.15, 1, 3]],
  armory: [['gun', 1, 1, 1], ['ammo:rifle', 1, 40, 80], ['att', 0.8, 1, 2], ['meds', 0.6, 1, 2]],
  pharmacy: [['meds', 1, 2, 4], ['water', 0.6, 1, 2]],
  manifest: [['components', 1, 4, 8], ['parts', 1, 3, 6], ['att', 0.6, 1, 1]],
  radio: [['water', 0.5, 1, 1], ['food', 0.4, 1, 1], ['ammo:light', 0.4, 10, 20]],
  pack: [],
};
export const CONTAINER_NAMES = {
  cabinet: 'Cupboard', fridge: 'Fridge', toolbox: 'Toolbox', car: 'Car trunk', shelf: 'Shelves', locker: 'Footlocker',
  ammo: 'Ammo crate', armory: 'Armory rack', pharmacy: 'Pharmacy shelf', manifest: 'Manifest crate', radio: 'Radio desk', pack: 'Your pack',
};
const GUN_POOL = ['revolver', 'pdw', 'ar', 'kestrel', 'br', 'shotgun', 'autoshotgun', 'sawnoff', 'dmr', 'sniper', 'lmg', 'launcher', 'smg'];

// Roll a container's contents. Better kinds roll better rarities.
export function rollLoot(kind, rng, day = 1) {
  const out = [];
  for (const [item, p, lo, hi] of T[kind] || []) {
    if (rng() > p) continue;
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    if (item === 'gun') {
      const id = GUN_POOL[Math.floor(rng() * GUN_POOL.length)];
      let tier = 0;
      const boost = kind === 'armory' ? 0.5 : 0.15 + Math.min(0.3, day * 0.02);
      for (let k = 1; k < RARITY.length; k++) if (rng() < boost / k) tier = k;
      out.push({ gun: id, tier });
    } else if (item === 'att') {
      const ids = Object.keys(ATTACHMENTS);
      out.push({ att: ids[Math.floor(rng() * ids.length)] });
    } else if (item.startsWith('ammo:')) out.push({ ammo: item.slice(5), n });
    else out.push({ item, n });
  }
  return out;
}

export function weightOf(inv) {
  let w = 0;
  for (const [k, n] of Object.entries(inv)) w += (ITEMS[k]?.w || 0) * n;
  return w;
}

// Put loot into a player; returns what didn't fit (left in the container).
export function take(P, loot) {
  const left = [];
  P.found ||= [];
  for (const l of loot) {
    if (l.ammo) { P.ammo[l.ammo] = (P.ammo[l.ammo] || 0) + l.n; continue; }
    if (l.gun || l.att) { P.found.push(l); continue; }
    const room = Math.floor((CARRY - weightOf(P.inv)) / (ITEMS[l.item].w || 1));
    const n = Math.min(l.n, Math.max(0, room));
    if (n > 0) P.inv[l.item] = (P.inv[l.item] || 0) + n;
    if (n < l.n) left.push({ item: l.item, n: l.n - n });
  }
  return left;
}

export function lootLabel(l) {
  if (l.ammo) return `${AMMO_TYPES[l.ammo]} ×${l.n}`;
  if (l.gun) return `${l.tier ? RARITY[l.tier].name + ' ' : ''}${WEAPONS[l.gun].name}`;
  if (l.att) return `${ATTACHMENTS[l.att].name} (attachment)`;
  return `${ITEMS[l.item].name} ×${l.n}`;
}
