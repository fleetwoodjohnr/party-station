// three.js view of the simulation, built for a Raspberry Pi 4 GPU:
// every static surface is merged per chunk with its lighting baked into
// vertex colours (worldgeo.js; MeshBasicMaterial — no runtime lights, no
// shadows). Small maps build at once; the open world streams 32-cell
// chunks built in a Web Worker. Zombies are one InstancedMesh per body
// part (~5 draw calls for the whole horde, animated procedurally), and the
// weapon is drawn in a second pass so it never clips into walls. Day and
// night, and the flashlight, are one shared shader patch.
import * as THREE from '/vendor/three/three.module.js';
import { C, CEIL, WIN_LO, WIN_HI, MAX_BOARDS } from './sim/world.js';
import { ZTYPES, S } from './sim/zombies.js';
import { buildWorld, hash, L } from './worldgeo.js';
import { clone as cloneSkinned } from '/vendor/three/addons/SkeletonUtils.js';
import { assets } from './assets.js';
import { gunModel } from './gear.js';

export { THREE };

const lin = hex => new THREE.Color(hex); // sRGB hex -> linear rgb (ColorManagement)

// Box parts with a top-lit gradient baked in (boards, doors), textured
// with one layer of the world's texture array.
function partGeo(w, h, d, pivotTop, layer = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, pivotTop ? -h / 2 : h / 2, 0);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3), tuv = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = pivotTop ? (y + h) / h : y / h;
    const v = 0.55 + 0.45 * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
    tuv[i * 3] = pos.getX(i) + pos.getZ(i); tuv[i * 3 + 1] = y; tuv[i * 3 + 2] = layer;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tuv', new THREE.BufferAttribute(tuv, 3));
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

// --------------------------------------------------------------- zombies
// Each live zombie borrows a skinned CC0 body (assets.js) from a free list
// per model, with its own mixer and material (for tint and hit flashes).
// The sim's state picks the clip; far and off-screen bodies animate at a
// lower rate. Model, extra scale and skin tint per type:
const ZLOOK = {
  walker: ['zombie', 1, null], runner: ['zombie', 1, 0xe0a49a], crawler: ['zombie', 1, 0xbcc4a4],
  armored: ['zombie', 1, 0x98a2ac], brute: ['brute', 1, null], spitter: ['zombie', 1, 0xb0ff78],
  screamer: ['zombie', 1, 0xf4eee0], exploder: ['zombie', 1, 0xf6e27a], warden: ['brute', 1, 0xc8604e],
  climber: ['zombie', 1, 0xc4c8de],
};
// Clip names per model, and the ground speed (m/s at scale 1) each
// locomotion clip was animated for, so feet roughly keep up.
const ZCLIPS = {
  zombie: { walk: 'Walk', run: 'Run_Arms', idle: 'Idle', attack: 'Punch', grab: 'Idle_Attack', die: 'Death', crawl: 'Crawl', walkV: 0.9, runV: 2.6, crawlV: 0.7 },
  brute: { walk: 'Walk', run: 'Run', idle: 'Idle', attack: 'Attack', grab: 'Attack', die: 'Death', crawl: 'Walk', walkV: 1.6, runV: 4.2, crawlV: 1.6 },
};
const BURN = new THREE.Color(0xff6a10), HIT = new THREE.Color(0x902010), FUSE = new THREE.Color(0xfff060);

class Horde {
  constructor(scene, pool) {
    this.scene = scene;
    this.pool = pool;
    this.slots = new Array(pool.n).fill(null);
    this.free = { zombie: [], brute: [] };
    this.tint = new THREE.Color();
    this.last = 0;
  }
  // Clone bodies up front (a clone is a few ms; not mid-fight).
  prewarm(n) {
    while (this.free.zombie.length < n) this.free.zombie.push(this._make('zombie'));
    while (this.free.brute.length < 3) this.free.brute.push(this._make('brute'));
  }
  _make(model) {
    const A = assets.chars[model];
    const body = cloneSkinned(A.scene);
    const inner = new THREE.Group(), root = new THREE.Group();
    inner.add(body); root.add(inner);
    const z = { model, root, inner, body, mixer: new THREE.AnimationMixer(body), actions: {}, cur: null, acc: 0, seed: -1, type: -1 };
    body.traverse(o => {
      if (o.isSkinnedMesh) {
        o.material = o.material.clone();
        z.mat = o.material;
        // Generous bounds around the feet-origin body, so culling works.
        o.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, A.height / 2 + A.minY, 0), A.height);
        o.frustumCulled = true;
      }
      if (o.isBone && o.name === 'Head') z.head = o;
      if (o.isBone && !z.spine && (o.name === 'Torso' || o.name === 'Body')) z.spine = o;
    });
    root.visible = false;
    this.scene.add(root);
    return z;
  }
  _take(model) { return this.free[model].pop() || this._make(model); }
  _release(z) {
    z.root.visible = false;
    z.mixer.stopAllAction();
    z.cur = null;
    if (z.head) z.head.scale.setScalar(1);
    this.free[z.model].push(z);
  }
  // Fit a body to its sim type: top of the head just over the hit sphere.
  _dress(z, T, look) {
    const A = assets.chars[z.model];
    const s = (T.headY + T.headR + 0.06) * T.size * look[1] / A.height;
    z.inner.scale.set(s * (T.id === 'exploder' ? 1.25 : 1), s, s * (T.id === 'exploder' ? 1.25 : 1));
    z.inner.position.y = -A.minY * s;
    z.base = this.tint.set(look[2] ?? 0xffffff).clone();
    z.mat.color.copy(z.base);
  }
  _play(z, name, rate, once) {
    const a = z.actions[name] || (z.actions[name] = z.mixer.clipAction(assets.chars[z.model].clips[name]));
    a.timeScale = rate;
    if (z.cur === a) return;
    a.reset();
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.play();
    if (z.cur) a.crossFadeFrom(z.cur, 0.18, false);
    z.cur = a;
  }
  _clip(z, T, st, i) {
    const c = ZCLIPS[z.model], P = this.pool;
    const spd = P.speed[i] / T.size;
    switch (st) {
      case S.DYING: return [c.die, 1, true];
      case S.ATTACK: case S.SPIT: return [c.attack, 1.3, false];
      case S.SLAM: return [c.attack, 0.6, false];
      case S.BREACH: case S.CLIMB: case S.SCREAM: return [c.grab, 1.1, false];
      case S.RISE: case S.FUSE: return [c.idle, 1, false];
      case S.WANDER: return [T.crawl ? c.crawl : c.walk, 0.55, false];
      default:
        if (T.crawl) return [c.crawl, Math.max(0.5, spd / c.crawlV), false];
        if (st === S.CHARGE || spd > 2.2) return [c.run, Math.max(0.7, spd / c.runV), false];
        return [c.walk, Math.max(0.5, spd / c.walkV), false];
    }
  }

  update(now, cam) {
    const P = this.pool;
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    const cx = cam.position.x, cz = cam.position.z;
    const fx = -Math.sin(cam.rotation.y), fz = -Math.cos(cam.rotation.y);
    let live = 0;
    for (let i = 0; i < P.n; i++) {
      const st = P.state[i];
      let z = this.slots[i];
      if (st === S.FREE) { if (z) { this._release(z); this.slots[i] = null; } continue; }
      const T = ZTYPES[P.type[i]], look = ZLOOK[T.id];
      if (z && (z.seed !== P.seed[i] || z.type !== P.type[i])) { this._release(z); z = null; }
      if (!z) {
        z = this.slots[i] = this._take(look[0]);
        z.seed = P.seed[i]; z.type = P.type[i];
        this._dress(z, T, look);
        z.acc = 1; // pose on the first frame
      }
      live++;
      let sink = 0;
      if (st === S.DYING) sink = Math.max(0, P.t[i] - 1.0) * 1.2;
      z.root.position.set(P.x[i], P.y[i] - sink, P.z[i]);
      z.root.rotation.y = P.yaw[i];
      z.root.visible = true;
      const [clip, rate, once] = this._clip(z, T, st, i);
      this._play(z, clip, rate * (P.buff?.[i] > 0 ? 1.3 : 1), once);
      // Animation rate by distance; behind the camera, barely.
      const dx = P.x[i] - cx, dz = P.z[i] - cz, d = Math.hypot(dx, dz);
      const behind = d > 4 && (dx * fx + dz * fz) < -0.2 * d;
      const every = behind ? 0.25 : d < 15 ? 0 : d < 35 ? 1 / 20 : 1 / 8;
      z.acc += dt;
      if (z.acc >= every) {
        z.mixer.update(z.acc);
        z.acc = 0;
        const fl = P.flinch[i];
        if (fl > 0 && z.spine) z.spine.rotation.x -= fl * 0.45;
        if (st === S.DYING && P.headKill[i] && z.head) z.head.scale.setScalar(0.001);
      }
      // Flash on hits, flicker while burning, pulse before an exploder pops.
      const m = z.mat;
      m.emissive.setRGB(0, 0, 0);
      if (P.flinch[i] > 0) m.emissive.copy(HIT).multiplyScalar(P.flinch[i]);
      if (P.burnT[i] > 0) m.emissive.copy(BURN).multiplyScalar(0.5 + Math.sin(now * 30 + i) * 0.25);
      if (st === S.FUSE) {
        m.emissive.copy(FUSE).multiplyScalar(0.4 + Math.sin(now * 40) * 0.3);
        z.inner.scale.x = z.inner.scale.z = z.inner.scale.y * (1.25 + Math.sin(now * 40) * 0.06);
      }
    }
    return live;
  }
  dispose() {
    for (const z of [...this.slots, ...this.free.zombie, ...this.free.brute]) if (z) { z.mixer.stopAllAction(); this.scene.remove(z.root); z.mat.dispose(); }
  }
}

// ------------------------------------------------------------------ crew
// Your co-op teammates: Matt, Lis, Sam or Shaun by seat, carrying the gun
// they actually have out, walking/running/crouching from the snapshot,
// lying down when they're down.
const CREW = ['matt', 'lis', 'sam', 'shaun'];
class Crew {
  constructor(scene) { this.scene = scene; this.bodies = {}; this.last = 0; }
  _make(seat) {
    const name = CREW[seat % 4], A = assets.chars[name];
    const body = cloneSkinned(A.scene);
    const root = new THREE.Group();
    const s = 1.8 / A.height;
    body.scale.setScalar(s);
    body.position.y = -A.minY * s;
    root.add(body);
    const b = { name, root, body, mixer: new THREE.AnimationMixer(body), actions: {}, cur: null, gunId: null };
    body.traverse(o => {
      if (o.isSkinnedMesh) o.frustumCulled = false;
      if (o.isBone && o.name === 'Middle1L') b.hand = o; // glTF loader strips the '.'
      if (o.isBone && o.name === 'Torso') b.spine = o;
    });
    this.scene.add(root);
    return b;
  }
  _play(b, name, once) {
    const a = b.actions[name] || (b.actions[name] = b.mixer.clipAction(assets.chars[b.name].clips[name]));
    if (b.cur === a) return;
    a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = once; a.play();
    if (b.cur) a.crossFadeFrom(b.cur, 0.2, false);
    b.cur = a;
  }
  // The gun they have out, held at the kit's weapon hand (the left
  // middle finger) and pointed where they're actually aiming.
  _gun(b, w, P) {
    const id = w?.id || null;
    if (b.gunId !== id) {
      b.gunId = id;
      if (b.gun) { this.scene.remove(b.gun); b.gun.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); b.gun = null; }
      if (id && b.hand) { b.gun = gunModel(w); this.scene.add(b.gun); }
    }
    if (!b.gun) return;
    b.hand.getWorldPosition(b.gun.position);
    b.gun.rotation.set(P.pitch || 0, P.yaw, 0, 'YXZ');
  }
  update(players, skip, now) {
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    const seen = new Set();
    for (const P of players || []) {
      if (!P || P.seat === skip) continue;
      seen.add(P.seat);
      const b = this.bodies[P.seat] || (this.bodies[P.seat] = this._make(P.seat));
      b.root.visible = true;
      b.root.position.set(P.x, P.y, P.z);
      b.root.rotation.y = P.yaw + Math.PI; // yaw 0 looks down -z; the model faces +z
      const sf = P.speedFrac || 0;
      if (P.down) this._play(b, 'Death', true);
      else if (P.crouched) this._play(b, 'Duck', true);
      else this._play(b, sf > 0.62 ? 'Run_Gun' : sf > 0.08 ? 'Walk_Gun' : 'Idle_Gun', false);
      if (b.cur && b.cur.getClip().name.endsWith('Gun')) b.cur.timeScale = Math.max(0.6, sf * 1.6);
      b.mixer.update(dt);
      if (b.spine && !P.down) b.spine.rotation.x += (P.pitch || 0) * 0.5 + (P.kick || 0) * 0.15;
      this._gun(b, P.down ? null : P.weapons?.[P.cur], P);
    }
    for (const seat of Object.keys(this.bodies)) if (!seen.has(+seat)) { const b = this.bodies[seat]; b.root.visible = false; if (b.gun) b.gun.visible = false; }
    for (const P of players || []) if (P && this.bodies[P.seat]?.gun) this.bodies[P.seat].gun.visible = P.seat !== skip;
  }
  dispose() { for (const b of Object.values(this.bodies)) { b.mixer.stopAllAction(); this.scene.remove(b.root); if (b.gun) this.scene.remove(b.gun); } }
}

// ---------------------------------------------------------------- boards
class Boards {
  constructor(scene, world) {
    this.world = world;
    const g = partGeo(1.0, 0.17, 0.06, false, L.planks);
    g.translate(0, -0.085, 0);
    this.mesh = new THREE.InstancedMesh(g, worldMat(), world.windows.length * MAX_BOARDS);
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
        this.mesh.setColorAt(k, this.c.copy(this.wood[b % 3]).multiplyScalar(1.6));
        k++;
      }
    });
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ------------------------------------------------------- world material
// Every static surface: baked light in the vertex colour × one layer of
// the texture array (per-vertex `tuv` = u, v, layer; layer 0 is white),
// plus the torch — a cone around the view axis that brightens what it
// falls on — and a brief warm muzzle light around you when you fire.
// Uniforms are shared, so one value switches every material at once.
const FLASH = { value: 0 }, MUZZLE = { value: 0 }, ATLAS = { value: null };
function worldMat(opts = {}) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, ...opts });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uFlash = FLASH;
    sh.uniforms.uMuzzle = MUZZLE;
    sh.uniforms.uAtlas = ATLAS;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 tuv;\nvarying vec3 vTuv;\nvarying vec3 vTorch;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTorch = mvPosition.xyz;\nvTuv = tuv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFlash;\nuniform float uMuzzle;\nuniform highp sampler2DArray uAtlas;\nvarying vec3 vTuv;\nvarying vec3 vTorch;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= texture(uAtlas, vTuv).rgb;')
      .replace('#include <fog_fragment>', `float d = length(vTorch);
        if (uFlash > 0.0) {
          float cone = smoothstep(0.82, 0.97, -vTorch.z / max(d, 0.001));
          float att = clamp(1.0 - d / 24.0, 0.0, 1.0) * (0.35 + 0.65 * smoothstep(0.4, 2.8, d));
          gl_FragColor.rgb = gl_FragColor.rgb * (1.0 + uFlash * cone * att * 2.2) + uFlash * cone * att * 0.02;
        }
        if (uMuzzle > 0.0) gl_FragColor.rgb *= 1.0 + uMuzzle * vec3(1.6, 1.25, 0.8) * clamp(1.0 - d / 9.0, 0.0, 1.0);
        #include <fog_fragment>`);
  };
  mat.customProgramCacheKey = () => 'world';
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
      lamps: def.lamps, spawns: [], starts: def.starts, containers: def.containers, pois: {}, zones: [], beds: [], regions: [],
      roofs: def.roofs || [], home: def.home,
    }, props: assets.props });
    this.worker.onmessage = ({ data: m }) => {
      if (m.t !== 'chunk') return;
      this.pending--;
      if (this.chunks.get(m.key) !== 'pending') return; // dropped while building
      if (m.empty) { this.chunks.set(m.key, null); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
      g.setAttribute('tuv', new THREE.BufferAttribute(m.tuv, 3));
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
const NIGHT_TOP = lin(0x02040c), DAY_TOP = lin(0x3a6aa8), DUSK_TOP = lin(0x2a2448);

// A soft round glow (moon halo, lamp heads), drawn once.
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class View {
  constructor(holder) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:auto';
    holder.appendChild(this.canvas);
    // Vignette: a CSS gradient over the canvas — costs the GPU nothing.
    holder.appendChild(Object.assign(document.createElement('div'), {
      style: 'position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.55) 100%)',
    }));
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.info.autoReset = false;
    this.renderer.autoClear = false;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));

    ATLAS.value = assets.texArray;
    this.scene = new THREE.Scene();
    this.scene.background = NIGHT_SKY.clone();
    this.scene.fog = new THREE.Fog(NIGHT_SKY.clone(), 10, 44);
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 70);
    this.scene.add(this.camera);
    this.staticMat = worldMat();
    this.glow = glowTexture();
    // Only the characters are lit for real (Lambert); the world's light is
    // baked. Moonlight, sky/ground fill, and the flashlight on the camera.
    this.hemi = new THREE.HemisphereLight(0x8fa0d0, 0x2a2420, 1);
    this.sun = new THREE.DirectionalLight(0xb8c8ff, 1);
    this.sun.position.set(-0.45, 0.75, -0.5);
    this.torch = new THREE.SpotLight(0xfff2d8, 0, 26, 0.42, 0.45, 1.2);
    this.torch.position.set(0.15, -0.1, 0);
    this.torch.target.position.set(0, 0, -1);
    this.camera.add(this.torch, this.torch.target);
    this.scene.add(this.hemi, this.sun);
    this._sky();
    // First-person weapon, drawn after a depth clear so it never clips.
    this.vmScene = new THREE.Scene();
    this.vmCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 5);
    this.vm = null;
    this.res = { w: 960, h: 540 };
    this.setResolution(960, 540);
    this.statics = [];
    this.doors = {};
    this.setDaylight(0);
  }

  // Show a world: the hand-built map is built whole; the open world streams.
  setWorld(world, mapDef, pool, zombieCap = 20) {
    for (const m of this.statics) { this.scene.remove(m); m.geometry.dispose(); }
    this.statics = [];
    for (const m of Object.values(this.doors)) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.doors = {};
    this.streamer?.dispose(); this.streamer = null;
    this.horde?.dispose();
    if (this.boards) { this.scene.remove(this.boards.mesh); this.boards.mesh.geometry.dispose(); }
    if (this.lampGlow) { this.scene.remove(this.lampGlow); this.lampGlow.geometry.dispose(); }
    this.world = world;
    if (world.openWorld) {
      this.streamer = new Streamer(this, world, mapDef);
      this.scene.fog.far = 60; this.camera.far = 80;
    } else {
      for (const g0 of buildWorld(world, mapDef)) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(g0.pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(g0.col, 3));
        g.setAttribute('tuv', new THREE.BufferAttribute(g0.tuv, 3));
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
        const g = partGeo(x1 - x0 - 0.04, CEIL - 0.02, z1 - z0 - 0.04, false, L.planks);
        const m = new THREE.Mesh(g, worldMat({ color: new THREE.Color(0x8a6a50).multiplyScalar(1.4) }));
        m.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
        this.scene.add(m);
        this.doors[d.id] = m;
      }
    }
    // Glowing heads on the outdoor lamp posts.
    const heads = [];
    for (const [x, z] of mapDef.lamps || []) if (world.cell(Math.floor(x), Math.floor(z)) === C.GROUND) heads.push(x, 4.35, z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(heads, 3));
    this.lampGlow = new THREE.Points(lg, new THREE.PointsMaterial({
      map: this.glow, color: 0xffc070, size: 2.6, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.lampGlow);
    this.camera.updateProjectionMatrix();
    this.horde = new Horde(this.scene, pool);
    this.horde.prewarm(zombieCap);
    this.crew?.dispose();
    this.crew = new Crew(this.scene);
    this.crewPlayers = null; this.crewSkip = -1;
    this.boards = new Boards(this.scene, world);
    // Compile every shader now rather than on the first zombie / teammate.
    for (const z of this.horde.free.zombie.slice(-1).concat(this.horde.free.brute.slice(-1))) z.root.visible = true;
    this.renderer.compile(this.scene, this.camera);
    for (const z of [...this.horde.free.zombie, ...this.horde.free.brute]) z.root.visible = false;
  }

  _sky() {
    // Gradient dome (zenith → horizon, matching the fog), the moon with a
    // halo, stars, and a ring of distant treeline so the horizon isn't a
    // flat wall of fog. None of it takes fog; it all follows the camera.
    this.skyU = { top: { value: NIGHT_TOP.clone() }, hor: { value: NIGHT_SKY.clone() } };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(75, 20, 10), new THREE.ShaderMaterial({
      uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 hor; varying vec3 vP;
        void main(){ float h = normalize(vP).y; gl_FragColor = vec4(mix(hor, top, pow(clamp(h, 0.0, 1.0), 0.55)), 1.0);
        #include <colorspace_fragment>
        }`,
    }));
    this.sky.renderOrder = -2;
    this.scene.add(this.sky);
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(3.2, 20), new THREE.MeshBasicMaterial({ color: lin(0xf3ead0), fog: false }));
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0x8090c0, fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(22);
    this.scene.add(this.moon, this.halo);
    const pts = [];
    for (let i = 0; i < 260; i++) {
      const a = hash(i, 1) * Math.PI * 2, e = 0.15 + hash(i, 2) * 1.2;
      pts.push(Math.cos(a) * Math.cos(e) * 60, Math.sin(e) * 60, Math.sin(a) * Math.cos(e) * 60);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfc8ff, size: 1.5, sizeAttenuation: false, fog: false }));
    this.stars.renderOrder = -1;
    this.scene.add(this.stars);
    // Treeline: a jagged band of pine tops at 68 m.
    const tp = [], N = 140;
    for (let i = 0; i < N; i++) {
      const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2, am = (a0 + a1) / 2;
      const h = 6 + hash(i, 3) * 7, r = 68;
      tp.push(Math.cos(a0) * r, -2, Math.sin(a0) * r, Math.cos(a1) * r, -2, Math.sin(a1) * r, Math.cos(am) * r, h, Math.sin(am) * r);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    this.treeline = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, side: THREE.DoubleSide }));
    this.treeline.renderOrder = -1;
    this.scene.add(this.treeline);
  }

  // 0 = midnight, 1 = noon. Tints every baked surface (they're lit for
  // night), relights the characters, and moves fog, sky, stars and moon.
  setDaylight(k, dusk = 0) {
    k = Math.max(0, Math.min(1, k));
    const tint = 1 + k * 1.55;
    this.staticMat.color.setRGB(tint, tint * 0.98, tint * (0.95 + 0.05 * (1 - k)));
    const sky = this.scene.background;
    sky.copy(NIGHT_SKY).lerp(DAY_SKY, k).lerp(DUSK_SKY, dusk * 0.6);
    this.scene.fog.color.copy(sky);
    this.skyU.hor.value.copy(sky);
    this.skyU.top.value.copy(NIGHT_TOP).lerp(DAY_TOP, k).lerp(DUSK_TOP, dusk * 0.6);
    this.treeline.material.color.copy(sky).multiplyScalar(0.45);
    this.scene.fog.near = 10 + k * 15;
    this.stars.visible = k < 0.3;
    this.halo.visible = k < 0.4;
    this.moon.material.color.set(k > 0.5 ? 0xfff6d0 : 0xf3ead0);
    this.hemi.intensity = 0.9 + k * 1.6;
    this.hemi.color.setRGB(0.55 + k * 0.45, 0.62 + k * 0.38, 0.85 + k * 0.15);
    this.sun.intensity = 0.7 + k * 2.2;
    this.sun.color.setRGB(0.7 + k * 0.3, 0.78 + k * 0.2, 1.0 - k * 0.1);
    if (this.lampGlow) this.lampGlow.visible = k < 0.45;
  }

  setFlashlight(on) { FLASH.value = on ? 1 : 0; this.torch.intensity = on ? 22 : 0; }
  muzzle(k) { MUZZLE.value = k; }

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
    this.sky.position.set(x, y, z);
    this.stars.position.set(x, 0, z);
    this.treeline.position.set(x, 0, z);
    this.moon.position.set(x - 38, 34, z - 50);
    this.moon.lookAt(x, y, z);
    this.halo.position.copy(this.moon.position);
  }

  render(now) {
    this.streamer?.update(this.camera.position.x, this.camera.position.z);
    const live = this.horde.update(now, this.camera);
    this.crew.update(this.crewPlayers, this.crewSkip, now);
    this.boards.update();
    for (const [id, m] of Object.entries(this.doors)) m.visible = !this.world.doors[id].open;
    MUZZLE.value *= 0.55;
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
    this.horde?.dispose();
    this.crew?.dispose();
    this.renderer.dispose();
    this.scene.traverse(o => { o.geometry?.dispose?.(); if (o.material && !o.isSkinnedMesh) o.material.dispose?.(); });
    this.vmScene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
