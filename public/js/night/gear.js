// First-person weapons, hit effects and chalk signs. The guns are CC0
// models (assets.js), each normalised once — muzzle down -z, a real-world
// length, origin at the grip — and shaded with a matcap, so they read as
// metal and wood without any lights. Gloves and sleeves are still built
// here (no CC0 pack has first-person arms). Effects are pooled instanced
// particles and tracers, so a firefight allocates nothing.
import * as THREE from '/vendor/three/three.module.js';
import { WEAPONS, MELEE, RARITY } from './sim/weapons.js';
import { assets } from './assets.js';

const lin = hex => new THREE.Color(hex);

// A box with a baked top-light gradient, coloured once (and textured with
// one layer of the world's texture array when it's drawn with worldMat).
export function block(w, h, d, hex, x, y, z, rx = 0, layer = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.getAttribute('position');
  const c = lin(hex);
  const col = new Float32Array(pos.count * 3), tuv = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = 0.55 + 0.45 * ((pos.getY(i) / h) + 0.5);
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  g.rotateX(rx);
  g.translate(x, y, z);
  for (let i = 0; i < pos.count; i++) { tuv[i * 3] = pos.getX(i) + pos.getZ(i); tuv[i * 3 + 1] = pos.getY(i); tuv[i * 3 + 2] = layer; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tuv', new THREE.BufferAttribute(tuv, 3));
  g.deleteAttribute('uv');
  return g;
}

// Merge geometries (all with position + colour; normals and tuv kept when
// every part has them).
export function merge(geos) {
  const names = ['position', 'color', 'normal', 'tuv'].filter(a => geos.every(g => g.getAttribute(a)));
  const out = new THREE.BufferGeometry();
  const flat = geos.map(g => (g.index ? g.toNonIndexed() : g));
  for (const a of names) {
    const n = flat.reduce((t, g) => t + g.getAttribute(a).count, 0);
    const arr = new Float32Array(n * 3);
    let o = 0;
    for (const g of flat) { const at = g.getAttribute(a); for (let i = 0; i < at.count; i++) { arr[o++] = at.getX(i); arr[o++] = at.getY(i); arr[o++] = at.getZ(i); } }
    out.setAttribute(a, new THREE.BufferAttribute(arr, 3));
  }
  for (const g of new Set([...geos, ...flat])) g.dispose();
  return out;
}

const STEEL = 0x4c505c, GRIP = 0x1c1d22, SLEEVE = 0x3a4436, GLOVE = 0x26282c;

// Weapon id -> [CC0 model, length in metres, grip position as a fraction
// of the length from the back, colour tint, authored backwards]. The
// models are authored muzzle toward +x, up +y (the launcher toward -x).
const GUNS = {
  pistol: ['pistol', 0.21, 0.28], revolver: ['revolver', 0.3, 0.25], smg: ['smg', 0.44, 0.5], pdw: ['pdw', 0.52, 0.45],
  ar: ['ar', 0.88, 0.42], kestrel: ['ak', 0.88, 0.42], br: ['bullpup', 0.74, 0.62], shotgun: ['shotgun', 1.0, 0.3],
  autoshotgun: ['shortstock', 0.86, 0.36], sawnoff: ['sawnoff', 0.62, 0.22], dmr: ['akwood', 0.98, 0.4],
  sniper: ['sniper', 1.15, 0.36], lmg: ['ar', 1.0, 0.4, 0x8a9078], launcher: ['launcher', 0.56, 0.24, null, true],
};
const SHORT = new Set(['pistol', 'revolver']);

// One normalised geometry per CC0 model and length (cached): rotated so
// the muzzle points down -z, scaled, origin at the grip; plus where its
// top (the sight line), muzzle and fore-end are.
const shapes = new Map();
function shape(model, len, gripAt, flip) {
  const key = `${model}|${len}|${gripAt}`;
  if (shapes.has(key)) return shapes.get(key);
  const src = assets.guns[model];
  const g = src.clone();
  g.rotateY(flip ? -Math.PI / 2 : Math.PI / 2); // muzzle -> -z
  g.computeBoundingBox();
  let b = g.boundingBox;
  const k = len / (b.max.z - b.min.z);
  g.scale(k, k, k);
  g.computeBoundingBox(); b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -b.max.y + 0.05, -(b.max.z - len * gripAt));
  g.computeBoundingBox(); b = g.boundingBox;
  // The bore: mean height of what's at the very tip of the muzzle.
  const P = g.getAttribute('position');
  let by = 0, n = 0;
  for (let i = 0; i < P.count; i++) if (P.getZ(i) < b.min.z + len * 0.02) { by += P.getY(i); n++; }
  const s = { geo: g, top: b.max.y, bottom: b.min.y, muzzle: b.min.z, back: b.max.z, fore: b.min.z + len * 0.3, bore: n ? by / n : b.max.y - 0.03, halfW: (b.max.x - b.min.x) / 2 };
  shapes.set(key, s);
  return s;
}
// Attachments: a CC0 part (scope, bipod) placed on the gun, scaled to a
// length along the barrel (or to a height).
function part(model, len, x, y, z, byHeight = false) {
  const g = assets.guns[model].clone();
  g.rotateY(Math.PI / 2);
  g.computeBoundingBox();
  const b = g.boundingBox, k = len / (byHeight ? b.max.y - b.min.y : b.max.z - b.min.z);
  g.scale(k, k, k);
  g.computeBoundingBox();
  const c = g.boundingBox;
  g.translate(x - (c.min.x + c.max.x) / 2, y - c.min.y, z - (c.min.z + c.max.z) / 2);
  return { geo: g, h: c.max.y - c.min.y };
}
// A plain cylinder along z (suppressors, compensators), with normals.
function tube(r, len, hex, y, z) {
  const g = new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2).translate(0, y, z).toNonIndexed();
  const c = lin(hex), n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
  g.deleteAttribute('uv');
  return g;
}

// The gun with its attachments, as one coloured geometry and a `def`
// describing it for posing (hip and ADS positions, sight line, muzzle).
function gunGeometry(w) {
  const [model, len0, gripAt, tint, flip] = GUNS[w.id] || GUNS.ar;
  const att = w.att || {};
  const len = len0 * (att.barrel === 'longbarrel' ? 1.06 : att.barrel === 'shortbarrel' ? 0.94 : 1);
  const S = shape(model, len, gripAt, flip);
  const parts = [S.geo.clone()];
  if (tint) {
    const c = parts[0].getAttribute('color'), t = lin(tint);
    for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * t.r * 1.4, c.getY(i) * t.g * 1.4, c.getZ(i) * t.b * 1.4);
  }
  const short = SHORT.has(w.id);
  const def = {
    sightY: S.top + 0.012, muzzle: S.muzzle, fore: S.fore, top: S.top, bore: S.bore,
    hipX: short ? 0.14 : 0.165, hipY: short ? -0.14 : -0.15, z: short ? -0.38 : -0.4, adsZ: short ? -0.32 : -0.26,
    scope: model === 'sniper', short,
  };
  // Optics sit on top, a little ahead of the grip; the sight line moves
  // up to the optic's centre so aiming down sights still lines up.
  const opt = att.optic;
  if (opt) {
    const L = opt === 'scope4' ? 0.26 : opt === 'holo' ? 0.12 : 0.09;
    // Sunk a little into the gun so it sits on the rail over any iron sight.
    const base = Math.max(S.bore + 0.03, S.top - 0.03);
    const p = part('scope', L, 0, base, -0.06);
    parts.push(p.geo);
    def.sightY = base + p.h * 0.62;
    if (opt === 'scope4') def.scope = true;
  }
  const boreY = S.bore;
  if (att.muzzle === 'suppressor') { parts.push(tube(0.018, 0.16, 0x1d1f24, boreY, S.muzzle - 0.08)); def.muzzle -= 0.16; }
  if (att.muzzle === 'compensator') { parts.push(tube(0.016, 0.05, STEEL, boreY, S.muzzle - 0.025)); def.muzzle -= 0.05; }
  if ((att.grip === 'vgrip' || att.grip === 'agrip') && !short) parts.push(block(0.026, 0.07, 0.028, GRIP, 0, S.bore - 0.07, def.fore + 0.04, att.grip === 'agrip' ? -0.6 : 0));
  if (w.id === 'lmg') { const b = part('bipod', 0.16, 0, 0, S.muzzle + 0.14, true); b.geo.translate(0, S.top - 0.05 - b.h, 0); parts.push(b.geo); }
  if (w.tier) parts.push(block(0.003, 0.01, 0.1, new THREE.Color(RARITY[w.tier].color).getHex(), S.halfW * 0.8, S.bore - 0.015, -0.03));
  return { geo: merge(parts), def };
}

// A matcap painted once: soft key light from the upper left, a bright
// specular spot and a cool rim — guns read as metal with no lights.
let matcapTex = null;
function matcap() {
  if (matcapTex) return matcapTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const base = g.createRadialGradient(46, 40, 4, 64, 64, 66);
  base.addColorStop(0, '#ffffff'); base.addColorStop(0.35, '#b8b8b8'); base.addColorStop(0.8, '#5a5a5a'); base.addColorStop(1, '#2a2a2a');
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  const spec = g.createRadialGradient(40, 34, 0, 40, 34, 16);
  spec.addColorStop(0, 'rgba(255,255,255,0.9)'); spec.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = spec; g.fillRect(0, 0, 128, 128);
  const rim = g.createRadialGradient(64, 64, 52, 64, 64, 64);
  rim.addColorStop(0, 'rgba(150,170,210,0)'); rim.addColorStop(1, 'rgba(150,170,210,0.55)');
  g.fillStyle = rim; g.fillRect(0, 0, 128, 128);
  matcapTex = new THREE.CanvasTexture(c);
  matcapTex.colorSpace = THREE.SRGBColorSpace;
  return matcapTex;
}
// The models' colours are daylight albedo, mostly dark metal: lifted so
// the sheen shows.
const vmMat = () => new THREE.MeshMatcapMaterial({ matcap: matcap(), vertexColors: true, fog: false, color: new THREE.Color(2.2, 2.2, 2.2) });

// Gloved hands: right on the grip, left on the fore-end (or cupping the
// right on a handgun), tapered sleeves running back out of the frame.
function limb(a, b, r0, r1, hex) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return paint(g, hex);
}
function fist(x, y, z) { return paint(new THREE.CapsuleGeometry(0.024, 0.035, 3, 8).rotateX(Math.PI / 2).translate(x, y, z), GLOVE); }
function paint(g, hex) {
  g = g.toNonIndexed();
  const c = lin(hex), n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
  g.deleteAttribute('uv');
  return g;
}
function hands(def) {
  const t = def.top;
  const rz = def.short ? 0.0 : 0.02;
  const g = [fist(0.004, t - 0.1, rz), limb([0.012, t - 0.115, rz + 0.04], [0.11, t - 0.3, rz + 0.36], 0.03, 0.045, SLEEVE)];
  const [lx, ly, lz] = def.short ? [-0.02, t - 0.115, -0.005] : [-0.012, t - 0.08, def.fore];
  g.push(fist(lx, ly, lz), limb([lx - 0.01, ly - 0.02, lz + 0.04], [-0.17, t - 0.33, lz + 0.36], 0.03, 0.045, SLEEVE));
  return g;
}

// The star-shaped muzzle flash texture (additive, so black is clear).
let flashTex = null;
function flashTexture() {
  if (flashTex) return flashTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 32);
  const r = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  r.addColorStop(0, '#fff8e0'); r.addColorStop(0.25, '#ffd070'); r.addColorStop(0.6, '#c05010'); r.addColorStop(1, '#000');
  g.fillStyle = r;
  g.beginPath();
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, rr = i % 2 ? 9 : 31; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
  g.fill();
  flashTex = new THREE.CanvasTexture(c);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}

export function buildViewmodel(w, meleeId = 'knife') {
  const { geo, def } = gunGeometry(w);
  const mat = vmMat();
  const mesh = new THREE.Mesh(merge([geo, ...hands(def)]), mat);
  const root = new THREE.Group();
  root.add(mesh);
  // Muzzle flash: a camera-facing star plus two crossed side-on quads.
  const fm = new THREE.MeshBasicMaterial({ map: flashTexture(), color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const flash = new THREE.Group();
  flash.add(new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), fm));
  for (const r of [0, Math.PI / 2]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.1), fm);
    q.rotation.set(0, Math.PI / 2, r);
    q.position.z = -0.06;
    flash.add(q);
  }
  flash.position.set(0, def.bore, def.muzzle - 0.02);
  flash.visible = false;
  root.add(flash);
  // Knife (or machete), hidden until a melee: the CC0 blade in a glove.
  const blade = meleeId === 'machete' ? ['machete', 0.5] : ['knife', 0.26];
  const B = assets.guns[blade[0]].clone();
  B.computeBoundingBox();
  const bb = B.boundingBox, tall = bb.max.y - bb.min.y, k = blade[1] / tall;
  // Authored blade-up: lay it down -z, handle at the origin.
  B.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  B.scale(k, k, k);
  B.rotateX(-Math.PI / 2);
  const knife = new THREE.Mesh(merge([B, block(0.06, 0.065, 0.08, GLOVE, 0, -0.01, 0.03).toNonIndexed()].map(x => { if (!x.getAttribute('normal')) x.computeVertexNormals(); return x; })), mat);
  knife.visible = false;
  return { root, mesh, flash, knife, def, id: w.id, key: vmKey(w, meleeId) };
}

// The same gun for the world (teammates' hands, wall-buys): Lambert-lit
// by the scene's moon and flashlight, muzzle down -z, origin at the grip.
export function gunModel(w) {
  const { geo } = gunGeometry(w);
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  const g = new THREE.Group();
  g.add(m);
  return g;
}

export const vmKey = (w, meleeId) => `${w.id}|${w.tier}|${Object.values(w.att || {}).join(',')}|${meleeId}`;

// Per-frame viewmodel pose from the player's state.
export function poseViewmodel(vm, P, dt, now, lookX, lookY) {
  const d = vm.def, W = WEAPONS[vm.id], M = MELEE[P.meleeId] || MELEE.knife;
  const a = P.ads;
  const st = vm.st || (vm.st = { swayX: 0, swayY: 0, flashT: 0 });
  st.swayX += (lookX * 0.9 - st.swayX) * Math.min(1, dt * 10);
  st.swayY += (lookY * 0.9 - st.swayY) * Math.min(1, dt * 10);
  const bobAmt = P.speedFrac * (1 - a * 0.85) * (P.grounded ? 1 : 0.2);
  const bx = Math.sin(P.stepPhase) * 0.012 * bobAmt;
  const by = -Math.abs(Math.cos(P.stepPhase)) * 0.012 * bobAmt;
  let x = d.hipX * (1 - a) + bx + st.swayX * 0.4 * (1 - a * 0.8);
  let y = (d.hipY * (1 - a) + (-d.sightY) * a) + by - st.swayY * 0.3 * (1 - a * 0.8);
  let z = d.z * (1 - a) + d.adsZ * a;
  let rx = 0, ry = 0, rz = 0;
  // Breathing idle.
  y += Math.sin(now * 1.6) * 0.002 * (1 - a);
  // Recoil kick.
  z += 0.035 * P.kick * (W.cls === 'shotgun' ? 1.8 : 1);
  rx += 0.09 * P.kick * (W.cls === 'shotgun' ? 1.6 : 1);
  // Sprint carry.
  if (P.sprinting) { rx -= 0.15; ry += 0.5; rz += 0.35; x += 0.03; y -= 0.04; }
  // Reload dip.
  if (P.act === 'reload') {
    const T = W.shell ? 0.6 : (P._emptyReload ? W.emptyReload : W.reload);
    const p = W.shell ? Math.min(1, P.actT / 0.25) : Math.min(1, P.actT / T);
    const s = W.shell ? p : Math.sin(Math.PI * p);
    rx -= 0.5 * s; rz += 0.35 * s; y -= 0.06 * s;
  }
  // Raising after a swap/buy.
  if (P.act === 'raise' || P.act === 'swap') {
    const p = Math.min(1, P.actT / (P.act === 'raise' ? 0.35 : 0.4));
    y -= 0.25 * (1 - p); rx -= 0.6 * (1 - p);
  }
  // Knife slash: gun drops away, the blade sweeps right to left.
  vm.knife.visible = P.act === 'melee';
  if (P.act === 'melee') {
    const p = Math.min(1, P.actT / M.time);
    y -= 0.3 * Math.sin(Math.PI * Math.min(1, p * 1.4));
    const k = Math.min(1, P.actT / M.hitAt);
    vm.knife.position.set(0.25 - 0.4 * k, -0.12 + 0.03 * Math.sin(Math.PI * k), -0.32);
    vm.knife.rotation.set(-0.2, 0.9 - 1.6 * k, -0.6 + 0.4 * k);
  }
  if (P.down) { y -= 0.4; }
  // Looking through a scope: the gun gets out of the way of the overlay.
  if (d.scope && a > 0.85) y -= 1;
  vm.mesh.position.set(0, 0, 0);
  vm.root.position.set(x, y, z);
  vm.root.rotation.set(rx, ry, rz);
  st.flashT -= dt;
  vm.flash.visible = st.flashT > 0;
}

export function muzzleFlash(vm) {
  if (!vm.st) vm.st = { swayX: 0, swayY: 0, flashT: 0 };
  vm.st.flashT = 0.05;
  vm.flash.rotation.z = Math.random() * Math.PI;
  const s = 0.8 + Math.random() * 0.6;
  vm.flash.scale.set(s, s, s);
}

// ----------------------------------------------------------------- effects
const MAXP = 160, MAXT = 12;
const FWD = new THREE.Vector3(0, 0, -1);
export class Effects {
  constructor(scene) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    this.parts = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXP);
    this.parts.frustumCulled = false;
    this.parts.setColorAt(0, new THREE.Color());
    this.parts.count = 0;
    scene.add(this.parts);
    this.p = { x: new Float32Array(MAXP), y: new Float32Array(MAXP), z: new Float32Array(MAXP),
      vx: new Float32Array(MAXP), vy: new Float32Array(MAXP), vz: new Float32Array(MAXP),
      life: new Float32Array(MAXP), max: new Float32Array(MAXP), size: new Float32Array(MAXP),
      col: Array.from({ length: MAXP }, () => new THREE.Color()) };
    this.next = 0;
    const tg = new THREE.BoxGeometry(0.012, 0.012, 1);
    tg.translate(0, 0, -0.5);
    this.tracers = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.7, fog: false }), MAXT);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    scene.add(this.tracers);
    this.t = Array.from({ length: MAXT }, () => ({ life: 0, a: new THREE.Vector3(), b: new THREE.Vector3() }));
    this.tn = 0;
    this.m = new THREE.Matrix4(); this.v = new THREE.Vector3(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3();
    this.blood = [lin(0x7a0d0d), lin(0x5c0808), lin(0x931616)];
    this.dust = [lin(0x8a8378), lin(0x6e685e)];
    this.wood = [lin(0x7a5a3a), lin(0x5c4128)];
    this.spark = [lin(0xbfe8ff).multiplyScalar(1.6), lin(0x7ac8ff).multiplyScalar(1.6)];
    this.metal = [lin(0x8a8f96), lin(0xc0c4c8)];
    this.flame = [lin(0xffd060).multiplyScalar(1.8), lin(0xff7a1a).multiplyScalar(1.6), lin(0xff3a0a).multiplyScalar(1.3)];
    this.smoke = [lin(0x3a3632), lin(0x2a2826)];
    this.acid = [lin(0x9be05a).multiplyScalar(1.4), lin(0x6fb83a)];
    this.brass = [lin(0xd8a840).multiplyScalar(1.3)];
    this.shell = [lin(0xb02818).multiplyScalar(1.2)];
  }

  burst(x, y, z, n, palette, speed = 2.5, size = 0.06, up = 1.5, life = 0.7) {
    const P = this.p;
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % MAXP;
      P.x[i] = x; P.y[i] = y; P.z[i] = z;
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      P.vx[i] = Math.cos(a) * s; P.vz[i] = Math.sin(a) * s; P.vy[i] = up * (0.4 + Math.random());
      P.life[i] = P.max[i] = life * (0.6 + Math.random() * 0.6);
      P.size[i] = size * (0.6 + Math.random() * 0.8);
      P.col[i].copy(palette[k % palette.length]);
    }
  }

  tracer(ax, ay, az, bx, by, bz) {
    const t = this.t[this.tn]; this.tn = (this.tn + 1) % MAXT;
    t.life = 0.06; t.a.set(ax, ay, az); t.b.set(bx, by, bz);
  }

  update(dt) {
    const P = this.p;
    let k = 0;
    for (let i = 0; i < MAXP; i++) {
      if (P.life[i] <= 0) continue;
      P.life[i] -= dt;
      P.vy[i] -= 9.8 * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      if (P.y[i] < 0.02) { P.y[i] = 0.02; P.vy[i] *= -0.25; P.vx[i] *= 0.5; P.vz[i] *= 0.5; }
      const s = P.size[i] * Math.min(1, P.life[i] / P.max[i] * 2);
      this.m.makeScale(s, s, s).setPosition(P.x[i], P.y[i], P.z[i]);
      this.parts.setMatrixAt(k, this.m);
      this.parts.setColorAt(k, P.col[i]);
      k++;
    }
    this.parts.count = k;
    if (k) { this.parts.instanceMatrix.needsUpdate = true; this.parts.instanceColor.needsUpdate = true; }
    let n = 0;
    for (const t of this.t) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const len = t.a.distanceTo(t.b);
      this.v.copy(t.b).sub(t.a).normalize();
      this.q.setFromUnitVectors(FWD, this.v);
      this.m.compose(t.a, this.q, this.s.set(1, 1, Math.max(0.01, len)));
      this.tracers.setMatrixAt(n++, this.m);
    }
    this.tracers.count = n;
    if (n) this.tracers.instanceMatrix.needsUpdate = true;
  }
}

// --------------------------------------------------------- world props
// Grenades in flight, fire and acid pools, claymores and power-up drops:
// one instanced unit box, recoloured and rescaled per item.
const PROP_COL = {
  frag: 0x3a4a2a, molotov: 0x8a5a2a, noisemaker: 0xd23a3a, stun: 0x9a9aa0, shell: 0x2a2a2a, acid: 0x9be05a,
  fire: 0xff7a1a, acidPool: 0x6fb83a, stunArea: 0xffffff, claymore: 0x4a5236,
  maxammo: 0x3ecf8e, instakill: 0xff4040, doublepts: 0xffd040, carpenter: 0xc08040, nuke: 0xff9020,
};
export class WorldProps {
  constructor(scene) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }), 96);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler();
    this.v = new THREE.Vector3(); this.s = new THREE.Vector3(); this.c = new THREE.Color();
    this.cols = Object.fromEntries(Object.entries(PROP_COL).map(([k, v]) => [k, lin(v)]));
  }
  update(game, now) {
    let k = 0;
    const put = (x, y, z, sx, sy, sz, ry, col, bright = 1) => {
      if (k >= 96) return;
      this.e.set(0, ry, 0); this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(x, y, z), this.q, this.s.set(sx, sy, sz));
      this.mesh.setMatrixAt(k, this.m);
      this.mesh.setColorAt(k++, this.c.copy(col).multiplyScalar(bright));
    };
    const E = game.equipment;
    for (const p of E.projectiles) put(p.x, p.y, p.z, 0.12, 0.12, p.kind === 'molotov' ? 0.22 : 0.12, p.t * 9, this.cols[p.kind] || this.cols.frag, p.kind === 'acid' ? 1.6 : 1);
    for (const a of E.areas) {
      const flick = a.kind === 'fire' ? 1.6 + Math.sin(now * 23 + a.x) * 0.4 : 1.2;
      const col = a.kind === 'fire' ? this.cols.fire : a.kind === 'acid' ? this.cols.acidPool : this.cols.stunArea;
      put(a.x, 0.03, a.z, a.r * 1.6, 0.02, a.r * 1.6, a.t, col, flick);
    }
    for (const c of E.claymores) put(c.x, 0.12, c.z, 0.22, 0.16, 0.08, c.yaw, this.cols.claymore);
    for (const d of game.mode.drops || []) {
      const blink = d.t > 21 && Math.floor(now * 6) % 2 ? 0 : 1;
      if (!blink) continue;
      put(d.x, 0.9 + Math.sin(now * 3) * 0.12, d.z, 0.42, 0.42, 0.42, now * 2, this.cols[d.kind], 1.8);
    }
    this.mesh.count = k;
    if (k) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
  }
}

// ------------------------------------------------------------ chalk signs
// Wall-buy outlines and door prices, drawn once to small canvas textures.
function chalkTexture(draw, w = 256, h = 128) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(240,236,220,0.9)';
  g.fillStyle = 'rgba(240,236,220,0.92)';
  g.lineWidth = 5; g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  return t;
}

const OUTLINES = {
  smg: [[30, 50], [175, 50], [175, 40], [215, 40], [215, 52], [235, 52], [235, 64], [150, 64], [140, 105], [120, 105], [124, 64], [95, 64], [88, 92], [72, 92], [76, 64], [30, 66]],
  shotgun: [[15, 52], [190, 46], [240, 46], [240, 56], [190, 58], [180, 66], [110, 68], [100, 92], [40, 84], [15, 70]],
  pistol: [[60, 40], [200, 40], [200, 60], [130, 60], [120, 100], [95, 100], [100, 60], [60, 60]],
  ar: [[10, 52], [200, 50], [200, 42], [236, 42], [236, 56], [246, 56], [246, 66], [150, 66], [146, 108], [126, 108], [128, 66], [96, 68], [92, 96], [76, 96], [80, 68], [20, 70]],
  machete: [[20, 70], [70, 60], [220, 40], [236, 46], [220, 62], [80, 82], [26, 86]],
  claymore: [[70, 40], [186, 40], [196, 86], [60, 86]],
  noisemaker: [[110, 30], [146, 30], [160, 100], [96, 100]],
  molotov: [[116, 22], [140, 22], [140, 48], [160, 70], [160, 110], [96, 110], [96, 70], [116, 48]],
  stun: [[96, 34], [160, 34], [168, 106], [88, 106]],
};

export function chalkSign(kind, text) {
  const tex = chalkTexture((g, w, h) => {
    if (kind === 'text') {
      g.font = 'bold 44px system-ui, sans-serif';
      g.textAlign = 'center';
      text.split('\n').forEach((line, i, a) => g.fillText(line, w / 2, h / 2 + (i - (a.length - 1) / 2) * 48 + 14));
      return;
    }
    const pts = OUTLINES[kind] || OUTLINES.pistol;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x + Math.random() * 2, y + Math.random() * 2) : g.moveTo(x, y)));
    g.closePath();
    g.stroke();
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
}
