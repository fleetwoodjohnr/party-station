// First-person weapons, hit effects and chalk signs. Viewmodels are built
// from boxes per weapon model (no meshes to download); effects are pooled
// instanced particles and tracers, so a firefight allocates nothing.
import { THREE } from './render.js';
import { WEAPONS, MELEE, RARITY } from './sim/weapons.js';

const lin = hex => new THREE.Color(hex);

// A box with a baked top-light gradient, coloured once.
function block(w, h, d, hex, x, y, z, rx = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.getAttribute('position');
  const c = lin(hex);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = 0.55 + 0.45 * ((pos.getY(i) / h) + 0.5);
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

function merge(geos) {
  let n = 0;
  for (const g of geos) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), idx = [];
  let o = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), c = g.getAttribute('color');
    pos.set(p.array, o * 3); col.set(c.array, o * 3);
    for (const i of g.index.array) idx.push(i + o);
    o += p.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.setIndex(idx);
  return m;
}

const METAL = 0x2b2e36, STEEL = 0x4c505c, WOOD = 0x6b4426, GRIP = 0x1c1d22, SKIN = 0xc79a7a, SLEEVE = 0x3a4436, GLOVE = 0x26282c;

// Gun parts in metres, muzzle toward -z; returns { geo, muzzle: z of tip, sightY }.
// Shared shapes: a receiver, barrel, magazine, grip and stock, sized per
// gun. `optic` is where a sight sits (y of the rail, z along the gun).
const rifle = ({ len = 0.34, bar = 0.18, barW = 0.022, mag = [0.03, 0.13, 0.05], magZ = -0.1, stock = 0.2, h = 0.07, wood = false }) => ({
  parts: [
    block(0.052, h, len, wood ? WOOD : METAL, 0, 0, -len / 2 + 0.08),
    block(barW, barW, bar, STEEL, 0, 0.01, -len + 0.08 - bar / 2),
    block(mag[0], mag[1], mag[2], GRIP, 0, -h / 2 - mag[1] / 2 + 0.01, magZ, -0.12),
    block(0.03, 0.09, 0.04, GRIP, 0, -0.075, 0.03, 0.3),
    block(0.034, 0.05, stock, wood ? WOOD : METAL, 0, -0.01, 0.08 + stock / 2),
    block(0.012, 0.022, 0.012, METAL, 0, h / 2 + 0.011, -len + 0.12),
    block(0.03, 0.016, 0.03, METAL, 0, h / 2 + 0.008, 0.02),
  ],
  muzzle: -len + 0.08 - bar, sightY: h / 2 + 0.02, rail: h / 2 + 0.005, hipX: 0.16, hipY: -0.17, z: -0.34, adsZ: -0.3,
  magAt: [0, -h / 2 - mag[1] / 2 + 0.01, magZ], mag, fore: magZ - 0.1,
});

const MODELS = {
  revolver: () => ({
    parts: [
      block(0.034, 0.034, 0.2, STEEL, 0, 0.02, -0.1),
      block(0.05, 0.05, 0.06, METAL, 0, 0.01, -0.01),
      block(0.03, 0.1, 0.045, WOOD, 0, -0.06, 0.04, 0.35),
      block(0.008, 0.012, 0.01, METAL, 0, 0.043, -0.19),
    ],
    muzzle: -0.2, sightY: 0.05, hipX: 0.15, hipY: -0.15, z: -0.36, adsZ: -0.34,
  }),
  pdw: () => ({ ...rifle({ len: 0.26, bar: 0.08, mag: [0.028, 0.16, 0.04], magZ: 0.02, stock: 0.14 }), hipX: 0.15 }),
  ar: () => rifle({ len: 0.4, bar: 0.22, mag: [0.032, 0.15, 0.055], magZ: -0.12, stock: 0.22 }),
  br: () => ({ ...rifle({ len: 0.44, bar: 0.2, mag: [0.034, 0.12, 0.06], magZ: -0.14, stock: 0.24, h: 0.08 }) }),
  autoshotgun: () => rifle({ len: 0.42, bar: 0.24, barW: 0.034, mag: [0.06, 0.12, 0.08], magZ: -0.12, stock: 0.22, h: 0.08 }),
  sawnoff: () => ({
    parts: [
      block(0.07, 0.035, 0.32, STEEL, 0, 0.02, -0.14),
      block(0.05, 0.05, 0.12, WOOD, 0, 0.0, 0.05),
      block(0.035, 0.1, 0.05, WOOD, 0, -0.06, 0.12, 0.5),
    ],
    muzzle: -0.3, sightY: 0.045, hipX: 0.15, hipY: -0.16, z: -0.32, adsZ: -0.3,
  }),
  dmr: () => rifle({ len: 0.5, bar: 0.26, mag: [0.03, 0.09, 0.06], magZ: -0.16, stock: 0.26, wood: true }),
  sniper: () => ({
    ...rifle({ len: 0.55, bar: 0.36, mag: [0.03, 0.06, 0.06], magZ: -0.12, stock: 0.28, wood: true }),
    scopeBuiltIn: true,
  }),
  lmg: () => ({
    ...rifle({ len: 0.5, bar: 0.28, barW: 0.028, mag: [0.1, 0.1, 0.12], magZ: -0.08, stock: 0.24, h: 0.09 }),
    hipX: 0.17, hipY: -0.19,
  }),
  launcher: () => ({
    parts: [
      block(0.085, 0.085, 0.42, 0x4a5236, 0, 0.0, -0.18),
      block(0.06, 0.06, 0.12, METAL, 0, -0.01, 0.07),
      block(0.03, 0.1, 0.045, GRIP, 0, -0.08, -0.02, 0.3),
      block(0.034, 0.05, 0.2, METAL, 0, -0.01, 0.2),
      block(0.03, 0.03, 0.03, 0xffa020, 0, 0.06, -0.32),
    ],
    muzzle: -0.39, sightY: 0.075, hipX: 0.16, hipY: -0.17, z: -0.34, adsZ: -0.32,
  }),
  pistol: () => ({
    parts: [
      block(0.036, 0.04, 0.2, STEEL, 0, 0.02, -0.06),
      block(0.032, 0.03, 0.17, METAL, 0, -0.012, -0.05),
      block(0.03, 0.1, 0.045, GRIP, 0, -0.065, 0.02, 0.25),
      block(0.008, 0.01, 0.01, METAL, 0, 0.046, -0.15),
      block(0.02, 0.01, 0.01, METAL, 0, 0.046, 0.025),
    ],
    muzzle: -0.17, sightY: 0.05, hipX: 0.15, hipY: -0.15, z: -0.36, adsZ: -0.34,
  }),
  smg: () => ({
    parts: [
      block(0.05, 0.065, 0.32, METAL, 0, 0, -0.08),
      block(0.024, 0.024, 0.16, STEEL, 0, 0.008, -0.31),
      block(0.03, 0.14, 0.045, GRIP, 0, -0.1, -0.12, -0.15),
      block(0.03, 0.09, 0.04, GRIP, 0, -0.07, 0.02, 0.3),
      block(0.03, 0.035, 0.2, METAL, 0, 0.005, 0.17),
      block(0.012, 0.03, 0.012, METAL, 0, 0.045, -0.2),
      block(0.03, 0.02, 0.03, METAL, 0, 0.045, 0.02),
    ],
    muzzle: -0.39, sightY: 0.058, hipX: 0.16, hipY: -0.17, z: -0.34, adsZ: -0.3,
  }),
  shotgun: () => ({
    parts: [
      block(0.034, 0.034, 0.62, STEEL, 0, 0.018, -0.28),
      block(0.026, 0.026, 0.42, METAL, 0, -0.014, -0.22),
      block(0.05, 0.05, 0.13, WOOD, 0, -0.012, -0.28),
      block(0.046, 0.06, 0.17, METAL, 0, -0.008, 0.05),
      block(0.04, 0.08, 0.26, WOOD, 0, -0.05, 0.24, 0.12),
      block(0.008, 0.012, 0.01, 0xc8c8c0, 0, 0.04, -0.58),
    ],
    muzzle: -0.6, sightY: 0.05, hipX: 0.15, hipY: -0.17, z: -0.32, adsZ: -0.36,
  }),
};

function hands(model) {
  const g = [];
  // Right hand on the grip, sleeve trailing back out of view.
  g.push(block(0.05, 0.06, 0.07, GLOVE, 0.005, -0.075, 0.03));
  g.push(block(0.055, 0.055, 0.26, SLEEVE, 0.035, -0.115, 0.24, 0.3));
  // Left hand on the fore-end (pistol: cupping the right).
  const fz = model === 'pistol' ? 0.0 : model === 'smg' ? -0.2 : -0.28;
  g.push(block(0.05, 0.05, 0.08, GLOVE, -0.022, -0.05, fz));
  g.push(block(0.055, 0.055, 0.26, SLEEVE, -0.085, -0.12, fz + 0.2, 0.4));
  return g;
}

// Attachments on the model: optic on the rail (and the sight line moves up
// to it so ADS still lines up), muzzle devices, bigger mags, foregrips,
// and a rarity stripe on the receiver.
function fit(def, w) {
  const extra = [];
  const att = w.att || {};
  const top = def.rail ?? def.sightY - 0.015;
  if (att.optic === 'reddot') { extra.push(block(0.03, 0.03, 0.05, METAL, 0, top + 0.015, -0.03)); def.sightY = top + 0.022; }
  if (att.optic === 'holo') { extra.push(block(0.04, 0.035, 0.03, METAL, 0, top + 0.018, -0.05), block(0.006, 0.03, 0.006, METAL, 0.017, top + 0.04, -0.05), block(0.006, 0.03, 0.006, METAL, -0.017, top + 0.04, -0.05)); def.sightY = top + 0.032; }
  if (att.optic === 'scope4' || def.scopeBuiltIn) { extra.push(block(0.036, 0.036, 0.24, 0x1d1f24, 0, top + 0.03, -0.05)); def.sightY = top + 0.03; def.scope = true; }
  if (att.muzzle === 'suppressor') extra.push(block(0.034, 0.034, 0.16, 0x1d1f24, 0, (def.sightY - 0.03), def.muzzle - 0.08));
  if (att.muzzle === 'compensator') extra.push(block(0.03, 0.03, 0.05, STEEL, 0, (def.sightY - 0.03), def.muzzle - 0.02));
  if (att.muzzle === 'suppressor') def.muzzle -= 0.16;
  if (att.mag === 'extmag' && def.magAt) extra.push(block(def.mag[0] * 1.05, def.mag[1] * 0.6, def.mag[2], GRIP, def.magAt[0], def.magAt[1] - def.mag[1] * 0.55, def.magAt[2]));
  if ((att.grip === 'vgrip' || att.grip === 'agrip') && def.fore != null) extra.push(block(0.028, 0.08, 0.03, GRIP, 0, -0.07, def.fore, att.grip === 'agrip' ? -0.6 : 0));
  if (w.tier) extra.push(block(0.054, 0.012, 0.12, new THREE.Color(RARITY[w.tier].color).getHex(), 0, 0.012, -0.04));
  return extra;
}

export function buildViewmodel(w, meleeId = 'knife') {
  const W = WEAPONS[w.id];
  const def = MODELS[W.model]();
  const extra = fit(def, w);
  const geo = merge([...def.parts, ...extra, ...hands(W.model)]);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const mesh = new THREE.Mesh(geo, mat);
  const root = new THREE.Group();
  root.add(mesh);
  // Muzzle flash: two crossed additive quads, shown for a frame or two.
  const fm = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const flash = new THREE.Group();
  for (const r of [0, Math.PI / 2]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), fm);
    q.rotation.set(0, Math.PI / 2, r);
    flash.add(q);
    const q2 = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), fm);
    q2.rotation.z = r + Math.PI / 4;
    flash.add(q2);
  }
  flash.position.set(0, def.sightY - 0.03, def.muzzle - 0.04);
  flash.visible = false;
  root.add(flash);
  // Knife (or machete), hidden until a melee.
  const big = meleeId === 'machete';
  const knife = new THREE.Mesh(merge([
    block(0.02, 0.025, 0.11, GRIP, 0, 0, 0.05),
    block(0.006, big ? 0.05 : 0.03, big ? 0.42 : 0.16, 0xd8dbe2, 0, 0.004, big ? -0.21 : -0.08),
    block(0.06, 0.065, 0.08, GLOVE, 0, -0.01, 0.1),
  ]), mat);
  knife.visible = false;
  return { root, mesh, flash, knife, def, id: w.id, key: vmKey(w, meleeId) };
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
