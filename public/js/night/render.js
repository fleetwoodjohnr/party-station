// three.js view of the simulation, built for a Raspberry Pi 4 GPU:
// every static surface is merged per chunk with its lighting baked into
// vertex colours (worldgeo.js; MeshBasicMaterial — no runtime lights, no
// shadows). Small maps build at once; the open world streams 32-cell
// chunks built in a Web Worker. Zombies are one InstancedMesh per body
// part (~5 draw calls for the whole horde, animated procedurally), and the
// weapon is drawn in a second pass so it never clips into walls. Day and
// night, and the flashlight, are one shared shader patch.
import * as THREE from '/vendor/three/three.module.js';
import { CEIL, WIN_LO, WIN_HI, MAX_BOARDS } from './sim/world.js';
import { ZTYPES, S } from './sim/zombies.js';
import { buildWorld, hash } from './worldgeo.js';

export { THREE };

const lin = hex => new THREE.Color(hex); // sRGB hex -> linear rgb (ColorManagement)

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
      exploder: [0xb8b06a, 0x8a7a3a], warden: [0x6a2a24, 0x1e1a1a], climber: [0xa8b090, 0x33333c],
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

// ---------------------------------------------------------- flashlight
// One patch for every MeshBasicMaterial that should catch the torch: a
// cone around the view axis that brightens what it falls on, fading with
// distance. Uniforms are shared, so one value switches it everywhere.
const FLASH = { value: 0 };
function torchable(mat) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uFlash = FLASH;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTorch;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTorch = mvPosition.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFlash;\nvarying vec3 vTorch;')
      .replace('#include <fog_fragment>', `if (uFlash > 0.0) {
          float d = length(vTorch);
          float cone = smoothstep(0.82, 0.97, -vTorch.z / max(d, 0.001));
          float att = clamp(1.0 - d / 24.0, 0.0, 1.0) * (0.35 + 0.65 * smoothstep(0.4, 2.8, d));
          gl_FragColor.rgb = gl_FragColor.rgb * (1.0 + uFlash * cone * att * 2.2) + uFlash * cone * att * 0.02;
        }
        #include <fog_fragment>`);
  };
  mat.customProgramCacheKey = () => 'torch';
  return mat;
}

// ---------------------------------------------------------- open world
// Streams 32×32-cell chunks around the camera: built in geo-worker.js,
// uploaded here, dropped again once far behind.
const CH = 32, LOAD_R = 2.6, DROP_R = 4;
class Streamer {
  constructor(view, world, def) {
    this.view = view;
    this.chunks = new Map(); // key -> mesh | 'pending' | null
    this.pending = 0;
    this.worker = new Worker(new URL('./geo-worker.js', import.meta.url), { type: 'module' });
    this.worker.postMessage({ t: 'world', def: {
      name: def.name, w: def.w, h: def.h, cells: def.cells, surf: def.surf, paint: def.paint,
      lamps: def.lamps, spawns: [], starts: def.starts, containers: [], pois: {}, zones: [], beds: [], regions: [],
    } });
    this.worker.onmessage = ({ data: m }) => {
      if (m.t !== 'chunk') return;
      this.pending--;
      if (this.chunks.get(m.key) !== 'pending') return; // dropped while building
      if (m.empty) { this.chunks.set(m.key, null); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, view.staticMat);
      mesh.matrixAutoUpdate = false;
      view.scene.add(mesh);
      this.chunks.set(m.key, mesh);
    };
  }
  update(x, z) {
    const cx = x / CH, cz = z / CH;
    // Request the nearest missing chunk(s); two in flight at most.
    let best = null, bd = Infinity;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      const kx = Math.floor(cx) + dx, kz = Math.floor(cz) + dz;
      if (kx < 0 || kz < 0 || kx * CH >= this.view.world.w || kz * CH >= this.view.world.h) continue;
      const d = Math.hypot(kx + 0.5 - cx, kz + 0.5 - cz);
      if (d > LOAD_R || this.chunks.has(kx + ',' + kz)) continue;
      if (d < bd) { bd = d; best = [kx, kz]; }
    }
    if (best && this.pending < 2) {
      const key = best[0] + ',' + best[1];
      this.chunks.set(key, 'pending');
      this.pending++;
      const x0 = best[0] * CH, z0 = best[1] * CH;
      this.worker.postMessage({ t: 'chunk', key, x0, z0, x1: Math.min(this.view.world.w, x0 + CH), z1: Math.min(this.view.world.h, z0 + CH) });
    }
    for (const [key, mesh] of this.chunks) {
      const [kx, kz] = key.split(',').map(Number);
      if (Math.hypot(kx + 0.5 - cx, kz + 0.5 - cz) <= DROP_R) continue;
      if (mesh && mesh !== 'pending') { this.view.scene.remove(mesh); mesh.geometry.dispose(); }
      this.chunks.delete(key);
    }
  }
  loaded() { let n = 0; for (const m of this.chunks.values()) if (m && m !== 'pending') n++; return n; }
  dispose() {
    this.worker.terminate();
    for (const mesh of this.chunks.values()) if (mesh && mesh !== 'pending') { this.view.scene.remove(mesh); mesh.geometry.dispose(); }
    this.chunks.clear();
  }
}

// ------------------------------------------------------------- renderer
const NIGHT_SKY = lin(0x0a0f1e), DAY_SKY = lin(0x8fa6bf), DUSK_SKY = lin(0x6a4a5a);

export class View {
  constructor(holder) {
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
    this.scene.background = NIGHT_SKY.clone();
    this.scene.fog = new THREE.Fog(NIGHT_SKY.clone(), 10, 44);
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 70);
    this.staticMat = torchable(new THREE.MeshBasicMaterial({ vertexColors: true }));
    this._sky();
    // First-person weapon, drawn after a depth clear so it never clips.
    this.vmScene = new THREE.Scene();
    this.vmCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 5);
    this.vm = null;
    this.res = { w: 960, h: 540 };
    this.setResolution(960, 540);
    this.statics = [];
    this.doors = {};
  }

  // Show a world: the hand-built map is built whole; the open world streams.
  setWorld(world, mapDef, pool) {
    for (const m of this.statics) { this.scene.remove(m); m.geometry.dispose(); }
    this.statics = [];
    for (const m of Object.values(this.doors)) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.doors = {};
    this.streamer?.dispose(); this.streamer = null;
    if (this.horde) for (const m of [this.horde.torso, this.horde.head, this.horde.arm, this.horde.leg, this.horde.extra]) { this.scene.remove(m); m.geometry.dispose(); }
    if (this.boards) { this.scene.remove(this.boards.mesh); this.boards.mesh.geometry.dispose(); }
    this.world = world;
    if (world.openWorld) {
      this.streamer = new Streamer(this, world, mapDef);
      this.scene.fog.far = 60; this.camera.far = 80;
    } else {
      for (const g0 of buildWorld(world, mapDef)) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(g0.pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(g0.col, 3));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.staticMat);
        m.matrixAutoUpdate = false;
        this.scene.add(m);
        this.statics.push(m);
      }
      this.scene.fog.far = 44; this.camera.far = 70;
      for (const d of Object.values(world.doors)) {
        const xs = d.cells.map(c => c[0]), zs = d.cells.map(c => c[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, z0 = Math.min(...zs), z1 = Math.max(...zs) + 1;
        const g = partGeo(x1 - x0 - 0.04, CEIL - 0.02, z1 - z0 - 0.04, false);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0x5a3c26).multiplyScalar(0.8) }));
        m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
        this.scene.add(m);
        this.doors[d.id] = m;
      }
    }
    this.camera.updateProjectionMatrix();
    this.horde = new Horde(this.scene, pool);
    torchable(this.horde.torso.material);
    this.boards = new Boards(this.scene, world);
  }

  _sky() {
    // Moon (or sun) disc + a scatter of stars; both ignore fog.
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(3.2, 20),
      new THREE.MeshBasicMaterial({ color: lin(0xf3ead0), fog: false }));
    this.moon.position.set(-38, 34, -50);
    this.moon.lookAt(0, 0, 0);
    this.scene.add(this.moon);
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

  // 0 = midnight, 1 = noon. Tints every baked surface (they're lit for
  // night), and moves fog, sky, stars and the moon/sun.
  setDaylight(k, dusk = 0) {
    k = Math.max(0, Math.min(1, k));
    const tint = 1 + k * 1.55;
    this.staticMat.color.setRGB(tint, tint * 0.98, tint * (0.95 + 0.05 * (1 - k)));
    this.horde?.torso.material.color.setScalar(0.65 + 0.5 * k);
    const sky = this.scene.background;
    sky.copy(NIGHT_SKY).lerp(DAY_SKY, k).lerp(DUSK_SKY, dusk * 0.6);
    this.scene.fog.color.copy(sky);
    this.scene.fog.near = 10 + k * 15;
    this.stars.visible = k < 0.3;
    this.moon.material.color.set(k > 0.5 ? 0xfff6d0 : 0xf3ead0);
  }

  setFlashlight(on) { FLASH.value = on ? 1 : 0; }

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
    this.moon.position.set(x - 38, 34, z - 50);
  }

  render(now) {
    this.streamer?.update(this.camera.position.x, this.camera.position.z);
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
    this.streamer?.dispose();
    this.renderer.dispose();
    this.scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.vmScene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
