// The farm's buildings: one InstancedMesh per piece type (built from boxes
// like the guns), recoloured by tier and damage, so even a sprawling base
// is a dozen draw calls. Turret guns turn to face what they shoot. Plus
// the ghost that shows where the next piece would go.
import { THREE } from './render.js';
import { block, merge } from './gear.js';
import { PIECES, PIECE_ORDER, MAX_PIECES } from './sim/shelter.js';
import { assets } from './assets.js';
import { L } from './worldgeo.js';

const P = L.planks;
// A baked CC0 prop as a piece: footprint `len` m, with a little light
// baked in (the world material is unlit).
function propGeo(name, len) {
  const A = assets.props[name];
  const k = len / Math.max(A.size[0], A.size[2]), n = A.pos.length / 3;
  const pos = A.pos.map(v => v * k), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = 0.6 + 0.5 * Math.max(0, A.nrm[i * 3 + 1] * 0.75 - A.nrm[i * 3] * 0.45 - A.nrm[i * 3 + 2] * 0.5);
    for (let j = 0; j < 3; j++) col[i * 3 + j] = A.col[i * 3 + j] * l * 1.4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tuv', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  return g;
}

const W = 0xffffff, WOOD = 0x8a6a44, DARK = 0x2c2e34, STEEL = 0x8a9098;
const SHAPES = {
  wall: () => [block(1, 3.2, 1, W, 0, 1.6, 0, 0, P), block(1.02, 0.08, 1.02, 0xcccccc, 0, 1.1, 0), block(1.02, 0.08, 1.02, 0xcccccc, 0, 2.3, 0)],
  gate: () => [block(0.14, 3.2, 0.14, W, -0.43, 1.6, 0, 0, P), block(0.14, 3.2, 0.14, W, 0.43, 1.6, 0, 0, P), block(0.72, 2.7, 0.12, 0xe8e0d0, 0, 1.45, 0, 0, P), block(0.72, 0.1, 0.16, 0xbbbbbb, 0, 1.6, 0)],
  sandbags: () => [0, 1, 2].flatMap(r => [block(0.48, 0.38, 0.95, 0xb8a888, -0.25 + (r % 2) * 0.1, 0.2 + r * 0.38, 0), block(0.48, 0.38, 0.95, 0xa89878, 0.25 + (r % 2) * 0.1, 0.2 + r * 0.38, 0)]),
  spikes: () => [block(0.9, 0.08, 0.9, WOOD, 0, 0.04, 0), ...[-0.3, 0, 0.3].flatMap(x => [-0.3, 0.3].map(z => block(0.06, 0.45, 0.06, 0xd8d0c0, x, 0.25, z, 0.5)))],
  tower: () => [
    ...[[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].map(([x, z]) => block(0.12, 3.6, 0.12, W, x, 1.8, z, 0, P)),
    block(1, 0.12, 1, W, 0, 3.0, 0, 0, P), block(1, 0.5, 0.06, W, 0, 3.35, -0.47, 0, P), block(1, 0.5, 0.06, W, 0, 3.35, 0.47, 0, P), block(0.06, 0.5, 1, W, 0.47, 3.35, 0, 0, P),
    ...[0.5, 1.1, 1.7, 2.3].map(y => block(0.6, 0.06, 0.06, 0xcccccc, 0, y, 0.5)),
  ],
  storage: () => [propGeo('ammobox', 0.9)],
  workbench: () => [block(1, 0.1, 0.7, WOOD, 0, 0.9, 0), ...[[-0.42, -0.28], [0.42, -0.28], [-0.42, 0.28], [0.42, 0.28]].map(([x, z]) => block(0.08, 0.85, 0.08, 0x5a3a22, x, 0.43, z)), block(0.18, 0.15, 0.14, STEEL, 0.35, 1.02, 0), block(0.4, 0.06, 0.25, 0x9a9a9a, -0.2, 0.98, 0)],
  generator: () => [block(0.9, 0.85, 0.65, 0xc0a030, 0, 0.45, 0), block(0.95, 0.1, 0.7, DARK, 0, 0.92, 0), block(0.1, 0.5, 0.1, DARK, 0.3, 1.2, 0.2)],
  turret: () => [block(0.5, 1.25, 0.5, STEEL, 0, 0.62, 0), block(0.44, 0.3, 0.44, DARK, 0, 1.4, 0)],
  shocker: () => [block(0.14, 1.0, 0.14, DARK, 0, 0.5, 0), ...[0.45, 0.65, 0.85].map(y => block(0.42, 0.06, 0.42, 0xd09040, 0, y, 0)), block(0.16, 0.16, 0.16, 0x9fd8ff, 0, 1.08, 0)],
  medbay: () => [block(0.9, 1.8, 0.6, 0xeeeeee, 0, 0.9, 0), block(0.4, 0.12, 0.62, 0xd02020, 0, 1.25, 0), block(0.12, 0.4, 0.62, 0xd02020, 0, 1.25, 0)],
};
const TEXTURED = new Set(['wall', 'gate', 'tower']);
const TIER_COL = [0x8a6a44, 0x8a9098, 0x5a5f68].map(c => new THREE.Color(c));
const HURT = new THREE.Color(0x4a1010);

export class ShelterView {
  // `mat` is the world's own material, so pieces take the same day/night
  // tint and catch the flashlight like everything else.
  constructor(scene, shelter, mat) {
    this.scene = scene;
    this.shelter = shelter;
    this.meshes = {};
    for (const type of PIECE_ORDER) {
      const m = new THREE.InstancedMesh(merge(SHAPES[type]()), mat, MAX_PIECES);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
      this.meshes[type] = m;
    }
    this.guns = new THREE.InstancedMesh(merge([block(0.12, 0.12, 0.7, DARK, 0, 0, -0.25), block(0.2, 0.2, 0.25, STEEL, 0, 0, 0.05)]), mat, 64);
    this.guns.count = 0; this.guns.frustumCulled = false;
    scene.add(this.guns);
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost.visible = false;
    scene.add(this.ghost);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler();
    this.v = new THREE.Vector3(); this.s = new THREE.Vector3(1, 1, 1); this.c = new THREE.Color();
    this.sig = '';
  }

  update() {
    const pieces = this.shelter.pieces;
    // Rebuild the instance lists only when something changed.
    let sig = 0, n = 0;
    for (const p of pieces) if (p) { n++; sig = (sig * 31 + p.id * 7 + p.tier * 13 + Math.round(p.hp / 25)) | 0; }
    const key = n + ':' + sig;
    if (key !== this.sig) {
      this.sig = key;
      const counts = {};
      for (const type of PIECE_ORDER) counts[type] = 0;
      for (const p of pieces) {
        if (!p) continue;
        const mesh = this.meshes[p.type], k = counts[p.type]++;
        this.e.set(0, (p.rot || 0) * Math.PI / 2, 0); this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(p.x + 0.5, 0, p.z + 0.5), this.q, this.s.set(1, 1, 1));
        mesh.setMatrixAt(k, this.m);
        const base = p.type === 'wall' || p.type === 'gate' || p.type === 'tower' ? TIER_COL[p.tier] : this.c.set(0xffffff);
        this.c.copy(base).lerp(HURT, Math.max(0, 1 - p.hp / p.maxHp) * 0.55).multiplyScalar(TEXTURED.has(p.type) ? 1.1 : 0.5); // night-baked like the map (plank texture darkens)
        mesh.setColorAt(k, this.c);
      }
      for (const type of PIECE_ORDER) {
        const mesh = this.meshes[type];
        mesh.count = counts[type];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    // Turret guns track every frame.
    let g = 0;
    for (const p of pieces) {
      if (!p || p.type !== 'turret' || g >= 64) continue;
      this.e.set(0, p.yaw || 0, 0); this.q.setFromEuler(this.e);
      this.m.compose(this.v.set(p.x + 0.5, 1.62, p.z + 0.5), this.q, this.s.set(1, 1, 1));
      this.guns.setMatrixAt(g++, this.m);
    }
    this.guns.count = g;
    if (g) this.guns.instanceMatrix.needsUpdate = true;
  }

  showGhost(x, z, type, ok) {
    if (x == null) { this.ghost.visible = false; return; }
    const h = PIECES[type].h;
    this.ghost.visible = true;
    this.ghost.position.set(x + 0.5, h / 2, z + 0.5);
    this.ghost.scale.set(1, h, 1);
    this.ghost.material.color.set(ok ? 0x40ff60 : 0xff4040);
  }

  dispose() {
    for (const m of [...Object.values(this.meshes), this.guns]) { this.scene.remove(m); m.geometry.dispose(); }
    this.scene.remove(this.ghost); this.ghost.geometry.dispose(); this.ghost.material.dispose();
  }
}
