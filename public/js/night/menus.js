// Menu screens shared by the title and pause menus: settings and button
// remapping. A screen is { el(), handle(input) -> bool, back() }; a stack
// of them lives on the owning state, top screen gets the input.
import { h, Menu, hints } from './ui.js';
import { ACTIONS, DEFAULT_BINDS, DEFAULT_SETTINGS } from './input.js';

const cycle = (list, cur, dir) => list[(list.indexOf(cur) + dir + list.length) % list.length];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const onOff = v => (v ? 'On' : 'Off');

export class Stack {
  constructor(layer, input, sfx) { this.layer = layer; this.input = input; this.sfx = sfx; this.screens = []; }
  get open() { return this.screens.length > 0; }
  push(s) { this.screens.push(s); this.draw(); }
  pop() { this.screens.pop(); this.draw(); }
  clear() { this.screens = []; this.draw(); }
  handle() {
    const top = this.screens.at(-1);
    if (top && top.handle(this.input, this.sfx)) this.draw();
  }
  draw() {
    if (this.closed) return; // owner left (an item switched state); layer belongs to someone else now
    const top = this.screens.at(-1);
    this.layer.replaceChildren(...(top ? [h('div', { class: 'nn-dim' }), ...[top.el()].flat().filter(Boolean)] : []));
  }
}

function screen(title, items, stack, onBack, extra = null) {
  const menu = new Menu(items, { onBack: () => onBack ? onBack() : stack.pop() });
  return {
    menu,
    handle: (input, sfx) => menu.handle(input, sfx),
    el: () => [
      h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.2em;font-weight:900;letter-spacing:.08em;text-transform:uppercase' }, title),
      menu.el(),
      extra?.(),
      hints(stack.input, [[0, 'Select'], [14, 'Adjust'], [1, 'Back']]),
    ],
  };
}

export function settingsScreen(app, stack) {
  const s = app.settings;
  const save = () => app.applySettings(s);
  const it = (label, val, adjust, sub) => ({ label, val, sub, adjust: d => { adjust(d); save(); } });
  const items = [
    it('Look sensitivity', () => s.sens, d => { s.sens = clamp(s.sens + d, 1, 10); }),
    it('Aiming sensitivity', () => `${Math.round(s.adsSens * 100)}%`, d => { s.adsSens = clamp(Math.round((s.adsSens + d * 0.1) * 10) / 10, 0.3, 1); }),
    it('Invert look', () => onOff(s.invertY), () => { s.invertY = !s.invertY; }),
    it('Stick dead zone', () => `${Math.round(s.deadzone * 100)}%`, d => { s.deadzone = clamp(Math.round((s.deadzone + d * 0.01) * 100) / 100, 0.04, 0.3); }),
    it('Look response', () => ({ 1: 'Linear', 1.8: 'Classic', 2.4: 'Precise' })[s.curve] || 'Classic', d => { s.curve = cycle([1, 1.8, 2.4], s.curve, d); }),
    it('Aim assist', () => ({ off: 'Off', low: 'Low', standard: 'Standard' })[s.aimAssist], d => { s.aimAssist = cycle(['off', 'low', 'standard'], s.aimAssist, d); }),
    it('Vibration', () => onOff(s.vibration), () => { s.vibration = !s.vibration; if (s.vibration) app.input.rumble(0.6, 0.6, 180); }),
    it('Volume', () => s.volume, d => { s.volume = clamp(s.volume + d, 0, 10); }),
    it('Graphics', () => ({ auto: 'Auto', performance: 'Performance', balanced: 'Balanced', quality: 'Quality' })[s.quality],
      d => { s.quality = cycle(['auto', 'performance', 'balanced', 'quality'], s.quality, d); },
      'Auto trades resolution and crowd size to stay smooth on this screen'),
    it('Show frame rate', () => onOff(s.showFps), () => { s.showFps = !s.showFps; }),
    { label: 'Reset to defaults', act: () => { Object.assign(s, structuredClone({ ...DEFAULT_SETTINGS, binds: s.binds })); save(); } },
    { label: 'Back', act: () => back() },
  ];
  const back = () => { app.saveSettings(); stack.pop(); };
  return screen('Settings', items, stack, back);
}

export function controlsScreen(app, stack) {
  const s = app.settings;
  let waiting = null, until = 0;
  const items = ACTIONS.map(([key, label]) => ({
    label,
    val: () => h('span', { html: app.input.glyph(key) }),
    act: () => { waiting = key; until = performance.now() + 5000; },
  }));
  items.push({ label: 'Reset to defaults', act: () => { s.binds = { ...DEFAULT_BINDS }; app.input.settings = s; app.saveSettings(); } });
  items.push({ label: 'Back', act: () => { app.saveSettings(); stack.pop(); } });
  const sc = screen('Controls', items, stack, () => { app.saveSettings(); stack.pop(); },
    () => waiting && h('div', { class: 'nn-center' }, h('div', { class: 'nn-panel', style: 'font-size:1.3em' },
      `Press the button for “${ACTIONS.find(a => a[0] === waiting)[1]}”…`,
      h('div', { style: 'font-size:.7em;opacity:.7;margin-top:.6em' }, 'Wait 5 seconds to cancel'))));
  const handle = sc.handle;
  sc.handle = (input, sfx) => {
    if (!waiting) return handle(input, sfx);
    const b = input.anyHit();
    if (b >= 0) {
      // Swap with whatever already had that button, so nothing goes unbound.
      const old = s.binds[waiting] ?? DEFAULT_BINDS[waiting];
      for (const k of Object.keys(s.binds)) if (s.binds[k] === b) s.binds[k] = old;
      s.binds[waiting] = b;
      waiting = null;
      sfx?.('select');
      return true;
    }
    if (performance.now() > until) { waiting = null; return true; }
    return false;
  };
  return sc;
}
