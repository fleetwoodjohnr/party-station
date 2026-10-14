// Dead of Night — entry point, called by public/js/games/deadofnight.js when
// the TV mounts the game. Owns the frame loop, the quality governor, perf
// beacons (POST /api/perf), settings persistence, and the app states:
// title menu, bench, and play.
import { View } from './render.js';
import { World } from './sim/world.js';
import { DINER } from './sim/maps.js';
import { Zombies } from './sim/zombies.js';
import { PadInput, DEFAULT_SETTINGS } from './input.js';
import { injectStyles, h, mount, Menu, hints } from './ui.js';
import { audio } from './audio.js';
import { Stack, settingsScreen, controlsScreen, careerScreen, modeScreen } from './menus.js';
import { slotsScreen } from './ow-ui.js';
import { PlayState } from './play.js';

const GAME = 'deadofnight';
// Internal render sizes (16:9), smallest first; CSS stretches to the screen.
export const RES = [[640, 360], [768, 432], [896, 504], [960, 540], [1120, 630], [1280, 720]];
export const PRESETS = {
  performance: { res: 0, cap: 12 },
  balanced: { res: 3, cap: 20 },
  quality: { res: 5, cap: 28 },
};

// --------------------------------------------------------------- profile
export async function loadProfile(key) {
  try {
    const r = await fetch(`/api/profiles/${GAME}/${key}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
export function saveProfile(key, data) {
  return fetch(`/api/profiles/${GAME}/${key}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true,
  }).then(r => r.ok).catch(() => false);
}

// ------------------------------------------------------------ frame stats
// Frame deltas between rendered frames; percentiles for the beacon/bench.
class FrameStats {
  constructor() { this.win = []; this.run = []; this.started = performance.now(); }
  push(ms) { this.win.push(ms); this.run.push(ms); }
  static pct(arr) {
    if (!arr.length) return {};
    const s = Float32Array.from(arr).sort();
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const total = arr.reduce((a, b) => a + b, 0);
    return { fps: arr.length / (total / 1000), p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: s[s.length - 1], frames: arr.length };
  }
  takeWindow() { const r = FrameStats.pct(this.win); this.win = []; return r; }
}

// ------------------------------------------------------------- governor
// Keeps the game responsive on whatever GPU it lands on. Frame pacing:
// render every vsync (60) or every other one (30). When frames run late it
// sheds internal resolution first, then the live-zombie cap (the mode
// spawns slower — never fewer zombies per round). When a render finishes
// well inside one vsync (measured by when the next rAF arrives) it climbs
// back. Fixed presets keep resolution still and only touch the cap.
class Governor {
  constructor(quality) { this.set(quality); }
  set(quality) {
    this.quality = quality;
    const p = PRESETS[quality] || PRESETS.balanced;
    this.res = p.res;
    this.maxRes = quality === 'auto' ? RES.length - 1 : p.res;
    this.maxCap = (PRESETS[quality] || PRESETS.quality).cap;
    if (quality === 'auto') { this.res = PRESETS.balanced.res; this.maxCap = PRESETS.quality.cap; }
    this.cap = quality === 'auto' ? PRESETS.balanced.cap : p.cap;
    this.fps = 30;
    this.deltas = []; this.costs = []; this.good = 0; this.since = 0;
  }
  frame(delta) { this.deltas.push(delta); }
  cost(ms) { this.costs.push(ms); }
  // Called once per rendered frame; evaluates every ~2 s.
  tick(now) {
    if (!this.since) this.since = now;
    if (now - this.since < 2000 || this.deltas.length < 20) return false;
    this.since = now;
    const p90 = a => { const s = Float32Array.from(a).sort(); return s[Math.floor(s.length * 0.9)] || 0; };
    const late = p90(this.deltas), cost = this.costs.length ? p90(this.costs) : 99;
    this.deltas = []; this.costs = [];
    const before = `${this.fps}/${this.res}/${this.cap}`;
    if (this.fps === 60 && late > 21) { this.fps = 30; this.good = 0; }
    else if (this.fps === 30 && late > 38) {
      this.good = 0;
      if (this.quality === 'auto' && this.res > 0) this.res--;
      else if (this.cap > 8) this.cap -= 2;
    } else if (this.fps === 30 && cost < 19) {
      // A render fits inside one vsync: there is headroom.
      if (++this.good >= 3) {
        this.good = 0;
        if (this.cap < this.maxCap) this.cap = Math.min(this.maxCap, this.cap + 2);
        else if (this.res < this.maxRes) this.res++;
        else if (cost < 15) this.fps = 60;
      }
    } else this.good = 0;
    return before !== `${this.fps}/${this.res}/${this.cap}`;
  }
}

// ------------------------------------------------------------------ app
class App {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.opts = ctx.options || {};
    this.runId = Math.random().toString(36).slice(2, 10);
    this.settings = structuredClone(DEFAULT_SETTINGS);
    // The pad of this screen's own player (in co-op that isn't seat 0 on
    // a guest's screen).
    this.input = new PadInput(() => ctx.gamepad?.(ctx.localSeats?.()[0] ?? 0), this.settings);
    this.stats = new FrameStats();
    this.gov = new Governor(this.opts.bench ? (this.opts.preset || 'balanced') : this.settings.quality);
    this.stopped = false;
    this.lastRender = 0;
    this.justRendered = false;
    this.lastBeacon = performance.now();
    this.tick = this.tick.bind(this);

    this.world = new World(DINER);
    this.pool = new Zombies(48);
    this.canvasLayer = h('div', { class: 'nn-layer' });
    this.uiLayer = h('div', { class: 'nn-layer' });
    this.perfEl = h('div', { class: 'nn-perf', style: 'display:none' });
    root.append(this.canvasLayer, this.uiLayer, this.perfEl);
    try {
      this.view = new View(this.canvasLayer);
      this.view.setWorld(this.world, DINER, this.pool);
    } catch (e) {
      console.error('Dead of Night: WebGL unavailable', e);
      mount(this.uiLayer, h('div', { class: 'nn-center' }, h('div', { class: 'nn-panel' },
        h('div', { style: 'font-size:1.6em;font-weight:900' }, 'This screen can’t run 3D graphics'),
        h('p', {}, 'WebGL failed to start. Returning to Party Station…'))));
      setTimeout(() => ctx.quit?.(), 4000);
      return;
    }
    this.applyResolution();
    if (ctx.sim === false) {
      // Co-op guest: wait for the host's first snapshot to know the game.
      this.setState(new WaitState(this));
      loadProfile('settings').then(s => { if (s) this.applySettings(s); });
    } else if (this.opts.bench && this.opts.scene === 'classic') {
      this.perfEl.style.display = '';
      this.setState(new PlayState(this, { autopilot: true, startRound: 10, benchSecs: Number(this.opts.secs) || 60 }));
    } else if (this.opts.bench) this.setState(new BenchState(this));
    else {
      this.setState(new TitleState(this));
      loadProfile('settings').then(s => { if (s) this.applySettings(s); });
    }
    requestAnimationFrame(this.tick);
  }

  applySettings(s) {
    Object.assign(this.settings, { ...s, binds: { ...DEFAULT_SETTINGS.binds, ...(s.binds || {}) } });
    if (!this.opts.bench) this.gov.set(this.settings.quality);
    this.applyResolution();
    this.perfEl.style.display = this.settings.showFps || this.opts.bench ? '' : 'none';
    audio.volume(this.settings.volume / 10 * 0.9);
  }
  saveSettings() { saveProfile('settings', this.settings); }

  applyResolution() {
    const [w, h2] = RES[this.gov.res];
    this.view?.setResolution(w, h2);
  }

  setState(st) {
    this.state?.exit?.();
    this.state = st;
    st.enter?.();
  }

  sfx(name) { audio.ui(name); }

  // End of a bench run (flythrough or autopilot): whole-run summary beacon
  // (first 2 s skipped — shader compiles, first uploads), then hand back.
  finishBench(live) {
    let skip = 0, acc = 0;
    while (skip < this.stats.run.length && acc < 2000) acc += this.stats.run[skip++];
    const all = FrameStats.pct(this.stats.run.slice(skip));
    this.beacon(true, live, 'bench-total', all).finally(() => {
      if (this.opts.bench) this.ctx.end?.({ title: 'Benchmark finished', lines: [`${all.fps?.toFixed(1)} fps average`] });
      else this.setState(new TitleState(this));
    });
    mount(this.uiLayer, h('div', { class: 'nn-center' }, h('div', { class: 'nn-panel' },
      h('div', { style: 'font-size:1.6em;font-weight:900' }, 'Benchmark finished'),
      h('p', {}, `${all.fps?.toFixed(1)} fps · p95 ${all.p95?.toFixed(1)} ms · worst ${all.worst?.toFixed(0)} ms`))));
  }

  tick(now) {
    if (this.stopped) return;
    requestAnimationFrame(this.tick);
    // The first rAF after a render tells us how long that render really took.
    if (this.justRendered) { this.gov.cost(now - this.lastRender); this.justRendered = false; }
    if (!this.lastRender) this.lastRender = now - 33;
    const since = now - this.lastRender;
    if (this.gov.fps === 30 && since < 1000 / 30 - 5) return;
    const dt = Math.min(0.1, since / 1000);
    this.lastRender = now;
    this.justRendered = true;
    this.stats.push(since);
    this.gov.frame(since);
    if (this.gov.tick(now)) this.applyResolution();

    this.input.poll(now);
    this.state.update(dt, now);
    const live = this.view.render(now / 1000);
    this.state.after?.(dt, now);

    if (now - this.lastBeacon > 10000) { this.lastBeacon = now; this.beacon(false, live); }
    if (this.perfEl.style.display !== 'none' && (this._pf = (this._pf || 0) + 1) % 15 === 0) {
      const w = FrameStats.pct(this.stats.win.slice(-120));
      const info = this.view.renderer.info.render;
      this.perfEl.textContent = `${w.fps?.toFixed(1)} fps  p95 ${w.p95?.toFixed(1)}ms\n`
        + `${RES[this.gov.res].join('×')} @${this.gov.fps}  cap ${this.gov.cap}\n`
        + `draws ${info.calls}  tris ${(info.triangles / 1000).toFixed(1)}k  z ${live}\n`
        + `${this.view.gpu.slice(0, 40)}`;
    }
  }

  beacon(final, live = 0, scene = this.state?.scene || 'menu', statsOverride = null) {
    const w = statsOverride || this.stats.takeWindow();
    const info = this.view.renderer.info.render;
    const body = {
      run: this.runId, scene, preset: this.gov.quality, gpu: this.view.gpu, final,
      ...w, draws: info.calls, tris: info.triangles, zombies: live, cap: this.gov.cap,
      scale: RES[this.gov.res][1],
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : undefined,
    };
    return fetch('/api/perf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
    }).catch(() => {});
  }

  quit() {
    this.ctx.quit?.();
  }

  onNet(m) {
    if (this.state?.onNet) this.state.onNet(m);
  }
  startClient(meta) {
    this.setState(new PlayState(this, { client: true, mode: meta.kind, seed: meta.seed, standard: meta.standard, meta }));
  }

  stop() {
    this.stopped = true;
    this.state?.exit?.();
    this.input.dispose();
    this.view?.dispose();
    this.root.remove();
  }
}

// ------------------------------------------------------------ title menu
// The diner at night behind the menu: a slow orbit outside while a few
// zombies shamble after a wandering decoy.
class TitleState {
  constructor(app) { this.app = app; this.scene = 'title'; this.t = 0; }
  enter() {
    const a = this.app;
    this.decoy = { x: 23, z: 28, y: 0, down: false };
    for (let k = 0; k < 6; k++) {
      const [x, z] = a.world.spawns[k % a.world.spawns.length];
      a.pool.spawn(0, x + 0.5, z + 0.5, 100, 0.9 + k * 0.05, k / 6);
    }
    this.stack = new Stack(a.uiLayer, a.input, n => a.sfx(n));
    const ret = this.stack.pop.bind(this.stack);
    this.stack.pop = () => { ret(); if (!this.stack.open) this.draw(); };
    loadProfile('career').then(c => { this.career = c || { xp: 0 }; });
    const play = opts => a.setState(new PlayState(a, { ...opts, career: this.career || { xp: 0 } }));
    this.menu = new Menu([
      { label: 'Classic Survival', sub: 'Hold the Route 9 Diner — doors, perks, the Forge, a Warden every tenth round', act: () => this.stack.push(modeScreen(a, this.stack, play)) },
      { label: 'Open World', sub: 'Scavenge Hollis County, day and night — missions, loot, hordes',
        act: async () => this.stack.push(await slotsScreen(a, this.stack, 'world', (slot, save) => play({ mode: 'world', slot, save }))) },
      { label: 'Shelter', sub: 'Fortify Hollis Farm, scavenge by day, hold it through nightly raids',
        act: async () => this.stack.push(await slotsScreen(a, this.stack, 'shelter', (slot, save) => play({ mode: 'shelter', slot, save }))) },
      { label: 'Career', sub: 'Rank, unlocks and records', act: () => this.stack.push(careerScreen(a, this.stack, this.career)) },
      { label: 'Settings', act: () => this.stack.push(settingsScreen(a, this.stack)) },
      { label: 'Controls', act: () => this.stack.push(controlsScreen(a, this.stack)) },
      { label: 'Run benchmark', sub: 'One-minute flythrough with 40 zombies — measures this TV', act: () => a.setState(new BenchState(a)) },
      { label: 'Quit to Party Station', act: () => a.quit() },
    ], { onBack: () => a.quit() });
    this.draw();
  }
  draw() {
    const a = this.app;
    if (this.stack.open) return;
    mount(a.uiLayer,
      h('div', { class: 'nn-dim', style: 'background:linear-gradient(90deg,rgba(5,6,12,.88),rgba(5,6,12,.2) 60%,transparent)' }),
      h('div', { style: 'position:absolute;left:7vw;top:8vh' },
        h('div', { class: 'nn-title' }, 'Dead of Night', h('small', {}, 'Route 9 Diner'))),
      this.menu.el(),
      hints(a.input, [[0, 'Select'], [1, 'Quit']]));
  }
  update(dt, now) {
    const a = this.app;
    this.t += dt;
    if (this.stack.open) this.stack.handle();
    else if (this.menu.handle(a.input, n => a.sfx(n)) && a.state === this) this.draw();
    if (a.state !== this) return;
    // Decoy wanders the parking lot so the zombies have somewhere to go.
    this.decoy.x = 23 + Math.sin(this.t * 0.11) * 12;
    this.decoy.z = 27 + Math.cos(this.t * 0.17) * 2;
    if (!this.flow || this.t - this.flowAt > 0.5) {
      this.flowAt = this.t;
      this.flow = a.world.flow([[Math.floor(this.decoy.x), Math.floor(this.decoy.z)]]);
    }
    a.pool.step(dt, a.world, this.flow, [this.decoy], [], Math.random);
    const ang = this.t * 0.05 + 2.2;
    const cx = 24 + Math.cos(ang) * 20, cz = 17 + Math.sin(ang) * 16;
    a.view.setEye(cx, 4.2, cz, Math.atan2(cx - 24, cz - 17), -0.12);
  }
  exit() { this.stack.closed = true; this.app.pool.clear(); }
}

// --------------------------------------------------------- co-op guest
// A screen that isn't hosting waits here until the host starts a match.
class WaitState {
  constructor(app) { this.app = app; this.scene = 'wait'; this.t = 0; }
  enter() {
    const host = (this.app.ctx.seats || []).find(s => !s.bot)?.name || 'the host';
    mount(this.app.uiLayer, h('div', { class: 'nn-dim' }), h('div', { class: 'nn-center' },
      h('div', { class: 'nn-title', style: 'font-size:clamp(36px,5vw,90px)' }, 'Dead of Night'),
      h('div', { style: 'font-size:1.3em;margin-top:.6em' }, `Co-op with ${host}`),
      h('div', { style: 'opacity:.75;margin-top:.3em' }, 'Waiting for the host to choose a mode…')));
  }
  onNet(m) { if (m.t === 'relayState' && m.d?.meta) this.app.startClient(m.d.meta); }
  update(dt) {
    this.t += dt;
    this.app.view.setEye(24 + Math.cos(this.t * 0.05) * 20, 4.2, 17 + Math.sin(this.t * 0.05) * 16, this.t * 0.05 + Math.PI / 2, -0.12);
  }
}

// ---------------------------------------------------------------- bench
// Scripted, input-free performance run (also reachable from the menu).
// Half the time inside the diner, half circling outside; N zombies chase
// the camera. Reports through the same beacon as play, plus a final
// whole-run summary, then hands control back to Party Station.
class BenchState {
  constructor(app) {
    this.app = app;
    this.scene = 'bench-diner';
    this.secs = Number(app.opts.secs) || 60;
    this.n = Math.min(app.pool.n, Number(app.opts.zombies) || 40);
    this.t = 0;
  }
  enter() {
    const a = this.app;
    a.perfEl.style.display = '';
    a.world.windows.forEach((_, i) => a.world.setBoards(i, 0));
    // Scatter zombies over open cells, deterministic.
    let seed = 7;
    const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9 | 0) >>> 0) / 4294967295;
    let placed = 0;
    for (let tries = 0; placed < this.n && tries < 5000; tries++) {
      const x = 2 + Math.floor(rnd() * (a.world.w - 4)), z = 2 + Math.floor(rnd() * (a.world.h - 4));
      if (!a.world.open(x, z, true)) continue;
      a.pool.spawn(rnd() < 0.3 ? 1 : 0, x + 0.5, z + 0.5, 100, 1.0 + rnd() * 0.6, rnd());
      placed++;
    }
    this.cam = { x: 21, z: 16.5, y: 0, down: false };
    a.stats.run = [];
    mount(a.uiLayer, h('div', { style: 'position:absolute;left:2vw;bottom:3vh;font-weight:800;opacity:.85' },
      `Benchmark — ${this.n} zombies, ${this.secs}s`));
  }
  update(dt) {
    const a = this.app;
    this.t += dt;
    const half = this.t < this.secs / 2;
    this.scene = half ? 'bench-diner' : 'bench-outside';
    const ang = this.t * (half ? 0.35 : 0.16);
    let x, z, y;
    if (half) { x = 21 + Math.cos(ang) * 6.5; z = 16.5 + Math.sin(ang) * 3; y = 1.6; }
    else { x = 24.5 + Math.cos(ang) * 16; z = 16 + Math.sin(ang) * 11; y = 1.7; }
    const tx = -Math.sin(ang), tz = Math.cos(ang);
    const yaw = Math.atan2(-tx, -tz) + Math.sin(this.t * 0.7) * 0.6;
    a.view.setEye(x, y, z, yaw, Math.sin(this.t * 0.5) * 0.08 - 0.03);
    this.cam.x = x; this.cam.z = z;
    if (!this._flowAt || this.t - this._flowAt > 0.25) {
      this._flowAt = this.t;
      this.flow = a.world.flow([[Math.floor(x), Math.floor(z)]]);
    }
    a.pool.step(dt, a.world, this.flow, [this.cam], [], Math.random);
    if (this.t >= this.secs && !this.done) this.finish();
  }
  finish() {
    this.done = true;
    this.app.finishBench(this.app.pool.alive);
  }
  exit() {
    const a = this.app;
    a.pool.state.fill(0); a.pool.alive = 0;
    a.world.windows.forEach((_, i) => a.world.setBoards(i, 6));
    a.perfEl.style.display = a.settings.showFps ? '' : 'none';
  }
}

export function start(holder, ctx) {
  injectStyles();
  const root = h('div', { class: 'nn-root' });
  holder.appendChild(root);
  const app = new App(root, ctx);
  if (/[?&]dev\b/.test(location.search)) window.__night = app; // test harness handle
  return {
    stop: () => app.stop(),
    rehome: h2 => { if (root.parentNode !== h2) h2.appendChild(root); },
    net: m => app.onNet(m),
  };
}
