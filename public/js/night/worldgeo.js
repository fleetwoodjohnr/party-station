// Static map geometry with baked lighting — no three.js, no DOM, so the
// open world can build chunks in a Web Worker (geo-worker.js) while the
// hand-built Classic map builds on the main thread. Output: flat position
// and colour arrays (non-indexed triangles), lighting and ambient
// occlusion baked into the colours. Colours are linear RGB.
import { C, CEIL, WIN_LO, WIN_HI } from './sim/world.js';
import { PERKS } from './sim/weapons.js';
import { SURF, PAINT } from './sim/regions.js';

const s2l = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export function lin(hex) {
  if (typeof hex === 'string') hex = parseInt(hex.replace('#', ''), 16);
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

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

// Growable typed arrays of triangle vertices.
class Builder {
  constructor() { this.p = new Float32Array(1 << 15); this.c = new Float32Array(1 << 15); this.n = 0; }
  v(q, col) {
    const k = this.n * 3;
    if (k + 3 > this.p.length) {
      const p = new Float32Array(this.p.length * 2); p.set(this.p); this.p = p;
      const c = new Float32Array(this.c.length * 2); c.set(this.c); this.c = c;
    }
    this.p[k] = q[0]; this.p[k + 1] = q[1]; this.p[k + 2] = q[2];
    this.c[k] = col[0]; this.c[k + 1] = col[1]; this.c[k + 2] = col[2];
    this.n++;
  }
  quad(a, b, c, d, ca, cb, cc, cd) { this.v(a, ca); this.v(b, cb); this.v(c, cc); this.v(a, ca); this.v(c, cc); this.v(d, cd); }
  tri(a, b, c, ca, cb, cc) { this.v(a, ca); this.v(b, cb); this.v(c, cc); }
  result() { return this.n ? { pos: this.p.slice(0, this.n * 3), col: this.c.slice(0, this.n * 3) } : null; }
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
const SURF_COL = {
  [SURF.grass]: PAL.grass, [SURF.dirt]: PAL.dirt, [SURF.asphalt]: PAL.asphalt, [SURF.concrete]: PAL.concrete,
  [SURF.field]: PAL.field, [SURF.wood]: PAL.floorWood, [SURF.tile]: PAL.tile, [SURF.gravel]: PAL.gravel, [SURF.forest]: PAL.forest,
};
const PAINT_COL = {
  [PAINT.siding]: lin(0x9fb4c8), [PAINT.siding2]: lin(0xd8c88a), [PAINT.siding3]: lin(0x9db08e), [PAINT.brick]: lin(0x8a4a3a),
  [PAINT.olive]: lin(0x5a6342), [PAINT.metal]: lin(0x8a8e94), [PAINT.rust]: lin(0x7a4a2e), [PAINT.plank]: lin(0x6e5236),
  [PAINT.barn]: lin(0x8e2a24), [PAINT.white]: lin(0xd8d4c8),
};

function shade(col, light, k = 1, jitter = 0) {
  const j = 1 + jitter;
  return [col[0] * light[0] * k * j, col[1] * light[1] * k * j, col[2] * light[2] * k * j];
}

// Build cells [x0, x1) × [z0, z1) into geometry. `lamps` should already be
// filtered to the ones that can reach this patch (cost is per vertex).
export function buildCells(world, mapDef, x0, z0, x1, z1, lamps = world.lamps || []) {
  const b = new Builder();
  const L = [0, 0, 0], L2 = [0, 0, 0], L3 = [0, 0, 0], L4 = [0, 0, 0];
  const LS = [L, L2, L3, L4];
  const solidish = c => c === C.WALL || c === C.VOID || c === C.WINDOW;
  const isInside = c => c === C.FLOOR || c === C.PROP || c === C.DOOR || c === C.MACHINE;
  const building = c => isInside(c) || c === C.WALL || c === C.WINDOW;
  const mach = new Map((mapDef.machines || []).map(m => [m.x + ',' + m.y, m]));
  const inRect = (r, x, z) => r && x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
  const lot = mapDef.lot;
  const surf = world.surf, paint = world.paint, W = world.w;
  const diner = !surf; // the hand-built Classic map keeps its diner trim
  INDOOR = diner ? 0.30 : 0.16;

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
  const face = (x, z, side, y0, y1, col, interior, k = 1, inset = 0) => {
    const p = P4;
    let n;
    if (side === 0) { const X = x + 1 - inset; p[0] = [X, y0, z + 1]; p[1] = [X, y0, z]; p[2] = [X, y1, z]; p[3] = [X, y1, z + 1]; n = [1, 0, 0]; }
    else if (side === 1) { const X = x + inset; p[0] = [X, y0, z]; p[1] = [X, y0, z + 1]; p[2] = [X, y1, z + 1]; p[3] = [X, y1, z]; n = [-1, 0, 0]; }
    else if (side === 2) { const Z = z + 1 - inset; p[0] = [x, y0, Z]; p[1] = [x + 1, y0, Z]; p[2] = [x + 1, y1, Z]; p[3] = [x, y1, Z]; n = [0, 0, 1]; }
    else { const Z = z + inset; p[0] = [x + 1, y0, Z]; p[1] = [x, y0, Z]; p[2] = [x, y1, Z]; p[3] = [x + 1, y1, Z]; n = [0, 0, -1]; }
    const aoLo = y0 < 0.01 ? 0.62 : 1;
    const j = (hash(x, z, side) - 0.5) * 0.08;
    const cs = p.map((q, i) => shade(col, bake(lamps, q[0], q[1], q[2], n[0], n[1], n[2], i < 2 ? aoLo : 1, interior, LS[i]), k, j));
    b.quad(p[0], p[1], p[2], p[3], cs[0], cs[1], cs[2], cs[3]);
  };
  const flat = (x, z, y, col, interior, down = false, k = 1, fx0 = 0, fx1 = 1, fz0 = 0, fz1 = 1, ao = false) => {
    const p = [[x + fx0, y, z + fz1], [x + fx1, y, z + fz1], [x + fx1, y, z + fz0], [x + fx0, y, z + fz0]];
    if (down) p.reverse();
    const j = (hash(x, z, 7) - 0.5) * 0.1;
    const cs = p.map((q, i) => shade(col, bake(lamps, q[0], q[1], q[2], 0, down ? -1 : 1, 0,
      ao ? cornerAO(Math.round(q[0]), Math.round(q[2])) : 1, interior, LS[i]), k, j));
    b.quad(p[0], p[1], p[2], p[3], cs[0], cs[1], cs[2], cs[3]);
  };
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const c = world.cell(x, z);
      const inside = isInside(c);
      // Ground / floor.
      if (inside) {
        const tile = surf ? SURF_COL[surf[z * W + x]] || PAL.floorWood
          : inRect(mapDef.garage, x, z) ? (hash(x, z, 4) > 0.8 ? PAL.stain : PAL.concrete)
            : inRect(mapDef.kitchen, x, z) ? PAL.kitchen : ((x + z) & 1 ? PAL.tileA : PAL.tileB);
        flat(x, z, 0, tile, true, false, 1, 0, 1, 0, 1, true);
        flat(x, z, CEIL, PAL.ceiling, true, true, 0.9);
      } else if (c !== C.WALL && c !== C.WINDOW) {
        let col = PAL.grass;
        if (surf) {
          col = SURF_COL[surf[z * W + x]] || PAL.grass;
          if (surf[z * W + x] === SURF.asphalt && (x % 6 === 0) && hash(x, z, 2) > 0.5) col = mul(PAL.line, 0.7);
        } else if (lot && x >= lot[0] && x <= lot[2] && z >= lot[1] && z <= lot[3]) col = (x % 5 === 0 && z === lot[1] + 2) ? PAL.line : PAL.asphalt;
        else if (hash(x, z, 3) > 0.7) col = PAL.dirt;
        flat(x, z, 0, col, false, false, 1, 0, 1, 0, 1, true);
      }
      // Roof over the whole building footprint (seen from outside).
      if (building(c)) flat(x, z, CEIL + 0.25, PAL.roof, false);

      for (let s = 0; s < 4; s++) {
        const nc = world.cell(x + SIDES[s][0], z + SIDES[s][1]);
        const nIn = isInside(nc);
        const nOpen = nc === C.FLOOR || nc === C.GROUND || nc === C.DOOR || nc === C.PROP || nc === C.WINDOW || nc === C.CAR || nc === C.FENCE || nc === C.TREE || nc === C.MACHINE;
        if (c === C.WALL && nOpen && nc !== C.WINDOW) {
          if (nIn) {
            face(x, z, s, 0, 1.0, diner ? PAL.wainscot : mul(PAL.wallIn, 0.7), true);
            face(x, z, s, 1.0, CEIL, PAL.wallIn, true);
          } else if (diner) {
            face(x, z, s, 0, 0.5, PAL.base, false);
            face(x, z, s, 0.5, 2.55, PAL.wallOut, false);
            face(x, z, s, 2.55, 2.85, PAL.stripe, false);
            face(x, z, s, 2.85, CEIL + 0.25, PAL.wallOut, false);
          } else {
            const pc = PAINT_COL[paint[z * W + x]] || PAL.wallOut;
            face(x, z, s, 0, 0.4, PAL.base, false);
            face(x, z, s, 0.4, CEIL + 0.25, pc, false);
          }
        } else if (c === C.WALL && nc === C.WINDOW) {
          face(x, z, s, WIN_LO, WIN_HI, PAL.sill, true, 0.8); // window jamb
        } else if (c === C.WINDOW && (nc === C.FLOOR || nc === C.GROUND || nc === C.PROP)) {
          const col = nIn ? PAL.wallIn : PAL.wallOut;
          face(x, z, s, 0, WIN_LO, nIn ? PAL.wainscot : PAL.base, nIn);
          face(x, z, s, WIN_HI, CEIL + (nIn ? 0 : 0.25), col, nIn);
        } else if (c === C.MACHINE && nc !== C.MACHINE && (nOpen || nIn)) {
          machineFace(x, z, s, mach.get(x + ',' + z), face, b);
        } else if (c === C.PROP && nIn && nc !== C.PROP) {
          face(x, z, s, 0, 0.92, diner ? PAL.counter : PAL.wood, true);
          face(x, z, s, 0.92, 1.0, PAL.counterTop, true);
        } else if (c === C.PROP && !nIn && nc !== C.PROP && nOpen) {
          face(x, z, s, 0, 1.0, PAL.wood, false); // outdoor crates / benches
        } else if (c === C.CAR && nc !== C.CAR && nOpen) {
          face(x, z, s, 0, 0.3, PAL.carDark, false);
          face(x, z, s, 0.3, 0.95, PAL.car, false);
        } else if (c === C.VOID && nOpen) {
          face(x, z, s, 0, 5, PAL.edge, false, 0.9);
        } else if (c === C.FENCE && nc !== C.FENCE && nOpen) {
          const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
          if (along ? SIDES[s][1] !== 0 : SIDES[s][0] !== 0) face(x, z, s, 0, 1.2, PAL.fence, false, 1, 0.42);
          else face(x, z, s, 0, 1.2, PAL.fence, false, 0.8, 0.42);
        }
      }
      if (c === C.WINDOW) {
        flat(x, z, WIN_LO, PAL.sill, false);
        flat(x, z, WIN_HI, PAL.sill, false, true, 0.7);
      }
      if (c === C.PROP) flat(x, z, 1.0, PAL.counterTop, inside, false, 1.05);
      if (c === C.MACHINE) {
        const m = mach.get(x + ',' + z);
        const [h2, top] = m?.kind === 'crate' ? [0.95, PAL.wood] : m?.kind === 'forge' ? [1.3, PAL.ember] : [2.1, PAL.iron];
        flat(x, z, h2, top, true, false, m?.kind === 'forge' ? 2.2 : 1);
      }
      if (c === C.CAR) {
        flat(x, z, 0.95, PAL.carTop, false);
        // Cabin on the car's first cell only, inset — reads as a wreck.
        if (world.cell(x - 1, z) !== C.CAR && world.cell(x, z - 1) !== C.CAR) {
          const horiz = world.cell(x + 1, z) === C.CAR;
          const cx0 = 0.2, cx1 = horiz ? 1.6 : 0.8, cz0 = 0.15, cz1 = horiz ? 0.85 : 1.6;
          flat(x, z, 1.4, PAL.carTop, false, false, 0.9, cx0, cx1, cz0, cz1);
          const dark = shade(PAL.carDark, [0.25, 0.27, 0.32]);
          const q = (a, bb, cc, d) => b.quad(a, bb, cc, d, dark, dark, dark, dark);
          q([x + cx0, 0.95, z + cz1], [x + cx1, 0.95, z + cz1], [x + cx1, 1.4, z + cz1], [x + cx0, 1.4, z + cz1]);
          q([x + cx1, 0.95, z + cz0], [x + cx0, 0.95, z + cz0], [x + cx0, 1.4, z + cz0], [x + cx1, 1.4, z + cz0]);
          q([x + cx1, 0.95, z + cz1], [x + cx1, 0.95, z + cz0], [x + cx1, 1.4, z + cz0], [x + cx1, 1.4, z + cz1]);
          q([x + cx0, 0.95, z + cz0], [x + cx0, 0.95, z + cz1], [x + cx0, 1.4, z + cz1], [x + cx0, 1.4, z + cz0]);
        }
      }
      if (c === C.FENCE) {
        const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
        if (along) flat(x, z, 1.2, PAL.fence, false, false, 1, 0, 1, 0.42, 0.58);
        else flat(x, z, 1.2, PAL.fence, false, false, 1, 0.42, 0.58, 0, 1);
      }
      if (c === C.TREE) tree(b, lamps, x + 0.5, z + 0.5, hash(x, z, 9));
    }
  }
  return b.result();
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
    face(x, z, s, 0, 0.8, PAL.wood, true);
    face(x, z, s, 0.8, 0.95, PAL.gold, true, 1.3);
    return;
  }
  if (m?.kind === 'forge') {
    face(x, z, s, 0, 1.1, PAL.iron, true);
    face(x, z, s, 1.1, 1.3, PAL.ember, true, 2.2);
    return;
  }
  const col = lin(PERKS[m?.perk]?.color || '#888888');
  face(x, z, s, 0, 1.2, mul(col, 0.45), true);
  // The lit sign: drawn with flat light so it glows in the dark diner.
  const p = s === 0 ? [[x + 1, 1.25, z + 1], [x + 1, 1.25, z], [x + 1, 1.9, z], [x + 1, 1.9, z + 1]]
    : s === 1 ? [[x, 1.25, z], [x, 1.25, z + 1], [x, 1.9, z + 1], [x, 1.9, z]]
      : s === 2 ? [[x, 1.25, z + 1], [x + 1, 1.25, z + 1], [x + 1, 1.9, z + 1], [x, 1.9, z + 1]]
        : [[x + 1, 1.25, z], [x, 1.25, z], [x, 1.9, z], [x + 1, 1.9, z]];
  const lit = shade(col, GLOW);
  b.quad(p[0], p[1], p[2], p[3], lit, lit, lit, lit);
  face(x, z, s, 1.9, 2.1, mul(col, 0.35), true);
}

// Low-poly pine: a trunk and two six-sided cones, colours baked.
function tree(b, lamps, cx, cz, r) {
  const s = 0.85 + r * 0.4;
  const tw = 0.18;
  const corners = [[-tw, -tw], [tw, -tw], [tw, tw], [-tw, tw]];
  const L = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const nx = (az + bz) === 0 ? Math.sign(ax + bx) : 0, nz = (ax + bx) === 0 ? Math.sign(az + bz) : 0;
    const col = shade(PAL.trunk, bake(lamps, cx, 1, cz, nx, 0, nz, 1, false, L));
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
