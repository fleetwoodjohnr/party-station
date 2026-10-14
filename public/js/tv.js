// Party Station console shell (the TV is the console screen).
// All games render here in 3D; phones and Bluetooth controllers drive it.
import { connect } from './net.js';
import { h, mount, toast, newOsk, oskNav, oskEl } from './ui.js';
import { createPads } from './pads.js';
import { sfx } from './sfx.js';
import * as S from './settings-core.js';

const root = document.getElementById('tv');
document.body.classList.add('tv');

let sync = null;
const modules = {};
let scene = null;          // { gameId, key, api } for mounted 3D scenes
let relaySim = null;
let hubCursor = 0;
// Landing choice: null (asking) | 'party' | 'retro' | 'settings'.
// /tv?mode=retro skips the chooser — handy for debugging a hub without a
// controller in hand.
let tvMode = ['party', 'retro', 'settings'].includes(new URLSearchParams(location.search).get('mode'))
  ? new URLSearchParams(location.search).get('mode') : null;
let chooseIdx = 0;         // focused tile on the landing chooser
const menus = new Map();   // pad index -> {seat, stage, idx, spec}
const peeked = new Set();  // seat indexes currently revealing their hand (Y)
const peekTimers = new Map();

// A finished self-update restarts the server with new client code, but the
// kiosk's Chromium never reloads by itself — so when the version changes
// under us (and we're idle), reload to actually run the new UI.
let loadedVersion = null;
function reloadOnNewVersion(s) {
  if (!s.version) return;
  if (loadedVersion === null) loadedVersion = s.version;
  else if (s.version !== loadedVersion && s.phase === 'hub' && !s.emulator) location.reload();
}

const net = connect({
  role: 'tv',
  onSync: s => { sync = s; reloadOnNewVersion(s); render(); },
  onMsg: m => {
    if (m.t === 'toast') { toast(m.text); sfx.toast(); }
    if (m.t === 'nope') { toast(m.text, true); sfx.nope(); }
    if (m.t === 'input' && relaySim?.input) relaySim.input(m.seat, m.d);
  },
});

const pads = createPads({
  onPress: (pad, btn, isRepeat) => handlePad(pad, btn, isRepeat),
  onConnect: (pad, id) => toast(`🎮 Controller detected — press any button to join`),
  onDisconnect: pad => { net.send({ t: 'padBye', pad }); menus.delete(pad); render(); },
});

const padMsg = (pad, m) => net.send({ t: 'padMsg', pad, m });
const padAct = (pad, a) => padMsg(pad, { t: 'act', a });

// Troubleshooting from a keyboard plugged into the Pi (the kiosk has no
// window chrome): Ctrl+Alt+Q exits the kiosk to the desktop — the server
// flags scripts/kiosk.sh, which closes Chromium and stops relaunching.
// Ctrl+Alt+R reloads the TV page. Re-enter with `party-station-kiosk`.
window.addEventListener('keydown', e => {
  if (!e.ctrlKey || !e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'q') {
    e.preventDefault();
    toast('👋 Exiting the kiosk — run party-station-kiosk in a terminal to come back');
    fetch('/api/kiosk/exit', { method: 'POST' }).catch(() => {});
  } else if (k === 'r') {
    e.preventDefault();
    location.reload();
  } else if (k === 's') {
    // Settings without a controller in hand.
    e.preventDefault();
    if (sync?.phase === 'hub' && !sync.emulator) {
      tvMode = 'settings';
      openSettings();
      render();
    } else {
      toast('Finish the game first, then press Ctrl+Alt+S from the hub.');
    }
  }
});

// A keyboard on the TV should drive the settings screen too — the same
// handlers the d-pad uses, so the two can never disagree.
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (sync?.phase !== 'hub' || tvMode !== 'settings') return;
  const map = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'a', Escape: 'b', Backspace: 'x', Tab: 'y', ' ': 'lb',
  };
  const btn = map[e.key];
  if (!btn) return;
  e.preventDefault();
  padSettings(btn);
});

async function loadModule(id) {
  if (!modules[id]) {
    try { modules[id] = await import(`./games/${id}.js`); }
    catch (e) { console.error('module load failed', id, e); modules[id] = { error: true }; }
    render();
  }
  return modules[id];
}

// ------------------------------------------------------------- pad routing

function myPadInfo(pad) { return sync?.pads?.[pad]; }

function handlePad(pad, btn, isRepeat) {
  if (!sync) return;
  if (sync.emulator) return; // RetroArch owns the controllers right now
  if (!myPadInfo(pad)) {
    if (!isRepeat) net.send({ t: 'padHello', pad, name: `P${pad + 1} 🎮` });
    return;
  }
  const info = myPadInfo(pad);
  switch (sync.phase) {
    case 'hub': return padHub(pad, btn);
    case 'lobby': return padLobby(pad, btn, info);
    case 'game': return padGame(pad, btn, info, isRepeat);
    case 'gameover': if (btn === 'a' && !isRepeat) padMsg(pad, { t: 'backToHub' }); return;
  }
}

// Hub entries grouped into visual rows (retro: the packed cover grid's rows;
// party: one row of card games) so the cursor moves the way the screen looks.
function hubGroups() {
  if (tvMode === 'retro') return retroLayout().rows;
  if (tvMode === 'party') {
    // One shelf per category, in registry order (cards first).
    const cats = [...new Set(sync.games.map(g => g.category))];
    return cats.map(c => sync.games.filter(g => g.category === c).map(g => ({ kind: 'game', g })));
  }
  return [];
}

function retroEnts() {
  return (sync.emu?.systems || []).flatMap(s =>
    s.games.map(gm => ({ kind: 'emu', system: s.id, sysName: s.name, icon: s.icon, file: gm.file, title: gm.title })));
}

// The whole library on one screen: start with big covers and shrink until
// every row fits the viewport (small libraries get large art, big ones get
// denser). Below 120px art we give up and let the grid scroll. Both the
// renderer and the pad cursor use these rows, so navigation matches pixels.
function retroLayout() {
  const ents = retroEnts();
  const availW = window.innerWidth - 96;   // tv-stage padding + slack
  const availH = window.innerHeight - 250; // top bar, eyebrow, hints, padding
  for (let artH = 250; ; artH -= 10) {
    const tileW = Math.max(150, Math.min(230, Math.round(artH * 0.85)));
    const cols = Math.max(1, Math.floor((availW + 16) / (tileW + 24 + 16)));
    const rowH = artH + 92; // tile padding + name block + row gap
    if (Math.ceil(ents.length / cols) * rowH <= availH || artH <= 120) {
      const rows = [];
      for (let i = 0; i < ents.length; i += cols) rows.push(ents.slice(i, i + cols));
      return { rows, artH, tileW };
    }
  }
}

function hubList() { return hubGroups().flat(); }

function padHub(pad, btn) {
  // Landing chooser: party games, the retro cabinet, or the settings screen.
  if (tvMode === null) {
    const modes = chooseModes();
    if (btn === 'left' || btn === 'up') { chooseIdx = (chooseIdx + modes.length - 1) % modes.length; sfx.blip(); }
    if (btn === 'right' || btn === 'down') { chooseIdx = (chooseIdx + 1) % modes.length; sfx.blip(); }
    if (btn === 'a' || btn === 'start' || btn === 'x') {
      tvMode = modes[chooseIdx];
      hubCursor = 0;
      if (tvMode === 'settings') openSettings();
      sfx.select();
    }
    render();
    return;
  }
  if (tvMode === 'settings') return padSettings(btn);
  if (btn === 'b') { tvMode = null; sfx.back(); render(); return; }
  const groups = hubGroups();
  const list = groups.flat();
  if (!list.length) { render(); return; }
  // The list can shrink underneath the cursor (ROMs re-sorted mid-session).
  hubCursor = Math.min(Math.max(0, hubCursor), list.length - 1);
  // Row/column navigation matching the rendered groups — a one-game row
  // (a system with a single ROM) is still a stop on the way down.
  let row = 0, start = 0;
  while (row < groups.length - 1 && hubCursor >= start + groups[row].length) {
    start += groups[row].length;
    row++;
  }
  let col = hubCursor - start;
  if (btn === 'left') col = Math.max(0, col - 1);
  if (btn === 'right') col = Math.min(groups[row].length - 1, col + 1);
  if (btn === 'up' && row > 0) {
    row--;
    start -= groups[row].length;
    col = Math.min(col, groups[row].length - 1);
  } else if (btn === 'down' && row < groups.length - 1) {
    start += groups[row].length;
    row++;
    col = Math.min(col, groups[row].length - 1);
  }
  hubCursor = start + col;
  if (['left', 'right', 'up', 'down'].includes(btn)) sfx.blip();
  const ent = list[hubCursor];
  if ((btn === 'a' || btn === 'start') && ent) {
    sfx.select();
    if (ent.kind === 'game') padMsg(pad, { t: 'openLobby', gameId: ent.g.id });
    else padMsg(pad, { t: 'emuLaunch', system: ent.system, file: ent.file });
  }
  if (btn === 'x' && ent?.kind === 'game' && sync.saves[ent.g.id]) {
    sfx.select();
    padMsg(pad, { t: 'resumeGame', gameId: ent.g.id });
  }
  render();
}

// ---------------------------------------------------------- settings screen
// The TV's own settings, driven entirely by a d-pad. Requests go out from the
// kiosk over loopback, which the server trusts without a code — standing in
// front of the television is the credential (see server/settings.js).
//
// Views: menu -> wifi (network list) -> pass (on-screen keyboard), plus
// display. `cfg.busy` blocks input while a request is in flight.
const cfg = {
  view: 'menu', idx: 0, info: null, nets: null,
  busy: '', note: '', osk: null, target: null, loading: false,
};

const chooseModes = () => ['party', 'retro', 'settings'];

function openSettings() {
  Object.assign(cfg, { view: 'menu', idx: 0, nets: null, note: '', osk: null, target: null });
  loadSettings();
}

async function loadSettings() {
  cfg.loading = true;
  try { cfg.info = await S.state(); }
  catch (e) { cfg.note = e.message; }
  cfg.loading = false;
  render();
}

// Rows of the top-level menu, built fresh each render so they reflect state.
function settingsMenu() {
  const n = cfg.info?.network;
  const d = cfg.info?.display;
  const rows = [
    { label: `📶 Wi-Fi — ${n?.ssid || 'not connected'}`, go: 'wifi' },
    { label: `🖥️ Display — ${d?.mode === 'native' ? 'native' : '1080p'}`, go: 'display' },
  ];
  if (d?.pending) rows.push({ label: '↻ Restart to apply the display change', act: 'reboot' });
  rows.push({ label: '← Back', act: 'back' });
  return rows;
}

function displayRows() {
  const mode = cfg.info?.display?.mode || '1080p';
  return [
    { label: `${mode === '1080p' ? '◉' : '○'} 1080p — recommended on a Pi 4`, act: 'mode', v: '1080p' },
    { label: `${mode === 'native' ? '◉' : '○'} Native — whatever the TV asks for`, act: 'mode', v: 'native' },
    { label: '← Back', act: 'back' },
  ];
}

function wifiRows() {
  if (cfg.nets === null) return [{ label: cfg.busy ? 'Scanning…' : '🔍 Scan for networks', act: 'scan' }, { label: '← Back', act: 'back' }];
  const rows = cfg.nets.map(x => ({
    label: `${S.bars(x.signal)}  ${x.ssid}${x.current ? '  · connected' : ''}${x.secured ? '  🔒' : ''}`,
    act: 'join', net: x,
  }));
  rows.push({ label: '🔍 Scan again', act: 'scan' });
  rows.push({ label: '← Back', act: 'back' });
  return rows;
}

function settingsRows() {
  if (cfg.view === 'wifi') return wifiRows();
  if (cfg.view === 'display') return displayRows();
  return settingsMenu();
}

async function settingsDo(fn, okMsg) {
  cfg.busy = '1';
  cfg.note = '';
  render();
  try {
    await fn();
    if (okMsg) cfg.note = okMsg;
  } catch (e) {
    cfg.note = e.message;
    sfx.nope();
  }
  cfg.busy = '';
  render();
}

function padSettings(btn) {
  // The keyboard owns every button while it's up.
  if (cfg.view === 'pass') {
    const r = oskNav(cfg.osk, btn);
    if (r === 'cancel') { cfg.view = 'wifi'; cfg.osk = null; sfx.back(); }
    else if (r === 'submit') {
      const net = cfg.target;
      const pass = cfg.osk.text;
      cfg.view = 'wifi'; cfg.osk = null;
      sfx.select();
      joinNetwork(net, pass);
    } else sfx.blip();
    render();
    return;
  }
  if (cfg.busy) return;

  const rows = settingsRows();
  if (btn === 'up') { cfg.idx = (cfg.idx + rows.length - 1) % rows.length; sfx.blip(); }
  if (btn === 'down') { cfg.idx = (cfg.idx + 1) % rows.length; sfx.blip(); }
  if (btn === 'b') {
    sfx.back();
    if (cfg.view === 'menu') { tvMode = null; chooseIdx = 2; }
    else { cfg.view = 'menu'; cfg.idx = 0; cfg.note = ''; }
    render();
    return;
  }
  if (btn === 'a' || btn === 'start') {
    const row = rows[Math.min(cfg.idx, rows.length - 1)];
    if (!row) return;
    sfx.select();
    if (row.go) { cfg.view = row.go; cfg.idx = 0; cfg.note = ''; if (row.go === 'wifi' && !cfg.nets) scanNetworks(); }
    else if (row.act === 'back') {
      if (cfg.view === 'menu') { tvMode = null; chooseIdx = 2; }
      else { cfg.view = 'menu'; cfg.idx = 0; }
    } else if (row.act === 'scan') scanNetworks();
    else if (row.act === 'join') startJoin(row.net);
    else if (row.act === 'mode') {
      settingsDo(async () => {
        const r = await S.setDisplay(row.v);
        await loadSettings();
        cfg.note = r.reboot ? 'Saved — restart the station to apply.' : 'Display updated.';
      });
      return;
    } else if (row.act === 'reboot') {
      settingsDo(() => S.reboot(), 'Restarting…');
      return;
    }
  }
  render();
}

function scanNetworks() {
  settingsDo(async () => {
    const r = await S.scan();
    cfg.nets = (r.networks || []).sort((a, b) => b.signal - a.signal);
    cfg.idx = 0;
  });
}

function startJoin(net) {
  if (net.current) { cfg.note = `Already on ${net.ssid}.`; render(); return; }
  cfg.target = net;
  if (!net.secured) { joinNetwork(net, ''); return; }
  cfg.osk = newOsk('');
  cfg.view = 'pass';
  render();
}

function joinNetwork(net, password) {
  settingsDo(async () => {
    // Switching drops every phone and changes the address guests need, so the
    // screen has to announce the new one — it's the only thing still visible.
    await S.connect(net.ssid, password);
    cfg.nets = null;
    await loadSettings();
    cfg.view = 'menu';
    cfg.idx = 0;
    const ip = cfg.info?.network?.ips?.[0] || cfg.info?.ips?.[0];
    cfg.note = `Joined ${net.ssid}. Phones now join at ${ip || 'the address above'}.`;
  });
}

function settingsScreen() {
  disposeScene();
  if (cfg.view === 'pass') {
    return h('div', { class: 'tv-stage' },
      h('div', { class: 'tv-top' }, h('div', { class: 'tv-title' }, '🔑 ', cfg.target?.ssid || 'Wi-Fi'), urlBox()),
      h('div', { class: 'tv-main' }, oskEl(cfg.osk, { title: `Password for ${cfg.target?.ssid || ''}`, masked: false })),
    );
  }
  const rows = settingsRows();
  const idx = Math.min(cfg.idx, rows.length - 1);
  const title = cfg.view === 'wifi' ? '📶 Wi-Fi' : cfg.view === 'display' ? '🖥️ Display' : '⚙️ Settings';
  const unsupported = cfg.info && !cfg.info.supported;
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, h('div', { class: 'tv-title' }, title), urlBox()),
    h('div', { class: 'hub-fill' },
      h('div', { class: 'hub-center', style: 'max-width:900px;width:100%' },
        cfg.loading && !cfg.info
          ? h('div', { class: 'dim center', style: 'font-size:22px' }, 'Loading…')
          : unsupported
            ? h('div', { class: 'banner center', style: 'font-size:20px' },
              cfg.info.isPi
                ? '⚠️ The system helper isn’t installed — re-run the Party Station setup script.'
                : 'ℹ️ Wi-Fi and display settings only work on the Raspberry Pi that runs the station.')
            : h('div', { class: 'set-list' }, rows.map((r, i) =>
              h('div', { class: 'set-row' + (i === idx ? ' focus' : '') }, r.label))),
        cfg.busy ? h('div', { class: 'dim center', style: 'margin-top:16px;font-size:20px' }, 'Working…') : null,
        cfg.note ? h('div', { class: 'banner center', style: 'margin-top:16px;font-size:19px' }, cfg.note) : null,
        cfg.view === 'display'
          ? h('p', { class: 'dim center', style: 'margin-top:14px;font-size:17px;max-width:760px' },
            'A Pi 4 can’t drive a 4K desktop: at 2160p the menus crawl and emulator '
            + 'sound breaks up, because the emulator clocks its audio off a video '
            + 'signal that can’t hold 60fps. Capping the output fixes both.')
          : null)),
    hintBar([['🎮 ▲▼', 'move'], ['🎮 A', 'select'], ['🎮 B', 'back'], ['📱', `phones: http://${joinHost()}/settings`]]),
  );
}

function padLobby(pad, btn, info) {
  if (btn === 'a' && !info.joined) { padMsg(pad, { t: 'joinLobby' }); sfx.select(); }
  if (btn === 'b' && info.joined) { padMsg(pad, { t: 'leaveLobby' }); sfx.back(); }
  if ((btn === 'start' || btn === 'x') && info.isHost) padMsg(pad, { t: 'start' });
  if (btn === 'x' && info.joined && !info.isHost) padMsg(pad, { t: 'start' }); // ignored server-side unless host
}

// Any seated player can pause and exit — a stuck game shouldn't need the
// host's device. Turn-based games auto-save; arcade matches just end.
function pauseMenuSpec(mode) {
  return {
    title: 'Pause', sticky: true, pause: true, items: [
      mode === 'relay'
        ? { label: '⛔ End game for everyone', raw: { t: 'quitGame' } }
        : { label: '💾 Save & exit to hub', raw: { t: 'quitGame' } },
      { label: 'Keep playing', close: true },
    ],
  };
}

function padGame(pad, btn, info, isRepeat) {
  const G = sync.game;
  if (G.mode === 'relay') {
    // Immersive games run their own menus (pause included) off raw pads.
    if (modules[G.gameId]?.tv?.immersive) return;
    // Arcade sims poll pads directly — Start (unused by the sims) pauses;
    // while this pad's menu is open the sim ignores it (see padDown).
    const menu = menus.get(pad);
    if (menu) menuNav(pad, menu, btn, isRepeat);
    else if (btn === 'start' && !isRepeat && info.seat >= 0) {
      openMenu(pad, info.seat, pauseMenuSpec('relay'));
    }
    render();
    return;
  }
  if (btn === 'y' && !isRepeat && info.seat >= 0) { togglePeek(info.seat); return; }
  if (btn === 'start' && !isRepeat && info.seat >= 0) {
    openMenu(pad, info.seat, pauseMenuSpec('server'));
    render();
    return;
  }
  const menu = menus.get(pad);
  if (!menu) {
    if (info.awaited) { buildActionMenu(pad, info); render(); }
    return;
  }
  menuNav(pad, menu, btn, isRepeat);
  focusScene(menus.get(pad));
  render();
}

function menuNav(pad, menu, btn, isRepeat) {
  const items = menu.spec.items.filter(i => !i.hidden);
  if (btn === 'up') { menu.idx = (menu.idx + items.length - 1) % items.length; sfx.blip(); }
  if (btn === 'down') { menu.idx = (menu.idx + 1) % items.length; sfx.blip(); }
  if (btn === 'b' && !isRepeat) { menus.delete(pad); sfx.back(); }
  if (btn === 'a' && !isRepeat) {
    const item = items[menu.idx];
    if (!item || item.disabled) return;
    sfx.select();
    if (item.close) { menus.delete(pad); }
    else if (item.raw) { padMsg(pad, item.raw); menus.delete(pad); }
    else if (item.pick !== undefined) {
      item.onPick(menu.stage);
      rebuildMenu(pad, menu);
    } else if (item.action) {
      padAct(pad, item.action);
      menus.delete(pad);
    }
  }
}

function togglePeek(seat) {
  clearTimeout(peekTimers.get(seat));
  if (peeked.has(seat)) peeked.delete(seat);
  else {
    peeked.add(seat);
    peekTimers.set(seat, setTimeout(() => { peeked.delete(seat); render(); }, 4000));
  }
  render();
}

function openMenu(pad, seat, spec) {
  menus.set(pad, { seat, stage: spec.stage || {}, idx: 0, spec });
}

function buildActionMenu(pad, info) {
  const mod = modules[sync.game.gameId];
  if (!mod?.padChoices) return;
  const stage = {};
  const spec = mod.padChoices({ pub: sync.game.pub, priv: info.priv, seats: sync.game.seats, seat: info.seat }, stage);
  if (spec) menus.set(pad, { seat: info.seat, stage, idx: 0, spec });
}

function rebuildMenu(pad, menu) {
  const mod = modules[sync.game.gameId];
  const info = myPadInfo(pad);
  if (!mod?.padChoices || !info) { menus.delete(pad); return; }
  const spec = mod.padChoices({ pub: sync.game.pub, priv: info.priv, seats: sync.game.seats, seat: info.seat }, menu.stage);
  if (!spec) { menus.delete(pad); return; }
  menu.spec = spec;
  menu.idx = Math.min(menu.idx, spec.items.length - 1);
}

function focusScene(menu) {
  const item = menu?.spec.items[menu.idx];
  scene?.api?.focus?.(menu?.seat, item?.focus ?? null);
}

// Refresh open menus when new state arrives (choices may have changed).
function refreshMenus() {
  if (sync.phase !== 'game') { menus.clear(); return; }
  if (sync.game.mode !== 'server') {
    // Relay: only pause menus exist — keep them while their pad is around.
    for (const pad of [...menus.keys()]) {
      if (!myPadInfo(pad)) menus.delete(pad);
    }
    return;
  }
  for (const [pad, menu] of [...menus.entries()]) {
    const info = myPadInfo(pad);
    if (!info || info.seat !== menu.seat || (!info.awaited && !menu.spec.sticky)) {
      menus.delete(pad);
      continue;
    }
    // Pause menus aren't derived from game state — never rebuild them into
    // an action menu underneath the player.
    if (!menu.spec.pause) rebuildMenu(pad, menu);
  }
  // Auto-open menus for pad players whose turn just arrived.
  for (const pad of Object.keys(sync.pads || {})) {
    const info = sync.pads[pad];
    if (info.awaited && !menus.has(Number(pad))) buildActionMenu(Number(pad), info);
  }
}

// ------------------------------------------------------------------ views

// The kiosk loads http://localhost/tv, so the browser's own URL is useless to
// a guest holding a phone — it literally says "localhost". The server knows
// the real answer and ships it in the sync payload (server/hostinfo.js);
// prefer a raw IP, which resolves everywhere, over the .local name.
// A smart TV browsing to the station over the network is already on a real
// address, so leave that case alone.
function joinHost() {
  const own = location.hostname.toLowerCase();
  const isLoopback = own === 'localhost' || own === '::1' || own.startsWith('127.');
  if (!isLoopback) return location.host;
  const n = sync?.net;
  return n?.ips?.[0] || n?.host || location.host;
}

function urlBox() {
  const n = sync?.net;
  const alt = n?.host && n.host !== joinHost() ? n.host : null;
  return h('div', { class: 'tv-url' },
    'Phones join at ', h('b', {}, joinHost()),
    alt ? h('span', { class: 'dim', style: 'font-size:.8em;margin-left:8px' }, `or ${alt}`) : null);
}

function wordmark(size = 40) {
  return h('div', { class: 'wordmark' },
    'PARTY STATION'.split('').map(ch => ch === ' '
      ? h('span', { class: 'gap' })
      : h('span', { style: `width:${size * .82}px;height:${size}px;font-size:${size * .5}px` }, ch)));
}

function hintBar(hints) {
  return h('div', { class: 'tv-hints' },
    hints.map(([k, label]) => h('span', {}, h('b', {}, k), ' ', label)));
}

// The Pi's Chromium is missing glyphs for several emoji (playing cards
// especially), so every icon the kiosk depends on is drawn inline as SVG.
const SUIT_PATHS = {
  heart: '<path d="M0 9 C-9 2 -12 -2 -12 -6.5 C-12 -10 -9 -12.5 -6 -12.5 C-3.5 -12.5 -1 -11 0 -8.5 C1 -11 3.5 -12.5 6 -12.5 C9 -12.5 12 -10 12 -6.5 C12 -2 9 2 0 9 Z" fill="#d22c47"/>',
  spade: '<path d="M0 -9 C-9 -2 -12 2 -12 5.5 C-12 8.7 -9.5 10.7 -6.5 10.7 C-4.5 10.7 -2.5 9.8 -1.2 8.2 C-1.8 10.8 -2.9 12.7 -4.3 14 L4.3 14 C2.9 12.7 1.8 10.8 1.2 8.2 C2.5 9.8 4.5 10.7 6.5 10.7 C9.5 10.7 12 8.7 12 5.5 C12 2 9 -2 0 -9 Z" fill="#1c1c28"/>',
  diamond: '<path d="M0 -12 L8.5 0 L0 12 L-8.5 0 Z" fill="#d22c47"/>',
  club: '<g fill="#1c1c28"><circle cx="0" cy="-7" r="5.4"/><circle cx="-5.8" cy="1.5" r="5.4"/><circle cx="5.8" cy="1.5" r="5.4"/><path d="M-1.2 0 C-1.8 6 -2.9 10.7 -4.3 12 L4.3 12 C2.9 10.7 1.8 6 1.2 0 Z"/></g>',
};

// One playing card as an SVG fragment: white face, rank in the corner, big
// suit pip in the middle. x/y/rot place it inside the icon's viewBox.
function cardSvg({ x = 0, y = 0, rot = 0, rank = 'A', suit = 'spade', back = false } = {}) {
  const red = suit === 'heart' || suit === 'diamond';
  const body = back
    ? '<rect x="-16" y="-22" width="32" height="44" rx="5" fill="#2d3253" stroke="#10121f" stroke-width="1.5"/>'
      + '<rect x="-11.5" y="-17.5" width="23" height="35" rx="3" fill="none" stroke="#454b76" stroke-width="2.5"/>'
    : '<rect x="-16" y="-22" width="32" height="44" rx="5" fill="#fdfbf5" stroke="#b9b4a4" stroke-width="1"/>'
      + `<text x="-12" y="-11" font-family="system-ui,sans-serif" font-size="12" font-weight="800" fill="${red ? '#d22c47' : '#1c1c28'}">${rank}</text>`
      + `<g transform="translate(2 5) scale(.9)">${SUIT_PATHS[suit]}</g>`;
  return `<g transform="translate(${x} ${y}) rotate(${rot})">${body}</g>`;
}

function svgIcon(size, viewW, viewH, inner) {
  return h('span', {
    class: 'arcade-icon',
    style: `width:${size}px;height:${Math.round(size * viewH / viewW)}px`,
    html: `<svg viewBox="0 0 ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`,
  });
}

// Per-game icons for the hub/lobby/game-over screens. Anything not listed
// falls back to the emoji the server registry supplies.
const GAME_ICONS = {
  hearts: s => svgIcon(s, 64, 56, cardSvg({ x: 32, y: 28, rank: 'A', suit: 'heart' })),
  crazy8s: s => svgIcon(s, 64, 56,
    cardSvg({ x: 24, y: 28, rot: -10, rank: '8', suit: 'club' })
    + cardSvg({ x: 42, y: 29, rot: 9, rank: '8', suit: 'diamond' })),
  holdem: s => svgIcon(s, 72, 60,
    cardSvg({ x: 28, y: 26, rot: -12, rank: 'A', suit: 'heart' })
    + cardSvg({ x: 46, y: 27, rot: 8, rank: 'A', suit: 'spade' })
    + '<g><circle cx="36" cy="49" r="9.5" fill="#ffb52e" stroke="#b97a10" stroke-width="2"/>'
    + '<circle cx="36" cy="49" r="5" fill="none" stroke="#b97a10" stroke-width="1.6" stroke-dasharray="2.6 2.2"/></g>'),
  blackjack: s => svgIcon(s, 68, 58,
    cardSvg({ x: 26, y: 28, rot: -12, back: true })
    + cardSvg({ x: 42, y: 28, rot: 7, rank: 'A', suit: 'spade' })),
  gofish: s => svgIcon(s, 64, 56,
    cardSvg({ x: 32, y: 28, rank: 'G', suit: 'spade' }).replace(SUIT_PATHS.spade,
      '<g><ellipse cx="0" cy="0" rx="9.5" ry="6" fill="#4da3ff"/>'
      + '<path d="M7 0 L14 -6 L14 6 Z" fill="#4da3ff"/>'
      + '<circle cx="-4.5" cy="-1.5" r="1.4" fill="#10121f"/></g>')),
  // A payoff pile with a wild King on top — the two things the game is about.
  spite: s => svgIcon(s, 68, 58,
    cardSvg({ x: 26, y: 30, rot: -9, back: true })
    + cardSvg({ x: 44, y: 27, rot: 8, rank: 'K', suit: 'spade' }).replace(SUIT_PATHS.spade,
      '<path d="M0 -11 L4 -3 L11 -6 L8 4 L-8 4 L-11 -6 L-4 -3 Z" fill="#b98bff"/>'
      + '<rect x="-8" y="5.5" width="16" height="3.5" rx="1" fill="#b98bff"/>')),
};

// Dead of Night: a full moon over a grave mound, one hand clawing out.
GAME_ICONS.deadofnight = s => svgIcon(s, 64, 60, `
  <circle cx="42" cy="20" r="15" fill="#f3e9c6"/>
  <circle cx="37" cy="16" r="3" fill="#d9cda4"/><circle cx="47" cy="25" r="2.2" fill="#d9cda4"/>
  <path d="M0 60 Q32 40 64 60 Z" fill="#2d3253"/>
  <g fill="#7fb07f" stroke="#2b4a30" stroke-width="1.2" stroke-linejoin="round">
    <rect x="20" y="36" width="10" height="20" rx="2"/>
    <rect x="16.5" y="25" width="17" height="14" rx="4"/>
    <rect x="16.8" y="13" width="3.6" height="14" rx="1.6"/>
    <rect x="21.2" y="9.5" width="3.6" height="17" rx="1.6"/>
    <rect x="25.6" y="10.5" width="3.6" height="16" rx="1.6"/>
    <rect x="30" y="15" width="3.4" height="12" rx="1.6"/>
    <path d="M17 32 L10.5 25 L12.5 22.5 L19 28 Z"/>
  </g>
  <path d="M18 46 L20 42 L22 45 L24 41 L26 45 L28 41.5 L30 45 L32 43 L32 56 L18 56 Z" fill="#4b3a80"/>`);

function gameIcon(g, size) {
  return GAME_ICONS[g.id]
    ? GAME_ICONS[g.id](size)
    : h('span', { style: `font-size:${size * .8}px;line-height:1.2` }, g.icon);
}

// A game cartridge — box-art placeholder for console games with no cover.
function cartridgeIcon(size = 48) {
  return h('span', {
    class: 'arcade-icon',
    style: `width:${size}px;height:${Math.round(size * 1.05)}px`,
    html: `<svg viewBox="0 0 64 67" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M10 4 h44 q4 0 4 4 v50 q0 4 -4 4 h-32 l-16 -14 v-44 q0 -4 4 -4 z" fill="#4b3a80"/>
      <rect x="16" y="12" width="32" height="26" rx="3" fill="#10121f"/>
      <rect x="19" y="15" width="26" height="20" rx="2" fill="#3ecf8e"/>
      <rect x="22" y="46" width="26" height="10" rx="2" fill="#2d3253"/>
      <g stroke="#2d3253" stroke-width="2"><line x1="14" y1="8" x2="14" y2="42"/></g>
    </svg>`,
  });
}

// There's no arcade-machine emoji, so the Retro Games icon is a hand-drawn
// cabinet in the console's own palette (marquee, screen, stick, buttons).
function arcadeIcon(size = 56) {
  return h('span', {
    class: 'arcade-icon',
    style: `width:${size}px;height:${Math.round(size * 1.18)}px`,
    html: `<svg viewBox="0 0 64 76" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 16 L58 16 L58 71 Q58 75 54 75 L10 75 Q6 75 6 71 Z" fill="#4b3a80"/>
      <rect x="6" y="2" width="52" height="15" rx="3" fill="#ffb52e"/>
      <rect x="11" y="5.5" width="42" height="8" rx="2" fill="#241a02" opacity=".3"/>
      <rect x="11" y="21" width="42" height="25" rx="3" fill="#10121f"/>
      <rect x="14" y="24" width="36" height="19" rx="2" fill="#3ecf8e"/>
      <path d="M14 24 h36 v8 h-36 z" fill="#ffffff" opacity=".16"/>
      <rect x="9" y="49" width="46" height="12" rx="3" fill="#2d3253"/>
      <rect x="19.6" y="43" width="2.8" height="11" rx="1.4" fill="#cfd2e6"/>
      <circle cx="21" cy="42" r="4.4" fill="#ff5d73"/>
      <circle cx="38" cy="55" r="3.6" fill="#ffb52e"/>
      <circle cx="48" cy="55" r="3.6" fill="#ff5d73"/>
      <rect x="13" y="64" width="38" height="8" rx="2" fill="#10121f" opacity=".55"/>
      <rect x="30" y="66" width="4" height="4" rx="1" fill="#ffb52e"/>
    </svg>`,
  });
}

function disposeScene() {
  if (scene?.api?.dispose) scene.api.dispose();
  scene = null;
  if (relaySim?.stop) relaySim.stop();
  relaySim = null;
}

function hubScreen() {
  disposeScene();
  if (tvMode === null) return chooseScreen();
  if (tvMode === 'settings') return settingsScreen();
  if (tvMode === 'retro') return retroHubScreen();
  let i = 0; // running index across shelves — matches hubCursor
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, wordmark(44), urlBox()),
    h('div', { class: 'hub-fill' },
      h('div', { class: 'hub-center' },
        hubGroups().flatMap(row => [
          h('div', { class: 'eyebrow', style: 'font-size:15px;margin:0 0 14px' },
            CATEGORY_LABELS[row[0].g.category] || row[0].g.category),
          h('div', { class: 'hub-grid', style: 'margin-bottom:22px' },
            row.map(e => {
              const g = e.g;
              return h('div', { class: `game-tile cat-${g.category}` + (i++ === hubCursor ? ' tv-focus' : '') },
                sync.saves[g.id] && h('div', { class: 'g-save' }, '💾 SAVED'),
                h('span', { class: 'g-icon' }, gameIcon(g, 92)),
                h('div', { class: 'g-name', style: 'font-size:24px' }, g.name),
                h('div', { class: 'g-sub', style: 'font-size:15px' },
                  `${g.minPlayers === g.maxPlayers ? g.minPlayers : g.minPlayers + '–' + g.maxPlayers} players`
                  + (g.needsPad ? ' · 🎮 controller' : '')));
            })),
        ]))),
    h('div', { class: 'tv-seats', style: 'margin:6px 0' },
      sync.players.length
        ? sync.players.map(p => h('div', { class: 'chip' }, h('span', { class: 'dot' }, p.name[0]?.toUpperCase()), p.name))
        : h('span', { class: 'dim', style: 'font-size:18px' }, 'No players yet — join from a phone or press a button on a paired controller.')),
    hintBar([['🎮 A', 'open game'], ['🎮 X', 'resume save'], ['🎮 B', 'retro ⇄ party'], ['📱', `phones: http://${joinHost()}`]]),
  );
}

const CATEGORY_LABELS = { cards: '🃏 Card games', action: '🧟 Action' };

// "Card games — …" until there's more than cards on the shelves.
function partySub() {
  const names = { cards: 'Card games', action: 'action' };
  const cats = [...new Set(sync.games.map(g => g.category))].map(c => names[c] || c);
  return cats.length > 1 ? `${cats.join(' & ')} — phones and controllers` : `${cats[0] || 'Card games'} — phones and controllers`;
}

// Landing chooser: the console's first screen — retro classics or party games?
function chooseScreen() {
  const emuGames = (sync.emu?.systems || []).reduce((n, s) => n + s.games.length, 0);
  const tiles = [
    { icon: () => h('span', { style: 'font-size:76px;line-height:1.2' }, '🃏'), name: 'Party Games', sub: partySub(), cls: 'cat-cards', mode: 'party' },
    {
      icon: () => arcadeIcon(76), name: 'Retro Games', cls: 'cat-arcade', mode: 'retro',
      sub: sync.emu?.available ? `${emuGames} classics on the emulator` : `Add ROMs at http://${joinHost()}/roms`,
    },
    {
      icon: () => h('span', { style: 'font-size:76px;line-height:1.2' }, '⚙️'),
      name: 'Settings', cls: 'cat-board', mode: 'settings',
      sub: 'Wi-Fi and display',
    },
  ];
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, wordmark(44), urlBox()),
    h('div', { class: 'tv-main' },
      h('div', { class: 'center' },
        h('div', { class: 'tv-big', style: 'font-size:44px;margin-bottom:26px' }, 'What are we playing?'),
        h('div', { class: 'row', style: 'gap:26px;justify-content:center' },
          tiles.map((t2, i) => h('div', {
            class: `game-tile ${t2.cls}` + (chooseIdx === i ? ' tv-focus' : ''),
            style: 'width:320px;min-height:250px;align-items:center;justify-content:center;text-align:center;gap:12px',
            onclick: () => { tvMode = t2.mode; hubCursor = 0; if (t2.mode === 'settings') openSettings(); render(); },
          },
            t2.icon(),
            h('div', { class: 'g-name', style: 'font-size:27px' }, t2.name),
            h('div', { class: 'g-sub', style: 'font-size:14px' }, t2.sub)))))),
    hintBar([['🎮 ◀▶', 'choose'], ['🎮 A', 'select'], ['📱', `phones: http://${joinHost()}`]]),
  );
}

// Art URLs the browser has already loaded once — re-renders (every cursor
// move rebuilds the DOM) skip the fade-in so covers don't blink.
const artSeen = new Set();

function romTile(e, focused, artH, tileW) {
  const url = `/api/art/${e.system}/${encodeURIComponent(e.file)}`;
  const isArcade = e.system.startsWith('arcade') || e.system.startsWith('mame') || e.system === 'fba';
  return h('div', {
    class: 'game-tile cat-arcade rom-tile' + (focused ? ' tv-focus' : ''),
    style: `width:${tileW + 24}px`,
  },
    h('div', { class: 'rom-art' + (artSeen.has(url) ? ' haveart' : ''), style: `height:${artH}px` },
      h('img', {
        src: url, alt: '', loading: 'lazy',
        onload: ev => { artSeen.add(url); ev.target.parentNode.classList.add('haveart'); },
      }),
      h('span', { class: 'rom-fallback' },
        isArcade ? arcadeIcon(Math.round(artH * .38)) : cartridgeIcon(Math.round(artH * .38))),
      h('span', { class: 'rom-badge' }, e.sysName.replace(/\s*\(.*\)$/, ''))),
    h('div', { class: 'rom-name' }, e.title));
}

function retroHubScreen() {
  const { rows, artH, tileW } = retroLayout();
  const total = retroEnts().length;
  let idx = 0;
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, wordmark(44), urlBox()),
    total
      ? h('div', { class: 'hub-fill' },
        h('div', { class: 'hub-center' },
          h('div', { class: 'eyebrow', style: 'font-size:15px;margin-bottom:14px;text-align:center' },
            `Retro games — ${total} in the library`),
          rows.map(row => h('div', { class: 'rom-row' },
            row.map(e => romTile(e, idx++ === hubCursor, artH, tileW))))))
      : h('div', { class: 'tv-main' },
        h('div', { class: 'center' },
          arcadeIcon(110),
          h('div', { class: 'tv-big', style: 'font-size:40px' }, 'No retro games yet'),
          h('p', { class: 'dim', style: 'font-size:22px;margin-top:12px' },
            `Add ROMs of games you own at http://${joinHost()}/roms`),
          h('p', { class: 'dim', style: 'font-size:18px' },
            `or scp them into ~/RetroPie/roms/incoming — they sort themselves.`))),
    hintBar([['🎮 A', 'play'], ['🎮 B', 'back'], ['📱', `phones: http://${joinHost()}`]]),
  );
}

function lobbyScreen() {
  disposeScene();
  const L = sync.lobby;
  const g = sync.games.find(x => x.id === L.gameId);
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' },
      h('div', { class: 'tv-title' }, gameIcon(g, 52), g.name),
      urlBox()),
    h('div', { class: 'tv-main' },
      h('div', { class: 'center' },
        h('div', { class: 'tv-big', style: 'font-size:50px;margin-bottom:10px' }, 'Who’s in?'),
        h('p', { class: 'dim', style: 'font-size:22px' },
          `${L.hostName} starts the game when everyone’s seated.`
            + (g.bots === false ? ' Press any button on a controller to join.' : ' Empty seats become bots.')))),
    h('div', { class: 'tv-seats' }, L.seats.map(s =>
      h('div', { class: 'chip' + (s.bot ? ' bot' : '') },
        h('span', { class: 'dot' }, s.bot ? '🤖' : s.name[0]?.toUpperCase()), s.name))),
    hintBar([['🎮 A', 'join'], ['🎮 B', 'leave'], ['🎮 X/Start', 'start (host)'], ['📱', 'phones: tap Join']]),
  );
}

function menuPanels() {
  const panels = [];
  for (const [pad, menu] of menus.entries()) {
    const info = myPadInfo(pad);
    if (!info) continue;
    const items = menu.spec.items.filter(i => !i.hidden);
    panels.push(h('div', { class: 'pad-menu' },
      h('div', { class: 'pad-menu-title' }, `🎮 ${info.name}${menu.spec.title ? ' — ' + menu.spec.title : ''}`),
      items.map((it, i) => h('div', {
        class: 'pad-menu-item' + (i === menu.idx ? ' focus' : '') + (it.disabled ? ' dis' : '') + (it.on ? ' on' : ''),
      }, it.label)),
    ));
  }
  return panels;
}

// The live Gamepad driving a seat on this screen: that seat's own pad, or —
// for a seat whose player is on a phone, or nobody's yet — the first pad
// that isn't some other seat's. Read fresh every call: pads reconnect and
// renumber, and the game polls this every frame.
function gamepadForSeat(seat) {
  const all = navigator.getGamepads?.() || [];
  const taken = new Map();
  for (const [pad, info] of Object.entries(sync?.pads || {})) {
    if (info.seat >= 0) taken.set(info.seat, Number(pad));
  }
  if (taken.has(seat)) return all[taken.get(seat)] || null;
  const busy = new Set(taken.values());
  return [...all].find(gp => gp && gp.connected && !busy.has(gp.index)) || null;
}

function gameScreen() {
  const G = sync.game;
  const g = sync.games.find(x => x.id === G.gameId);
  const mod = modules[G.gameId];
  if (!mod) { loadModule(G.gameId); return h('div', { class: 'tv-stage center dim' }, 'Loading…'); }
  if (mod.error) {
    return h('div', { class: 'tv-stage' },
      h('div', { class: 'tv-main' },
        h('div', { class: 'banner center', style: 'font-size:22px' },
          `⚠️ ${g.name}'s screen failed to load — check the browser console. The game engine is still running.`)));
  }

  const immersive = G.mode === 'relay' && !!mod.tv?.immersive;
  const holder = h('div', { class: immersive ? 'tv-immersive' : 'tv-scene' });
  const padSeats = {};
  for (const [pad, info] of Object.entries(sync.pads || {})) {
    if (info.seat >= 0) padSeats[info.seat] = Number(pad);
  }

  if (G.mode === 'relay') {
    const key = G.gameId + JSON.stringify(G.seats.map(s => s.name));
    if (scene?.key !== key) {
      disposeScene();
      scene = { key, gameId: G.gameId, api: null };
      requestAnimationFrame(() => {
        if (mod.tv?.start && scene?.key === key) {
          relaySim = mod.tv.start(holder, {
            seats: G.seats, options: G.options || {},
            // A pad with its pause menu open is invisible to the sim, so
            // navigating the menu doesn't twitch the player's character.
            padDown: (seat, k2) => padSeats[seat] !== undefined
              && !menus.has(padSeats[seat])
              && pads.isDown(padSeats[seat], k2),
            end: result => net.send({ t: 'relayEnd', result }),
            sendScore: d => net.send({ t: 'relayScore', d }),
            // Raw analog access for games that need sticks and triggers.
            gamepad: seat => gamepadForSeat(seat),
            // Straight back to the hub (an immersive game's own "Quit").
            quit: () => net.send({ t: 'relayQuit' }),
          });
          scene.api = relaySim;
        }
      });
    } else if (relaySim?.rehome) {
      requestAnimationFrame(() => relaySim.rehome(holder));
    }
  } else {
    const ctx = {
      pub: G.pub, seats: G.seats, game: G, peeked,
      padSeats,
      privOf: seat => {
        for (const info of Object.values(sync.pads || {})) {
          if (info.seat === seat) return info.priv;
        }
        return null;
      },
    };
    const key = G.gameId;
    if (scene?.key !== key || !scene.api) {
      disposeScene();
      scene = { key, gameId: G.gameId, api: null };
      requestAnimationFrame(() => {
        if (mod.tv?.mount && scene?.key === key) {
          scene.api = mod.tv.mount(holder, ctx);
          scene.api?.update?.(ctx);
        }
      });
    } else {
      const api = scene.api;
      requestAnimationFrame(() => {
        api.rehome?.(holder);
        api.update?.(ctx);
      });
    }
  }

  if (immersive) return holder; // the game draws every pixel, HUD and menus included
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' },
      h('div', { class: 'tv-title', style: 'font-size:26px' }, gameIcon(g, 38), g.name),
      urlBox()),
    holder,
    h('div', { class: 'pad-menus' }, menuPanels()),
    hintBar(G.mode === 'relay'
      ? [['🎮', 'plays directly'], ['🎮 Start', 'pause / quit'], ['📱', 'phone = gamepad']]
      : [['🎮 A', 'choose'], ['🎮 Y', 'peek hand'], ['🎮 Start', 'pause / exit'], ['📱', 'play from your phone']]),
  );
}

function gameoverScreen() {
  disposeScene();
  const G = sync.game;
  const g = sync.games.find(x => x.id === G.gameId);
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, wordmark(34), urlBox()),
    h('div', { class: 'tv-main' },
      h('div', { class: 'center' },
        h('div', {}, gameIcon(g, 130)),
        h('div', { class: 'tv-big' }, G.over?.title || 'Game over'),
        h('div', { style: 'font-size:24px;margin-top:14px' },
          (G.over?.lines || []).map(l => h('div', { class: 'dim' }, l))))),
    hintBar([['🎮 A', 'back to games'], ['📱', 'tap “Back to games”']]),
  );
}

function emulatorScreen() {
  disposeScene();
  const e = sync.emulator;
  return h('div', { class: 'tv-stage' },
    h('div', { class: 'tv-top' }, wordmark(34), urlBox()),
    h('div', { class: 'tv-main' },
      h('div', { class: 'center' },
        h('div', { style: 'font-size:100px' }, e.icon || '🕹️'),
        h('div', { class: 'tv-big', style: 'font-size:54px' }, e.title),
        h('p', { class: 'dim', style: 'font-size:22px;margin-top:12px' },
          `${e.system} — the emulator is taking over this screen…`),
        e.system?.startsWith('Arcade') && h('p', { class: 'dim', style: 'font-size:18px' },
          '🪙 Arcade rules: tap Select to insert a coin, then press Start to play.'),
        h('p', { class: 'dim', style: 'font-size:18px' }, 'Exit by holding Select and pressing Start.'))),
  );
}

// State-driven sounds: chime on game start, fanfare on game over, and a
// ding whenever a human seat's turn comes up in a turn-based game.
let prevPhase = null;
let prevAwaited = new Set();
function soundTransitions() {
  if (sync.phase !== prevPhase) {
    if (sync.phase === 'game') sfx.start();
    if (sync.phase === 'gameover') sfx.over();
    prevPhase = sync.phase;
    prevAwaited = new Set();
  }
  if (sync.phase === 'game' && sync.game?.mode === 'server') {
    const awaited = new Set(sync.game.awaiting || []);
    for (const seat of awaited) {
      if (!prevAwaited.has(seat) && !sync.game.seats[seat]?.bot) { sfx.turn(); break; }
    }
    prevAwaited = awaited;
  }
}

// A phone asked to change the network; the code exists only here, on screen.
// Drawn over whatever else is showing so it works mid-game too.
function pinOverlay() {
  const p = sync.settingsPin;
  if (!p) return null;
  return h('div', { class: 'pin-overlay' },
    h('div', { class: 'pin-card' },
      h('div', { class: 'eyebrow', style: 'font-size:19px' }, 'Settings unlock code'),
      h('div', { class: 'code' }, p.code),
      h('p', { class: 'dim', style: 'font-size:20px;margin-top:14px' },
        'Type this on the phone that asked to change Wi-Fi or the display.'),
      h('p', { class: 'dim', style: 'font-size:16px;margin-top:6px' },
        'It disappears in a minute and a half.')));
}

function render() {
  if (!sync) return;
  soundTransitions();
  if (sync.emulator) { menus.clear(); mount(root, emulatorScreen()); return; }
  // A session started from a phone answers the landing prompt implicitly.
  if (tvMode === null && sync.phase !== 'hub') tvMode = 'party';
  if (sync.phase === 'game') refreshMenus(); else menus.clear();
  const pin = pinOverlay();
  switch (sync.phase) {
    case 'hub':
      mount(root, hubScreen(), pin);
      // Shelves can overflow the screen — keep the pad cursor's tile visible.
      requestAnimationFrame(() => root.querySelector('.tv-focus')?.scrollIntoView({ block: 'nearest' }));
      break;
    case 'lobby': mount(root, lobbyScreen(), pin); break;
    case 'game': mount(root, gameScreen(), pin); break;
    case 'gameover': mount(root, gameoverScreen(), pin); break;
  }
}
