// The game's art: CC0 models by Quaternius (via poly.pizza) and CC0
// textures from Poly Haven — see /night-assets/CREDITS.md. Loaded once per
// page while the title screen is up; render.js, gear.js and worldgeo.js
// build everything on screen from what this hands them.
//
// Characters keep their skeleton and clips but swap the glTF's PBR
// material for a Lambert one (cheap on a Pi). Guns and props are flattened
// into one vertex-coloured mesh each: material colour × texture sample ×
// vertex colour baked per vertex, so a whole gun is one draw call and a
// prop can be merged straight into the world's baked-light chunks.
import * as THREE from '/vendor/three/three.module.js';
import { GLTFLoader } from '/vendor/three/addons/GLTFLoader.js';
import { TEX, L, setProps } from './worldgeo.js';

const BASE = '/night-assets/';

export const CHAR_FILES = ['zombie', 'brute', 'matt', 'lis', 'sam', 'shaun'];
const names = s => Object.fromEntries(s.split(' ').map(n => [n, n]));
export const GUN_FILES = names('pistol revolver smg pdw ar ak akwood bullpup shotgun shortstock sawnoff sniper launcher knife machete grenade firegrenade landmine scope bipod');
export const PROP_FILES = names('car1 car2 car3 car4 pine tree deadtree streetlight ceilinglight drawer bookcase fridge lootbox chest ammobox boxes smallboxes bag trashcan pallet rock watertower');

export const assets = { chars: {}, guns: {}, props: {}, texArray: null };
let loading = null;

export function loadAssets(progress = () => {}) {
  if (loading) return loading;
  const loader = new GLTFLoader();
  const jobs = [
    ...CHAR_FILES.map(n => ['chars', n, `chars/${n}.glb`]),
    ...Object.entries(GUN_FILES).map(([n, f]) => ['guns', n, `guns/${f}.glb`]),
    ...Object.entries(PROP_FILES).map(([n, f]) => ['props', n, `props/${f}.glb`]),
  ];
  let done = 0;
  const tick = () => progress(++done / (jobs.length + 1));
  loading = Promise.all([
    ...jobs.map(([kind, name, file]) => loader.loadAsync(BASE + file).then(g => {
      assets[kind][name] = kind === 'chars' ? prepChar(g) : kind === 'guns' ? bakeMesh(g.scene) : bakeArrays(g.scene);
      tick();
    })),
    buildTextures().then(t => { assets.texArray = t; tick(); }),
  ]).then(() => { setProps(assets.props); return assets; });
  return loading;
}

// ------------------------------------------------------------ characters
// One Lambert material per character file; clips by their short name.
function prepChar(g) {
  const mats = new Map();
  g.scene.traverse(o => {
    if (!o.isMesh) return;
    if (!mats.has(o.material)) {
      const m = o.material;
      mats.set(m, new THREE.MeshLambertMaterial({ map: m.map, color: m.color, vertexColors: m.vertexColors }));
    }
    o.material = mats.get(o.material);
    o.frustumCulled = false; // bind-pose bounds don't follow the animation
  });
  const box = new THREE.Box3().setFromObject(g.scene);
  const clips = Object.fromEntries(g.animations.map(c => [c.name.split('|').pop(), c]));
  return { scene: g.scene, clips, height: box.max.y - box.min.y, minY: box.min.y };
}

// ------------------------------------------------------- baked meshes
const pixels = new Map();
function texSampler(tex) {
  if (!tex?.image) return null;
  let px = pixels.get(tex.image);
  if (!px) {
    const img = tex.image, w = img.width, h = img.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    px = { w, h, d: g.getImageData(0, 0, w, h).data };
    pixels.set(tex.image, px);
  }
  // glTF UVs: (0,0) is the image's top-left. Returns linear RGB.
  return (u, v, out) => {
    const x = Math.min(px.w - 1, Math.floor((u - Math.floor(u)) * px.w));
    const y = Math.min(px.h - 1, Math.floor((v - Math.floor(v)) * px.h));
    const i = (y * px.w + x) * 4;
    out.setRGB(px.d[i] / 255, px.d[i + 1] / 255, px.d[i + 2] / 255, THREE.SRGBColorSpace);
    return out;
  };
}

// Every mesh in the scene, in scene space, as flat triangles with colour.
function flatten(root) {
  root.updateMatrixWorld(true);
  const pos = [], col = [], nrm = [];
  const c = new THREE.Color(), s = new THREE.Color(), v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), UV = g.getAttribute('uv'), VC = g.getAttribute('color');
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: P.count, materialIndex: 0 }];
    nm.getNormalMatrix(o.matrixWorld);
    for (const gr of groups) {
      const m = mats[gr.materialIndex] || mats[0];
      const sample = UV && texSampler(m.map);
      for (let i = gr.start; i < gr.start + gr.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
        pos.push(v.x, v.y, v.z);
        if (N) { n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nrm.push(n.x, n.y, n.z); }
        c.copy(m.color || c.set(1, 1, 1));
        if (sample) c.multiply(sample(UV.getX(i), UV.getY(i), s));
        if (VC) c.multiply(s.fromBufferAttribute(VC, i));
        col.push(c.r, c.g, c.b);
      }
    }
    // Flat-shaded props ship without normals: one per face.
    if (!N) {
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (let k = nrm.length; k < pos.length; k += 9) {
        v.fromArray(pos, k); a.fromArray(pos, k + 3).sub(v); b.fromArray(pos, k + 6).sub(v);
        n.crossVectors(a, b).normalize();
        for (let j = 0; j < 3; j++) nrm.push(n.x, n.y, n.z);
      }
    }
    if (g !== o.geometry) g.dispose();
  });
  return { pos: new Float32Array(pos), col: new Float32Array(col), nrm: new Float32Array(nrm) };
}

// Props for the world builder: plain arrays (they go to a worker), sitting
// on y = 0 with the origin at the middle of what touches the ground (the
// trunk, the pole, between the wheels), plus their size and where their
// top is relative to that (a street lamp's head hangs out on its arm).
function bakeArrays(root) {
  const a = flatten(root);
  const b = new THREE.Box3().setFromArray(a.pos);
  const h = b.max.y - b.min.y;
  const mid = (lo, k) => {
    let x = 0, z = 0, n = 0;
    for (let i = 0; i < a.pos.length; i += 3) if (lo ? a.pos[i + 1] < b.min.y + h * k : a.pos[i + 1] > b.max.y - h * k) { x += a.pos[i]; z += a.pos[i + 2]; n++; }
    return [x / n, z / n];
  };
  const [cx, cz] = mid(true, 0.05), [tx, tz] = mid(false, 0.15);
  for (let i = 0; i < a.pos.length; i += 3) { a.pos[i] -= cx; a.pos[i + 1] -= b.min.y; a.pos[i + 2] -= cz; }
  a.size = [b.max.x - b.min.x, h, b.max.z - b.min.z];
  a.top = [tx - cx, tz - cz];
  return a;
}

// Guns: one BufferGeometry with colour and normals, as authored.
function bakeMesh(root) {
  const a = flatten(root);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(a.col, 3));
  g.computeBoundingBox();
  return g;
}

// --------------------------------------------------------------- textures
const TS = 256;
async function buildTextures() {
  const data = new Uint8Array(TS * TS * 4 * TEX.length);
  const c = document.createElement('canvas'); c.width = c.height = TS;
  const g = c.getContext('2d', { willReadFrequently: true });
  const put = layer => data.set(g.getImageData(0, 0, TS, TS).data, layer * TS * TS * 4);
  g.fillStyle = '#fff'; g.fillRect(0, 0, TS, TS); put(0);
  const imgs = await Promise.all(TEX.slice(1, -1).map(n => fetch(`${BASE}tex/${n}.jpg`).then(r => r.blob()).then(b => createImageBitmap(b))));
  imgs.forEach((im, i) => { g.drawImage(im, 0, 0, TS, TS); put(i + 1); im.close?.(); });
  drawWindow(g); put(L.window);
  const t = new THREE.DataArrayTexture(data, TS, TS, TEX.length);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// A sash window. Texture rows run bottom-up (row 0 is v = 0), so canvas
// y here counts up from the sill. Frame in the wall's paint colour (white
// here, tinted by the vertex colour), dark glass with a faint sheen.
function drawWindow(g) {
  g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, TS, TS);
  const glass = g.createLinearGradient(0, 0, TS, TS);
  glass.addColorStop(0, '#1b2230'); glass.addColorStop(0.45, '#0b0e14'); glass.addColorStop(0.55, '#202a3a'); glass.addColorStop(1, '#090b10');
  g.fillStyle = glass;
  g.fillRect(40, 34, TS - 80, 92); g.fillRect(40, 138, TS - 80, 92);
  g.fillStyle = '#c8c8c8'; g.fillRect(TS / 2 - 4, 34, 8, 196);
  g.fillStyle = '#9a9a9a'; g.fillRect(28, 16, TS - 56, 14); // sill
}
