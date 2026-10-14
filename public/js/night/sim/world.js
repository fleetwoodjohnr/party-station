// Tile-grid world: 1 m cells, x = column, z = row (three.js: +y up).
// Pure data + math (no DOM, no three.js) so it runs in the TV browser and
// in Node (scripts/night-sim.js, co-op host). Provides the map, circle
// collision, a 3D ray march for bullets and sight lines, and the shared
// flow field every zombie steers by.

export const C = { FLOOR: 0, GROUND: 1, WALL: 2, WINDOW: 3, DOOR: 4, PROP: 5, TREE: 6, CAR: 7, FENCE: 8, VOID: 9 };
const CHAR = {
  '.': C.FLOOR, P: C.FLOOR, ',': C.GROUND, S: C.GROUND, '#': C.WALL, W: C.WINDOW,
  T: C.PROP, t: C.TREE, c: C.CAR, f: C.FENCE, X: C.VOID,
};
// Solid height of each cell type, for bullets and the renderer. Windows are
// special-cased: a hole between WIN_LO and WIN_HI.
export const TOP = [0, 0, 3.2, 3.2, 3.2, 1.0, 7, 1.4, 1.2, 50];
export const CEIL = 3.2;              // interior ceiling height
export const WIN_LO = 0.9, WIN_HI = 2.2;
export const MAX_BOARDS = 6;
const INF = 0xffffffff;

export class World {
  constructor(def) {
    const rows = def.rows;
    this.name = def.name;
    this.w = rows[0].length;
    this.h = rows.length;
    this.cells = new Uint8Array(this.w * this.h);
    this.door = new Int8Array(this.w * this.h).fill(-1);   // door group per cell
    this.win = new Int16Array(this.w * this.h).fill(-1);   // window index per cell
    this.spawns = [];
    this.starts = [];
    this.windows = [];
    this.doors = {};
    for (let y = 0; y < this.h; y++) {
      if (rows[y].length !== this.w) throw new Error(`${def.name}: row ${y} is ${rows[y].length} wide, expected ${this.w}`);
      for (let x = 0; x < this.w; x++) {
        const ch = rows[y][x];
        const i = y * this.w + x;
        if (ch >= '1' && ch <= '9') {
          this.cells[i] = C.DOOR;
          const id = +ch;
          this.door[i] = id;
          (this.doors[id] ||= { id, cells: [], open: false, cost: def.doors?.[id]?.cost ?? 1000, name: def.doors?.[id]?.name || 'Door' }).cells.push([x, y]);
          continue;
        }
        if (!(ch in CHAR)) throw new Error(`${def.name}: unknown map char '${ch}' at ${x},${y}`);
        this.cells[i] = CHAR[ch];
        if (ch === 'S') this.spawns.push([x, y]);
        if (ch === 'P') this.starts.push([x, y]);
      }
    }
    // Windows: remember which side is in and which is out, so zombies know
    // where to stand while tearing boards and where they land after.
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.cell(x, y) !== C.WINDOW) continue;
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const inside = n.find(([dx, dy]) => this.cell(x + dx, y + dy) === C.FLOOR);
        const outside = n.find(([dx, dy]) => this.cell(x + dx, y + dy) === C.GROUND);
        if (!inside || !outside) throw new Error(`${def.name}: window ${x},${y} needs floor on one side and ground on the other`);
        this.win[y * this.w + x] = this.windows.length;
        this.windows.push({
          x, y, boards: MAX_BOARDS,
          in: [x + inside[0], y + inside[1]], out: [x + outside[0], y + outside[1]],
        });
      }
    }
    this.wallbuys = (def.wallbuys || []).map(b => ({ ...b }));
    this.lamps = def.lamps || [];
    this.version = 0; // bumps whenever passability changes (flow field cache key)
  }

  // Back to a fresh map: every window boarded, every door shut.
  reset() {
    for (const w of this.windows) w.boards = MAX_BOARDS;
    for (const d of Object.values(this.doors)) d.open = false;
    this.version++;
  }

  idx(x, y) { return y * this.w + x; }
  cell(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return C.VOID;
    return this.cells[y * this.w + x];
  }
  interior(x, y) { const c = this.cell(x, y); return c === C.FLOOR || c === C.PROP || (c === C.DOOR); }

  // Can a body stand in this cell? Zombies also pass through bare windows.
  open(x, y, zombie = false) {
    const c = this.cell(x, y);
    if (c === C.FLOOR || c === C.GROUND) return true;
    if (c === C.DOOR) return this.doors[this.door[y * this.w + x]].open;
    if (c === C.WINDOW) return zombie && this.windows[this.win[y * this.w + x]].boards === 0;
    return false;
  }

  openDoor(id) {
    const d = this.doors[id];
    if (!d || d.open) return false;
    d.open = true;
    this.version++;
    return true;
  }

  setBoards(wi, n) {
    const w = this.windows[wi];
    const was = w.boards;
    w.boards = Math.max(0, Math.min(MAX_BOARDS, n));
    // Only the 0 <-> >0 edge changes who can walk through.
    if ((was === 0) !== (w.boards === 0)) this.version++;
    return w.boards;
  }

  // Push a circle (x, z, r) out of every solid cell it overlaps. Returns
  // the corrected position in `p` (mutated). Two passes settle corners.
  collide(p, r, zombie = false) {
    for (let pass = 0; pass < 2; pass++) {
      const cx = Math.floor(p.x), cz = Math.floor(p.z);
      for (let y = cz - 1; y <= cz + 1; y++) {
        for (let x = cx - 1; x <= cx + 1; x++) {
          if (this.open(x, y, zombie)) continue;
          const nx = Math.max(x, Math.min(p.x, x + 1));
          const nz = Math.max(y, Math.min(p.z, y + 1));
          let dx = p.x - nx, dz = p.z - nz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 < 1e-9) { // centre inside the cell: shove out the short way
            const l = p.x - x, rr = x + 1 - p.x, t = p.z - y, b = y + 1 - p.z;
            const m = Math.min(l, rr, t, b);
            if (m === l) p.x = x - r; else if (m === rr) p.x = x + 1 + r;
            else if (m === t) p.z = y - r; else p.z = y + 1 + r;
            continue;
          }
          const d = Math.sqrt(d2);
          p.x = nx + dx / d * r;
          p.z = nz + dz / d * r;
        }
      }
    }
    return p;
  }

  // Is this point inside solid stuff? (height-aware, for the ray march)
  solidAt(x, y, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    const c = this.cell(cx, cz);
    if (y < 0) return true;
    switch (c) {
      case C.FLOOR: return y > CEIL;
      case C.GROUND: return false;
      case C.WINDOW: return y < WIN_LO || y > WIN_HI;
      case C.DOOR: return !this.doors[this.door[cz * this.w + cx]].open || y > CEIL;
      case C.PROP: return y < TOP[C.PROP] || y > CEIL;
      default: return y < TOP[c];
    }
  }

  // March a ray from o along unit dir d; distance to the first solid point
  // (or max). Grid DDA picks the cells; within a cell the ray's height is
  // checked at entry, exit and the floor/top crossing, which is exact for
  // these axis-aligned slabs.
  raycast(ox, oy, oz, dx, dy, dz, max = 60) {
    let cx = Math.floor(ox), cz = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? cx + 1 - ox : ox - cx) * tdx) : Infinity;
    let tmz = dz !== 0 ? ((dz > 0 ? cz + 1 - oz : oz - cz) * tdz) : Infinity;
    let t0 = 0;
    for (let guard = 0; guard < 512 && t0 < max; guard++) {
      const t1 = Math.min(tmx, tmz, max);
      // Sample entry, exit, and any horizontal surface crossed in between.
      const hit = this._cellHit(cx, cz, oy, dy, t0, t1);
      if (hit >= 0) return { t: hit, x: ox + dx * hit, y: oy + dy * hit, z: oz + dz * hit, cx, cz };
      if (t1 >= max) break;
      t0 = t1;
      if (tmx < tmz) { cx += stepX; tmx += tdx; } else { cz += stepZ; tmz += tdz; }
    }
    return null;
  }

  _cellHit(cx, cz, oy, dy, t0, t1) {
    const c = this.cell(cx, cz);
    let lo = 0, hi = 0; // open between lo and hi; solid below lo / above hi
    switch (c) {
      case C.GROUND: lo = 0; hi = Infinity; break;
      case C.FLOOR: lo = 0; hi = CEIL; break;
      case C.WINDOW: lo = WIN_LO; hi = WIN_HI; break;
      case C.DOOR: if (this.doors[this.door[cz * this.w + cx]].open) { lo = 0; hi = CEIL; } else return t0; break;
      case C.PROP: lo = TOP[C.PROP]; hi = CEIL; break;
      default: lo = TOP[c]; hi = Infinity;
    }
    const y0 = oy + dy * t0, y1 = oy + dy * t1;
    if (y0 < lo || y0 > hi) return t0;          // entered through a solid face
    if (y1 < lo) return dy !== 0 ? Math.max(t0, (lo - oy) / dy) : t0;
    if (y1 > hi) return dy !== 0 ? Math.max(t0, (hi - oy) / dy) : t0;
    return -1;
  }

  // Line of sight between two eye points (used by AI and turrets).
  sees(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-6;
    const hit = this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len);
    return !hit;
  }

  // ------------------------------------------------------------ flow field
  // Multi-source Dijkstra from the targets (player cells) over everything a
  // zombie could cross. Boarded windows count as passable but expensive, so
  // the field leads zombies to the window they must break, not around it.
  // `next[i]` is the neighbour cell to step toward (-1 = at a target / stuck).
  flow(targets) {
    const n = this.w * this.h, w = this.w;
    if (!this._dist) {
      this._dist = new Uint32Array(n);
      this._next = new Int32Array(n);
      this._cost = new Int8Array(n);
      this._heap = new Int32Array(n * 8);
      this._hk = new Uint32Array(n * 8);
    }
    const dist = this._dist, next = this._next, cost = this._cost;
    for (let i = 0; i < n; i++) cost[i] = this._stepCost(i % w, (i / w) | 0);
    // A diagonal step is allowed only when both orthogonal cells are plain
    // walkable (cost 1, never a window) and so is the destination.
    dist.fill(INF); next.fill(-1);
    const heap = this._heap, hk = this._hk;
    let size = 0;
    const push = (k, v) => {
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; heap[i] = heap[p]; i = p;
      }
      hk[i] = k; heap[i] = v;
    };
    for (const [x, y] of targets) {
      if (x < 0 || y < 0 || x >= w || y >= this.h) continue;
      const i = y * w + x;
      dist[i] = 0;
      push(0, i);
    }
    const relax = (from, to, base) => {
      const c = cost[to];
      if (c <= 0) return;
      const nd = dist[from] + base * c;
      if (nd < dist[to]) { dist[to] = nd; next[to] = from; push(nd, to); }
    };
    while (size > 0) {
      // pop
      const i = heap[0], key = hk[0];
      const k = hk[--size], v = heap[size];
      let j = 0;
      for (;;) {
        let c = 2 * j + 1;
        if (c >= size) break;
        if (c + 1 < size && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[j] = hk[c]; heap[j] = heap[c]; j = c;
      }
      hk[j] = k; heap[j] = v;
      if (key > dist[i]) continue; // stale entry
      // The map edge is always VOID (cost -1), so ±1/±w never wraps into
      // a walkable cell on the far side.
      const e = i + 1, wst = i - 1, s2 = i + w, nn = i - w;
      relax(i, e, 10); relax(i, wst, 10); relax(i, s2, 10); relax(i, nn, 10);
      const ce = cost[e] === 1, cw = cost[wst] === 1, cs = cost[s2] === 1, cn = cost[nn] === 1;
      if (ce && cs && cost[s2 + 1] === 1) relax(i, s2 + 1, 14);
      if (ce && cn && cost[nn + 1] === 1) relax(i, nn + 1, 14);
      if (cw && cs && cost[s2 - 1] === 1) relax(i, s2 - 1, 14);
      if (cw && cn && cost[nn - 1] === 1) relax(i, nn - 1, 14);
    }
    return { dist, next };
  }

  // Multiplier for entering a cell (-1 = impassable for zombies).
  _stepCost(x, y) {
    const c = this.cell(x, y);
    if (c === C.FLOOR || c === C.GROUND) return 1;
    if (c === C.WINDOW) return 1 + this.windows[this.win[y * this.w + x]].boards * 2;
    if (c === C.DOOR) return this.doors[this.door[y * this.w + x]].open ? 1 : -1;
    return -1;
  }
}
