// First-person weapons, hit effects and chalk signs. Viewmodels are built
// from boxes per weapon model (no meshes to download); effects are pooled
// instanced particles and tracers, so a firefight allocates nothing.
import { THREE } from './render.js';
import { WEAPONS, KNIFE } from './sim/weapons.js';

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
const MODELS = {
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

export function buildViewmodel(id) {
  const W = WEAPONS[id];
  const def = MODELS[W.model]();
  const geo = merge([...def.parts, ...hands(W.model)]);
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
  // Knife, hidden until a melee.
  const knife = new THREE.Mesh(merge([
    block(0.02, 0.025, 0.11, GRIP, 0, 0, 0.05),
    block(0.006, 0.03, 0.16, 0xd8dbe2, 0, 0.004, -0.08),
    block(0.06, 0.065, 0.08, GLOVE, 0, -0.01, 0.1),
  ]), mat);
  knife.visible = false;
  return { root, mesh, flash, knife, def, id };
}

// Per-frame viewmodel pose from the player's state.
export function poseViewmodel(vm, P, dt, now, lookX, lookY) {
  const d = vm.def, W = WEAPONS[vm.id];
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
    const p = Math.min(1, P.actT / KNIFE.time);
    y -= 0.3 * Math.sin(Math.PI * Math.min(1, p * 1.4));
    const k = Math.min(1, P.actT / KNIFE.hitAt);
    vm.knife.position.set(0.25 - 0.4 * k, -0.12 + 0.03 * Math.sin(Math.PI * k), -0.32);
    vm.knife.rotation.set(-0.2, 0.9 - 1.6 * k, -0.6 + 0.4 * k);
  }
  if (P.down) { y -= 0.4; }
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
