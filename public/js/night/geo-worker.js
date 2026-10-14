// Open-world chunk builder, off the main thread: the renderer posts the
// world grid (and the baked CC0 props) once, then asks for 32×32-cell
// chunks; geometry comes back as transferable typed arrays (zero-copy),
// so streaming never hitches.
import { World } from './sim/world.js';
import { buildCells, lampsNear, setProps } from './worldgeo.js';

let world = null, def = null;

self.onmessage = ({ data: m }) => {
  if (m.t === 'world') {
    def = m.def;
    world = new World(def);
    setProps(m.props);
    return;
  }
  if (m.t === 'chunk' && world) {
    const { x0, z0, x1, z1, key } = m;
    const g = buildCells(world, def, x0, z0, x1, z1, lampsNear(def.lamps, x0, z0, x1, z1));
    if (!g) { self.postMessage({ t: 'chunk', key, empty: true }); return; }
    self.postMessage({ t: 'chunk', key, pos: g.pos, col: g.col, tuv: g.tuv }, [g.pos.buffer, g.col.buffer, g.tuv.buffer]);
  }
};
