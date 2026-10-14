// End-to-end smoke test over a real WebSocket connection:
//   two phones + a TV join, play Crazy 8s to completion, and exercise
//   save & resume plus the controller (pad) player flow.
// Usage: PORT=8090 node scripts/e2e.js   (expects the server already running;
// start it with BOT_DELAY_MS=50 for a fast run — at the default human-feeling
// bot pace the pad game alone averages ~45s, which is also why the deadline
// below is generous: game length is random and long games are legitimate).
import WebSocket from 'ws';

const PORT = process.env.PORT || 8090;
const URL = `ws://127.0.0.1:${PORT}/ws`;

const deadline = setTimeout(() => { console.error('✗ e2e timed out'); process.exit(1); }, 180000);

function client(role, name) {
  const ws = new WebSocket(URL);
  const c = {
    ws, name, sync: null, seat: -1,
    send: m => ws.send(JSON.stringify(m)),
    handlers: [],
    onSync(fn) { this.handlers.push(fn); },
  };
  ws.on('open', () => c.send({ t: 'hello', role, name }));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'sync') {
      c.sync = m;
      c.seat = m.game?.yourSeat ?? -1;
      for (const fn of [...c.handlers]) fn(m);
    }
    if (m.t === 'input' && c.relayInput) c.relayInput(m);
  });
  return c;
}

const waitFor = (c, pred, label) => new Promise(res => {
  if (c.sync && pred(c.sync)) return res(c.sync);
  const fn = s => { if (pred(s)) { c.handlers.splice(c.handlers.indexOf(fn), 1); res(s); } };
  c.onSync(fn);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = label => { passed++; console.log(`✓ ${label}`); };

const alice = client('player', 'Alice');
const bob = client('player', 'Bob');
const tv = client('tv');

// A legal Crazy 8s move from a sync snapshot: play the first legal card
// (calling spades on an 8), else draw while allowed, else pass.
function crazy8sMove(pub, priv) {
  if (priv?.legal?.length) {
    const card = priv.legal[0];
    return card[0] === '8' ? { t: 'play', card, suit: 's' } : { t: 'play', card };
  }
  if (pub.drawn < pub.maxDraws && pub.deckCount > 0) return { t: 'draw' };
  return { t: 'pass' };
}

// Autoplay: whenever it's our turn in Crazy 8s, make a legal move (at
// human-ish pace so the save/quit step below happens mid-game, not after
// it already ended).
for (const c of [alice, bob]) {
  c.onSync(s => {
    if (s.phase === 'game' && s.game?.gameId === 'crazy8s'
      && s.game.awaiting?.includes(s.game.yourSeat)) {
      setTimeout(() => {
        const g = c.sync.game; // re-read: the state may have moved on
        if (c.sync.phase !== 'game' || !g.awaiting?.includes(g.yourSeat)) return;
        c.send({ t: 'act', a: crazy8sMove(g.pub, g.priv) });
      }, 250); // slow enough that even a lucky short game outlives the 500ms save test
    }
  });
}

await waitFor(alice, s => s.phase === 'hub', 'hub');
await waitFor(tv, s => s.phase === 'hub');
ok('all clients connected, hub visible');

alice.send({ t: 'openLobby', gameId: 'crazy8s' });
await waitFor(bob, s => s.phase === 'lobby');
bob.send({ t: 'joinLobby' });
await waitFor(alice, s => s.lobby?.seats.length === 2);
ok('lobby opened and joined');

alice.send({ t: 'start' });
await waitFor(alice, s => s.phase === 'game');
ok('game started');

// Let a few turns happen, then save & quit, then resume.
await sleep(500);
if (alice.sync.phase !== 'game') throw new Error('game ended before the save test could run');
alice.send({ t: 'quitGame' });
await waitFor(alice, s => s.phase === 'hub');
await sleep(600); // allow the debounced save to flush
alice.send({ t: 'resumeGame', gameId: 'crazy8s' });
const resumed = await waitFor(alice, s => s.phase === 'game');
if (resumed.game.gameId !== 'crazy8s') throw new Error('resume loaded wrong game');
ok('save & resume works');

await waitFor(alice, s => s.phase === 'gameover');
ok(`crazy 8s finished: ${alice.sync.game.over?.title}`);
alice.send({ t: 'backToHub' });
await waitFor(bob, s => s.phase === 'hub');
ok('back to hub');

// Gamepad-player flow: a Bluetooth controller (via the TV socket) claims a
// seat, opens a lobby, and plays a whole game with actions relayed by the TV.
tv.send({ t: 'padHello', pad: 0, name: 'PadOne' });
await waitFor(tv, s => s.pads && s.pads[0]);
ok('pad player joined via TV');
tv.send({ t: 'padMsg', pad: 0, m: { t: 'openLobby', gameId: 'crazy8s' } });
await waitFor(tv, s => s.phase === 'lobby');
tv.send({ t: 'padMsg', pad: 0, m: { t: 'start' } }); // bots fill the second seat
await waitFor(tv, s => s.phase === 'game' && s.pads[0].seat >= 0);
ok('pad player seated in game');
const padAuto = s => {
  if (s.phase === 'game' && s.game?.gameId === 'crazy8s' && s.pads?.[0]?.awaited) {
    setTimeout(() => {
      const cur = tv.sync;
      if (cur.phase !== 'game' || !cur.pads?.[0]?.awaited) return;
      tv.send({ t: 'padMsg', pad: 0, m: { t: 'act', a: crazy8sMove(cur.game.pub, cur.pads[0].priv) } });
    }, 40);
  }
};
tv.onSync(padAuto);
padAuto(tv.sync);
await waitFor(tv, s => s.phase === 'gameover');
ok('pad player finished a full game');
tv.send({ t: 'padMsg', pad: 0, m: { t: 'backToHub' } });
await waitFor(tv, s => s.phase === 'hub');
tv.send({ t: 'padBye', pad: 0 });
await waitFor(tv, s => !s.pads || !s.pads[0]);
ok('pad player left cleanly');

// Hearts with auto-filled bots should start straight away.
bob.send({ t: 'openLobby', gameId: 'hearts' });
await waitFor(bob, s => s.phase === 'lobby');
bob.send({ t: 'start' });
const hs = await waitFor(bob, s => s.phase === 'game');
if (hs.game.seats.filter(x => x.bot).length !== 3) throw new Error('bots not auto-filled');
ok('hearts auto-filled with 3 bots');
bob.send({ t: 'quitGame' });
await waitFor(bob, s => s.phase === 'hub');
bob.send({ t: 'deleteSave', gameId: 'hearts' });
bob.send({ t: 'deleteSave', gameId: 'crazy8s' });
ok('cleanup done');

// Dead of Night: a relay game the TV simulates. Registered on the hub,
// controller-hosted, no bots, quits straight to the hub, never benches
// over a running game; profiles round-trip and survive a corrupt file.
{
  const BASE = `http://127.0.0.1:${PORT}`;
  const don = tv.sync.games.find(g => g.id === 'deadofnight');
  if (!don || don.mode !== 'relay' || don.bots !== false || don.category !== 'action') {
    throw new Error('Dead of Night missing from the catalog: ' + JSON.stringify(don));
  }
  ok('Dead of Night listed on the hub (relay, action, no bots)');
  tv.send({ t: 'padHello', pad: 1, name: 'Survivor' });
  await waitFor(tv, s => s.pads?.[1]);
  tv.send({ t: 'padMsg', pad: 1, m: { t: 'openLobby', gameId: 'deadofnight' } });
  await waitFor(tv, s => s.phase === 'lobby');
  tv.send({ t: 'padMsg', pad: 1, m: { t: 'addBot' } });
  await sleep(150);
  if (tv.sync.lobby.seats.length !== 1) throw new Error('a bot joined Dead of Night');
  tv.send({ t: 'padMsg', pad: 1, m: { t: 'start' } });
  const g = await waitFor(tv, s => s.phase === 'game');
  if (g.game.mode !== 'relay' || g.pads[1].seat !== 0) throw new Error('Dead of Night did not seat the pad');
  const busy = await fetch(`${BASE}/api/bench`, { method: 'POST' });
  if (busy.status !== 409) throw new Error('bench was allowed over a running game');
  tv.send({ t: 'relayQuit' });
  await waitFor(tv, s => s.phase === 'hub');
  ok('Dead of Night: pad hosts, no bots, bench refused mid-game, quits to hub');

  const bench = await (await fetch(`${BASE}/api/bench?secs=10`, { method: 'POST' })).json();
  if (!bench.ok) throw new Error('bench refused at an idle hub: ' + bench.err);
  await waitFor(tv, s => s.phase === 'game' && s.game.options?.bench);
  tv.send({ t: 'relayEnd', result: { title: 'Benchmark finished' } });
  await waitFor(tv, s => s.phase === 'hub');
  ok('bench session starts from an idle hub and ends straight back at it');
  tv.send({ t: 'padBye', pad: 1 });

  const url = `${BASE}/api/profiles/deadofnight/e2e-test`;
  const put = v => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v }) });
  await put(1); await put(2);
  const got = await (await fetch(url)).json();
  if (got.v !== 2) throw new Error('profile round-trip failed');
  // Corrupt the main file (the e2e runs from the server's own tree): the
  // previous good copy must come back.
  const { default: fs } = await import('fs');
  const { fileURLToPath } = await import('url');
  const file = fileURLToPath(new globalThis.URL('../data/profiles/deadofnight/e2e-test.json', import.meta.url));
  if (fs.existsSync(file)) {
    fs.writeFileSync(file, '{"v": 3, trunc');
    const back = await (await fetch(url)).json();
    if (back.v !== 1) throw new Error('corrupt profile did not fall back to .bak (got ' + JSON.stringify(back) + ')');
    fs.rmSync(file); fs.rmSync(file + '.bak');
    ok('profiles round-trip; a corrupt file falls back to its .bak');
  } else {
    ok('profiles round-trip (corruption check skipped: server runs from another tree)');
  }
  if ((await fetch(`${BASE}/api/profiles/hearts/x`)).status !== 404) throw new Error('profiles open to non-relay games');

  // Co-op across two screens: one player per TV, the host's TV simulates,
  // a screen may only drive its own seat, and only the host may publish.
  const tv2 = client('tv');
  const relayed = { tv: [], tv2: [] };
  tv.ws.on('message', raw => { const m = JSON.parse(raw); if (m.t?.startsWith('relay')) relayed.tv.push(m); });
  tv2.ws.on('message', raw => { const m = JSON.parse(raw); if (m.t?.startsWith('relay')) relayed.tv2.push(m); });
  await waitFor(tv2, s => s.phase === 'hub');
  tv.send({ t: 'padHello', pad: 0, name: 'Hostie' });
  tv2.send({ t: 'padHello', pad: 0, name: 'Guest' });
  tv.send({ t: 'padHello', pad: 1, name: 'Couch' });
  await waitFor(tv, s => s.pads?.[0] && s.pads?.[1]);
  await waitFor(tv2, s => s.pads?.[0]);
  tv.send({ t: 'padMsg', pad: 0, m: { t: 'openLobby', gameId: 'deadofnight' } });
  await waitFor(tv, s => s.phase === 'lobby');
  tv2.send({ t: 'padMsg', pad: 0, m: { t: 'joinLobby' } });
  tv.send({ t: 'padMsg', pad: 1, m: { t: 'joinLobby' } });
  await waitFor(tv, s => s.lobby?.seats.length === 2);
  await sleep(150);
  if (tv.sync.lobby.seats.length !== 2) throw new Error('a second pad on the same screen joined');
  tv.send({ t: 'padMsg', pad: 0, m: { t: 'start' } });
  const g1 = await waitFor(tv, s => s.phase === 'game');
  const g2 = await waitFor(tv2, s => s.phase === 'game');
  if (g1.game.sim !== true || g2.game.sim !== false) throw new Error(`sim flags wrong: host ${g1.game.sim}, guest ${g2.game.sim}`);
  const guestSeat = g2.pads[0].seat;
  tv2.send({ t: 'relayInput', seat: guestSeat, d: { i: 1 } });
  tv2.send({ t: 'relayInput', seat: 1 - guestSeat, d: { i: 99 } });  // not theirs
  tv2.send({ t: 'relayState', d: { forged: true } });                // not the host
  tv.send({ t: 'relayState', d: { t: 1 } });
  await sleep(250);
  if (!relayed.tv.some(m => m.t === 'relayInput' && m.seat === guestSeat && m.d.i === 1)) throw new Error('guest input not relayed to the host');
  if (relayed.tv.some(m => m.d?.i === 99)) throw new Error('a screen drove someone else\'s seat');
  if (relayed.tv.some(m => m.t === 'relayState')) throw new Error('a guest published a snapshot');
  if (!relayed.tv2.some(m => m.t === 'relayState' && m.d.t === 1)) throw new Error('host snapshot not relayed');
  tv.send({ t: 'relayQuit' });
  await waitFor(tv2, s => s.phase === 'hub');
  for (const p of [0, 1]) tv.send({ t: 'padBye', pad: p });
  tv2.send({ t: 'padBye', pad: 0 });
  tv2.ws.close();
  ok('co-op relay: one player per screen, host simulates, seats are owner-only, only the host publishes');
}

// Cabinet (RetroArch) flow — runs only when the server sees an emulator
// setup (real, or the fake one the test harness fabricates via env vars).
if (alice.sync.emu?.available) {
  // ROM upload API: extension routing, override, listing, delete, and the
  // scp "incoming" folder sorter.
  const base = `http://127.0.0.1:${PORT}`;
  const romsDir = process.env.ROMS_DIR;
  const upload = (name, system = 'auto', body = 'fake-rom-bytes') =>
    fetch(`${base}/api/roms?name=${encodeURIComponent(name)}&system=${system}`,
      { method: 'POST', body });

  // Build a real (stored or deflated) zip for content-probing tests.
  const zipOf = (inner, data, method = 0, rawLen = data.length) => {
    const nameBuf = Buffer.from(inner);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(rawLen, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(rawLen, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + nameBuf.length, 12);
    eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
    return Buffer.concat([lfh, nameBuf, data, cdh, nameBuf, eocd]);
  };

  let r = await (await upload('Super Test (USA).sfc')).json();
  if (r.system !== 'snes') throw new Error('.sfc did not route to snes: ' + JSON.stringify(r));
  r = await (await upload('coinop.zip', 'auto', zipOf('coinop.rom', Buffer.from('ARCADEROM')))).json();
  if (r.system !== 'arcade') throw new Error('real arcade-looking zip did not route to arcade: ' + JSON.stringify(r));
  r = await (await upload('junk.zip')).json(); // not actually a zip
  if (!r.err || !r.err.includes("isn't actually a zip")) {
    throw new Error('non-zip .zip should be rejected: ' + JSON.stringify(r));
  }
  r = await (await upload('console game.zip', 'snes')).json();
  if (r.system !== 'snes') throw new Error('explicit system override ignored');
  // A stale client may claim "arcade" for a console zip — the probe wins.
  r = await (await upload('Stale Page.zip', 'arcade', zipOf('Stale Page.gbc', Buffer.from('GBCDATA')))).json();
  if (r.system !== 'gbc' || r.file !== 'Stale Page.gbc') {
    throw new Error('probe should override stale explicit system: ' + JSON.stringify(r));
  }
  r = await (await upload('mystery.xyz')).json();
  if (!r.err) throw new Error('unknown extension should be rejected');
  const lib = await (await fetch(`${base}/api/roms`)).json();
  const snes = lib.systems.find(s => s.id === 'snes');
  if (!snes || !snes.files.some(f => f.file === 'Super Test (USA).sfc')) {
    throw new Error('uploaded ROM missing from library listing');
  }
  ok('ROM upload routes by extension (override + rejects unknowns)');

  // Zipped console games get sniffed by their contents and UNPACKED into
  // the right system, instead of being dumped whole into arcade.
  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('Monopoly Test.zip')}&system=auto`,
    { method: 'POST', body: zipOf('Monopoly Test.gb', Buffer.from('GBDATA')) })).json();
  if (r.system !== 'gb' || r.file !== 'Monopoly Test.gb') {
    throw new Error('stored zip was not unpacked to gb: ' + JSON.stringify(r));
  }
  ok('zipped console ROM unpacked by contents (.gb inside → gb/)');

  const { deflateRawSync } = await import('zlib');
  const chdRaw = Buffer.from('FAKE-CHD-DISC-IMAGE-BYTES-0123456789');
  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('Blitz Test.zip')}&system=auto`,
    { method: 'POST', body: zipOf('Blitz Test.chd', deflateRawSync(chdRaw), 8, chdRaw.length) })).json();
  if (r.system !== 'psx' || r.file !== 'Blitz Test.chd') {
    throw new Error('deflated chd zip was not unpacked to psx: ' + JSON.stringify(r));
  }
  const { default: fsChk } = await import('fs');
  const { default: pathChk } = await import('path');
  if (process.env.ROMS_DIR) {
    const extractedBytes = fsChk.readFileSync(pathChk.join(process.env.ROMS_DIR, 'psx', 'Blitz Test.chd'));
    if (!extractedBytes.equals(chdRaw)) throw new Error('deflated chd bytes corrupted on extraction');
  }
  ok('zipped PS1 .chd unpacked with correct bytes (deflate)');

  // PS1 cue+bin discs: a bare .bin defaults to Genesis, but once its cue
  // sheet is in psx/ the tracks must follow it — including one that was
  // uploaded (and misfiled) BEFORE the cue arrived.
  r = await (await upload('Blitz Disc (USA) (Track 1).bin')).json();
  if (r.system !== 'megadrive') throw new Error('.bin without a cue should default to megadrive: ' + JSON.stringify(r));
  const cueText = 'FILE "Blitz Disc (USA) (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n'
    + 'FILE "Blitz Disc (USA) (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n';
  r = await (await upload('Blitz Disc (USA).cue', 'auto', cueText)).json();
  if (r.system !== 'psx') throw new Error('.cue did not route to psx: ' + JSON.stringify(r));
  r = await (await upload('Blitz Disc (USA) (Track 2).bin')).json();
  if (r.system !== 'psx') throw new Error('.bin named by an existing cue should route to psx: ' + JSON.stringify(r));
  if (romsDir) {
    const { default: fsCue } = await import('fs');
    const { default: pathCue } = await import('path');
    if (!fsCue.existsSync(pathCue.join(romsDir, 'psx', 'Blitz Disc (USA) (Track 1).bin'))) {
      throw new Error('cue arrival did not pull the misfiled track out of megadrive/');
    }
    if (fsCue.existsSync(pathCue.join(romsDir, 'megadrive', 'Blitz Disc (USA) (Track 1).bin'))) {
      throw new Error('misfiled track still present in megadrive/');
    }
  }
  ok('PS1 cue+bin discs stay together (cue rescues misfiled tracks)');

  // New systems route by extension.
  r = await (await upload('Sonic Test (USA).sms')).json();
  if (r.system !== 'mastersystem') throw new Error('.sms did not route to mastersystem: ' + JSON.stringify(r));
  r = await (await upload('Bonk Test (USA).pce')).json();
  if (r.system !== 'pcengine') throw new Error('.pce did not route to pcengine: ' + JSON.stringify(r));
  ok('Master System and TurboGrafx route by extension');

  // Arcade boards route by what's inside the zip: CPS-2 sets carry a QSound
  // .key, CPS-3 games are SIMM dumps, Neo Geo chunks use .p1/.c1/… names.
  // An explicit shelf choice beats the guess, and neogeo.zip is the BIOS.
  const multiZip = files => { // [[name, data], …] — stored entries only
    const parts = [], cds = [];
    let off = 0;
    for (const [nm, raw] of files) {
      const nameBuf = Buffer.from(nm), data = Buffer.from(raw);
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4);
      lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      parts.push(lfh, nameBuf, data);
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 6);
      cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(data.length, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt32LE(off, 42);
      cds.push(Buffer.concat([cdh, nameBuf]));
      off += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(cds);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, eocd]);
  };
  r = await (await upload('mvsc test.zip', 'auto', zipOf('mvsc.key', Buffer.from('QSOUNDKEY')))).json();
  if (r.system !== 'cps2') throw new Error('.key zip did not route to cps2: ' + JSON.stringify(r));
  r = await (await upload('sfiii3 test.zip', 'auto', zipOf('sfiii3-simm1.0', Buffer.from('SIMMDATA')))).json();
  if (r.system !== 'cps3') throw new Error('simm zip did not route to cps3: ' + JSON.stringify(r));
  r = await (await upload('mslug test.zip', 'auto',
    multiZip([['201-p1.p1', 'P'], ['201-c1.c1', 'C'], ['201-v1.v1', 'V']]))).json();
  if (r.system !== 'neogeo') throw new Error('Neo Geo chunk zip did not route to neogeo: ' + JSON.stringify(r));
  r = await (await upload('neogeo.zip', 'auto', zipOf('sp-s2.sp1', Buffer.from('NEOBIOS')))).json();
  if (r.system !== 'neogeo') throw new Error('neogeo.zip (BIOS) did not route to neogeo: ' + JSON.stringify(r));
  r = await (await upload('forced.zip', 'arcade', zipOf('mvsc.key', Buffer.from('QSOUNDKEY')))).json();
  if (r.system !== 'arcade') throw new Error('explicit shelf choice should beat the board sniff: ' + JSON.stringify(r));
  ok('arcade zips route by board fingerprint (CPS-2/3, Neo Geo; explicit wins)');

  // Manual move: relocates a filed ROM when the router guessed wrong.
  r = await (await fetch(`${base}/api/roms/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'arcade', to: 'mame2010', file: 'forced.zip' }),
  })).json();
  if (!r.ok || r.system !== 'mame2010') throw new Error('move API failed: ' + JSON.stringify(r));
  const libMv = await (await fetch(`${base}/api/roms`)).json();
  if (!libMv.systems.find(s => s.id === 'mame2010').files.some(f => f.file === 'forced.zip')
    || libMv.systems.find(s => s.id === 'arcade').files.some(f => f.file === 'forced.zip')) {
    throw new Error('moved ROM not in mame2010/ (or still in arcade/)');
  }
  ok('manual move relocates a ROM between shelves');

  // PS1 .iso dumps: routed bare, and unpacked out of zips.
  r = await (await upload('Blitz Port (USA).iso')).json();
  if (r.system !== 'psx') throw new Error('.iso did not route to psx: ' + JSON.stringify(r));
  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('Zipped ISO.zip')}&system=auto`,
    { method: 'POST', body: zipOf('Zipped ISO.iso', Buffer.from('FAKE-ISO-BYTES')) })).json();
  if (r.system !== 'psx' || r.file !== 'Zipped ISO.iso') {
    throw new Error('zipped .iso was not unpacked to psx: ' + JSON.stringify(r));
  }
  ok('PS1 .iso routed to psx (bare + zipped)');

  // PSP shares '.iso' with PS1 — the PSP_GAME marker inside decides. '.cso'
  // is PSP-only, and a zipped PSP iso must land in psp/ after extraction.
  r = await (await upload('Ridge Test (USA).iso', 'auto', 'ISO9660-junk PSP_GAME more-junk')).json();
  if (r.system !== 'psp') throw new Error('.iso with PSP_GAME did not route to psp: ' + JSON.stringify(r));
  r = await (await upload('Ridge Test (USA).cso')).json();
  if (r.system !== 'psp') throw new Error('.cso did not route to psp: ' + JSON.stringify(r));
  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('Zipped PSP.zip')}&system=auto`,
    { method: 'POST', body: zipOf('Zipped PSP.iso', Buffer.from('junk PSP_GAME junk')) })).json();
  if (r.system !== 'psp' || r.file !== 'Zipped PSP.iso') {
    throw new Error('zipped PSP iso was not unpacked to psp: ' + JSON.stringify(r));
  }
  ok('PSP discs route to psp (bare .iso by contents, .cso, zipped)');

  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('Catan Test.zip')}&system=auto`,
    { method: 'POST', body: zipOf('Catan Test.nds', Buffer.from('NDSDATA')) })).json();
  if (!r.err || !r.err.includes('Nintendo DS')) {
    throw new Error('DS zip should be rejected with a clear reason: ' + JSON.stringify(r));
  }
  ok('unsupported-console zip rejected with named reason (DS)');

  // BIOS dumps route to RetroPie/BIOS by canonical name — bare or zipped.
  r = await (await upload('scph1001.bin')).json();
  if (r.system !== 'bios') throw new Error('BIOS file not routed to BIOS: ' + JSON.stringify(r));
  r = await (await fetch(`${base}/api/roms?name=${encodeURIComponent('ps1bios.zip')}&system=auto`,
    { method: 'POST', body: zipOf('scph5501.bin', Buffer.from('BIOSDATA')) })).json();
  if (r.system !== 'bios' || r.file !== 'scph5501.bin') {
    throw new Error('zipped BIOS not unpacked to BIOS: ' + JSON.stringify(r));
  }
  if (romsDir) {
    const { default: fsB } = await import('fs');
    const { default: pathB } = await import('path');
    for (const f of ['scph1001.bin', 'scph5501.bin']) {
      if (!fsB.existsSync(pathB.join(romsDir, '..', 'BIOS', f))) {
        throw new Error(`BIOS/${f} missing on disk`);
      }
    }
  }
  ok('PS1 BIOS files land in RetroPie/BIOS (bare + zipped)');

  if (romsDir) {
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const inc = path.join(romsDir, 'incoming');
    fs.mkdirSync(inc, { recursive: true });
    fs.writeFileSync(path.join(inc, 'Dropped Game.nes'), 'fake-nes');
    fs.writeFileSync(path.join(inc, 'Dropped UMD.iso'), 'iso-junk PSP_GAME iso-junk');
    fs.writeFileSync(path.join(inc, 'Dropped CPS2.zip'), zipOf('dropped.key', Buffer.from('QSOUNDKEY')));
    const deadline2 = Date.now() + 15000;
    let sorted = false;
    while (Date.now() < deadline2) {
      if (fs.existsSync(path.join(romsDir, 'nes', 'Dropped Game.nes'))
        && fs.existsSync(path.join(romsDir, 'psp', 'Dropped UMD.iso'))
        && fs.existsSync(path.join(romsDir, 'cps2', 'Dropped CPS2.zip'))) { sorted = true; break; }
      await sleep(200);
    }
    if (!sorted) throw new Error('incoming/ files were not sorted into nes/, psp/ and cps2/');
    ok('scp incoming folder sorts ROMs automatically (PSP iso + CPS-2 zip by contents)');
  }

  for (const [sys, file] of [['snes', 'Super Test (USA).sfc'], ['arcade', 'coinop.zip'],
                             ['snes', 'console game.zip'], ['nes', 'Dropped Game.nes'],
                             ['gb', 'Monopoly Test.gb'], ['psx', 'Blitz Test.chd'],
                             ['psx', 'Blitz Port (USA).iso'], ['psx', 'Zipped ISO.iso'],
                             ['psx', 'Blitz Disc (USA).cue'], ['psx', 'Blitz Disc (USA) (Track 1).bin'],
                             ['psx', 'Blitz Disc (USA) (Track 2).bin'],
                             ['mastersystem', 'Sonic Test (USA).sms'], ['pcengine', 'Bonk Test (USA).pce'],
                             ['gbc', 'Stale Page.gbc'], ['psp', 'Ridge Test (USA).iso'],
                             ['psp', 'Ridge Test (USA).cso'], ['psp', 'Zipped PSP.iso'],
                             ['psp', 'Dropped UMD.iso'],
                             ['cps2', 'mvsc test.zip'], ['cps3', 'sfiii3 test.zip'],
                             ['neogeo', 'mslug test.zip'], ['neogeo', 'neogeo.zip'],
                             ['mame2010', 'forced.zip'], ['cps2', 'Dropped CPS2.zip']]) {
    await fetch(`${base}/api/roms/${sys}/${encodeURIComponent(file)}`, { method: 'DELETE' });
  }
  const lib2 = await (await fetch(`${base}/api/roms`)).json();
  if (lib2.systems.some(s => s.files.some(f => f.file.includes('Super Test')))) {
    throw new Error('delete did not remove the ROM');
  }
  ok('ROM delete works');

  const sys = alice.sync.emu.systems[0];
  alice.send({ t: 'emuLaunch', system: sys.id, file: sys.games[0].file });
  await waitFor(alice, s => !!s.emulator);
  ok(`emulator launched: ${alice.sync.emulator.title}`);
  alice.send({ t: 'openLobby', gameId: 'hearts' });
  await sleep(300);
  if (alice.sync.phase !== 'hub' || !alice.sync.emulator) throw new Error('lobby opened during emulator!');
  ok('game launches blocked while the cabinet is running');
  alice.send({ t: 'emuKill' });
  await waitFor(alice, s => !s.emulator);
  ok('emulator force-quit returns control to the hub');
} else {
  console.log('· cabinet checks skipped (no emulator configured)');
}

console.log(`\nAll ${passed} e2e checks passed.`);
clearTimeout(deadline);
process.exit(0);
