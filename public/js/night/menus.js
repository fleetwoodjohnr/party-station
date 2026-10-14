// Menu screens shared by the title and pause menus: settings and button
// remapping. A screen is { el(), handle(input) -> bool, back() }; a stack
// of them lives on the owning state, top screen gets the input.
import { h, Menu, hints } from './ui.js';
import { ACTIONS, DEFAULT_BINDS, DEFAULT_SETTINGS } from './input.js';
import { SLOTS, ATTACHMENTS, RARITY, canFit, statsOf, weaponName } from './sim/weapons.js';
import { rankOf, xpForRank } from './sim/classic.js';

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

// ------------------------------------------------------- Forge / gunsmith
const SLOT_NAMES = { optic: 'Optic', mag: 'Magazine', barrel: 'Barrel', stock: 'Stock', grip: 'Grip', muzzle: 'Muzzle', ammo: 'Ammunition' };

function statsPanel(P) {
  const w = P.weapon, S = statsOf(w, P.perks);
  const row = (k, v) => h('div', { style: 'display:flex;justify-content:space-between;gap:2em' }, h('span', { style: 'opacity:.75' }, k), h('b', {}, v));
  return h('div', { class: 'nn-panel', style: 'position:absolute;right:6vw;top:22vh;min-width:24vw;font-size:.95em' },
    h('div', { style: `font-size:1.2em;font-weight:900;margin-bottom:.5em;color:${S.rarity.color}` }, weaponName(w)),
    row('Damage', Math.round(S.dmg) + (S.pellets > 1 ? ` ×${S.pellets}` : '')),
    row('Fire rate', `${Math.round(S.rpm)} rpm`),
    row('Magazine', S.mag),
    row('Reload', `${(S.shell ? S.shell : S.reload).toFixed(2)} s${S.shell ? ' / shell' : ''}`),
    row('Aim time', `${S.adsTime.toFixed(2)} s`),
    row('Recoil', S.recoil.v.toFixed(3)),
    row('Range', `${Math.round(S.range[0])}–${Math.round(S.range[1])} m`),
    h('div', { style: 'margin-top:.6em;color:#ffe08a' }, `Your points: ${P.points.toLocaleString()}`));
}

export function forgeScreen(app, stack, game, P, onChange, act = d => (d.a === 'forge' ? game.mode.forgeUpgrade(P) : game.mode.gunsmith(P, d.slot, d.att))) {
  const mode = game.mode, w = P.weapon;
  const next = RARITY[w.tier + 1];
  const reopen = () => { stack.pop(); stack.push(forgeScreen(app, stack, game, P, onChange, act)); };
  const items = [{
    label: next ? `Forge to ${next.name}` : 'Fully forged',
    sub: next ? `+${Math.round((next.dmg / RARITY[w.tier].dmg - 1) * 100)}% damage, full ammo — ${mode.constructor.FORGE_COST}` : 'Nothing left to temper',
    disabled: !next || P.points < mode.constructor.FORGE_COST,
    act: () => { if (act({ a: 'forge' })) { onChange(); stack.pop(); } },
  }];
  for (const slot of SLOTS) {
    const opts = Object.keys(ATTACHMENTS).filter(a => ATTACHMENTS[a].slot === slot && canFit(w.id, a));
    if (!opts.length) continue;
    items.push({
      label: SLOT_NAMES[slot], val: () => (w.att[slot] ? ATTACHMENTS[w.att[slot]].name : 'None'),
      act: () => stack.push(slotScreen(slot, opts)),
    });
  }
  items.push({ label: 'Done', act: () => stack.pop() });
  const slotScreen = (slot, opts) => {
    const list = [{ id: null, name: 'None', rank: 1 }, ...opts.map(id => ({ id, ...ATTACHMENTS[id] }))].map(o => ({
      label: o.name,
      val: () => ((w.att[slot] || null) === o.id ? 'Fitted' : o.rank > mode.rank ? `Rank ${o.rank}` : `${mode.constructor.GUNSMITH_COST}`),
      disabled: o.rank > mode.rank || (w.att[slot] || null) === o.id || P.points < mode.constructor.GUNSMITH_COST,
      act: () => { if (act({ a: 'gunsmith', slot, att: o.id })) { onChange(); stack.pop(); reopen(); } },
    }));
    list.push({ label: 'Back', act: () => stack.pop() });
    return screen(SLOT_NAMES[slot], list, stack, null, () => statsPanel(P));
  };
  return screen('The Forge', items, stack, null, () => statsPanel(P));
}

// ----------------------------------------------------------------- career
export function careerScreen(app, stack, career) {
  const xp = career?.xp || 0, rank = rankOf(xp);
  const lo = xpForRank(rank), hi = xpForRank(rank + 1);
  const unlocks = Object.entries(ATTACHMENTS).filter(([, a]) => a.rank > rank).sort((a, b) => a[1].rank - b[1].rank).slice(0, 4);
  return screen('Career', [{ label: 'Back', act: () => stack.pop() }], stack, null, () => h('div', { class: 'nn-panel', style: 'position:absolute;left:7vw;top:22vh;min-width:44vw;font-size:1.05em' },
    h('div', { style: 'font-size:1.6em;font-weight:900' }, `Rank ${rank}`),
    h('div', { style: 'height:.6em;background:rgba(255,255,255,.1);border-radius:.3em;margin:.5em 0;overflow:hidden' },
      h('i', { style: `display:block;height:100%;background:#d33c3c;width:${Math.round((xp - lo) / Math.max(1, hi - lo) * 100)}%` })),
    h('div', { style: 'opacity:.8' }, `${(xp - lo).toLocaleString()} / ${(hi - lo).toLocaleString()} XP to rank ${rank + 1}`),
    h('div', { style: 'margin-top:1em' }, `Best: ${career?.bestRound || 0} rounds · ${(career?.kills || 0).toLocaleString()} kills · ${career?.games || 0} games · ${career?.wins || 0} escapes`),
    unlocks.length ? h('div', { style: 'margin-top:1em;opacity:.85' }, 'Next unlocks: ' + unlocks.map(([, a]) => `${a.name} (rank ${a.rank})`).join(', ')) : null));
}

// Endless or Standard (escape at dawn after round 30).
export function modeScreen(app, stack, start) {
  return screen('Classic Survival', [
    { label: 'Endless', sub: 'No dawn. How long can you last?', act: () => start({ standard: false }) },
    { label: 'Standard', sub: 'Survive 30 rounds and the sun comes up', act: () => start({ standard: true }) },
    { label: 'Back', act: () => stack.pop() },
  ], stack);
}
