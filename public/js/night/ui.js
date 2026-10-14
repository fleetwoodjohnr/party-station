// Dead of Night's DOM layer: HUD and menus drawn over the 3D canvas at the
// screen's native resolution (the 3D view renders smaller and is stretched,
// text stays sharp). Built with Party Station's own h()/mount() helpers.
import { h, mount } from '../ui.js';

export { h, mount };

const CSS = `
.nn-root{position:absolute;inset:0;overflow:hidden;font-family:system-ui,'Segoe UI',sans-serif;color:#f1ecdf;
  user-select:none;cursor:none;font-size:clamp(16px,1.6vw,30px)}
.nn-layer{position:absolute;inset:0;pointer-events:none}
.nn-dim{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(5,6,12,.55),rgba(5,6,12,.9))}
.nn-title{font-weight:900;letter-spacing:.12em;text-transform:uppercase;line-height:.9;
  font-size:clamp(40px,6vw,118px);color:#efe6cf;text-shadow:0 0 30px rgba(180,40,40,.55),0 6px 0 #4a0d12}
.nn-title small{display:block;font-size:.22em;letter-spacing:.5em;color:#c9b98f;text-shadow:none;margin-top:.7em;font-weight:700}
.nn-menu{position:absolute;left:7vw;top:31vh;display:flex;flex-direction:column;gap:.35em;min-width:34vw;max-width:60vw}
.nn-menu.compact{top:22vh;gap:.15em}.nn-menu.compact .nn-item{font-size:1.02em;padding:.24em .8em}
.nn-more{font-size:.8em;opacity:.6;padding-left:1em}
.nn-item{font-size:1.35em;font-weight:800;padding:.42em .8em;border-left:.22em solid transparent;color:#d8d0bd;
  background:linear-gradient(90deg,rgba(0,0,0,.35),transparent)}
.nn-item.focus{border-color:#d33c3c;color:#fff;background:linear-gradient(90deg,rgba(160,30,30,.55),transparent)}
.nn-item.dis{opacity:.42}
.nn-item .sub{display:block;font-size:.55em;font-weight:600;color:#b8ad95;margin-top:.15em}
.nn-item .val{float:right;color:#ffcf6b;margin-left:1.5em}
.nn-hints{position:absolute;bottom:3.2vh;left:7vw;right:7vw;display:flex;gap:2em;font-size:.95em;color:#cfc6b2}
.nn-glyph{display:inline-flex;align-items:center;justify-content:center;min-width:1.55em;height:1.55em;padding:0 .3em;
  border-radius:.35em;border:2px solid var(--g,#ccc);color:var(--g,#ccc);font-weight:900;font-size:.85em;margin-right:.35em;
  background:rgba(0,0,0,.45);vertical-align:middle}
.nn-glyph.round{border-radius:50%;padding:0}
.nn-perf{position:absolute;top:1.2vh;right:1.2vw;font:600 .7em/1.35 ui-monospace,monospace;background:rgba(0,0,0,.55);
  padding:.5em .7em;border-radius:.4em;white-space:pre;color:#bfffcf}
.nn-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:.6em}
.nn-panel{background:rgba(10,11,18,.86);border:2px solid rgba(255,255,255,.08);border-radius:.6em;padding:1.2em 1.6em}
`;

export function injectStyles() {
  if (document.getElementById('nn-style')) return;
  const s = document.createElement('style');
  s.id = 'nn-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// A vertical, controller-driven menu. items: [{label, sub, val, disabled,
// act()}]; `left/right` on an item with `adjust(dir)` changes its value.
export class Menu {
  constructor(items, { onBack } = {}) {
    this.items = items;
    this.idx = Math.max(0, items.findIndex(i => !i.disabled));
    this.onBack = onBack;
  }
  // Returns true if it consumed input that changed what's on screen.
  handle(input, sfx) {
    const dir = input.nav();
    const items = this.items;
    if (dir === 'up' || dir === 'down') {
      const step = dir === 'up' ? -1 : 1;
      for (let k = 1; k <= items.length; k++) {
        const j = (this.idx + step * k + items.length * 4) % items.length;
        if (!items[j].disabled) { this.idx = j; break; }
      }
      sfx?.('blip');
      return true;
    }
    const it = items[this.idx];
    if ((dir === 'left' || dir === 'right') && it?.adjust) {
      it.adjust(dir === 'left' ? -1 : 1);
      sfx?.('blip');
      return true;
    }
    if (input.hit(0) && it && !it.disabled) {
      sfx?.('select');
      if (it.adjust && !it.act) it.adjust(1);
      else it.act?.();
      return true;
    }
    if (input.hit(1) && this.onBack) { sfx?.('back'); this.onBack(); return true; }
    return false;
  }
  // Long lists get the compact style and a window of 9 rows that follows
  // the focus, so nothing ever runs off a 720p screen.
  el() {
    const n = this.items.length, VIS = 9;
    const compact = n > 6;
    let lo = 0, hi = n;
    if (n > VIS) {
      lo = Math.max(0, Math.min(n - VIS, this.idx - (VIS >> 1)));
      hi = lo + VIS;
    }
    return h('div', { class: 'nn-menu' + (compact ? ' compact' : '') },
      lo > 0 ? h('div', { class: 'nn-more' }, '▲') : null,
      this.items.slice(lo, hi).map((it, k) => {
        const i = lo + k;
        return h('div', { class: 'nn-item' + (i === this.idx ? ' focus' : '') + (it.disabled ? ' dis' : '') },
          typeof it.val === 'function' ? h('span', { class: 'val' }, it.val()) : null,
          typeof it.label === 'function' ? it.label() : it.label,
          it.sub ? h('span', { class: 'sub' }, it.sub) : null);
      }),
      hi < n ? h('div', { class: 'nn-more' }, '▼') : null);
  }
}

export function hints(input, pairs) {
  return h('div', { class: 'nn-hints', html: pairs.map(([b, t]) => `<span>${input.glyph(b)}${t}</span>`).join('') });
}
