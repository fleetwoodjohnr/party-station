// In-game HUD: DOM over the canvas, built once and patched only when a
// value changes (cheap on the Pi's CPU, crisp at 1080p while the 3D view
// renders smaller). Large type, high contrast, controller glyphs.
import { h } from './ui.js';
import { spreadOf, PERKS, weaponName } from './sim/weapons.js';
import { EQUIP } from './sim/equipment.js';

const CSS = `
.nn-hud{position:absolute;inset:0;pointer-events:none;font-weight:800}
.nn-vign{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,transparent 45%,rgba(150,0,0,.85) 100%);transition:opacity .15s}
.nn-x{position:absolute;left:50%;top:50%;width:0;height:0}
.nn-x i{position:absolute;background:rgba(255,255,255,.9);box-shadow:0 0 2px #000}
.nn-x .t,.nn-x .b{width:2px;height:12px;left:-1px}.nn-x .l,.nn-x .r{height:2px;width:12px;top:-1px}
.nn-hit{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px;opacity:0}
.nn-hit:before,.nn-hit:after{content:'';position:absolute;left:50%;top:0;width:3px;height:100%;margin-left:-1.5px;
  background:linear-gradient(#fff 0 35%,transparent 35% 65%,#fff 65%);transform:rotate(45deg)}
.nn-hit:after{transform:rotate(-45deg)}
.nn-hit.kill:before,.nn-hit.kill:after{background:linear-gradient(#ff4040 0 35%,transparent 35% 65%,#ff4040 65%)}
.nn-round{position:absolute;left:3.2vw;bottom:3vh;font-size:clamp(60px,7vw,130px);line-height:.9;color:#a3141c;
  text-shadow:0 0 18px rgba(120,0,0,.6),0 3px 0 #2a0204;font-family:Georgia,'Times New Roman',serif;font-style:italic}
.nn-pts{position:absolute;left:3.4vw;bottom:calc(3vh + clamp(60px,7vw,130px) + 1vh);font-size:1.35em;color:#ffe08a;text-shadow:0 2px 0 #000}
.nn-pop{position:absolute;left:3.4vw;font-size:1em;color:#ffe08a;text-shadow:0 2px 0 #000;animation:nnpop .9s ease-out forwards}
.nn-pop.neg{color:#ff7070}
@keyframes nnpop{from{transform:translate(0,0);opacity:1}to{transform:translate(4vw,-5vh);opacity:0}}
.nn-ammo{position:absolute;right:3.2vw;bottom:3.4vh;text-align:right;text-shadow:0 2px 0 #000}
.nn-ammo .m{font-size:2.4em;line-height:1}.nn-ammo .r{font-size:1.2em;color:#bdb6a6}
.nn-ammo .n{font-size:.85em;color:#d8d0bd;letter-spacing:.06em;text-transform:uppercase}
.nn-ammo .low{color:#ff6060}
.nn-prompt{position:absolute;left:50%;bottom:24vh;transform:translateX(-50%);font-size:1.1em;background:rgba(0,0,0,.55);
  padding:.35em .9em;border-radius:.4em;white-space:nowrap;text-shadow:0 2px 0 #000}
.nn-prompt .c{color:#ffe08a}.nn-prompt .no{color:#ff7070}
.nn-banner{position:absolute;left:0;right:0;top:20vh;text-align:center;font-family:Georgia,serif;font-style:italic;
  font-size:clamp(40px,5vw,96px);color:#c41a22;text-shadow:0 0 24px rgba(160,0,0,.7),0 3px 0 #000;opacity:0;transition:opacity .6s}
.nn-banner small{display:block;font:700 .3em system-ui;font-style:normal;color:#e8dcc0;letter-spacing:.4em;text-transform:uppercase;margin-top:.4em}
.nn-note{position:absolute;left:50%;top:12vh;transform:translateX(-50%);font-size:1em;background:rgba(0,0,0,.6);padding:.35em .9em;border-radius:.4em;opacity:0;transition:opacity .3s}
.nn-obj{position:absolute;right:3vw;top:12vh;min-width:24vw}
.nn-hpbar{position:absolute;left:3.4vw;bottom:calc(3vh + clamp(60px,7vw,130px) + 4.6vh);width:14vw;height:.45em;background:rgba(0,0,0,.5);border-radius:.3em;overflow:hidden;opacity:0;transition:opacity .4s}
.nn-hpbar i{display:block;height:100%;background:#d23a3a}
.nn-perks{position:absolute;left:3.4vw;bottom:calc(3vh + clamp(60px,7vw,130px) + 7.5vh);display:flex;gap:.35em}
.nn-perks b{width:1.6em;height:1.6em;border-radius:.35em;display:flex;align-items:center;justify-content:center;font-size:.8em;color:#111;box-shadow:0 2px 0 rgba(0,0,0,.6)}
.nn-equip{position:absolute;right:3.2vw;bottom:calc(3.4vh + 5.2em);text-align:right;font-size:.85em;color:#d8d0bd;text-shadow:0 2px 0 #000}
.nn-boss{position:absolute;left:30vw;right:30vw;top:4vh;text-align:center;font:900 .9em system-ui;letter-spacing:.3em;color:#e8c0b0;text-shadow:0 2px 0 #000;display:none}
.nn-boss .bar{height:.55em;margin-top:.3em;background:rgba(0,0,0,.6);border:1px solid #6a2a24;border-radius:.3em;overflow:hidden}
.nn-boss .bar i{display:block;height:100%;background:linear-gradient(90deg,#a3141c,#ff4a3a)}
.nn-timers{position:absolute;left:50%;top:9vh;transform:translateX(-50%);display:flex;gap:1.2em;font-weight:900;text-shadow:0 2px 0 #000}
.nn-scope{position:absolute;inset:0;display:none;background:radial-gradient(circle at center,transparent 0 31vh,#000 31.3vh)}
.nn-scope:before,.nn-scope:after{content:'';position:absolute;background:#000}
.nn-scope:before{left:50%;top:19vh;bottom:19vh;width:2px;margin-left:-1px}.nn-scope:after{top:50%;left:calc(50% - 31vh);right:calc(50% - 31vh);height:2px;margin-top:-1px}
`;

export class Hud {
  constructor(layer, input) {
    if (!document.getElementById('nn-hud-style')) {
      const s = document.createElement('style'); s.id = 'nn-hud-style'; s.textContent = CSS; document.head.appendChild(s);
    }
    this.input = input;
    this.vign = h('div', { class: 'nn-vign' });
    this.x = h('div', { class: 'nn-x' }, ...['t', 'b', 'l', 'r'].map(c => h('i', { class: c })));
    this.hit = h('div', { class: 'nn-hit' });
    this.round = h('div', { class: 'nn-round' });
    this.pts = h('div', { class: 'nn-pts' });
    this.hpbar = h('div', { class: 'nn-hpbar' }, this.hpfill = h('i'));
    this.ammo = h('div', { class: 'nn-ammo' });
    this.prompt = h('div', { class: 'nn-prompt', style: 'display:none' });
    this.banner = h('div', { class: 'nn-banner' });
    this.note = h('div', { class: 'nn-note' });
    this.obj = h('div', { class: 'nn-obj nn-panel', style: 'display:none' });
    this.perks = h('div', { class: 'nn-perks' });
    this.equip = h('div', { class: 'nn-equip' });
    this.boss = h('div', { class: 'nn-boss' }, 'THE WARDEN', h('div', { class: 'bar' }, this.bossFill = h('i')));
    this.timers = h('div', { class: 'nn-timers' });
    this.scope = h('div', { class: 'nn-scope' });
    this.root = h('div', { class: 'nn-hud' }, this.scope, this.vign, this.x, this.hit, this.round, this.hpbar, this.pts,
      this.perks, this.ammo, this.equip, this.prompt, this.banner, this.note, this.obj, this.boss, this.timers);
    layer.appendChild(this.root);
    this.last = {};
    this.hitT = 0;
  }

  _set(key, val, fn) { if (this.last[key] !== val) { this.last[key] = val; fn(val); } }

  flashHit(kill) {
    this.hit.className = 'nn-hit' + (kill ? ' kill' : '');
    this.hitT = kill ? 0.3 : 0.18;
  }

  popPoints(n) {
    const el = h('div', { class: 'nn-pop' + (n < 0 ? ' neg' : ''), style: `bottom:calc(3vh + clamp(60px,7vw,130px) + 5.5vh)` }, (n > 0 ? '+' : '') + n);
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  showBanner(main, sub = '', secs = 3) {
    this.banner.replaceChildren(main, sub ? h('small', {}, sub) : '');
    this.banner.style.opacity = 1;
    clearTimeout(this._bt);
    this._bt = setTimeout(() => { this.banner.style.opacity = 0; }, secs * 1000);
  }

  showNote(text, secs = 2.5) {
    this.note.textContent = text;
    this.note.style.opacity = 1;
    clearTimeout(this._nt);
    this._nt = setTimeout(() => { this.note.style.opacity = 0; }, secs * 1000);
  }

  // Objectives overlay while Select is held.
  objectives(show, mode) {
    this.obj.style.display = show ? '' : 'none';
    if (!show) return;
    const s = mode.status();
    const key = JSON.stringify(s.doors) + s.round + s.left + s.phase;
    this._set('obj', key, () => {
      this.obj.replaceChildren(
        h('div', { style: 'font-size:1.2em;margin-bottom:.4em' }, '☠ Survive the night'),
        h('div', {}, s.phase === 'wave' ? `Round ${s.round} — ${s.left} zombies left` : `Round ${s.round + 1} starts in ${Math.ceil(s.timer)}s`),
        ...s.doors.map(d => h('div', { style: 'opacity:.85;font-weight:600' }, `${d.open ? '✔' : '🔒'} ${d.name}${d.open ? '' : ` — ${d.cost}`}`)),
        h('div', { style: 'opacity:.75;font-weight:600;margin-top:.5em;font-size:.85em' }, 'Hold X at a broken window to rebuild it. Chalk outlines on the walls are guns for sale.'));
    });
  }

  update(dt, P, game, viewH, fovY, scoped = false) {
    const W = P.W;
    this._set('scope', scoped ? 1 : 0, v => { this.scope.style.display = v ? 'block' : 'none'; });
    this._set('perks', [...P.perks].join(','), () => {
      this.perks.replaceChildren(...[...P.perks].map(id => h('b', { style: `background:${PERKS[id].color}`, title: PERKS[id].name },
        PERKS[id].name.split(' ').map(w => w[0]).join(''))));
    });
    const eq = `${P.lethal?.id}:${P.lethal?.n}|${P.tactical?.id}:${P.tactical?.n}|${this.input.family}`;
    this._set('equip', eq, () => {
      const row = (slot, btn) => slot ? `<div>${this.input.glyph(btn)}${EQUIP[slot.id].name} ×${slot.n}</div>` : '';
      this.equip.innerHTML = row(P.lethal, 'lethal') + row(P.tactical, 'tactical');
    });
    const m = game.mode;
    const bi = m.boss ?? -1;
    const bossFrac = bi >= 0 && game.zombies.isLive(bi) ? game.zombies.hp[bi] / game.zombies.maxHp[bi] : -1;
    this._set('boss', Math.round(bossFrac * 100), v => {
      this.boss.style.display = v >= 0 ? 'block' : 'none';
      if (v >= 0) this.bossFill.style.width = `${v}%`;
    });
    const tk = Object.entries(m.timed || {}).map(([k, t]) => `${k}:${Math.ceil(t)}`).join('|');
    this._set('timers', tk, () => {
      const names = { instakill: ['INSTA-KILL', '#ff6060'], doublepts: ['DOUBLE POINTS', '#ffd040'] };
      this.timers.replaceChildren(...Object.entries(m.timed || {}).map(([k, t]) =>
        h('span', { style: `color:${names[k]?.[1] || '#fff'}` }, `${names[k]?.[0] || k} ${Math.ceil(t)}`)));
    });
    // Crosshair gap follows the real spread cone.
    const moving = Math.min(1, Math.hypot(P.vx, P.vz) / 4);
    const spread = spreadOf(W, P.ads, moving, P.bloom);
    const gap = Math.round(6 + Math.tan(spread) / Math.tan(fovY / 2) * (window.innerHeight / 2));
    this._set('gap', gap, g => {
      const [t, b, l, r] = this.x.children;
      t.style.top = `${-g - 12}px`; b.style.top = `${g}px`; l.style.left = `${-g - 12}px`; r.style.left = `${g}px`;
    });
    const xo = P.ads > 0.6 || P.sprinting || P.act === 'reload' || P.down ? 0 : 1;
    this._set('xo', xo, v => { this.x.style.opacity = v; });
    this.hitT -= dt;
    this._set('hito', this.hitT > 0 ? 1 : 0, v => { this.hit.style.opacity = v; });

    const hurt = 1 - P.hp / P.maxHp;
    this._set('vign', Math.round(hurt * 20), v => { this.vign.style.opacity = Math.min(1, v / 20 * 1.15); });
    this._set('hpb', Math.round(P.hp), v => {
      this.hpfill.style.width = `${v / P.maxHp * 100}%`;
      this.hpbar.style.opacity = v < P.maxHp ? 1 : 0;
    });
    this._set('round', game.mode.round, r => { this.round.textContent = r > 0 ? String(r) : ''; });
    this._set('pts', P.points, p => { this.pts.textContent = p.toLocaleString(); });
    const wpn = P.weapon;
    this._set('ammo', `${wpn.id}|${wpn.tier}|${wpn.mag}|${wpn.reserve}|${P.infiniteAmmo}|${W.mag}`, () => {
      const low = wpn.mag <= Math.ceil(W.mag * 0.25);
      this.ammo.replaceChildren(
        h('div', { class: 'n', style: wpn.tier ? `color:${W.rarity.color}` : '' }, weaponName(wpn)),
        h('span', { class: 'm' + (low ? ' low' : '') }, String(wpn.mag)),
        h('span', { class: 'r' }, ` / ${P.infiniteAmmo ? '∞' : wpn.reserve}`));
    });
    // What X would do here.
    const pr = P.prompt;
    const key = pr ? `${pr.kind}|${pr.label}|${pr.afford}|${pr.cost}|${this.input.family}` : '';
    this._set('prompt', key, () => {
      if (!pr) { this.prompt.style.display = 'none'; return; }
      this.prompt.style.display = '';
      const verb = pr.kind === 'repair' ? 'Hold' : 'Press';
      const cost = pr.cost && !pr.full ? ` <span class="${pr.afford ? 'c' : 'no'}">${pr.cost}</span>` : '';
      this.prompt.innerHTML = `${verb} ${this.input.glyph('reload')} ${pr.label}${cost}`;
    });
    if (P.weapon.mag === 0 && P.weapon.reserve === 0 && !P.infiniteAmmo) this._set('noammo', 1, () => this.showNote('Out of ammo — buy more at a chalk outline', 3));
    else this.last.noammo = 0;
  }
}
