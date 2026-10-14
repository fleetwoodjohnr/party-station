// Controller input for one seat: Gamepad API (standard mapping) -> game
// actions, with remapping, radial dead zones, a look response curve,
// controller-aware button glyphs and rumble. A keyboard fallback exists
// only for development on a PC; the game never requires it.

// Standard-mapping button indices.
export const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export const ACTIONS = [
  ['fire', 'Fire'], ['ads', 'Aim down sights'], ['jump', 'Jump'], ['crouch', 'Crouch'],
  ['reload', 'Reload / interact'], ['swap', 'Switch weapon'], ['tactical', 'Tactical equipment'],
  ['lethal', 'Lethal equipment'], ['sprint', 'Sprint'], ['melee', 'Melee'],
  ['inv', 'Inventory (D-pad up)'], ['heal', 'Heal (D-pad down)'], ['dleft', 'D-pad left'], ['dright', 'D-pad right'],
  ['pause', 'Pause'], ['map', 'Map / objectives'],
];
export const DEFAULT_BINDS = {
  fire: BTN.RT, ads: BTN.LT, jump: BTN.A, crouch: BTN.B, reload: BTN.X, swap: BTN.Y,
  tactical: BTN.LB, lethal: BTN.RB, sprint: BTN.L3, melee: BTN.R3,
  inv: BTN.UP, heal: BTN.DOWN, dleft: BTN.LEFT, dright: BTN.RIGHT, pause: BTN.START, map: BTN.SELECT,
};

export const DEFAULT_SETTINGS = {
  sens: 5, adsSens: 0.6, invertY: false, deadzone: 0.12, curve: 1.8,
  aimAssist: 'standard', vibration: true, quality: 'auto', showFps: false,
  binds: { ...DEFAULT_BINDS },
};

const FAMILY_LABELS = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', '▲', '▼', '◀', '▶'],
  ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', '▲', '▼', '◀', '▶'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', '▲', '▼', '◀', '▶'],
};
const FACE_COLORS = {
  xbox: ['#3ecf5e', '#ff4f5e', '#3d8bff', '#ffc531'],
  ps: ['#7fa8ff', '#ff6b7a', '#ff8ad8', '#3ee0b0'],
  nintendo: ['#e8e8e8', '#e8e8e8', '#e8e8e8', '#e8e8e8'],
};

export function padFamily(id = '') {
  const s = id.toLowerCase();
  if (/054c|sony|dualsense|dualshock|wireless controller|ps[345]/.test(s)) return 'ps';
  if (/057e|nintendo|pro controller|joy-con/.test(s)) return 'nintendo';
  return 'xbox';
}

// Radial dead zone, rescaled so the stick still reaches full deflection.
function stick(x, y, dz, curve) {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const s = Math.min(1, (m - dz) / (1 - dz));
  const k = curve === 1 ? s : Math.pow(s, curve);
  return [x / m * k, y / m * k];
}

export class PadInput {
  constructor(getPad, settings) {
    this.getPad = getPad;
    this.settings = settings;
    this.prev = new Uint8Array(17);
    this.cur = new Uint8Array(17);
    this.trig = [0, 0];
    this.move = [0, 0]; this.look = [0, 0];
    this.family = 'xbox';
    this.connected = false;
    this.lastSeen = 0;
    this.keys = new Set();
    this._kb = e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.type === 'keydown') this.keys.add(e.code); else this.keys.delete(e.code);
    };
    addEventListener('keydown', this._kb);
    addEventListener('keyup', this._kb);
    this.repeatAt = new Float64Array(17);
  }
  dispose() { removeEventListener('keydown', this._kb); removeEventListener('keyup', this._kb); }

  poll(now = performance.now()) {
    this.prev.set(this.cur);
    this.cur.fill(0);
    const gp = this.getPad();
    const st = this.settings;
    this.connected = !!(gp && gp.connected);
    let mx = 0, my = 0, lx = 0, ly = 0;
    if (this.connected) {
      this.lastSeen = now;
      this.family = padFamily(gp.id);
      for (let i = 0; i < 17 && i < gp.buttons.length; i++) {
        const b = gp.buttons[i];
        this.cur[i] = (i === BTN.LT || i === BTN.RT) ? (b.value > 0.35 || b.pressed ? 1 : 0) : (b.pressed ? 1 : 0);
      }
      this.trig = [gp.buttons[BTN.LT]?.value || 0, gp.buttons[BTN.RT]?.value || 0];
      [mx, my] = stick(gp.axes[0] || 0, gp.axes[1] || 0, st.deadzone, 1);
      [lx, ly] = stick(gp.axes[2] || 0, gp.axes[3] || 0, st.deadzone, st.curve);
    }
    // Dev keyboard: WASD move, arrows look, Space jump, mouse-less fire on J.
    const K = this.keys;
    if (K.size) {
      if (K.has('KeyW')) my = -1; if (K.has('KeyS')) my = 1;
      if (K.has('KeyA')) mx = -1; if (K.has('KeyD')) mx = 1;
      if (K.has('ArrowLeft')) lx = -0.7; if (K.has('ArrowRight')) lx = 0.7;
      if (K.has('ArrowUp')) ly = -0.5; if (K.has('ArrowDown')) ly = 0.5;
      const map = { KeyJ: BTN.RT, KeyK: BTN.LT, Space: BTN.A, KeyC: BTN.B, KeyR: BTN.X, KeyQ: BTN.Y, ShiftLeft: BTN.L3,
        KeyV: BTN.R3, KeyG: BTN.RB, KeyF: BTN.LB, Escape: BTN.START, Tab: BTN.SELECT, Enter: BTN.A, Backspace: BTN.B,
        Digit1: BTN.UP, Digit2: BTN.DOWN, Digit3: BTN.LEFT, Digit4: BTN.RIGHT };
      for (const [code, b] of Object.entries(map)) if (K.has(code)) this.cur[b] = 1;
      this.connected = true;
    }
    this.move = [mx, my];
    this.look = [lx, st.invertY ? -ly : ly];
  }

  // Raw button (menus use fixed A/B/D-pad regardless of game binds).
  held(b) { return !!this.cur[b]; }
  hit(b) { return !!this.cur[b] && !this.prev[b]; }
  // Action by binding.
  down(action) { return !!this.cur[this.settings.binds[action] ?? DEFAULT_BINDS[action]]; }
  pressed(action) { const b = this.settings.binds[action] ?? DEFAULT_BINDS[action]; return !!this.cur[b] && !this.prev[b]; }
  released(action) { const b = this.settings.binds[action] ?? DEFAULT_BINDS[action]; return !this.cur[b] && !!this.prev[b]; }

  // Menu navigation: D-pad or left stick, with key-repeat.
  nav(now = performance.now()) {
    const dirs = { up: BTN.UP, down: BTN.DOWN, left: BTN.LEFT, right: BTN.RIGHT };
    const stickDir = { up: this.move[1] < -0.5, down: this.move[1] > 0.5, left: this.move[0] < -0.5, right: this.move[0] > 0.5 };
    for (const [name, b] of Object.entries(dirs)) {
      const on = this.cur[b] || stickDir[name];
      const slot = b;
      if (!on) { this.repeatAt[slot] = 0; continue; }
      if (!this.repeatAt[slot]) { this.repeatAt[slot] = now + 380; return name; }
      if (now >= this.repeatAt[slot]) { this.repeatAt[slot] = now + 120; return name; }
    }
    return null;
  }

  // The first button pressed this frame (for the remap screen).
  anyHit() {
    for (let i = 0; i < 17; i++) if (this.cur[i] && !this.prev[i]) return i;
    return -1;
  }

  label(btn) { return FAMILY_LABELS[this.family][btn] ?? `B${btn}`; }
  glyph(actionOrBtn) {
    const b = typeof actionOrBtn === 'number' ? actionOrBtn : (this.settings.binds[actionOrBtn] ?? DEFAULT_BINDS[actionOrBtn]);
    const color = b <= 3 ? FACE_COLORS[this.family][b] : '#cfd3e6';
    const round = b <= 3;
    return `<span class="nn-glyph${round ? ' round' : ''}" style="--g:${color}">${this.label(b)}</span>`;
  }

  rumble(strong, weak, ms) {
    if (!this.settings.vibration) return;
    const gp = this.getPad();
    try {
      gp?.vibrationActuator?.playEffect?.('dual-rumble', {
        startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
      })?.catch?.(() => {});
    } catch {}
  }
}
