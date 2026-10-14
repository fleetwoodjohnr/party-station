// Party Station — local party game server.
// Serves the player app (/) and TV app (/tv), and speaks WebSocket to both.
import { execFile } from 'child_process';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { handleConnection, isIdle, notifyClients, startBench } from './lobby.js';
import { byId } from './registry.js';
import * as saves from './saves.js';
import * as perf from './perf.js';
import { getArt } from './art.js';
import { defaultAudioToHdmi } from './audio.js';
import * as emulator from './emulator.js';
import { romsRouter, startIncomingSorter } from './roms.js';
import { settingsRouter } from './settings.js';
import * as hostinfo from './hostinfo.js';
import * as sysctl from './sysctl.js';
import * as updater from './updater.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.get('/tv', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'tv.html')));
app.get('/roms', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'roms.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'settings.html')));
// Warm the box-art cache while there's likely internet (at boot and the
// moment a ROM arrives) so covers are on disk before an offline party.
// getArt dedupes and fails soft, so firing for the whole library is cheap.
function prefetchArt() {
  for (const s of emulator.scan()) {
    for (const g of s.games) getArt(s.id, g.file);
  }
}

app.use('/api/roms', romsRouter({
  onChange: () => { emulator.scan(true); notifyClients(); prefetchArt(); },
}));
// Wi-Fi and display settings, reachable from the phone (/settings) and from
// the TV's own on-screen menu. See server/settings.js for the access rules.
app.use('/api/settings', settingsRouter({ onChange: () => notifyClients() }));
// Box art for the retro hub: cached cover, or fetched on first browse
// (see server/art.js). 404 = no cover known; the TV shows an icon instead.
app.get('/api/art/:system/:file', async (req, res) => {
  const p = await getArt(req.params.system, req.params.file).catch(() => null);
  if (p) res.sendFile(p);
  else res.status(404).set('Cache-Control', 'no-store').json({ ok: false });
});
// Ctrl+Alt+Q on the TV (attached keyboard) lands here: flag the kiosk
// launcher (scripts/kiosk.sh watches for this file) to close Chromium and
// stop relaunching, dropping to the Pi desktop for troubleshooting.
app.post('/api/kiosk/exit', (_req, res) => {
  const dir = path.join(os.homedir(), '.config', 'party-station-kiosk');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stop'), new Date().toISOString());
    console.log('kiosk: exit requested from the TV keyboard');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});
// Kill the kiosk's Chromium (the kiosk loop restarts it in seconds with a
// fresh page load) — recovery for a TV stuck on stale UI code.
app.post('/api/tv/reload', (_req, res) => {
  execFile('pkill', ['-f', 'user-data-dir=.*party-station-kiosk'], () => res.json({ ok: true }));
});
// Long-lived per-game data for real-time games (settings, progression,
// world saves). Kept beside the turn-based saves in data/, which survives
// self-updates; a .bak of the previous copy guards against corruption.
const relayGame = (req, res, next) => (byId(req.params.game)?.meta.mode === 'relay'
  ? next() : res.status(404).json({ ok: false, err: 'unknown game' }));
app.get('/api/profiles/:game', relayGame, (req, res) => res.json({ keys: saves.listProfiles(req.params.game) }));
app.get('/api/profiles/:game/:key', relayGame, (req, res) => {
  const d = saves.loadProfile(req.params.game, req.params.key);
  if (d) res.set('Cache-Control', 'no-store').json(d);
  else res.status(404).set('Cache-Control', 'no-store').json({ ok: false });
});
app.put('/api/profiles/:game/:key', relayGame, express.json({ limit: '4mb' }), (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false });
  try {
    saves.saveProfile(req.params.game, req.params.key, req.body);
    res.json({ ok: true });
  } catch (e) {
    console.error('profile save failed', req.params.game, req.params.key, e.message);
    res.status(500).json({ ok: false, err: e.message });
  }
});
// Frame-time beacons from the TV's renderer, joined with what the Pi itself
// says (free RAM, swap, kiosk memory, SoC temperature) — readable remotely
// at /api/status, so a bench can be judged without standing at the TV.
app.post('/api/perf', express.json({ limit: '64kb' }), (req, res) => {
  perf.record(req.body || {});
  res.json({ ok: true });
});
// Kick off a scripted benchmark run on the TV (idle hub only). Query keys
// are passed to the game as options: secs, preset, scene, zombies.
app.post('/api/bench', (req, res) => {
  const opts = {};
  for (const k of ['secs', 'preset', 'scene', 'zombies']) {
    if (req.query[k] != null) opts[k] = String(req.query[k]).slice(0, 24);
  }
  const r = startBench(String(req.query.game || 'deadofnight'), opts);
  if (r.err) res.status(409).json({ ok: false, err: r.err });
  else { perf.resetRun(); res.json(r); }
});
app.get('/api/status', (_req, res) => res.json({
  ok: true,
  version: updater.status.version,
  updateAvailable: updater.status.updateAvailable,
  updating: updater.status.updating,
  lastCheck: updater.status.lastCheck ? new Date(updater.status.lastCheck).toISOString() : null,
  updateError: updater.status.error,
  emulatorLastExit: emulator.lastExitInfo(),
  perf: perf.summary(),
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => handleConnection(ws));

// Keepalive: terminate dead sockets so seats free up promptly.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true;
    ws.ping();
  }
}, 30000);
wss.on('connection', ws => {
  ws._dead = false;
  ws.on('pong', () => { ws._dead = false; });
  ws.on('message', () => { ws._dead = false; });
});

server.listen(PORT, () => {
  // Same addresses the TV shows guests (see server/hostinfo.js) — on a dev
  // box this prints the name that will actually resolve, since only the Pi is
  // named "party-station" (scripts/dev-mdns.sh can alias it for testing).
  const { host, ips } = hostinfo.addresses(true);
  const port = PORT === 80 ? '' : ':' + PORT;
  console.log(`Party Station on port ${PORT}`);
  console.log(`  Players: http://${host}${port}`);
  for (const ip of ips) console.log(`  (or http://${ip}${port})`);
  console.log(`  TV:      add /tv to either URL`);
});

updater.init({ isIdle, onStatusChange: notifyClients });
sysctl.init(); // warm the display-mode cache before anyone launches a game
startIncomingSorter({ onChange: () => { emulator.scan(true); notifyClients(); prefetchArt(); } });
defaultAudioToHdmi();
setTimeout(prefetchArt, 5000); // after boot, once the network is up
