// three.js view of the simulation, built for a Raspberry Pi 4 GPU:
// every static surface is merged per 16×16-cell chunk with its lighting
// baked into vertex colours (MeshBasicMaterial — no runtime lights, no
// shadows), zombies are one InstancedMesh per body part (~4 draw calls for
// the whole horde, animated procedurally), and the weapon is drawn in a
// second pass so it never clips into walls.
import * as THREE from '/vendor/three/three.module.js';
import { C, CEIL, WIN_LO, WIN_HI, MAX_BOARDS } from './sim/world.js';
import { ZTYPES, S } from './sim/zombies.js';
import { PERKS } from './sim/weapons.js';

export { THREE };

const lin = hex => new THREE.Color(hex); // sRGB hex -> linear rgb (ColorManagement)

// ------------------------------------------------------------ baked light
// Moonlight from one side, warm pools under the lamps, ambient occlusion
// passed in by the caller. Computed once per vertex at build time.
const MOON = new THREE.Vector3(-0.45, 0.75, -0.5).normalize();
const MOON_RGB = [0.62, 0.72, 1.0];
const LAMP_RGB = [1.25, 0.95, 0.62];

function bake(world, px, py, pz, nx, ny, nz, ao, interior, out) {
  let r, g, b;
  if (interior) { r = 0.30; g = 0.28; b = 0.30; } else {
    const m = Math.max(0, nx * MOON.x + ny * MOON.y + nz * MOON.z) * 0.4 + 0.19;
    r = MOON_RGB[0] * m; g = MOON_RGB[1] * m; b = MOON_RGB[2] * m;
  }
  for (const [lx, lz] of world.lamps) {
    const dx = lx - px, dy = (interior ? 2.9 : 4.2) - py, dz = lz - pz;
    const d = Math.hypot(dx, dy, dz);
    if (d > 8) continue;
    const ndl = Math.max(0.2, (nx * dx + ny * dy + nz * dz) / d);
    const f = (1 - d / 8) ** 2 * ndl * (interior ? 1.15 : 0.8);
    r += LAMP_RGB[0] * f; g += LAMP_RGB[1] * f; b += LAMP_RGB[2] * f;
  }
  out[0] = r * ao; out[1] = g * ao; out[2] = b * ao;
  return out;
}

// Deterministic per-cell noise for colour variety.
const hash = (x, y, k = 0) => {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

// Accumulates quads/triangles with vertex colours into one geometry.
class Builder {
  constructor() { this.pos = []; this.col = []; }
  // Quad corners in CCW order seen from the front; one colour per corner.
  quad(a, b, c, d, ca, cb, cc, cd) {
    this.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    this.col.push(...ca, ...cb, ...cc, ...ca, ...cc, ...cd);
  }
  tri(a, b, c, ca, cb, cc) {
    this.pos.push(...a, ...b, ...c);
    this.col.push(...ca, ...cb, ...cc);
  }
  geometry() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------- world geometry
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
};

function shade(col, light, k = 1, jitter = 0) {
  const j = 1 + jitter;
  return [col.r * light[0] * k * j, col.g * light[1] * k * j, col.b * light[2] * k * j];
}

export function buildWorld(world, mapDef) {
  const chunks = new Map();
  const B = (x, z) => {
    const k = (x >> 4) + ',' + (z >> 4);
    if (!chunks.has(k)) chunks.set(k, new Builder());
    return chunks.get(k);
  };
  const L = [0, 0, 0], L2 = [0, 0, 0], L3 = [0, 0, 0], L4 = [0, 0, 0];
  const solidish = c => c === C.WALL || c === C.VOID || c === C.WINDOW;
  const isInside = c => c === C.FLOOR || c === C.PROP || c === C.DOOR || c === C.MACHINE;
  const building = c => isInside(c) || c === C.WALL || c === C.WINDOW;
  const mach = new Map((mapDef.machines || []).map(m => [m.x + ',' + m.y, m]));
  const inRect = (r, x, z) => r && x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
  const lot = mapDef.lot;
  const inLot = (x, z) => lot && x >= lot[0] && x <= lot[2] && z >= lot[1] && z <= lot[3];

  // Floor-level ambient occlusion at a grid corner: darker beside walls.
  const cornerAO = (vx, vz) => {
    let n = 0;
    for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const cc = world.cell(vx + dx, vz + dz);
      if (solidish(cc) || cc === C.PROP || cc === C.MACHINE) n++;
    }
    return 1 - n * 0.16;
  };

  // A vertical face of a cell, from y0 to y1. side: 0=+x 1=-x 2=+z 3=-z.
  const face = (b, x, z, side, y0, y1, col, interior, k = 1, inset = 0) => {
    let p, n;
    if (side === 0) { p = [[x + 1 - inset, y0, z + 1], [x + 1 - inset, y0, z], [x + 1 - inset, y1, z], [x + 1 - inset, y1, z + 1]]; n = [1, 0, 0]; }
    else if (side === 1) { p = [[x + inset, y0, z], [x + inset, y0, z + 1], [x + inset, y1, z + 1], [x + inset, y1, z]]; n = [-1, 0, 0]; }
    else if (side === 2) { p = [[x, y0, z + 1 - inset], [x + 1, y0, z + 1 - inset], [x + 1, y1, z + 1 - inset], [x, y1, z + 1 - inset]]; n = [0, 0, 1]; }
    else { p = [[x + 1, y0, z + inset], [x, y0, z + inset], [x, y1, z + inset], [x + 1, y1, z + inset]]; n = [0, 0, -1]; }
    const aoLo = y0 < 0.01 ? 0.62 : 1;
    const j = (hash(x, z, side) - 0.5) * 0.08;
    const cs = p.map((q, i) => shade(col, bake(world, q[0], q[1], q[2], ...n, i < 2 ? aoLo : 1, interior, [L, L2, L3, L4][i]), k, j));
    b.quad(p[0], p[1], p[2], p[3], ...cs);
  };
  const flat = (b, x, z, y, col, interior, down = false, k = 1, x0 = 0, x1 = 1, z0 = 0, z1 = 1, ao = false) => {
    const p = [[x + x0, y, z + z1], [x + x1, y, z + z1], [x + x1, y, z + z0], [x + x0, y, z + z0]];
    if (down) p.reverse();
    const j = (hash(x, z, 7) - 0.5) * 0.1;
    const cs = p.map((q, i) => shade(col, bake(world, q[0], q[1], q[2], 0, down ? -1 : 1, 0,
      ao ? cornerAO(Math.round(q[0]), Math.round(q[2])) : 1, interior, [L, L2, L3, L4][i]), k, j));
    b.quad(p[0], p[1], p[2], p[3], ...cs);
  };
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let z = 0; z < world.h; z++) {
    for (let x = 0; x < world.w; x++) {
      const c = world.cell(x, z);
      const b = B(x, z);
      const inside = isInside(c);
      // Ground / floor.
      if (inside) {
        const tile = inRect(mapDef.garage, x, z) ? (hash(x, z, 4) > 0.8 ? PAL.stain : PAL.concrete)
          : inRect(mapDef.kitchen, x, z) ? PAL.kitchen : ((x + z) & 1 ? PAL.tileA : PAL.tileB);
        flat(b, x, z, 0, tile, true, false, 1, 0, 1, 0, 1, true);
        flat(b, x, z, CEIL, PAL.ceiling, true, true, 0.9);
      } else if (c !== C.WALL && c !== C.WINDOW) {
        let col = PAL.grass;
        if (inLot(x, z)) col = (x % 5 === 0 && z === lot[1] + 2) ? PAL.line : PAL.asphalt;
        else if (hash(x, z, 3) > 0.7) col = PAL.dirt;
        flat(b, x, z, 0, col, false, false, 1, 0, 1, 0, 1, true);
      }
      // Roof over the whole building footprint (seen from outside).
      if (building(c)) flat(b, x, z, CEIL + 0.25, PAL.roof, false);

      for (let s = 0; s < 4; s++) {
        const [dx, dz] = SIDES[s];
        const nc = world.cell(x + dx, z + dz);
        const nIn = isInside(nc);
        const nOpen = nc === C.FLOOR || nc === C.GROUND || nc === C.DOOR || nc === C.PROP || nc === C.WINDOW || nc === C.CAR || nc === C.FENCE || nc === C.TREE || nc === C.MACHINE;
        if (c === C.WALL && nOpen && nc !== C.WINDOW) {
          if (nIn) {
            face(b, x, z, s, 0, 1.0, PAL.wainscot, true);
            face(b, x, z, s, 1.0, CEIL, PAL.wallIn, true);
          } else {
            face(b, x, z, s, 0, 0.5, PAL.base, false);
            face(b, x, z, s, 0.5, 2.55, PAL.wallOut, false);
            face(b, x, z, s, 2.55, 2.85, PAL.stripe, false);
            face(b, x, z, s, 2.85, CEIL + 0.25, PAL.wallOut, false);
          }
        } else if (c === C.WALL && nc === C.WINDOW) {
          face(b, x, z, s, WIN_LO, WIN_HI, PAL.sill, true, 0.8); // window jamb
        } else if (c === C.WINDOW && (nc === C.FLOOR || nc === C.GROUND || nc === C.PROP)) {
          const col = nIn ? PAL.wallIn : PAL.wallOut;
          face(b, x, z, s, 0, WIN_LO, nIn ? PAL.wainscot : PAL.base, nIn);
          face(b, x, z, s, WIN_HI, CEIL + (nIn ? 0 : 0.25), col, nIn);
        } else if (c === C.MACHINE && nc !== C.MACHINE && (nOpen || nIn)) {
          machineFace(b, x, z, s, mach.get(x + ',' + z), face);
        } else if (c === C.PROP && nIn && nc !== C.PROP) {
          face(b, x, z, s, 0, 0.92, PAL.counter, true);
          face(b, x, z, s, 0.92, 1.0, PAL.counterTop, true);
        } else if (c === C.CAR && nc !== C.CAR && nOpen) {
          face(b, x, z, s, 0, 0.3, PAL.carDark, false);
          face(b, x, z, s, 0.3, 0.95, PAL.car, false);
        } else if (c === C.VOID && nOpen) {
          face(b, x, z, s, 0, 5, PAL.edge, false, 0.9);
        } else if (c === C.FENCE && nc !== C.FENCE && nOpen) {
          const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
          if (along ? dz !== 0 : dx !== 0) face(b, x, z, s, 0, 1.2, PAL.fence, false, 1, 0.42);
          else face(b, x, z, s, 0, 1.2, PAL.fence, false, 0.8, 0.42);
        }
      }
      if (c === C.WINDOW) {
        flat(b, x, z, WIN_LO, PAL.sill, false);
        flat(b, x, z, WIN_HI, PAL.sill, false, true, 0.7);
      }
      if (c === C.PROP) flat(b, x, z, 1.0, PAL.counterTop, true, false, 1.05);
      if (c === C.MACHINE) {
        const m = mach.get(x + ',' + z);
        const [h2, top] = m?.kind === 'crate' ? [0.95, PAL.wood] : m?.kind === 'forge' ? [1.3, PAL.ember] : [2.1, PAL.iron];
        flat(b, x, z, h2, top, true, false, m?.kind === 'forge' ? 2.2 : 1);
      }
      if (c === C.CAR) {
        flat(b, x, z, 0.95, PAL.carTop, false);
        // Cabin on the car's first cell only, inset — reads as a wreck.
        if (world.cell(x - 1, z) !== C.CAR && world.cell(x, z - 1) !== C.CAR) {
          const horiz = world.cell(x + 1, z) === C.CAR;
          const cx0 = 0.2, cx1 = horiz ? 1.6 : 0.8, cz0 = 0.15, cz1 = horiz ? 0.85 : 1.6;
          flat(b, x, z, 1.4, PAL.carTop, false, false, 0.9, cx0, cx1, cz0, cz1);
          const q = (a, bb, cc, d) => b.quad(a, bb, cc, d, ...[a, bb, cc, d].map(() => shade(PAL.carDark, [0.25, 0.27, 0.32])));
          q([x + cx0, 0.95, z + cz1], [x + cx1, 0.95, z + cz1], [x + cx1, 1.4, z + cz1], [x + cx0, 1.4, z + cz1]);
          q([x + cx1, 0.95, z + cz0], [x + cx0, 0.95, z + cz0], [x + cx0, 1.4, z + cz0], [x + cx1, 1.4, z + cz0]);
          q([x + cx1, 0.95, z + cz1], [x + cx1, 0.95, z + cz0], [x + cx1, 1.4, z + cz0], [x + cx1, 1.4, z + cz1]);
          q([x + cx0, 0.95, z + cz0], [x + cx0, 0.95, z + cz1], [x + cx0, 1.4, z + cz1], [x + cx0, 1.4, z + cz0]);
        }
      }
      if (c === C.FENCE) {
        const along = world.cell(x + 1, z) === C.FENCE || world.cell(x - 1, z) === C.FENCE;
        if (along) flat(b, x, z, 1.2, PAL.fence, false, false, 1, 0, 1, 0.42, 0.58);
        else flat(b, x, z, 1.2, PAL.fence, false, false, 1, 0.42, 0.58, 0, 1);
      }
      if (c === C.TREE) tree(b, world, x + 0.5, z + 0.5, hash(x, z, 9));
    }
  }
  const meshes = [];
  for (const b of chunks.values()) {
    const g = b.geometry();
    if (g) meshes.push(g);
  }
  return meshes;
}

// Perk machines, the mystery crate and the Forge: a body plus a band of
// colour that ignores the baked light, so it reads as lit from inside.
const GLOW = [1.35, 1.35, 1.35];
function machineFace(b, x, z, s, m, face) {
  if (m?.kind === 'crate') {
    face(b, x, z, s, 0, 0.8, PAL.wood, true);
    face(b, x, z, s, 0.8, 0.95, PAL.gold, true, 1.3);
    return;
  }
  if (m?.kind === 'forge') {
    face(b, x, z, s, 0, 1.1, PAL.iron, true);
    face(b, x, z, s, 1.1, 1.3, PAL.ember, true, 2.2);
    return;
  }
  const col = lin(PERKS[m?.perk]?.color || '#888888');
  face(b, x, z, s, 0, 1.2, col.clone().multiplyScalar(0.45), true);
  // The lit sign: drawn with flat light so it glows in the dark diner.
  const p = s === 0 ? [[x + 1, 1.25, z + 1], [x + 1, 1.25, z], [x + 1, 1.9, z], [x + 1, 1.9, z + 1]]
    : s === 1 ? [[x, 1.25, z], [x, 1.25, z + 1], [x, 1.9, z + 1], [x, 1.9, z]]
      : s === 2 ? [[x, 1.25, z + 1], [x + 1, 1.25, z + 1], [x + 1, 1.9, z + 1], [x, 1.9, z + 1]]
        : [[x + 1, 1.25, z], [x, 1.25, z], [x, 1.9, z], [x + 1, 1.9, z]];
  const lit = shade(col, GLOW);
  b.quad(p[0], p[1], p[2], p[3], lit, lit, lit, lit);
  face(b, x, z, s, 1.9, 2.1, col.clone().multiplyScalar(0.35), true);
}

// Low-poly pine: a trunk and two six-sided cones, colours baked.
function tree(b, world, cx, cz, r) {
  const L = [0, 0, 0];
  const s = 0.85 + r * 0.4;
  const trunkC = PAL.trunk, leaf = PAL.leaf;
  const tw = 0.18;
  const corners = [[-tw, -tw], [tw, -tw], [tw, tw], [-tw, tw]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const nx = (az + bz) === 0 ? Math.sign(ax + bx) : 0, nz = (ax + bx) === 0 ? Math.sign(az + bz) : 0;
    const col = shade(trunkC, bake(world, cx, 1, cz, nx, 0, nz, 1, false, L));
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
      const cb = shade(leaf, bake(world, p0[0], p0[1], p0[2], nx, 0.5, nz, 0.75, false, [0, 0, 0]), 1, (hash(i, y0 | 0, 5) - 0.5) * 0.2);
      const ct = shade(leaf, bake(world, cx, top[1], cz, nx, 0.5, nz, 1.1, false, [0, 0, 0]));
      b.tri(p1, p0, top, cb, cb, ct);
      b.tri(p0, p1, [cx, y0 * s, cz], cb, cb, cb);
    }
  }
}

// --------------------------------------------------------------- zombies
// Box parts with a top-lit gradient baked in; instanceColor tints them.
function partGeo(w, h, d, pivotTop) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, pivotTop ? -h / 2 : h / 2, 0);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = pivotTop ? (y + h) / h : y / h;
    const v = 0.55 + 0.45 * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

class Horde {
  constructor(scene, pool) {
    this.pool = pool;
    const n = pool.n;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mk = (geo, count) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // instances roam; one bound would be wrong
      m.count = 0;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      return m;
    };
    this.torso = mk(partGeo(0.46, 0.62, 0.27, false), n);
    this.head = mk(partGeo(0.3, 0.32, 0.3, false), n);
    this.arm = mk(partGeo(0.12, 0.64, 0.12, true), n * 2);
    this.leg = mk(partGeo(0.16, 0.8, 0.17, true), n * 2);
    // Unit box for everything type-specific: helmets, vests, sacs, horns.
    this.extra = mk(partGeo(1, 1, 1, false), n * 3);
    this.m = new THREE.Matrix4(); this.root = new THREE.Matrix4(); this.loc = new THREE.Matrix4();
    this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3();
    this.col = new THREE.Color();
    this.skins = [0x7d9a6c, 0x8fa27a, 0x6e8466, 0x9aa07c, 0x7a8a72].map(lin);
    this.cloth = [0x4a4a5c, 0x6b3a3a, 0x3a4f6b, 0x5c5236, 0x3f5c45, 0x705a4a].map(lin);
    this.pants = [0x2b2d38, 0x3a3226, 0x2e3b4a].map(lin);
    // Per-type skin / shirt overrides (null = the random palette).
    this.look = {
      runner: [null, 0x7a2222], crawler: [0x6a7a5c, 0x3a3a3a], armored: [null, 0x3c4238],
      brute: [0x5f6f52, 0x5a4636], spitter: [0x8fbf5a, 0x4a5a2a], screamer: [0xc9c7b6, 0x6a6a72],
      exploder: [0xb8b06a, 0x8a7a3a], warden: [0x6a2a24, 0x1e1a1a],
    };
    for (const k of Object.keys(this.look)) this.look[k] = this.look[k].map(c => (c == null ? null : lin(c)));
    this.helmetC = lin(0x3f4636); this.plateC = lin(0x2f342c); this.sacC = lin(0x9be05a); this.hornC = lin(0xd8cfb8);
    this.fuseC = lin(0xffe04a);
  }

  _put(mesh, idx, x, y, z, rx, ry, rz, s = 1, sy = s, sz = s) {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.loc.compose(this.v.set(x, y, z), this.q, this.sc.set(s, sy, sz));
    this.m.multiplyMatrices(this.root, this.loc);
    mesh.setMatrixAt(idx, this.m);
  }

  update(now) {
    const P = this.pool;
    let k = 0, x = 0;
    const ex = (px, py, pz, rx, ry, rz, w, h, d, col) => {
      this._put(this.extra, x, px, py, pz, rx, ry, rz, w, h, d);
      this.extra.setColorAt(x++, col);
    };
    for (let i = 0; i < P.n; i++) {
      const st = P.state[i];
      if (st === S.FREE) continue;
      const T = ZTYPES[P.type[i]];
      const seed = P.seed[i];
      const walk = P.walk[i];
      let fall = 0, sink = 0;
      if (st === S.DYING) {
        const t = P.t[i];
        fall = Math.min(1, t / 0.55);
        sink = Math.max(0, t - 0.9) * 1.2;
      }
      this.e.set(-fall * (T.crawl ? 0.2 : 1.45), P.yaw[i], 0, 'YXZ');
      this.q.setFromEuler(this.e);
      const s = T.size * (0.94 + (seed % 13) / 100);
      this.root.compose(this.v.set(P.x[i], P.y[i] - sink, P.z[i]), this.q, this.sc.set(s, s, s));
      const moving = st === S.CHASE || st === S.CHARGE ? 1 : 0.2;
      const swing = Math.sin(walk) * 0.55 * moving;
      const bob = Math.abs(Math.cos(walk)) * 0.05 * moving;
      const fl = P.flinch[i];
      const sway = Math.sin(now * 1.7 + seed) * 0.08;
      const look = this.look[T.id] || [];
      const hot = 1 + fl * 0.8 + (P.burnT[i] > 0 ? 0.6 + Math.sin(now * 30 + i) * 0.3 : 0);
      const headGone = st === S.DYING && P.headKill[i];
      if (T.crawl) {
        // Belly on the floor, dragging itself on its arms.
        this._put(this.torso, k, 0, 0.22, 0.05, 1.45, 0, sway * 0.5);
        this._put(this.head, k, 0, 0.32, -0.55, 0.3 + sway, sway * 2, 0, headGone ? 0.001 : 1);
        this._put(this.leg, k * 2, -0.11, 0.2, 0.6, 1.6 + swing * 0.2, 0, 0.1);
        this._put(this.leg, k * 2 + 1, 0.11, 0.2, 0.6, 1.6 - swing * 0.2, 0, -0.1);
        this._put(this.arm, k * 2, -0.25, 0.3, -0.45, -1.4 + Math.sin(walk) * 0.6, 0, 0.2);
        this._put(this.arm, k * 2 + 1, 0.25, 0.3, -0.45, -1.4 - Math.sin(walk) * 0.6, 0, -0.2);
      } else {
        const lean = T.id === 'brute' || T.id === 'warden' ? 0.3 : 0.18;
        this._put(this.leg, k * 2, -0.11, 0.8 + bob, 0, swing, 0, 0);
        this._put(this.leg, k * 2 + 1, 0.11, 0.8 + bob, 0, -swing, 0, 0);
        const bloat = T.id === 'exploder' ? 1.35 : 1;
        this._put(this.torso, k, 0, 0.8 + bob, 0, lean - fl * 0.35, 0, sway * 0.6, bloat, 1, bloat);
        let armX = -1.3 + Math.sin(walk * 0.5 + seed) * 0.12;
        if (st === S.ATTACK) armX = -2.1 + Math.min(1, P.t[i] / 0.42) * 1.9;
        if (st === S.BREACH) armX = -1.5 + Math.sin(P.t[i] * 9) * 0.5;
        if (st === S.SLAM) armX = -3.0 + Math.min(1, P.t[i] / 0.9) * 2.6;
        if (st === S.SCREAM) armX = -2.6;
        if (st === S.SPIT) armX = -0.4;
        if (T.id === 'screamer' && st === S.CHASE) armX = -0.3;
        this._put(this.arm, k * 2, -0.3 * bloat, 1.38 + bob, 0.04, armX + swing * 0.3, 0, 0.1);
        this._put(this.arm, k * 2 + 1, 0.3 * bloat, 1.38 + bob, 0.04, armX - swing * 0.3, 0, -0.1);
        const headTilt = st === S.SCREAM || st === S.SPIT ? -0.5 : 0.15 + sway;
        this._put(this.head, k, 0, 1.42 + bob, 0.02, headTilt, sway * 2, sway, headGone ? 0.001 : 1);
        // Type extras, in the same root space.
        if (P.helmet[i] > 0) ex(0, 1.72 + bob, 0.02, 0.15, 0, 0, 0.34, 0.12, 0.34, this.helmetC);
        if (P.vest[i] > 0) ex(0, 0.95 + bob, 0.0, lean, 0, 0, 0.52, 0.42, 0.33, this.plateC);
        if (T.id === 'spitter') ex(0, 1.15 + bob, 0.2, lean, 0, 0, 0.3, 0.32, 0.18, this.sacC);
        if (T.id === 'warden') {
          ex(-0.12, 1.78 + bob, 0, 0, 0, 0.5, 0.06, 0.18, 0.06, this.hornC);
          ex(0.12, 1.78 + bob, 0, 0, 0, -0.5, 0.06, 0.18, 0.06, this.hornC);
        }
        if (st === S.FUSE) ex(0, 1.0, 0, 0, now * 6, 0, 0.62 + Math.sin(now * 40) * 0.06, 0.6, 0.45, this.fuseC);
      }
      // Colours: per-zombie skin / shirt / trousers, flashing on hits.
      this.col.copy(look[0] || this.skins[seed % 5]).multiplyScalar(hot);
      this.head.setColorAt(k, this.col);
      this.arm.setColorAt(k * 2, this.col); this.arm.setColorAt(k * 2 + 1, this.col);
      this.col.copy(look[1] || this.cloth[(seed >>> 3) % 6]).multiplyScalar(hot);
      this.torso.setColorAt(k, this.col);
      this.col.copy(this.pants[(seed >>> 6) % 3]);
      this.leg.setColorAt(k * 2, this.col); this.leg.setColorAt(k * 2 + 1, this.col);
      k++;
    }
    for (const m of [this.torso, this.head]) { m.count = k; }
    for (const m of [this.arm, this.leg]) { m.count = k * 2; }
    this.extra.count = x;
    for (const m of [this.torso, this.head, this.arm, this.leg, this.extra]) {
      if (!m.count) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    return k;
  }
}

// ---------------------------------------------------------------- boards
class Boards {
  constructor(scene, world) {
    this.world = world;
    const g = partGeo(1.0, 0.17, 0.06, false);
    g.translate(0, -0.085, 0);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }), world.windows.length * MAX_BOARDS);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());
    scene.add(this.mesh);
    this.shown = world.windows.map(() => -1);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler();
    this.v = new THREE.Vector3(); this.s = new THREE.Vector3(1, 1, 1); this.c = new THREE.Color();
    this.wood = [0x8a6a44, 0x7a5a3a, 0x9a7a52].map(lin);
  }
  update() {
    let dirty = false;
    this.world.windows.forEach((W, wi) => { if (W.boards !== this.shown[wi]) { this.shown[wi] = W.boards; dirty = true; } });
    if (!dirty) return;
    let k = 0;
    this.world.windows.forEach((W, wi) => {
      const ox = W.out[0] - W.x, oz = W.out[1] - W.y;
      const along = ox !== 0 ? Math.PI / 2 : 0; // board spans the opening
      for (let b = 0; b < W.boards; b++) {
        const r = hash(wi, b, 11);
        const y = WIN_LO + 0.12 + b * ((WIN_HI - WIN_LO - 0.2) / (MAX_BOARDS - 1));
        this.e.set(0, along, (r - 0.5) * 0.35, 'YXZ');
        this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(W.x + 0.5 + ox * 0.42, y, W.y + 0.5 + oz * 0.42), this.q, this.s.set(1.15, 1, 1));
        this.mesh.setMatrixAt(k, this.m);
        this.mesh.setColorAt(k, this.c.copy(this.wood[b % 3]).multiplyScalar(0.55));
        k++;
      }
    });
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------------- renderer
export class View {
  constructor(holder, world, mapDef, pool) {
    this.world = world;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:auto';
    holder.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = false;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));

    this.scene = new THREE.Scene();
    const sky = lin(0x0a0f1e);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 10, 44);
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 70);

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.static = buildWorld(world, mapDef).map(g => {
      const m = new THREE.Mesh(g, mat);
      m.matrixAutoUpdate = false;
      this.scene.add(m);
      return m;
    });
    this._sky();
    this.doors = {};
    for (const d of Object.values(world.doors)) {
      const xs = d.cells.map(c => c[0]), zs = d.cells.map(c => c[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, z0 = Math.min(...zs), z1 = Math.max(...zs) + 1;
      const g = partGeo(x1 - x0 - 0.04, CEIL - 0.02, z1 - z0 - 0.04, false);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, color: PAL.door.clone().multiplyScalar(0.8) }));
      m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      this.scene.add(m);
      this.doors[d.id] = m;
    }
    this.horde = new Horde(this.scene, pool);
    this.boards = new Boards(this.scene, world);

    // First-person weapon, drawn after a depth clear so it never clips.
    this.vmScene = new THREE.Scene();
    this.vmCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 5);
    this.vm = null;
    this.res = { w: 960, h: 540 };
    this.setResolution(960, 540);
  }

  _sky() {
    // Moon disc + a scatter of stars; both ignore fog.
    const moon = new THREE.Mesh(new THREE.CircleGeometry(3.2, 20),
      new THREE.MeshBasicMaterial({ color: lin(0xf3ead0), fog: false }));
    moon.position.set(-38, 34, -50);
    moon.lookAt(0, 0, 0);
    this.scene.add(moon);
    const pts = [];
    for (let i = 0; i < 260; i++) {
      const a = hash(i, 1) * Math.PI * 2, e = 0.15 + hash(i, 2) * 1.2;
      pts.push(Math.cos(a) * Math.cos(e) * 60, Math.sin(e) * 60, Math.sin(a) * Math.cos(e) * 60);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfc8ff, size: 1.5, sizeAttenuation: false, fog: false }));
    this.scene.add(this.stars);
  }

  // Internal render size; CSS stretches the canvas over the screen.
  setResolution(w, h) {
    w = Math.round(w); h = Math.round(h);
    if (w === this.res.w && h === this.res.h && this._sized) return;
    this._sized = true;
    this.res = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.vmCam.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCam.updateProjectionMatrix();
  }

  setViewmodel(obj) {
    if (this.vm) this.vmScene.remove(this.vm);
    this.vm = obj;
    if (obj) this.vmScene.add(obj);
  }

  // Camera from an eye position + yaw/pitch (yaw 0 looks toward -z).
  setEye(x, y, z, yaw, pitch, roll = 0) {
    this.camera.position.set(x, y, z);
    this.camera.rotation.set(pitch, yaw, roll, 'YXZ');
    this.stars.position.set(x, 0, z);
  }

  render(now) {
    const live = this.horde.update(now);
    this.boards.update();
    for (const [id, m] of Object.entries(this.doors)) m.visible = !this.world.doors[id].open;
    const r = this.renderer;
    r.info.reset();
    r.clear();
    r.render(this.scene, this.camera);
    if (this.vm) {
      r.clearDepth();
      r.render(this.vmScene, this.vmCam);
    }
    return live;
  }

  dispose() {
    this.renderer.dispose();
    this.scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.vmScene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
