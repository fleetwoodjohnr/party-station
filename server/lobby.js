// Session orchestration: players, the single lobby/game session, bots, saves.
//
// Roles: 'player' clients (phones) and 'tv' clients (the big screen).
// Phases: hub -> lobby -> game -> gameover -> hub.
//
// Turn-based games ("server" mode) run their engine here; bots are scheduled
// with human-feeling delays. Real-time arcade games ("relay" mode) run their
// simulation in the TV browser; this server just relays phone inputs to it.
import crypto from 'crypto';
import { execFile } from 'child_process';
import { byId, catalog } from './registry.js';
import * as saves from './saves.js';
import * as updater from './updater.js';
import * as emulator from './emulator.js';
import * as hostinfo from './hostinfo.js';
import { pinForTv } from './settings.js';
import { botName } from './bots.js';

const players = new Map();   // pid -> {id, name, token, ws, connected}
const tvSockets = new Set();

let phase = 'hub';
let lobby = null;    // {gameId, hostPid, humans:[pid], bots:[name], options:{}}
let session = null;  // {gameId, mode, options, seats:[{name,bot,pid}], game, over, botTimers:Map}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const uid = () => crypto.randomBytes(8).toString('hex');

// Route a message to a player: phones get it directly; gamepad players
// (owned by a TV connection) get it via their TV, tagged with the pad index.
const sendTo = (p, msg) => {
  if (p.viaTv) send(p.viaTv, { ...msg, pad: p.pad });
  else send(p.ws, msg);
};

// ---------------------------------------------------------------- state sync

function gameLite() {
  return catalog().map(m => ({
    id: m.id, name: m.name, tagline: m.tagline, icon: m.icon, category: m.category,
    minPlayers: m.minPlayers, maxPlayers: m.maxPlayers, mode: m.mode, options: m.options || [],
    bots: m.bots !== false, needsPad: !!m.needsPad, description: m.description,
  }));
}

function hostPid() {
  if (phase === 'lobby') return lobby?.hostPid;
  if (session) {
    const seat = session.seats.find(s => !s.bot && s.pid && players.get(s.pid)?.connected);
    return seat?.pid;
  }
  return null;
}

function sharedState() {
  return {
    games: gameLite(),
    saves: saves.summaries(),
    players: [...players.values()].filter(p => p.connected).map(p => ({ name: p.name })),
    tvCount: tvSockets.size,
    version: updater.status.version,
    updateAvailable: updater.status.updateAvailable,
    updating: updater.status.updating,
    updateError: updater.status.error,
    emu: emulator.summary(),
    emulator: emulator.publicState(),
    // The address guests should actually type. The TV can't work this out for
    // itself — the kiosk's own URL is http://localhost/tv.
    net: hostinfo.addresses(),
    // Set while someone on a phone is waiting to be let into settings; the TV
    // is the only place this code is ever shown.
    settingsPin: pinForTv(),
  };
}

// For TV recipients, `recipient` is the TV's websocket; for players it's the
// player record.
function syncFor(recipient, isTV, shared = sharedState()) {
  const recipientTvWs = isTV ? recipient : null;
  const msg = { t: 'sync', phase, ...shared };
  if (!isTV && recipient) {
    msg.you = { id: recipient.id, name: recipient.name };
  } else {
    msg.isTV = true;
    // Everything the TV needs to act for its gamepad players.
    msg.pads = {};
    for (const p of players.values()) {
      if (p.viaTv !== recipientTvWs || !p.connected) continue;
      const info = { name: p.name, id: p.id };
      if (phase === 'lobby' && lobby) {
        info.joined = lobby.humans.includes(p.id);
        info.isHost = lobby.hostPid === p.id;
      }
      if ((phase === 'game' || phase === 'gameover') && session) {
        info.seat = session.seats.findIndex(s => s.pid === p.id);
        info.isHost = p.id === hostPid();
        if (info.seat >= 0 && session.mode === 'server' && session.game) {
          info.priv = session.game.priv(info.seat);
          info.awaited = session.game.awaiting().includes(info.seat);
        }
      }
      msg.pads[p.pad] = info;
    }
  }
  if (phase === 'lobby' && lobby) {
    msg.lobby = {
      gameId: lobby.gameId,
      hostName: players.get(lobby.hostPid)?.name,
      youAreHost: !isTV && recipient?.id === lobby.hostPid,
      youJoined: !isTV && lobby.humans.includes(recipient?.id),
      seats: [
        ...lobby.humans.map(pid => ({ name: players.get(pid)?.name || '?', bot: false })),
        ...lobby.bots.map(n => ({ name: n, bot: true })),
      ],
      options: lobby.options,
    };
  }
  if ((phase === 'game' || phase === 'gameover') && session) {
    const yourSeat = !isTV && recipient
      ? session.seats.findIndex(s => s.pid === recipient.id) : -1;
    msg.game = {
      gameId: session.gameId,
      mode: session.mode,
      options: session.options,
      seats: session.seats.map(s => ({
        name: s.name, bot: s.bot,
        connected: s.bot ? true : !!(s.pid && players.get(s.pid)?.connected),
      })),
      yourSeat,
      youAreHost: !isTV && recipient?.id === hostPid(),
      over: session.over || null,
    };
    if (isTV && session.mode === 'relay') msg.game.sim = !session.simTv || session.simTv === recipient;
    if (session.mode === 'server' && session.game) {
      msg.game.pub = session.game.pub();
      if (yourSeat >= 0) msg.game.priv = session.game.priv(yourSeat);
      msg.game.awaiting = session.game.awaiting();
    }
  }
  return msg;
}

export function broadcast() {
  const shared = sharedState();
  for (const p of players.values()) {
    if (p.connected && !p.viaTv) send(p.ws, syncFor(p, false, shared));
  }
  for (const ws of tvSockets) send(ws, syncFor(ws, true, shared));
}

function toast(target, text) {
  if (target === 'all') {
    for (const p of players.values()) if (!p.viaTv) send(p.ws, { t: 'toast', text });
    for (const ws of tvSockets) send(ws, { t: 'toast', text });
  } else if (target) sendTo(target, { t: 'toast', text });
}

// ---------------------------------------------------------------- lifecycle

function uniqueName(raw, selfPid) {
  let name = String(raw || '').trim().slice(0, 16) || 'Player';
  const taken = [...players.values()].filter(p => p.id !== selfPid).map(p => p.name.toLowerCase());
  let n = name, i = 2;
  while (taken.includes(n.toLowerCase())) n = `${name} ${i++}`;
  return n;
}

function attachPlayer(ws, hello) {
  // Resume by token first; then reclaim a disconnected player by name
  // (helps phones that dropped localStorage or switched browsers).
  let p = hello.token && [...players.values()].find(x => x.token === hello.token && x.pad == null);
  if (!p && hello.name) {
    p = [...players.values()].find(
      x => !x.connected && x.pad == null
        && x.name.toLowerCase() === String(hello.name).trim().toLowerCase());
  }
  if (!p) {
    p = { id: uid(), token: uid(), name: '', ws: null, connected: false };
    p.name = uniqueName(hello.name, p.id);
    players.set(p.id, p);
  }
  if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch {} }
  p.ws = ws;
  p.connected = true;
  ws._pid = p.id;
  send(ws, { t: 'welcome', id: p.id, token: p.token, name: p.name });
  return p;
}

function cleanupSession() {
  if (session) {
    for (const t of session.botTimers.values()) clearTimeout(t);
    clearTimeout(session.tickTimer);
  }
  session = null;
}

function returnToHub() {
  cleanupSession();
  lobby = null;
  phase = 'hub';
  broadcast();
}

// ---------------------------------------------------------------- lobby ops

function openLobby(p, gameId) {
  const mod = byId(gameId);
  if (!mod || phase !== 'hub') return;
  if (emulator.publicState()) { toast(p, 'Finish the arcade cabinet game first!'); return; }
  const options = {};
  for (const o of mod.meta.options || []) options[o.key] = o.def;
  lobby = { gameId, hostPid: p.id, humans: [p.id], bots: [], options };
  phase = 'lobby';
  broadcast();
}

function lobbySize() { return lobby.humans.length + lobby.bots.length; }

function startGame() {
  const mod = byId(lobby.gameId);
  const meta = mod.meta;
  // Fill with bots up to the minimum player count.
  while (lobbySize() < meta.minPlayers) {
    lobby.bots.push(botName([...lobby.bots, ...lobby.humans.map(h => players.get(h)?.name)]));
  }
  if (meta.mode === 'relay' && tvSockets.size === 0) {
    toast(players.get(lobby.hostPid), 'This game needs the big screen. Open the TV page first (see Settings).');
    return;
  }
  const seats = [
    ...lobby.humans.map(pid => ({ name: players.get(pid)?.name || '?', bot: false, pid })),
    ...lobby.bots.map(name => ({ name, bot: true, pid: null })),
  ];
  session = {
    gameId: lobby.gameId, mode: meta.mode, options: lobby.options,
    seats, game: null, over: null, botTimers: new Map(),
  };
  // Relay games run on one screen (the host's); any other TV in the game
  // renders its snapshots and sends its own players' inputs (co-op).
  if (meta.mode === 'relay') {
    const host = players.get(lobby.hostPid);
    session.simTv = host?.viaTv && tvSockets.has(host.viaTv) ? host.viaTv : [...tvSockets][0];
  }
  if (meta.mode === 'server') {
    session.game = mod.create({
      seats: seats.map(s => ({ name: s.name, bot: s.bot })),
      options: lobby.options,
    });
  }
  lobby = null;
  phase = 'game';
  pump();
  broadcast();
}

function resumeGame(p, gameId) {
  if (phase !== 'hub') return;
  const mod = byId(gameId);
  const data = saves.load(gameId);
  if (!mod || !data) { toast(p, 'No saved game found.'); return; }
  const unclaimed = [...players.values()].filter(x => x.connected);
  const seats = data.seats.map(s => {
    const match = !s.bot && unclaimed.find(x => x.name.toLowerCase() === s.name.toLowerCase());
    if (match) {
      unclaimed.splice(unclaimed.indexOf(match), 1);
      return { name: match.name, bot: false, pid: match.id };
    }
    return { name: s.name, bot: true, pid: null }; // absent humans become bots (can be taken over)
  });
  try {
    const game = mod.restore(
      { seats: seats.map(s => ({ name: s.name, bot: s.bot })), options: data.options },
      data.state);
    session = { gameId, mode: 'server', options: data.options, seats, game, over: null, botTimers: new Map() };
    phase = 'game';
    pump();
    broadcast();
  } catch (e) {
    console.error('resume failed', gameId, e);
    saves.clear(gameId);
    toast(p, 'That save could not be loaded, so it was discarded.');
    broadcast();
  }
}

// ---------------------------------------------------------------- game loop

function autosave() {
  if (!session || session.mode !== 'server' || session.over) return;
  saves.save(session.gameId, {
    gameId: session.gameId,
    options: session.options,
    seats: session.seats.map(s => ({ name: s.name, bot: s.bot })),
    state: session.game.state,
  });
}

function pump() {
  if (!session || session.mode !== 'server') return;
  const g = session.game;
  const over = g.over();
  if (over) {
    session.over = over;
    phase = 'gameover';
    saves.clear(session.gameId);
    for (const t of session.botTimers.values()) clearTimeout(t);
    session.botTimers.clear();
    clearTimeout(session.tickTimer);
    session.tickTimer = null;
    return;
  }
  autosave();
  scheduleBots();
  scheduleTick();
}

// Timed display states (a finished trick lingering on the table, a round
// summary): when an engine reports pending(), call its tick() after that
// long — nobody is awaited during the pause, so bots idle too.
function scheduleTick() {
  const g = session.game;
  if (!g.pending || !g.tick || session.tickTimer) return;
  const ms = g.pending();
  if (ms == null) return;
  session.tickTimer = setTimeout(() => {
    if (!session || session.game !== g) return;
    session.tickTimer = null;
    try { g.tick(); } catch (e) { console.error(`tick crashed in ${session.gameId}:`, e); }
    pump();
    broadcast();
  }, ms);
}

function scheduleBots() {
  const g = session.game;
  for (const seatIdx of g.awaiting()) {
    const seat = session.seats[seatIdx];
    if (!seat || !seat.bot || session.botTimers.has(seatIdx)) continue;
    // BOT_DELAY_MS: test hook (e2e) — full games against bots at human pace
    // take minutes; never set in production.
    const delay = Number(process.env.BOT_DELAY_MS) || 650 + Math.random() * 850;
    session.botTimers.set(seatIdx, setTimeout(() => {
      if (!session || session.game !== g) return;
      session.botTimers.delete(seatIdx);
      if (!g.awaiting().includes(seatIdx)) return;
      try {
        const action = g.botAct(seatIdx);
        if (action) {
          const res = g.act(seatIdx, action);
          if (res?.err) console.error(`bot illegal move in ${session.gameId}:`, res.err, action);
        }
      } catch (e) {
        console.error(`bot crashed in ${session.gameId}:`, e);
      }
      pump();
      broadcast();
    }, delay));
  }
}

// ---------------------------------------------------------------- messages

function onPlayerMsg(p, m) {
  switch (m.t) {
    case 'setName': {
      p.name = uniqueName(m.name, p.id);
      broadcast(); break;
    }
    case 'openLobby': openLobby(p, m.gameId); break;
    case 'joinLobby': {
      if (phase !== 'lobby' || lobby.humans.includes(p.id)) break;
      const meta = byId(lobby.gameId).meta;
      // First-person games need a screen per player: one pad per TV.
      if (meta.onePerScreen && p.viaTv && lobby.humans.some(h => players.get(h)?.viaTv === p.viaTv)) {
        toast(p, 'One player per screen — join from another TV or a browser at this address/tv');
        break;
      }
      if (lobbySize() >= meta.maxPlayers) {
        if (lobby.bots.length) lobby.bots.pop(); // humans displace bots
        else { toast(p, 'This table is full.'); break; }
      }
      lobby.humans.push(p.id);
      broadcast(); break;
    }
    case 'leaveLobby': {
      if (phase !== 'lobby') break;
      lobby.humans = lobby.humans.filter(x => x !== p.id);
      if (!lobby.humans.length) { returnToHub(); break; }
      if (lobby.hostPid === p.id) lobby.hostPid = lobby.humans[0];
      broadcast(); break;
    }
    case 'addBot': {
      if (phase !== 'lobby' || p.id !== lobby.hostPid) break;
      const meta = byId(lobby.gameId).meta;
      if (meta.bots !== false && lobbySize() < meta.maxPlayers) {
        lobby.bots.push(botName([...lobby.bots, ...lobby.humans.map(h => players.get(h)?.name)]));
      }
      broadcast(); break;
    }
    case 'removeBot': {
      if (phase !== 'lobby' || p.id !== lobby.hostPid) break;
      lobby.bots.splice(m.i, 1);
      broadcast(); break;
    }
    case 'setOption': {
      if (phase !== 'lobby' || p.id !== lobby.hostPid) break;
      const def = (byId(lobby.gameId).meta.options || []).find(o => o.key === m.key);
      if (def && def.choices.some(c => String(c.v) === String(m.value))) {
        lobby.options[m.key] = def.choices.find(c => String(c.v) === String(m.value)).v;
      }
      broadcast(); break;
    }
    case 'cancelLobby': {
      if (phase === 'lobby' && p.id === lobby.hostPid) returnToHub();
      break;
    }
    case 'start': {
      if (phase !== 'lobby' || p.id !== lobby.hostPid) break;
      startGame(); break;
    }
    case 'resumeGame':
      if (emulator.publicState()) { toast(p, 'Finish the arcade cabinet game first!'); break; }
      resumeGame(p, m.gameId); break;
    case 'emuLaunch': {
      if (phase !== 'hub') { toast(p, 'Head back to the hub first.'); break; }
      const res = emulator.launch(m.system, m.file, (_code, info) => {
        if (info?.crashed) {
          toast('all', info.system === 'arcade'
            ? `⚠️ ${info.title} quit right away — arcade zips must match the MAME 2003-Plus (0.78) ROM set.`
            : `⚠️ ${info.title} quit right away — that file may not match this system's emulator.`);
        }
        broadcast();
      });
      if (res.err) toast(p, res.err);
      else toast('all', `🕹️ ${emulator.publicState()?.title} is starting on the big screen…`);
      broadcast(); break;
    }
    case 'emuKill':
      emulator.kill();
      break;
    case 'emuRescan':
      emulator.scan(true);
      broadcast(); break;
    case 'deleteSave': {
      if (phase === 'hub') { saves.clear(m.gameId); broadcast(); }
      break;
    }
    case 'act': {
      if (phase !== 'game' || !session || session.mode !== 'server') break;
      const seatIdx = session.seats.findIndex(s => s.pid === p.id && !s.bot);
      if (seatIdx < 0) break;
      const res = session.game.act(seatIdx, m.a);
      if (res?.err) { sendTo(p, { t: 'nope', text: res.err }); break; }
      pump();
      broadcast(); break;
    }
    case 'input': { // real-time arcade controls -> forwarded to the TV sim
      if (phase !== 'game' || !session || session.mode !== 'relay') break;
      const seatIdx = session.seats.findIndex(s => s.pid === p.id && !s.bot);
      if (seatIdx < 0) break;
      for (const ws of tvSockets) send(ws, { t: 'input', seat: seatIdx, d: m.d });
      break;
    }
    case 'takeover': {
      if (phase !== 'game' || !session) break;
      const seat = session.seats[m.seat];
      const already = session.seats.some(s => s.pid === p.id && !s.bot);
      if (!seat || !seat.bot || already) break;
      clearTimeout(session.botTimers.get(m.seat));
      session.botTimers.delete(m.seat);
      session.seats[m.seat] = { name: p.name, bot: false, pid: p.id };
      toast('all', `${p.name} took over for ${seat.name}`);
      if (session.mode === 'server') pump();
      broadcast(); break;
    }
    case 'botify': {
      if (phase !== 'game' || !session || p.id !== hostPid()) break;
      const seat = session.seats[m.seat];
      if (!seat || seat.bot || seat.pid === p.id) break;
      if (seat.pid && players.get(seat.pid)?.connected) break; // only for dropped players
      session.seats[m.seat] = { name: seat.name, bot: true, pid: null };
      toast('all', `A bot is filling in for ${seat.name}`);
      if (session.mode === 'server') pump();
      broadcast(); break;
    }
    case 'quitGame': {
      if ((phase !== 'game' && phase !== 'gameover') || !session) break;
      // Any seated player may end the game — pads and phones alike; a stuck
      // table shouldn't depend on one person's device. Spectators may not.
      const seated = session.seats.some(s => !s.bot && s.pid === p.id);
      if (phase === 'game' && !seated) break;
      if (phase === 'game' && session.mode === 'server') autosave(); // resumable later
      returnToHub(); break;
    }
    case 'backToHub': {
      if (phase === 'gameover') returnToHub();
      break;
    }
    case 'checkUpdate':
      // Always answer — a silent "you're current" looks like a broken button.
      updater.check()
        .then(avail => {
          sendTo(p, avail
            ? { t: 'toast', text: '⬇️ Update available — install it from Settings' }
            : { t: 'toast', text: `✅ Up to date — ${updater.status.version}` });
          broadcast();
        })
        .catch(e => {
          sendTo(p, { t: 'nope', text: 'Update check failed: ' + e.message });
          broadcast();
        });
      break;
    case 'applyUpdate':
      if (updater.status.updateAvailable) {
        toast('all', 'Updating Party Station… back in a moment!');
        broadcast();
        updater.apply().catch(e => toast('all', 'Update failed: ' + e.message));
      }
      break;
    case 'ping': send(p.ws, { t: 'pong' }); break;
  }
}

function padPlayer(ws, pad) {
  return [...players.values()].find(x => x.viaTv === ws && x.pad === pad);
}

function onTvMsg(ws, m) {
  switch (m.t) {
    case 'padHello': { // a Bluetooth controller pressed a button on this TV
      let p = padPlayer(ws, m.pad);
      if (!p && m.name) {
        // TV reloaded mid-game: reclaim the disconnected pad player by name.
        p = [...players.values()].find(x => x.pad != null && !x.connected
          && x.name.toLowerCase() === String(m.name).trim().toLowerCase());
      }
      if (p) {
        p.viaTv = ws; p.pad = m.pad; p.connected = true;
      } else {
        p = { id: uid(), token: uid(), name: '', ws: null, viaTv: ws, pad: m.pad, connected: true };
        p.name = uniqueName(m.name || `P${m.pad + 1} 🎮`, p.id);
        players.set(p.id, p);
      }
      broadcast(); break;
    }
    case 'padMsg': { // controller-driven action, relayed by the TV
      const p = padPlayer(ws, m.pad);
      if (p && p.connected && m.m && typeof m.m.t === 'string') onPlayerMsg(p, m.m);
      break;
    }
    case 'padBye': {
      const p = padPlayer(ws, m.pad);
      if (p) {
        p.connected = false;
        if (phase === 'lobby' && lobby) {
          lobby.humans = lobby.humans.filter(pid => pid !== p.id);
          if (lobby.hostPid === p.id && lobby.humans.length) lobby.hostPid = lobby.humans[0];
          if (!lobby.humans.length) { returnToHub(); break; }
        }
        if (phase === 'hub') players.delete(p.id);
      }
      broadcast(); break;
    }
    case 'relayEnd': { // the TV sim finished an arcade game
      if (phase !== 'game' || !session || session.mode !== 'relay') break;
      if (session.options?.bench) { returnToHub(); break; } // nobody to show a scoreboard to
      session.over = m.result || { title: 'Game over' };
      phase = 'gameover';
      broadcast(); break;
    }
    case 'relayState': { // the simulating TV's snapshot -> every other TV
      if (phase !== 'game' || session?.mode !== 'relay' || ws !== session.simTv) break;
      const out = JSON.stringify({ t: 'relayState', d: m.d });
      for (const t of tvSockets) if (t !== ws && t.readyState === 1) t.send(out);
      break;
    }
    case 'relayInput': case 'relayAct': { // a remote TV's player -> the simulating TV
      if (phase !== 'game' || session?.mode !== 'relay' || !session.simTv || ws === session.simTv) break;
      const seat = session.seats[m.seat];
      const owner = seat && !seat.bot && players.get(seat.pid);
      if (!owner || owner.viaTv !== ws) break; // a screen only drives its own players
      send(session.simTv, { t: m.t, seat: m.seat, d: m.d });
      break;
    }
    case 'relayQuit': { // an immersive game's own "Quit to Party Station"
      if (phase === 'game' && session?.mode === 'relay') returnToHub();
      break;
    }
    case 'relayScore': { // lightweight score mirror for phones during arcade games
      if (phase !== 'game' || !session || session.mode !== 'relay') break;
      for (const p of players.values()) send(p.ws, { t: 'relayScore', d: m.d });
      break;
    }
    case 'ping': send(ws, { t: 'pong' }); break;
  }
}

// ---------------------------------------------------------------- wiring

// A crashed TV tab ("Aw, Snap") never reconnects, and the kiosk only
// relaunches Chromium when the whole browser exits — so if no TV comes back
// within 15 s, restart the kiosk browser (no-op where there's no kiosk).
let tvGoneTimer = null;
function watchForDeadTv() {
  clearTimeout(tvGoneTimer);
  tvGoneTimer = setTimeout(() => {
    if (tvSockets.size || emulator.publicState()) return;
    console.log('tv: no screen for 15 s — restarting the kiosk browser');
    execFile('pkill', ['-f', 'user-data-dir=.*party-station-kiosk'], () => {});
  }, 15000);
}

export function handleConnection(ws) {
  let role = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!role) {
      if (m.t !== 'hello') return;
      role = m.role === 'tv' ? 'tv' : 'player';
      if (role === 'tv') {
        tvSockets.add(ws);
        clearTimeout(tvGoneTimer);
        send(ws, syncFor(ws, true));
      } else {
        const p = attachPlayer(ws, m);
        send(ws, syncFor(p, false));
      }
      broadcast();
      return;
    }
    if (role === 'tv') onTvMsg(ws, m);
    else {
      const p = players.get(ws._pid);
      if (p) onPlayerMsg(p, m);
    }
  });
  ws.on('close', () => {
    if (role === 'tv') {
      tvSockets.delete(ws);
      if (!tvSockets.size) watchForDeadTv();
      // Gamepad players live on the TV connection.
      for (const p of [...players.values()]) {
        if (p.viaTv === ws) {
          p.connected = false;
          if (phase === 'hub') players.delete(p.id);
        }
      }
      if (phase === 'lobby' && lobby) {
        lobby.humans = lobby.humans.filter(pid => players.get(pid)?.connected);
        if (!lobby.humans.length) { returnToHub(); return; }
        if (!players.get(lobby.hostPid)?.connected) lobby.hostPid = lobby.humans[0];
      }
      // A relay game cannot outlive its screen (or, in co-op, its host's).
      if (phase === 'game' && session?.mode === 'relay' && (tvSockets.size === 0 || session.simTv === ws)) {
        toast('all', 'The big screen disconnected — arcade game ended.');
        returnToHub();
        return;
      }
    } else if (ws._pid) {
      const p = players.get(ws._pid);
      if (p && p.ws === ws) { p.connected = false; p.ws = null; }
      if (phase === 'lobby' && lobby) {
        lobby.humans = lobby.humans.filter(pid => players.get(pid)?.connected);
        if (!lobby.humans.length) { returnToHub(); return; }
        if (!players.get(lobby.hostPid)?.connected) lobby.hostPid = lobby.humans[0];
      }
      // Drop fully-departed players that aren't part of a running game.
      if (phase === 'hub') players.delete(ws._pid);
    }
    broadcast();
  });
}

export function isIdle() { return phase === 'hub'; }

// Performance bench (POST /api/bench): runs a relay game on the TV with a
// synthetic seat and options.bench, so the real launch path is what gets
// measured. Only from an idle hub — it never interrupts anyone — and a
// watchdog brings the hub back if the TV never reports the end.
export function startBench(gameId, opts = {}) {
  const mod = byId(gameId);
  if (!mod || mod.meta.mode !== 'relay') return { err: 'not a relay game' };
  if (phase !== 'hub' || emulator.publicState()) return { err: 'busy — bench only runs from an idle hub' };
  if (!tvSockets.size) return { err: 'no TV connected' };
  const secs = Math.min(600, Math.max(10, Number(opts.secs) || 60));
  session = {
    gameId, mode: 'relay', options: { ...opts, bench: true, secs },
    seats: [{ name: 'Bench', bot: true, pid: null }], game: null, over: null, botTimers: new Map(),
  };
  phase = 'game';
  const s = session;
  setTimeout(() => { if (session === s) returnToHub(); }, (secs + 60) * 1000);
  broadcast();
  return { ok: true, secs };
}
export { broadcast as notifyClients };
