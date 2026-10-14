// The open world: a 6×6 grid of 64 m regions generated from a seed into
// one tile grid (384×384 cells). Each region type has a small generator
// that stamps buildings (with doorways), roads, props, loot containers,
// lamps, named places (POIs), infected zones and zombie populations.
// Pure data; the renderer streams geometry around the player and the
// survival mode simulates only what's near.
import { C } from './world.js';

export const RS = 64;                // region size in cells (metres)
export const GRID = 6;               // regions per side
export const SIZE = RS * GRID;
export const SURF = { grass: 0, dirt: 1, asphalt: 2, concrete: 3, field: 4, wood: 5, tile: 6, gravel: 7, forest: 8 };
// Exterior wall paints (renderer palette indices).
export const PAINT = { siding: 0, siding2: 1, siding3: 2, brick: 3, olive: 4, metal: 5, rust: 6, plank: 7, barn: 8, white: 9 };

// Region map. F forest, N neighbourhood, T town, M military, W warehouse,
// I industrial, O outpost, H home (the farm — the shelter plot in Mode C).
const LAYOUT = [
  'FFOFMF',
  'FNNTTW',
  'FNHTTI',
  'FNNTWI',
  'FFFMII',
  'OFFFFO',
];
const TYPES = { F: 'forest', N: 'neighborhood', T: 'town', M: 'military', W: 'warehouse', I: 'industrial', O: 'outpost', H: 'home' };
export const REGION_NAMES = {
  forest: 'Blackpine Woods', neighborhood: 'Maple Street', town: 'Main Street', military: 'Checkpoint',
  warehouse: 'Warehouse District', industrial: 'Rendering Plant', outpost: 'Outpost', home: 'Hollis Farm',
};
// Zombies a region can hold when untouched, by type.
export const DENSITY = { forest: 6, neighborhood: 18, town: 30, military: 22, warehouse: 18, industrial: 26, outpost: 3, home: 3 };

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function regionType(rx, rz) { return TYPES[LAYOUT[rz]?.[rx]] || 'forest'; }

// Build the whole world. Returns the map definition World accepts.
export function generateWorld(seed = 1) {
  const W = SIZE, H = SIZE;
  const cells = new Uint8Array(W * H).fill(C.GROUND);
  const surf = new Uint8Array(W * H).fill(SURF.grass);
  const paint = new Uint8Array(W * H);
  const def = {
    name: 'Hollis County', w: W, h: H, cells, surf, paint,
    starts: [], spawns: [], lamps: [], containers: [], pois: {}, zones: [], beds: [], regions: [],
  };
  const idx = (x, z) => z * W + x;
  const inb = (x, z) => x > 0 && z > 0 && x < W - 1 && z < H - 1;
  const set = (x, z, c, s = null) => { if (!inb(x, z)) return; cells[idx(x, z)] = c; if (s != null) surf[idx(x, z)] = s; };
  const get = (x, z) => (inb(x, z) ? cells[idx(x, z)] : C.VOID);
  const setSurf = (x, z, s) => { if (inb(x, z)) surf[idx(x, z)] = s; };
  const rect = (x0, z0, x1, z1, fn) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(x, z); };
  const clear = (x, z) => get(x, z) === C.GROUND;
  // Map edge.
  for (let x = 0; x < W; x++) { cells[idx(x, 0)] = cells[idx(x, H - 1)] = C.VOID; }
  for (let z = 0; z < H; z++) { cells[idx(0, z)] = cells[idx(W - 1, z)] = C.VOID; }

  let cid = 0;
  const container = (x, z, kind, region, extra = {}) => {
    set(x, z, C.PROP);
    def.containers.push({ id: cid++, x, z, kind, region, ...extra });
    return def.containers.at(-1);
  };
  // A building: perimeter walls with doorway gaps, floor inside, a lamp,
  // containers along the inside of the walls. doors: [[side, offset, width]]
  // with side n/s/e/w.
  // No power in the county: rooms are lit only by daylight and your torch
  // (the farm's porch light runs off its generator).
  const building = (x0, z0, w, h, { paintId = PAINT.siding, floor = SURF.wood, doors = [['s', 2, 2]], lamp = false, region, loot = [], rng }) => {
    rect(x0, z0, x0 + w - 1, z0 + h - 1, (x, z) => {
      const edge = x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + h - 1;
      set(x, z, edge ? C.WALL : C.FLOOR, edge ? null : floor);
      if (edge) paint[idx(x, z)] = paintId;
    });
    for (const [side, off, dw] of doors) {
      for (let k = 0; k < dw; k++) {
        const [x, z] = side === 'n' ? [x0 + off + k, z0] : side === 's' ? [x0 + off + k, z0 + h - 1]
          : side === 'w' ? [x0, z0 + off + k] : [x0 + w - 1, z0 + off + k];
        set(x, z, C.FLOOR, floor);
      }
    }
    if (lamp) def.lamps.push([x0 + w / 2, z0 + h / 2]);
    // Containers hug inside walls, away from doors.
    const spots = [];
    for (let x = x0 + 1; x < x0 + w - 1; x++) { spots.push([x, z0 + 1]); spots.push([x, z0 + h - 2]); }
    for (let z = z0 + 2; z < z0 + h - 2; z++) { spots.push([x0 + 1, z]); spots.push([x0 + w - 2, z]); }
    const out = [];
    for (const kind of loot) {
      for (let tries = 0; tries < 20; tries++) {
        const [x, z] = spots[Math.floor(rng() * spots.length)];
        // Keep doorways and their approach clear.
        let nearDoor = false;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const c = get(x + dx, z + dz);
          if ((dx || dz) && c === C.FLOOR && (x + dx === x0 || x + dx === x0 + w - 1 || z + dz === z0 || z + dz === z0 + h - 1)) nearDoor = true;
        }
        if (get(x, z) !== C.FLOOR || nearDoor) continue;
        out.push(container(x, z, kind, region));
        break;
      }
    }
    return out;
  };
  const road = (x0, z0, x1, z1, s = SURF.asphalt) => rect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), (x, z) => {
    if (get(x, z) === C.GROUND) setSurf(x, z, s);
  });
  const tree = (x, z) => { if (clear(x, z)) set(x, z, C.TREE); };
  const car = (x, z, horiz, region, rng) => {
    const cells2 = horiz ? [[x, z], [x + 1, z]] : [[x, z], [x, z + 1]];
    if (!cells2.every(([a, b]) => clear(a, b))) return;
    for (const [a, b] of cells2) set(a, b, C.CAR);
    if (rng() < 0.6) def.containers.push({ id: cid++, x: cells2[0][0], z: cells2[0][1], kind: 'car', region, onProp: true });
  };
  const fence = (x0, z0, x1, z1, gapAt = -1) => {
    let k = 0;
    rect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), (x, z) => {
      if (gapAt >= 0 && Math.abs(k - gapAt) <= 1) { k++; return; }
      k++;
      if (clear(x, z)) set(x, z, C.FENCE);
    });
  };

  // Roads first (so buildings avoid them): between the centres of
  // neighbouring non-forest regions, plus dirt trails into the woods.
  const busy = t => t !== 'forest';
  for (let rz = 0; rz < GRID; rz++) {
    for (let rx = 0; rx < GRID; rx++) {
      const t = regionType(rx, rz), cx = rx * RS + RS / 2, cz = rz * RS + RS / 2;
      if (rx + 1 < GRID) {
        const t2 = regionType(rx + 1, rz);
        if (busy(t) || busy(t2)) road(cx, cz - 2, cx + RS, cz + 2, busy(t) && busy(t2) ? SURF.asphalt : SURF.dirt);
      }
      if (rz + 1 < GRID) {
        const t2 = regionType(rx, rz + 1);
        if (busy(t) || busy(t2)) road(cx - 2, cz, cx + 2, cz + RS, busy(t) && busy(t2) ? SURF.asphalt : SURF.dirt);
      }
    }
  }

  for (let rz = 0; rz < GRID; rz++) {
    for (let rx = 0; rx < GRID; rx++) {
      const type = regionType(rx, rz);
      const rng = rngFrom(seed * 1000 + rz * 16 + rx);
      const ox = rx * RS, oz = rz * RS, cx = ox + RS / 2, cz = oz + RS / 2;
      const region = def.regions.length;
      const R = { id: region, rx, rz, type, name: REGION_NAMES[type], x: cx, z: cz, density: DENSITY[type] };
      def.regions.push(R);
      const scatter = (n, fn, margin = 3) => {
        for (let k = 0; k < n; k++) fn(ox + margin + Math.floor(rng() * (RS - margin * 2)), oz + margin + Math.floor(rng() * (RS - margin * 2)));
      };
      const lots = []; // building footprints already taken in this region
      const fits = (x, z, w, h) => {
        for (const [a, b, c, d] of lots) if (x < c + 2 && x + w + 2 > a && z < d + 2 && z + h + 2 > b) return false;
        for (let zz = z - 1; zz <= z + h; zz++) for (let xx = x - 1; xx <= x + w; xx++) {
          if (get(xx, zz) !== C.GROUND || surf[idx(xx, zz)] === SURF.asphalt) return false;
        }
        return true;
      };
      const place = (w, h, opts, tries = 30) => {
        for (let k = 0; k < tries; k++) {
          const x = ox + 3 + Math.floor(rng() * (RS - w - 6)), z = oz + 3 + Math.floor(rng() * (RS - h - 6));
          if (!fits(x, z, w, h)) continue;
          lots.push([x, z, x + w, z + h]);
          return { x, z, loot: building(x, z, w, h, { ...opts, region, rng }) };
        }
        return null;
      };
      const zone = (name, x, z, r, boost = 2) => { def.zones.push({ id: def.zones.length, name, x, z, r, region, boost, cleared: false }); };
      switch (type) {
        case 'forest': {
          scatter(260, (x, z) => { if (surf[idx(x, z)] === SURF.grass && rng() < 0.85) { tree(x, z); setSurf(x, z, SURF.forest); } });
          scatter(120, (x, z) => setSurf(x, z, SURF.forest));
          if (rng() < 0.55) place(6, 5, { paintId: PAINT.plank, doors: [['s', 2, 1]], loot: ['cabinet', 'toolbox'] });
          break;
        }
        case 'neighborhood': {
          const paints = [PAINT.siding, PAINT.siding2, PAINT.siding3, PAINT.white];
          for (let k = 0; k < 9; k++) {
            const b = place(8 + Math.floor(rng() * 3), 7, { paintId: paints[k % 4], doors: [['s', 3, 1], ['n', 4, 1]], loot: ['cabinet', 'fridge', rng() < 0.5 ? 'cabinet' : 'toolbox'] });
            if (b) { const [x, , x1, z1] = lots.at(-1); fence(x - 2, z1 + 2, x1 + 2, z1 + 2, 5); }
          }
          scatter(14, (x, z) => { if (surf[idx(x, z)] === SURF.asphalt) car(x, z, rng() < 0.5, region, rng); });
          scatter(40, tree);
          def.lamps.push([cx, cz + 4], [cx - 20, cz + 4], [cx + 20, cz + 4]);
          break;
        }
        case 'town': {
          for (let k = 0; k < 7; k++) {
            const pharmacy = k === 0 && rz === 2 && rx === 3;
            const b = place(11, 9, { paintId: PAINT.brick, floor: SURF.tile, doors: [['s', 3, 4]], loot: ['shelf', 'shelf', 'cabinet'] });
            if (b && pharmacy) {
              const c = b.loot[0];
              if (c) { c.kind = 'pharmacy'; def.pois.pharmacy = { x: c.x + 0.5, z: c.z + 0.5, name: 'Pharmacy', container: c.id }; }
            }
          }
          scatter(16, (x, z) => { if (surf[idx(x, z)] === SURF.asphalt) car(x, z, rng() < 0.5, region, rng); });
          for (let k = -24; k <= 24; k += 12) def.lamps.push([cx + k, cz + 4], [cx + 4, cz + k]);
          zone(`${REGION_NAMES.town} (${rx},${rz})`, cx + (rng() - 0.5) * 20, cz + (rng() - 0.5) * 20, 14, 2.5);
          break;
        }
        case 'military': {
          const x0 = ox + 8, z0 = oz + 8, x1 = ox + RS - 9, z1 = oz + RS - 9;
          fence(x0, z0, x1, z0, (cx - x0)); fence(x0, z1, x1, z1, (cx - x0)); fence(x0, z0, x0, z1, (cz - z0)); fence(x1, z0, x1, z1, (cz - z0));
          rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, (x, z) => { if (get(x, z) === C.GROUND && surf[idx(x, z)] !== SURF.asphalt) setSurf(x, z, SURF.gravel); });
          for (let k = 0; k < 5; k++) place(6, 5, { paintId: PAINT.olive, floor: SURF.concrete, doors: [['s', 1, 4]], loot: ['locker', rng() < 0.5 ? 'ammo' : 'locker'] });
          const arm = place(9, 7, { paintId: PAINT.olive, floor: SURF.concrete, doors: [['e', 3, 1]], loot: ['armory', 'ammo', 'locker'] });
          if (arm?.loot[0] && !def.pois.armory) def.pois.armory = { x: arm.loot[0].x + 0.5, z: arm.loot[0].z + 0.5, name: 'Armory', container: arm.loot[0].id };
          zone(`${REGION_NAMES.military} (${rx},${rz})`, cx, cz, 16, 2);
          def.lamps.push([x0 + 2, z0 + 2], [x1 - 2, z0 + 2], [x0 + 2, z1 - 2], [x1 - 2, z1 - 2]);
          break;
        }
        case 'warehouse': {
          const b = place(30, 20, { paintId: PAINT.metal, floor: SURF.concrete, doors: [['s', 6, 5], ['n', 18, 5], ['e', 8, 3]], loot: ['shelf', 'shelf', 'shelf', 'manifest'] }, 60);
          if (b) {
            const [x, z] = [b.x, b.z];
            for (let row = 0; row < 3; row++) for (let k = 4; k < 26; k++) if (k % 7 !== 0 && get(x + k, z + 5 + row * 5) === C.FLOOR) set(x + k, z + 5 + row * 5, C.PROP);
            const m = b.loot.find(c => c.kind === 'manifest');
            if (m && !def.pois.manifest) def.pois.manifest = { x: m.x + 0.5, z: m.z + 0.5, name: 'Shipping manifest', container: m.id };
            def.lamps.push([x + 8, z + 10], [x + 22, z + 10]);
          }
          place(8, 6, { paintId: PAINT.metal, floor: SURF.concrete, doors: [['s', 2, 3]], loot: ['toolbox', 'shelf'] });
          scatter(6, (x, z) => { if (surf[idx(x, z)] === SURF.asphalt) car(x, z, true, region, rng); });
          break;
        }
        case 'industrial': {
          // Tanks: solid squares; pipes: fence runs; sheds with toolboxes.
          for (let k = 0; k < 4; k++) {
            const x = ox + 6 + Math.floor(rng() * 50), z = oz + 6 + Math.floor(rng() * 50);
            if (fits(x, z, 5, 5)) { lots.push([x, z, x + 5, z + 5]); rect(x, z, x + 4, z + 4, (a, b2) => { set(a, b2, C.WALL); paint[idx(a, b2)] = PAINT.rust; }); }
          }
          for (let k = 0; k < 4; k++) place(8, 6, { paintId: PAINT.rust, floor: SURF.concrete, doors: [['w', 2, 2]], loot: ['toolbox', 'toolbox', 'shelf'] });
          rect(ox + 2, oz + 2, ox + RS - 3, oz + RS - 3, (x, z) => { if (get(x, z) === C.GROUND && surf[idx(x, z)] === SURF.grass && rng() < 0.7) setSurf(x, z, SURF.gravel); });
          zone(`${REGION_NAMES.industrial} (${rx},${rz})`, cx, cz, 15, 2.5);
          def.lamps.push([cx - 15, cz], [cx + 15, cz]);
          break;
        }
        case 'outpost': {
          const x0 = cx - 10, z0 = cz - 10;
          fence(x0, z0, x0 + 20, z0, 10); fence(x0, z0 + 20, x0 + 20, z0 + 20, 10); fence(x0, z0, x0, z0 + 20, 10); fence(x0 + 20, z0, x0 + 20, z0 + 20, 10);
          const shack = place(7, 6, { paintId: PAINT.plank, doors: [['s', 2, 1]], loot: ['radio', 'ammo', 'cabinet'] });
          const radio = shack?.loot.find(c => c.kind === 'radio');
          const key = rx === 2 && rz === 0 ? 'ridge' : rx === 5 && rz === 5 ? 'echo' : 'kilo';
          if (radio) def.pois[key] = { x: radio.x + 0.5, z: radio.z + 0.5, name: { ridge: 'Ridge Outpost', echo: 'Echo Outpost', kilo: 'Kilo Outpost' }[key], container: radio.id };
          def.lamps.push([cx, cz]);
          scatter(30, tree);
          break;
        }
        case 'home': {
          // Hollis Farm: farmhouse (radio + bed), barn, fields. Player start.
          const fx = cx - 12, fz = cz - 14;
          lots.push([fx, fz, fx + 12, fz + 9]);
          const loot = building(fx, fz, 12, 9, { paintId: PAINT.white, doors: [['s', 5, 2]], region, loot: ['radio', 'fridge', 'cabinet'], rng });
          const radio = loot.find(c => c.kind === 'radio');
          if (radio) def.pois.farm = { x: radio.x + 0.5, z: radio.z + 0.5, name: 'Farmhouse radio', container: radio.id };
          def.beds.push({ x: fx + 9, z: fz + 2 });
          set(fx + 9, fz + 2, C.PROP);
          const bx = cx + 6, bz = cz - 12;
          lots.push([bx, bz, bx + 12, bz + 10]);
          building(bx, bz, 12, 10, { paintId: PAINT.barn, floor: SURF.dirt, doors: [['s', 4, 4]], region, loot: ['toolbox', 'shelf'], rng });
          rect(cx - 20, cz + 6, cx + 18, cz + 22, (x, z) => { if (get(x, z) === C.GROUND && surf[idx(x, z)] !== SURF.asphalt) setSurf(x, z, SURF.field); });
          def.starts.push([fx + 6, fz + 11]);
          def.home = { x: cx, z: cz, x0: cx - 22, z0: cz - 24, x1: cx + 22, z1: cz + 24 };
          def.lamps.push([fx + 6, fz + 11]);
          scatter(16, tree, 2);
          break;
        }
      }
      // Ambient spawn anchors: open ground scattered over the region.
      for (let k = 0; k < 10; k++) {
        const x = ox + 2 + Math.floor(rng() * (RS - 4)), z = oz + 2 + Math.floor(rng() * (RS - 4));
        if (get(x, z) === C.GROUND) def.spawns.push([x, z]);
      }
    }
  }
  return def;
}
