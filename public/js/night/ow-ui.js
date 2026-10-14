// Survival-mode screens and HUD: the world map (Select), the inventory
// (D-pad up), save slots, and the survival HUD (clock, needs, mission
// tracker with distance and direction, loot pop-ups). All controller-
// driven, built on the same Menu/screen pieces as everything else.
import { h, Menu, hints } from './ui.js';
import { ITEMS, AMMO_TYPES, CARRY, weightOf, lootLabel } from './sim/loot.js';
import { RS, GRID } from './sim/regions.js';
import { loadProfile } from './main.js';

const CSS = `
.nn-sv{position:absolute;inset:0;pointer-events:none}
.nn-clock{position:absolute;right:3vw;top:3vh;text-align:right;font-weight:900;text-shadow:0 2px 0 #000}
.nn-clock .t{font-size:1.5em}.nn-clock .r{font-size:.8em;color:#cfc6b2;font-weight:700}
.nn-needs{position:absolute;left:3.4vw;bottom:calc(3vh + clamp(60px,7vw,130px) + 9.5vh);display:flex;gap:.6em;font-size:.75em;font-weight:800}
.nn-needs div{width:7vw}.nn-needs i{display:block;height:.45em;border-radius:.3em;background:rgba(0,0,0,.5);overflow:hidden;margin-top:.2em}
.nn-needs b{display:block;height:100%}
.nn-mission{position:absolute;left:3vw;top:3vh;max-width:34vw;text-shadow:0 2px 0 #000}
.nn-mission .h{font-weight:900;font-size:1.05em;color:#ffe08a}.nn-mission .b{font-size:.8em;font-weight:600;color:#e8dcc0}
.nn-mission .d{font-size:.85em;margin-top:.2em;font-weight:800}
.nn-loot{position:absolute;left:50%;top:60vh;transform:translateX(-50%);text-align:center;font-weight:800;text-shadow:0 2px 0 #000;font-size:.9em}
.nn-loot div{animation:nnloot 2.6s ease-out forwards}
@keyframes nnloot{0%{opacity:0;transform:translateY(8px)}10%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
.nn-hold{position:absolute;left:50%;bottom:21vh;width:12vw;height:.4em;margin-left:-6vw;background:rgba(0,0,0,.5);border-radius:.3em;overflow:hidden}
.nn-hold b{display:block;height:100%;background:#ffe08a}
.nn-mapwrap{position:absolute;inset:6vh 6vw;display:flex;gap:2vw}
.nn-mapwrap canvas{height:100%;aspect-ratio:1;border-radius:.4em;border:2px solid rgba(255,255,255,.15)}
.nn-legend{font-size:.85em;line-height:1.7}
.nn-inv{position:absolute;right:6vw;top:22vh;min-width:30vw;font-size:.95em}
`;

export function injectSurvivalStyles() {
  if (document.getElementById('nn-sv-style')) return;
  const s = document.createElement('style'); s.id = 'nn-sv-style'; s.textContent = CSS; document.head.appendChild(s);
}

export class SurvivalHud {
  constructor(layer) {
    injectSurvivalStyles();
    this.clockEl = h('div', { class: 'nn-clock' });
    this.needs = h('div', { class: 'nn-needs' });
    this.mission = h('div', { class: 'nn-mission' });
    this.loot = h('div', { class: 'nn-loot' });
    this.hold = h('div', { class: 'nn-hold', style: 'display:none' }, this.holdFill = h('b'));
    this.root = h('div', { class: 'nn-sv' }, this.clockEl, this.needs, this.mission, this.loot, this.hold);
    layer.appendChild(this.root);
    this.last = {};
  }
  _set(k, v, fn) { if (this.last[k] !== v) { this.last[k] = v; fn(v); } }

  showLoot(lines, full) {
    const el = h('div', {}, ...(lines.length ? lines : ['Nothing useful']).map(l => h('div', {}, l)),
      full ? h('div', { style: 'color:#ff8a7a' }, 'Pack full — some left behind') : null);
    this.loot.replaceChildren(el);
  }

  update(P, mode) {
    const st = mode.status();
    this._set('clock', `${st.day}|${st.clock}|${st.region}`, () => {
      this.clockEl.replaceChildren(h('div', { class: 't' }, `${st.night ? '🌙' : '☀'} Day ${st.day} · ${st.clock}`), h('div', { class: 'r' }, st.region));
    });
    const bar = (label, v, col) => h('div', {}, label, h('i', {}, h('b', { style: `width:${Math.round(v)}%;background:${v < 20 ? '#ff5050' : col}` })));
    this._set('needs', `${Math.round(P.hunger)}|${Math.round(P.thirst)}`, () => {
      this.needs.replaceChildren(bar('Food', P.hunger, '#e0a040'), bar('Water', P.thirst, '#4fb4ff'));
    });
    // Mission tracker: title, brief, progress, and where to go.
    let dir = '';
    if (st.target) {
      const dx = st.target.x - P.x, dz = st.target.z - P.z, d = Math.hypot(dx, dz);
      const ang = Math.atan2(-dx, -dz) - P.yaw;
      const arrows = ['↑', '↖', '←', '↙', '↓', '↘', '→', '↗'];
      const k = Math.round(((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI / 4)) % 8;
      dir = d < 6 ? `${st.target.name} — here` : `${arrows[k]} ${st.target.name} — ${Math.round(d)} m`;
    }
    const mk = st.mission ? `${st.mission.title}|${st.mission.progress}|${dir}` : '';
    this._set('mission', mk, () => {
      this.mission.replaceChildren(...(st.mission ? [
        h('div', { class: 'h' }, st.mission.title),
        h('div', { class: 'b' }, st.mission.brief + (st.mission.progress ? ` (${st.mission.progress})` : '')),
        dir ? h('div', { class: 'd' }, dir) : null,
      ] : []));
    });
    const s = P.searching || 0;
    this._set('hold', Math.round(s * 20), v => {
      this.hold.style.display = v > 0 ? '' : 'none';
      this.holdFill.style.width = `${v * 5}%`;
    });
  }
  remove() { this.root.remove(); }
}

// ---------------------------------------------------------------- map
const REGION_COL = { forest: '#24331e', neighborhood: '#3a4a3a', town: '#4a3f3a', military: '#3d4530', warehouse: '#3c3f46', industrial: '#4a3a2e', outpost: '#3a3a28', home: '#46402a' };

export function mapScreen(app, stack, game) {
  const W = game.world, M = game.mode, P = game.players[0];
  const cv = h('canvas', { width: 768, height: 768 });
  const g = cv.getContext('2d');
  const k = 768 / W.w;
  for (const R of W.regions) { g.fillStyle = REGION_COL[R.type]; g.fillRect(R.rx * RS * k, R.rz * RS * k, RS * k, RS * k); }
  // Roads and buildings from the grid (every other cell is plenty).
  for (let z = 0; z < W.h; z += 2) for (let x = 0; x < W.w; x += 2) {
    const c = W.cell(x, z);
    if (W.surf[z * W.w + x] === 2 && c === 1) { g.fillStyle = '#6a6a70'; g.fillRect(x * k, z * k, 2 * k, 2 * k); }
    else if (c === 2) { g.fillStyle = '#a8a090'; g.fillRect(x * k, z * k, 2 * k, 2 * k); }
  }
  // Fog of war over what you haven't seen.
  g.fillStyle = 'rgba(5,6,12,.88)';
  for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) if (!M.explored[z * 48 + x]) g.fillRect(x * 8 * k, z * 8 * k, 8 * k + 0.5, 8 * k + 0.5);
  g.strokeStyle = 'rgba(255,255,255,.08)';
  for (let i = 0; i <= GRID; i++) { g.beginPath(); g.moveTo(i * RS * k, 0); g.lineTo(i * RS * k, 768); g.moveTo(0, i * RS * k); g.lineTo(768, i * RS * k); g.stroke(); }
  for (const z of W.zones) {
    const seen = M.explored[Math.floor(z.z / 8) * 48 + Math.floor(z.x / 8)];
    if (!seen) continue;
    g.strokeStyle = M.zonesCleared.has(z.id) ? '#5fd46b' : '#ff4040'; g.lineWidth = 3;
    g.beginPath(); g.arc(z.x * k, z.z * k, z.r * k, 0, Math.PI * 2); g.stroke();
  }
  const dot = (x, z, col, r = 6) => { g.fillStyle = col; g.beginPath(); g.arc(x * k, z * k, r, 0, Math.PI * 2); g.fill(); };
  dot(W.home.x, W.home.z, '#ffe08a', 7);
  for (const p of M.packs) dot(p.x, p.z, '#b46bff', 6);
  const st = M.status();
  if (st.target) { g.fillStyle = '#ffd040'; g.font = 'bold 22px system-ui'; g.fillText('★', st.target.x * k - 8, st.target.z * k + 8); }
  // You: an arrow.
  g.save(); g.translate(P.x * k, P.z * k); g.rotate(-P.yaw);
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill(); g.restore();
  const menu = new Menu([{ label: 'Close', act: () => stack.pop() }], { onBack: () => stack.pop() });
  return {
    handle: (input, sfx) => { if (input.pressed('map')) { stack.pop(); return true; } return menu.handle(input, sfx); },
    el: () => [h('div', { class: 'nn-mapwrap' }, cv, h('div', { class: 'nn-legend' },
      h('div', { style: 'font-size:1.6em;font-weight:900;margin-bottom:.4em' }, 'Hollis County'),
      h('div', {}, `Day ${st.day} · ${st.clock}`),
      st.mission ? h('div', { style: 'color:#ffe08a;margin-top:.6em' }, `★ ${st.mission.title}`) : null,
      st.mission ? h('div', { style: 'opacity:.8;max-width:22vw' }, st.mission.brief) : null,
      h('div', { style: 'margin-top:1em' }, '● Farm (home)'), h('div', { style: 'color:#ff6060' }, '◯ Infected zone'),
      h('div', { style: 'color:#5fd46b' }, '◯ Cleared zone'), h('div', { style: 'color:#b46bff' }, '● Your dropped pack'),
      h('div', { style: 'margin-top:1em;opacity:.7' }, 'Press Select or B to close')))],
  };
}

// ------------------------------------------------------------ inventory
export function inventoryScreen(app, stack, game, P, onChange) {
  const M = game.mode;
  const reopen = () => { stack.pop(); stack.push(inventoryScreen(app, stack, game, P, onChange)); };
  const items = [];
  for (const id of ['food', 'water', 'meds']) {
    items.push({ label: `${ITEMS[id].name}`, val: () => `×${P.inv[id] || 0}`, disabled: !(P.inv[id] > 0),
      sub: { food: 'Eat (+35 food)', water: 'Drink (+40 water)', meds: 'Heal 60' }[id],
      act: () => { if (M.useItem(P, id)) { onChange?.('used'); reopen(); } } });
  }
  P.found.forEach((f, k) => items.push({ label: lootLabel(f), sub: f.gun ? `Equip (replaces your ${P.weapons.length < 2 ? 'empty slot' : 'gun in hand'})` : 'Fit to the gun in hand',
    act: () => { if (M.equipFound(P, k)) { onChange?.('equip'); reopen(); } } }));
  items.push({ label: 'Close', act: () => stack.pop() });
  const res = Object.keys(ITEMS).filter(id => !['food', 'water', 'meds'].includes(id) && P.inv[id] > 0);
  const panel = () => h('div', { class: 'nn-panel nn-inv' },
    h('div', { style: 'font-weight:900;font-size:1.15em;margin-bottom:.4em' }, `Pack ${weightOf(P.inv).toFixed(1)} / ${CARRY} kg`),
    ...res.map(id => h('div', { style: 'display:flex;justify-content:space-between' }, h('span', {}, ITEMS[id].name), h('b', {}, `×${P.inv[id]}`))),
    h('div', { style: 'margin-top:.6em;font-weight:900' }, 'Ammo'),
    ...Object.entries(AMMO_TYPES).map(([k, n]) => h('div', { style: 'display:flex;justify-content:space-between;opacity:.9' }, h('span', {}, n), h('b', {}, P.ammo[k] || 0))));
  const menu = new Menu(items, { onBack: () => stack.pop() });
  return {
    handle: (input, sfx) => { if (input.pressed('inv')) { stack.pop(); return true; } return menu.handle(input, sfx); },
    el: () => [
      h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.2em;font-weight:900;letter-spacing:.08em' }, 'INVENTORY'),
      menu.el(), panel(), hints(app.input, [[0, 'Use'], [1, 'Close']]),
    ],
  };
}

// ---------------------------------------------------------------- slots
// Three save slots per survival mode; picking one continues it (or starts
// fresh), Y deletes.
export async function slotsScreen(app, stack, mode, onPick) {
  const metas = (await Promise.all([1, 2, 3].map(n => loadProfile(`${mode}-${n}`)))).map(s => (s && !s.deleted ? s : null));
  const label = { world: 'Open World', shelter: 'Shelter' }[mode];
  const items = metas.map((s, k) => ({
    label: s ? `Slot ${k + 1} — Day ${s.day}` : `Slot ${k + 1} — empty`,
    sub: s ? `${s.mission < 12 ? 'Story mission ' + (s.mission + 1) + ' of 12' : 'Story complete'} · saved ${new Date(s.savedAt).toLocaleString()}` : 'Start a new survivor',
    act: () => onPick(k + 1, s),
  }));
  items.push({ label: 'Back', act: () => stack.pop() });
  const menu = new Menu(items, { onBack: () => stack.pop() });
  return {
    handle: (input, sfx) => {
      if (input.hit(3) && menu.idx < 3 && metas[menu.idx]) {
        // Y: wipe the slot (save an empty marker so the server keeps a .bak).
        fetch(`/api/profiles/deadofnight/${mode}-${menu.idx + 1}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"deleted":true}' });
        metas[menu.idx] = null;
        items[menu.idx].label = `Slot ${menu.idx + 1} — empty`; items[menu.idx].sub = 'Start a new survivor';
        const k = menu.idx; items[k].act = () => onPick(k + 1, null);
        sfx?.('back');
        return true;
      }
      return menu.handle(input, sfx);
    },
    el: () => [
      h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.2em;font-weight:900;letter-spacing:.08em;text-transform:uppercase' }, label),
      menu.el(), hints(app.input, [[0, 'Play'], [3, 'Delete'], [1, 'Back']]),
    ],
  };
}

// ------------------------------------------------------------ build HUD
export function buildPanel(el, input, info) {
  if (!info) { el.style.display = 'none'; return; }
  el.style.display = '';
  const g = b => input.glyph(b);
  el.innerHTML = `<div style="font-weight:900;font-size:1.1em">${info.title}</div>`
    + `<div style="opacity:.9">${info.line}</div>`
    + (info.why ? `<div style="color:#ff8a7a">${info.why}</div>` : '')
    + `<div style="opacity:.8;font-size:.85em;margin-top:.3em">${info.power}</div>`
    + `<div style="margin-top:.4em;font-size:.85em">${g('fire')}build ${g('tactical')}${g('lethal')}piece ${g('swap')}turn ${g('reload')}repair/upgrade ${g('melee')}demolish ${g(1)}done</div>`;
}

// ------------------------------------------------------------ workbench
export function benchScreen(app, stack, game, P, careerXp, onChange, RECIPES, ATT, rankOf) {
  const Sh = game.mode.shelter;
  const fmt = need => Object.entries(need).map(([k, n]) => `${n} ${ITEMS[k]?.name.toLowerCase() || k}`).join(', ');
  const items = RECIPES.map(r => {
    const why = Sh.canCraft(r, P);
    const need = r.give.upgrade ? Sh.upgradeNeed(P.weapon) : r.need;
    return { label: r.name, sub: (need ? fmt(need) : '') + (why ? ` — ${why}` : ''), disabled: !!why,
      act: () => { if (Sh.craft(r.id, P)) { onChange?.(); stack.pop(); stack.push(benchScreen(app, stack, game, P, careerXp, onChange, RECIPES, ATT, rankOf)); } } };
  });
  items.push({ label: 'Craft an attachment', sub: '3 weapon parts, 2 components — any you’ve unlocked by rank', act: () => {
    const list = Object.entries(ATT).filter(([, a]) => a.rank <= rankOf(careerXp)).map(([id, a]) => ({
      label: a.name, sub: a.slot, disabled: !Sh.have({ parts: 3, components: 2 }),
      act: () => { if (Sh.craftAttachment(id, P, careerXp)) { onChange?.(); stack.pop(); } },
    }));
    list.push({ label: 'Back', act: () => stack.pop() });
    const m = new Menu(list, { onBack: () => stack.pop() });
    stack.push({ handle: (i, s) => m.handle(i, s), el: () => [h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.2em;font-weight:900' }, 'ATTACHMENTS'), m.el(), hints(app.input, [[0, 'Craft'], [1, 'Back']])] });
  } });
  items.push({ label: 'Close', act: () => stack.pop() });
  const menu = new Menu(items, { onBack: () => stack.pop() });
  const stash = () => h('div', { class: 'nn-panel nn-inv' },
    h('div', { style: 'font-weight:900;font-size:1.1em;margin-bottom:.4em' }, `Workshop ${'I'.repeat(Sh.tech)}`),
    ...Object.keys(ITEMS).filter(k => (Sh.stash[k] || 0) + (P.inv[k] || 0) > 0).map(k => h('div', { style: 'display:flex;justify-content:space-between' },
      h('span', {}, ITEMS[k].name), h('b', {}, `${(Sh.stash[k] || 0) + (P.inv[k] || 0)}`))),
    h('div', { style: 'margin-top:.5em;opacity:.8' }, `Turret ammo in storage: ${Sh.stashAmmo.light || 0}`));
  return {
    handle: (i, s) => menu.handle(i, s),
    el: () => [h('div', { style: 'position:absolute;left:7vw;top:9vh;font-size:2.2em;font-weight:900;letter-spacing:.08em' }, 'WORKBENCH'), menu.el(), stash(), hints(app.input, [[0, 'Craft'], [1, 'Close']])],
  };
}
