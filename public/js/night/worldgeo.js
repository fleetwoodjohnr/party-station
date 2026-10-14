// Static map geometry with baked lighting — no three.js, no DOM, so the
// open world can build chunks in a Web Worker (geo-worker.js) while the
// hand-built Classic map builds on the main thread. Output: flat position,
// colour and texture arrays (non-indexed triangles). Lighting and ambient
// occlusion are baked into the colours (linear RGB); `tuv` is (u, v,
// layer) into the texture array (assets.js), in world units so textures
// repeat. CC0 props (trees, cars, lamp posts, furniture) arrive as baked
// triangle soups (setProps) and are merged in with the same lighting.
import { C, CEIL, WIN_LO, WIN_HI } from './sim/world.js';
import { PERKS } from './sim/weapons.js';
import { SURF, PAINT, RS, regionType } from './sim/regions.js';

// Texture-array layers (assets.js loads them in this order). Layer 0 is
// white: untextured. 'c' layers carry their own colour, 'd' layers are
// grey detail under the surface's palette colour.
export const TEX = ['white', 'grass', 'forest', 'dirt', 'field', 'asphalt', 'gravel', 'concrete', 'planks', 'tiles',
  'shingles', 'rooftiles', 'brick', 'rust', 'olive', 'siding', 'corrugated', 'plaster', 'interior', 'window'];
export const L = Object.fromEntries(TEX.map((n, i) => [n, i]));

const s2l = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export function lin(hex) {
  if (typeof hex === 'string') hex = parseInt(hex.replace('#', ''), 16);
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// Baked props, by name (assets.js → setProps; the worker gets a copy).
let PROPS = {};
export function setProps(p) { PROPS = p || {}; }

// ------------------------------------------------------------ baked light
// Moonlight from one side, warm pools under the lamps, ambient occlusion
// passed in by the caller. (Daylight is a global tint applied at draw time.)
const MOON = (() => { const v = [-0.45, 0.75, -0.5], l = Math.hypot(...v); return v.map(x => x / l); })();
const MOON_RGB = [0.62, 0.72, 1.0];
const LAMP_RGB = [1.25, 0.95, 0.62];

// Interiors of the open world bake darker: daylight brightens everything
// with one global tint, and rooms shouldn't glow at noon.
let INDOOR = 0.30;
function bake(lamps, px, py, pz, nx, ny, nz, ao, interior, out) {
  let r, g, b;
  if (interior) { r = INDOOR; g = INDOOR * 0.93; b = INDOOR; } else {
    const m = Math.max(0, nx * MOON[0] + ny * MOON[1] + nz * MOON[2]) * 0.4 + 0.19;
    r = MOON_RGB[0] * m; g = MOON_RGB[1] * m; b = MOON_RGB[2] * m;
  }
  for (let k = 0; k < lamps.length; k++) {
    const L = lamps[k];
    const dx = L[0] - px, dy = (interior ? 2.9 : 4.2) - py, dz = L[1] - pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 64) continue;
    const d = Math.sqrt(d2);
    const ndl = Math.max(0.2, (nx * dx + ny * dy + nz * dz) / d);
    const f = (1 - d / 8) ** 2 * ndl * (interior ? 1.15 : 0.8);
    r += LAMP_RGB[0] * f; g += LAMP_RGB[1] * f; b += LAMP_RGB[2] * f;
  }
  out[0] = r * ao; out[1] = g * ao; out[2] = b * ao;
  return out;
}

// Deterministic per-cell noise for colour variety.
export const hash = (x, y, k = 0) => {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

// Growable typed arrays of triangle vertices. `T` is the texture mapping
// for what's emitted next: [layer, plane, metres per repeat u, v, offset
// u, v]; plane 0 maps (x, z), 1 maps (z, y), 2 maps (x, y).
const NOTEX = [0, 0, 1, 1, 0, 0];
class Builder {
  constructor() { this.p = new Float32Array(1 << 15); this.c = new Float32Array(1 << 15); this.t = new Float32Array(1 << 15); this.n = 0; this.T = NOTEX; }
  v(q, col) {
    const k = this.n * 3;
    if (k + 3 > this.p.length) {
      for (const f of ['p', 'c', 't']) { const a = new Float32Array(this[f].length * 2); a.set(this[f]); this[f] = a; }
    }
    this.p[k] = q[0]; this.p[k + 1] = q[1]; this.p[k + 2] = q[2];
    this.c[k] = col[0]; this.c[k + 1] = col[1]; this.c[k + 2] = col[2];
    const T = this.T;
    const a = T[1] === 1 ? q[2] : q[0], b = T[1] === 0 ? q[2] : q[1];
    this.t[k] = a / T[2] + T[4]; this.t[k + 1] = b / T[3] + T[5]; this.t[k + 2] = T[0];
    this.n++;
  }
  quad(a, b, c, d, ca, cb, cc, cd) { this.v(a, ca); this.v(b, cb); this.v(c, cc); this.v(a, ca); this.v(c, cc); this.v(d, cd); }
  tri(a, b, c, ca, cb, cc) { this.v(a, ca); this.v(b, cb); this.v(c, cc); }
  result() { return this.n ? { pos: this.p.slice(0, this.n * 3), col: this.c.slice(0, this.n * 3), tuv: this.t.slice(0, this.n * 3) } : null; }
}

// ---------------------------------------------------------- world palette
const PAL = {
  tileA: lin(0xe9e1cf), tileB: lin(0x2a2328), kitchen: lin(0x8c8f93),
  grass: lin(0x3b4a2c), dirt: lin(0x4a4032), asphalt: lin(0x3a3b40), line: lin(0xd8d2b0),
  wallOut: lin(0xb9c9c3), stripe: lin(0xb3343c), base: lin(0x5c5f66),
  wallIn: lin(0xe8dcc0), wainscot: lin(0x7a2e2e), ceiling: lin(0x8b8678), roof: lin(0x2b2b30),
  counter: lin(0xc23a3a), counterTop: lin(0xd8dde0), wood: lin(0x7a5232),
  car: lin(0x6b4a3a), carTop: lin(0x7d6a5a), carDark: lin(0x18181c),
  fence: lin(0x6b5135), trunk: lin(0x3b2a1e), leaf: lin(0x1f3a26), edge: lin(0x101a14),
  sill: lin(0x8a7a62), door: lin(0x5a3c26),
  concrete: lin(0x77746c), stain: lin(0x55524b), iron: lin(0x34363c), ember: lin(0xff8a2a), gold: lin(0xe0b040),
  field: lin(0x5a4a2e), gravel: lin(0x6a665e), forest: lin(0x2c3a22), floorWood: lin(0x6e5236), tile: lin(0xbdb6a6),
};
export { PAL };
// A colour-texture layer brings its own colour: the vertex colour is just
// light × this (per layer, to even out the photos' brightness).
const TW = k => [k, k, k];
const SURF_TEX = {
  [SURF.grass]: [L.grass, TW(0.42)], [SURF.dirt]: [L.dirt, TW(0.34)], [SURF.asphalt]: [L.asphalt, TW(0.5)],
  [SURF.concrete]: [L.concrete, TW(0.42)], [SURF.field]: [L.field, TW(0.5)], [SURF.wood]: [L.planks, TW(0.55)],
  [SURF.tile]: [L.tiles, TW(0.5)], [SURF.gravel]: [L.gravel, TW(0.32)], [SURF.forest]: [L.forest, TW(0.4)],
};
// Exterior paint: [texture layer, colour]. Detail layers keep the paint.
const PAINT_TEX = {
  [PAINT.siding]: [L.siding, lin(0x9fb4c8)], [PAINT.siding2]: [L.siding, lin(0xd8c88a)], [PAINT.siding3]: [L.siding, lin(0x9db08e)],
  [PAINT.brick]: [L.brick, TW(0.55)], [PAINT.olive]: [L.olive, TW(0.6)], [PAINT.metal]: [L.corrugated, lin(0x8a8e94)],
  [PAINT.rust]: [L.rust, TW(0.55)], [PAINT.plank]: [L.siding, lin(0x8a6a48)], [PAINT.barn]: [L.siding, lin(0xa8322a)],
  [PAINT.white]: [L.siding, lin(0xe0dcd0)],
};
// Houses get pitched roofs and windows; sheds and industry stay flat-roofed.
const HOUSE = new Set([PAINT.siding, PAINT.siding2, PAINT.siding3, PAINT.white, PAINT.brick, PAINT.plank, PAINT.barn]);

function shade(col, light, k = 1, jitter = 0) {
  const j = 1 + jitter;
  return [col[0] * light[0] * k * j, col[1] * light[1] * k * j, col[2] * light[2] * k * j];
}

// A baked prop (assets.js) stood at (cx, y0, cz), turned by ry, scaled per
// axis, lit by the same moon and lamps as the walls around it.
// Model albedo is daylight colour; at night it needs a lift to read
// against the walls (whose palette is tuned for the dark).
const PGAIN = 2.2;
const PQ = [0, 0, 0], PL = [0, 0, 0], PC = [0, 0, 0];
function prop(b, lamps, P, cx, cz, ry, sx, sy = sx, sz = sx, y0 = 0, glow = 0, gain = PGAIN) {
  const { pos, col, nrm } = P;
  const c = Math.cos(ry), s = Math.sin(ry);
  b.T = NOTEX;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] * sx, z = pos[i + 2] * sz;
    PQ[0] = cx + x * c + z * s; PQ[1] = y0 + pos[i + 1] * sy; PQ[2] = cz - x * s + z * c;
    bake(lamps, PQ[0], PQ[1], PQ[2], nrm[i] * c + nrm[i + 2] * s, nrm[i + 1], -nrm[i] * s + nrm[i + 2] * c, 1, false, PL);
    PC[0] = col[i] * (PL[0] * gain + glow); PC[1] = col[i + 1] * (PL[1] * gain + glow); PC[2] = col[i + 2] * (PL[2] * gain + glow);
    b.v(PQ, PC);
  }
}
// Fit a prop's footprint to `len` metres along its longest side.
const fit = (P, len) => len / Math.max(P.size[0], P.size[2]);
const pick = (names, r) => { const a = names.filter(n => PROPS[n]); return a.length ? PROPS[a[Math.floor(r * a.length) % a.length]] : null; };

// Loot containers drawn as furniture (kind → prop, footprint in m).
const FURNITURE = { cabinet: ['drawer', 0.9], shelf: ['bookcase', 0.95], pharmacy: ['bookcase', 0.95], locker: ['lootbox', 0.85],
  toolbox: ['boxes', 0.8], manifest: ['boxes', 0.8], ammo: ['ammobox', 0.85], armory: ['ammobox', 0.9], radio: ['drawer', 0.9], fridge: ['fridge', 0.8] };

// Build cells [x0, x1) × [z0, z1) into geometry. `lamps` should already be
// filtered to the ones that can reach this patch (cost is per vertex).
export function buildCells(world, mapDef, x0, z0, x1, z1, lamps = world.lamps || []) {
  const b = new Builder();
  const L1 = [0, 0, 0], L2 = [0, 0, 0], L3 = [0, 0, 0], L4 = [0, 0, 0];
  const LS = [L1, L2, L3, L4];
  const solidish = c => c === C.WALL || c === C.VOID || c === C.WINDOW;
  const isInside = c => c === C.FLOOR || c === C.PROP || c === C.DOOR || c === C.MACHINE;
  const building = c => isInside(c) || c === C.WALL || c === C.WINDOW;
  const mach = new Map((mapDef.machines || []).map(m => [m.x + ',' + m.y, m]));
  const furn = new Map();
  for (const k of mapDef.containers || []) if (!k.onProp && FURNITURE[k.kind] && PROPS[FURNITURE[k.kind][0]]) furn.set(k.x + ',' + k.z, k);
  const inRect = (r, x, z) => r && x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
  const lot = mapDef.lot;
  const surf = world.surf, paint = world.paint, W = world.w;
  const diner = !surf; // the hand-built Classic map keeps its diner trim
  INDOOR = diner ? 0.30 : 0.16;
  // Roofed (pitched) buildings: their walls get windows.
  const pitched = (mapDef.roofs || []).filter(r => HOUSE.has(r[4]));
  const housed = (x, z) => pitched.some(r => x >= r[0] && x < r[0] + r[2] && z >= r[1] && z < r[1] + r[3]);

  // Floor-level ambient occlusion at a grid corner: darker beside walls.
  const cornerAO = (vx, vz) => {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const cc = world.cell(vx + (k & 1 ? 0 : -1), vz + (k & 2 ? 0 : -1));
      if (solidish(cc) || cc === C.PROP || cc === C.MACHINE) n++;
    }
    return 1 - n * 0.16;
  };
  const P4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  // A vertical face of a cell, from y0 to y1. side: 0=+x 1=-x 2=+z 3=-z.
  // `tex` = [layer, metres per repeat] (or a full mapping for windows).
  const face = (x, z, side, y0, y1, col, interior, k = 1, inset = 0, tex = null) => {
    const p = P4;
    let n;
    if (side === 0) { const X = x + 1 - inset; p[0] = [X, y0, z + 1]; p[1] = [X, y0, z]; p[2] = [X, y1, z]; p[3] = [X, y1, z + 1]; n = [1, 0, 0]; }
    else if (side === 1) { const X = x + inset; p[0] = [X, y0, z]; p[1] = [X, y0, z + 1]; p[2] = [X, y1, z + 1]; p[3] = [X, y1, z]; n = [-1, 0, 0]; }
    else if (side === 2) { const Z = z + 1 - inset; p[0] = [x, y0, Z]; p[1] = [x + 1, y0, Z]; p[2] = [x + 1, y1, Z]; p[3] = [x, y1, Z]; n = [0, 0, 1]; }
    else { const Z = z + inset; p[0] = [x + 1, y0, Z]; p[1] = [x, y0, Z]; p[2] = [x, y1, Z]; p[3] = [x + 1, y1, Z]; n = [0, 0, -1]; }
    const aoLo = y0 < 0.01 ? 0.62 : 1;
    const j = (hash(x, z, side) - 0.5) * 0.08;
    const cs = p.map((q, i) => shade(col, bake(lamps, q[0], q[1], q[2], n[0], n[1], n[2], i < 2 ? aoLo : 1, interior, LS[i]), k, j));
    b.T = !tex ? NOTEX : tex.length > 2 ? tex : [tex[0], side < 2 ? 1 : 2, tex[1], tex[1], 0, 0];
    b.quad(p[0], p[1], p[2], p[3], cs[0], cs[1], cs[2], cs[3]);
  };
  const flat = (x, z, y, col, interior, down = false, k = 1, fx0 = 0, fx1 = 1, fz0 = 0, fz1 = 1, ao = false, tex = null) => {
    const p = [[x + fx0, y, z + fz1], [x + fx1, y, z + fz1], [x + fx1, y, z + fz0], [x + fx0, y, z + fz0]];
    if (down) p.reverse();
    const j = (hash(x, z, 7) - 0.5) * 0.1;
    const cs = p.map((q, i) => shade(col, bake(lamps, q[0], q[1], q[2], 0, down ? -1 : 1, 0,
      ao ? cornerAO(Math.round(q[0]), Math.round(q[2])) : 1, interior, LS[i]), k, j));
    b.T = tex ? [tex[0], 0, tex[1], tex[1], 0, 0] : NOTEX;
    b.quad(p[0], p[1], p[2], p[3], cs[0], cs[1], cs[2], cs[3]);
  };
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const WIN_TEX = [L.window, 0, 1, 1.2, 0, -1.0 / 1.2]; // plane set per face below

  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const c = world.cell(x, z);
      const inside = isInside(c);
      // Ground / floor.
      if (inside) {
        if (surf) {
          const [layer, col] = SURF_TEX[surf[z * W + x]] || SURF_TEX[SURF.wood];
          flat(x, z, 0, col, true, false, 1.6, 0, 1, 0, 1, true, [layer, 2]);
        } else if (inRect(mapDef.garage, x, z)) flat(x, z, 0, hash(x, z, 4) > 0.8 ? mul(PAL.stain, 1.3) : PAL.concrete, true, false, 1.5, 0, 1, 0, 1, true, [L.concrete, 2]);
        else if (inRect(mapDef.kitchen, x, z)) flat(x, z, 0, PAL.kitchen, true, false, 1.3, 0, 1, 0, 1, true, [L.concrete, 1]);
        else flat(x, z, 0, TW(0.95), true, false, 1, 0, 1, 0, 1, true, [L.tiles, 2]);
        flat(x, z, CEIL, PAL.ceiling, true, true, 1.3, 0, 1, 0, 1, false, [L.plaster, 2]);
      } else if (c !== C.WALL && c !== C.WINDOW) {
        let col, layer;
        if (surf) {
          const s = surf[z * W + x];
          [layer, col] = SURF_TEX[s] || SURF_TEX[SURF.grass];
          if (s === SURF.asphalt && (x % 6 === 0) && hash(x, z, 2) > 0.5) col = mul(PAL.line, 0.9);
        } else if (lot && x >= lot[0] && x <= lot[2] && z >= lot[1] && z <= lot[3]) {
          [layer, col] = SURF_TEX[SURF.asphalt];
          if (x % 5 === 0 && z === lot[1] + 2) col = mul(PAL.line, 0.9);
        } else [layer, col] = SURF_TEX[hash(x, z, 3) > 0.8 ? SURF.dirt : SURF.grass];
        flat(x, z, 0, col, false, false, 1, 0, 1, 0, 1, true, [layer, 2]);
      }
      // Roof over the whole building footprint (seen from outside).
      if (building(c) && !housed(x, z)) flat(x, z, CEIL + 0.25, PAL.gravel, false, false, 0.5, 0, 1, 0, 1, false, [L.gravel, 3]);

      for (let s = 0; s < 4; s++) {
        const nc = world.cell(x + SIDES[s][0], z + SIDES[s][1]);
        const nIn = isInside(nc);
        const nOpen = nc === C.FLOOR || nc === C.GROUND || nc === C.DOOR || nc === C.PROP || nc === C.WINDOW || nc === C.CAR || nc === C.FENCE || nc === C.TREE || nc === C.MACHINE;
        if (c === C.WALL && nOpen && nc !== C.WINDOW) {
          if (nIn) {
            face(x, z, s, 0, 1.0, diner ? PAL.wainscot : mul(PAL.wallIn, 0.7), true, 1.5, 0, [diner ? L.planks : L.interior, 2]);
            face(x, z, s, 1.0, CEIL, PAL.wallIn, true, 1.3, 0, [L.interior, 2]);
          } else if (diner) {
            face(x, z, s, 0, 0.5, PAL.base, false, 1.4, 0, [L.concrete, 2]);
            face(x, z, s, 0.5, 2.55, PAL.wallOut, false, 1.3, 0, [L.plaster, 2]);
            face(x, z, s, 2.55, 2.85, PAL.stripe, false, 1.2, 0, [L.plaster, 2]);
            face(x, z, s, 2.85, CEIL + 0.25, PAL.wallOut, false, 1.3, 0, [L.plaster, 2]);
          } else {
            const [layer, pc] = PAINT_TEX[paint[z * W + x]] || [L.plaster, PAL.wallOut];
            const k = layer === L.siding || layer === L.corrugated ? 1.5 : 1;
            face(x, z, s, 0, 0.4, PAL.base, false, 1.4, 0, [L.concrete, 2]);
            // A window on most outside walls of a house (not corners).
            const along = s < 2 ? [world.cell(x, z - 1), world.cell(x, z + 1)] : [world.cell(x - 1, z), world.cell(x + 1, z)];
            if (housed(x, z) && along[0] === C.WALL && along[1] === C.WALL && hash(x, z, s + 20) < 0.55) {
              face(x, z, s, 0.4, 1.0, pc, false, k, 0, [layer, 2]);
              WIN_TEX[1] = s < 2 ? 1 : 2;
              face(x, z, s, 1.0, 2.2, pc, false, 1.35, 0, WIN_TEX);
              face(x, z, s, 2.2, CEIL + 0.25, pc, false, k, 0, [layer, 2]);
            } else face(x, z, s, 0.4, CEIL + 0.25, pc, false, k, 0, [layer, 2]);
          }
        } else if (c === C.WALL && nc === C.WINDOW) {
          face(x, z, s, WIN_LO, WIN_HI, PAL.sill, true, 1.3, 0, [L.planks, 1]); // window jamb
        } else if (c === C.WINDOW && (nc === C.FLOOR || nc === C.GROUND || nc === C.PROP)) {
          const col = nIn ? PAL.wallIn : PAL.wallOut;
          face(x, z, s, 0, WIN_LO, nIn ? PAL.wainscot : PAL.base, nIn, 1.4, 0, [nIn ? L.planks : L.concrete, 2]);
          face(x, z, s, WIN_HI, CEIL + (nIn ? 0 : 0.25), col, nIn, 1.3, 0, [nIn ? L.interior : L.plaster, 2]);
        } else if (c === C.MACHINE && nc !== C.MACHINE && (nOpen || nIn)) {
          if (mach.get(x + ',' + z)?.kind !== 'crate' || !PROPS.chest) machineFace(x, z, s, mach.get(x + ',' + z), face, b);
        } else if (c === C.PROP && nIn && nc !== C.PROP && !furn.has(x + ',' + z)) {
          face(x, z, s, 0, 0.92, diner ? PAL.counter : PAL.wood, true, 1.3, 0, [diner ? L.white : L.planks, 1]);
          face(x, z, s, 0.92, 1.0, PAL.counterTop, true);
        } else if (c === C.PROP && !nIn && nc !== C.PROP && nOpen && !furn.has(x + ',' + z)) {
          face(x, z, s, 0, 1.0, PAL.wood, false, 1.5, 0, [L.planks, 1]); // outdoor crates / benches
        } else if (c === C.CAR && nc !== C.CAR && nOpen && !PROPS.car1) {
          face(x, z, s, 0, 0.3, PAL.carDark, false);
          face(x, z, s, 0.3, 0.95, PAL.car, false);
        } else if (c === C.VOID && nOpen) {
          face(x, z, s, 0, 5, PAL.edge, false, 0.9);
        } else if (c === C.FENCE && nc !== C.FENCE && nOpen) {
          const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
          const fk = along ? SIDES[s][1] !== 0 : SIDES[s][0] !== 0;
          face(x, z, s, 0, 1.2, PAL.fence, false, fk ? 1.6 : 1.3, 0.42, [L.planks, 1.2]);
        }
      }
      if (c === C.WINDOW) {
        flat(x, z, WIN_LO, PAL.sill, false, false, 1.3, 0, 1, 0, 1, false, [L.planks, 1]);
        flat(x, z, WIN_HI, PAL.sill, false, true, 0.9, 0, 1, 0, 1, false, [L.planks, 1]);
      }
      if (c === C.PROP && !furn.has(x + ',' + z)) flat(x, z, 1.0, PAL.counterTop, inside, false, 1.05);
      if (c === C.MACHINE) {
        const m = mach.get(x + ',' + z);
        if (m?.kind === 'crate' && PROPS.chest) {
          // The mystery crate: a glowing treasure chest.
          if (world.cell(x - 1, z) !== C.MACHINE && world.cell(x, z - 1) !== C.MACHINE) prop(b, lamps, PROPS.chest, x + 0.5, z + 0.5, 0, fit(PROPS.chest, 1.0), undefined, undefined, 0, 0.35);
        } else {
          const [h2, top] = m?.kind === 'forge' ? [1.3, PAL.ember] : [2.1, PAL.iron];
          flat(x, z, m?.kind === 'crate' ? 0.95 : h2, m?.kind === 'crate' ? PAL.wood : top, true, false, m?.kind === 'forge' ? 2.2 : 1);
        }
      }
      const fur = furn.get(x + ',' + z);
      if (fur) {
        // Turn the furniture's back to the nearest wall.
        const [name, len] = FURNITURE[fur.kind];
        const P = PROPS[name];
        let ry = 0;
        for (let s = 0; s < 4; s++) if (solidish(world.cell(x + SIDES[s][0], z + SIDES[s][1]))) { ry = [Math.PI / 2, -Math.PI / 2, 0, Math.PI][s] + Math.PI; break; }
        prop(b, lamps, P, x + 0.5, z + 0.5, ry, fit(P, len));
      }
      if (c === C.CAR) {
        const first = world.cell(x - 1, z) !== C.CAR && world.cell(x, z - 1) !== C.CAR;
        const horiz = world.cell(x + 1, z) === C.CAR;
        const P = pick(['car1', 'car1', 'car2', 'car3', 'car4'], hash(x, z, 31));
        if (P && first) {
          // A wreck spans two cells; real cars are longer, so it overhangs a bit.
          const ry = (horiz ? Math.PI / 2 : 0) + (hash(x, z, 32) < 0.5 ? Math.PI : 0) + (hash(x, z, 33) - 0.5) * 0.25;
          const along = P.size[2] >= P.size[0];
          prop(b, lamps, P, x + (horiz ? 1 : 0.5), z + (horiz ? 0.5 : 1), ry + (along ? 0 : Math.PI / 2), fit(P, 3.0));
        } else if (!P) {
          flat(x, z, 0.95, PAL.carTop, false);
          // Cabin on the car's first cell only, inset — reads as a wreck.
          if (first) {
            const cx0 = 0.2, cx1 = horiz ? 1.6 : 0.8, cz0 = 0.15, cz1 = horiz ? 0.85 : 1.6;
            flat(x, z, 1.4, PAL.carTop, false, false, 0.9, cx0, cx1, cz0, cz1);
            const dark = shade(PAL.carDark, [0.25, 0.27, 0.32]);
            b.T = NOTEX;
            const q = (a, bb, cc, d) => b.quad(a, bb, cc, d, dark, dark, dark, dark);
            q([x + cx0, 0.95, z + cz1], [x + cx1, 0.95, z + cz1], [x + cx1, 1.4, z + cz1], [x + cx0, 1.4, z + cz1]);
            q([x + cx1, 0.95, z + cz0], [x + cx0, 0.95, z + cz0], [x + cx0, 1.4, z + cz0], [x + cx1, 1.4, z + cz0]);
            q([x + cx1, 0.95, z + cz1], [x + cx1, 0.95, z + cz0], [x + cx1, 1.4, z + cz0], [x + cx1, 1.4, z + cz1]);
            q([x + cx0, 0.95, z + cz0], [x + cx0, 0.95, z + cz1], [x + cx0, 1.4, z + cz1], [x + cx0, 1.4, z + cz0]);
          }
        }
      }
      if (c === C.FENCE) {
        const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
        if (along) flat(x, z, 1.2, PAL.fence, false, false, 1.5, 0, 1, 0.42, 0.58, false, [L.planks, 1]);
        else flat(x, z, 1.2, PAL.fence, false, false, 1.5, 0.42, 0.58, 0, 1, false, [L.planks, 1]);
      }
      if (c === C.TREE) {
        const r = hash(x, z, 9);
        const P = pick(['pine', 'pine', 'pine', 'tree', 'deadtree'], r);
        if (P) prop(b, lamps, P, x + 0.5 + (hash(x, z, 10) - 0.5) * 0.4, z + 0.5 + (hash(x, z, 11) - 0.5) * 0.4, r * 6.28, (5.5 + r * 2.5) / P.size[1] * 1);
        else tree(b, lamps, x + 0.5, z + 0.5, r);
      }
      // Litter by the walls of town and industry, rocks in the woods (no
      // collision, so all of it small).
      if (c === C.GROUND && surf && hash(x, z, 40) < 0.035) {
        const t = regionType(Math.floor(x / RS), Math.floor(z / RS));
        const byWall = SIDES.some(([dx, dz]) => world.cell(x + dx, z + dz) === C.WALL);
        const P = t === 'forest' ? PROPS.rock
          : byWall && t !== 'outpost' && t !== 'military' && pick(['bag', 'smallboxes', 'trashcan', 'pallet'], hash(x, z, 41));
        if (P) prop(b, lamps, P, x + 0.5, z + 0.5, hash(x, z, 42) * 6.28, fit(P, P === PROPS.rock ? 0.5 + hash(x, z, 43) * 0.4 : 0.75));
      }
    }
  }
  // Lamp posts (outdoors) and ceiling lights (in the diner), whose cells
  // fall in this patch. Their heads glow: unlit colour on top of the bake.
  for (const [lx, lz] of mapDef.lamps || []) {
    if (lx < x0 || lx >= x1 || lz < z0 || lz >= z1) continue;
    const out = world.cell(Math.floor(lx), Math.floor(lz)) === C.GROUND;
    const P = out ? PROPS.streetlight : PROPS.ceilinglight;
    if (!P) continue;
    if (out) {
      // Pole on the kerb, head out over the lamp's spot.
      const k = 4.6 / P.size[1];
      prop(b, lamps, P, lx - P.top[0] * k, lz - P.top[1] * k, 0, k, k, k, 0, 0, 0.9); // painted grey, not white
    } else { const k = 0.85 / P.size[1]; prop(b, lamps, P, lx, lz, 0, k, k, k, CEIL - 0.85, 1.2); }
  }
  for (const r of pitched) if (r[0] >= x0 && r[0] < x1 && r[1] >= z0 && r[1] < z1) roof(b, lamps, r);
  // The farm's water tower, out past the farmhouse.
  const H = mapDef.home, T = PROPS.watertower;
  if (H && T && H.x - 17 >= x0 && H.x - 17 < x1 && H.z - 3 >= z0 && H.z - 3 < z1) prop(b, lamps, T, H.x - 17, H.z - 3, 0.4, 9 / T.size[1]);
  return b.result();
}

// A gable roof over a building footprint [x0, z0, w, h]: ridge along the
// long side, shingles (or clay tiles on the barn and farmhouse), gable
// ends in the wall's paint.
function roof(b, lamps, [x0, z0, w, h, paintId]) {
  const o = 0.35, base = CEIL + 0.25;
  const alongX = w >= h, span = alongX ? h : w;
  const rise = Math.min(3, span * 0.38);
  const layer = paintId === PAINT.barn || paintId === PAINT.white ? L.rooftiles : L.shingles;
  const col = [0.5, 0.5, 0.5];
  const Lc = [0, 0, 0];
  const lit = (q, n) => shade(col, bake(lamps, q[0], q[1], q[2], n[0], n[1], n[2], 1, false, Lc));
  const slope = Math.hypot(span / 2 + o, rise);
  if (alongX) {
    const xa = x0 - o, xb = x0 + w + o, zA = z0 - o, zB = z0 + h + o, zm = z0 + h / 2, top = base + rise;
    const n1 = [0, (span / 2 + o) / slope, -rise / slope], n2 = [0, n1[1], -n1[2]];
    // Texture v runs up the slope (plane (x, y) with v = distance up it).
    b.T = [layer, 2, 2, 2 * (rise / slope), 0, 0];
    let a = [xa, base, zA], bb = [xb, base, zA], c = [xb, top, zm], d = [xa, top, zm];
    b.quad(a, d, c, bb, lit(a, n1), lit(d, n1), lit(c, n1), lit(bb, n1));
    a = [xb, base, zB]; bb = [xa, base, zB]; c = [xa, top, zm]; d = [xb, top, zm];
    b.quad(a, d, c, bb, lit(a, n2), lit(d, n2), lit(c, n2), lit(bb, n2));
    gable(b, lamps, [x0, base, z0], [x0, base, z0 + h], [x0, top, zm], [-1, 0, 0], paintId);
    gable(b, lamps, [x0 + w, base, z0 + h], [x0 + w, base, z0], [x0 + w, top, zm], [1, 0, 0], paintId);
  } else {
    const zA = z0 - o, zB = z0 + h + o, xA = x0 - o, xB = x0 + w + o, xm = x0 + w / 2, top = base + rise;
    const n1 = [-rise / slope, (span / 2 + o) / slope, 0], n2 = [-n1[0], n1[1], 0];
    b.T = [layer, 1, 2, 2 * (rise / slope), 0, 0];
    let a = [xA, base, zB], bb = [xA, base, zA], c = [xm, top, zA], d = [xm, top, zB];
    b.quad(a, d, c, bb, lit(a, n1), lit(d, n1), lit(c, n1), lit(bb, n1));
    a = [xB, base, zA]; bb = [xB, base, zB]; c = [xm, top, zB]; d = [xm, top, zA];
    b.quad(a, d, c, bb, lit(a, n2), lit(d, n2), lit(c, n2), lit(bb, n2));
    gable(b, lamps, [x0 + w, base, z0], [x0, base, z0], [xm, top, z0], [0, 0, -1], paintId);
    gable(b, lamps, [x0, base, z0 + h], [x0 + w, base, z0 + h], [xm, top, z0 + h], [0, 0, 1], paintId);
  }
}
function gable(b, lamps, p0, p1, p2, n, paintId) {
  const [layer, pc] = PAINT_TEX[paintId] || [L.siding, PAL.wallOut];
  const Lc = [0, 0, 0];
  const col = q => shade(pc, bake(lamps, q[0], q[1], q[2], n[0], n[1], n[2], 1, false, Lc), layer === L.siding ? 1.5 : 1);
  b.T = [layer, n[0] !== 0 ? 1 : 2, 2, 2, 0, 0];
  b.tri(p0, p1, p2, col(p0), col(p1), col(p2));
}

// The hand-built map, all at once, cut into 16×16-cell pieces (each one a
// mesh the renderer can frustum-cull).
export function buildWorld(world, mapDef) {
  const out = [];
  for (let z = 0; z < world.h; z += 16) {
    for (let x = 0; x < world.w; x += 16) {
      const g = buildCells(world, mapDef, x, z, Math.min(world.w, x + 16), Math.min(world.h, z + 16));
      if (g) out.push(g);
    }
  }
  return out;
}

// Lamps that can light a patch (8 m reach plus a margin).
export function lampsNear(lamps, x0, z0, x1, z1) {
  return lamps.filter(([x, z]) => x > x0 - 9 && x < x1 + 9 && z > z0 - 9 && z < z1 + 9);
}

// Perk machines, the mystery crate and the Forge: a body plus a band of
// colour that ignores the baked light, so it reads as lit from inside.
const GLOW = [1.35, 1.35, 1.35];
function machineFace(x, z, s, m, face, b) {
  if (m?.kind === 'crate') {
    face(x, z, s, 0, 0.8, PAL.wood, true, 1.5, 0, [L.planks, 1]);
    face(x, z, s, 0.8, 0.95, PAL.gold, true, 1.3);
    return;
  }
  if (m?.kind === 'forge') {
    face(x, z, s, 0, 1.1, PAL.iron, true, 1.6, 0, [L.rust, 1.5]);
    face(x, z, s, 1.1, 1.3, PAL.ember, true, 2.2);
    return;
  }
  const col = lin(PERKS[m?.perk]?.color || '#888888');
  face(x, z, s, 0, 1.2, mul(col, 0.45), true, 1.4, 0, [L.corrugated, 1.2]);
  // The lit sign: drawn with flat light so it glows in the dark diner.
  const p = s === 0 ? [[x + 1, 1.25, z + 1], [x + 1, 1.25, z], [x + 1, 1.9, z], [x + 1, 1.9, z + 1]]
    : s === 1 ? [[x, 1.25, z], [x, 1.25, z + 1], [x, 1.9, z + 1], [x, 1.9, z]]
      : s === 2 ? [[x, 1.25, z + 1], [x + 1, 1.25, z + 1], [x + 1, 1.9, z + 1], [x, 1.9, z + 1]]
        : [[x + 1, 1.25, z], [x, 1.25, z], [x, 1.9, z], [x + 1, 1.9, z]];
  const lit = shade(col, GLOW);
  b.T = NOTEX;
  b.quad(p[0], p[1], p[2], p[3], lit, lit, lit, lit);
  face(x, z, s, 1.9, 2.1, mul(col, 0.35), true);
}

// Low-poly pine (when no tree model is loaded): a trunk and two cones.
function tree(b, lamps, cx, cz, r) {
  const s = 0.85 + r * 0.4;
  const tw = 0.18;
  const corners = [[-tw, -tw], [tw, -tw], [tw, tw], [-tw, tw]];
  const Lc = [0, 0, 0];
  b.T = NOTEX;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const nx = (az + bz) === 0 ? Math.sign(ax + bx) : 0, nz = (ax + bx) === 0 ? Math.sign(az + bz) : 0;
    const col = shade(PAL.trunk, bake(lamps, cx, 1, cz, nx, 0, nz, 1, false, Lc));
    b.quad([cx + bx, 0, cz + bz], [cx + ax, 0, cz + az], [cx + ax, 2.2 * s, cz + az], [cx + bx, 2.2 * s, cz + bz], col, col, col, col);
  }
  for (const [y0, y1, rad] of [[1.6, 4.6, 1.7], [3.3, 6.6, 1.2]]) {
    const top = [cx, y1 * s, cz];
    for (let i = 0; i < 6; i++) {
      const a0 = i / 6 * Math.PI * 2 + r, a1 = (i + 1) / 6 * Math.PI * 2 + r;
      const p0 = [cx + Math.cos(a0) * rad * s, y0 * s, cz + Math.sin(a0) * rad * s];
      const p1 = [cx + Math.cos(a1) * rad * s, y0 * s, cz + Math.sin(a1) * rad * s];
      const am = (a0 + a1) / 2;
      const nx = Math.cos(am) * 0.8, nz = Math.sin(am) * 0.8;
      const cb = shade(PAL.leaf, bake(lamps, p0[0], p0[1], p0[2], nx, 0.5, nz, 0.75, false, [0, 0, 0]), 1, (hash(i, y0 | 0, 5) - 0.5) * 0.2);
      const ct = shade(PAL.leaf, bake(lamps, cx, top[1], cz, nx, 0.5, nz, 1.1, false, [0, 0, 0]));
      b.tri(p1, p0, top, cb, cb, ct);
      b.tri(p0, p1, [cx, y0 * s, cz], cb, cb, cb);
    }
  }
}
