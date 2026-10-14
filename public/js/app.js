// Player app shell: join → hub → lobby → game → game over.
import { connect } from './net.js';
import { h, mount, toast, sheet, chipEl } from './ui.js';

const root = document.getElementById('app');
let sync = null;
let scratchKey = null;
let scratch = {};           // per-game-session module scratch space
const modules = {};         // gameId -> loaded client module
let padActive = false;
let hubMode = null;         // landing choice: 'party' | 'retro' (asked once per visit)
let tableView = localStorage.getItem('ps-tableview') === '1'; // mini TV table in games

// After a self-update the server restarts with new client code; reload
// idle phones so they don't keep driving it with the old bundle.
let loadedVersion = null;
function reloadOnNewVersion(s) {
  if (!s.version) return;
  if (loadedVersion === null) loadedVersion = s.version;
  else if (s.version !== loadedVersion && s.phase === 'hub' && !s.emulator) location.reload();
}

const net = connect({
  role: 'player',
  onSync: s => { sync = s; reloadOnNewVersion(s); render(); },
  onMsg: m => {
    if (m.t === 'toast') toast(m.text);
    if (m.t === 'nope') toast(m.text, true);
  },
});

async function loadModule(id) {
  if (!modules[id]) {
    try { modules[id] = await import(`./games/${id}.js`); }
    catch (e) { console.error('module load failed', id, e); modules[id] = { error: true }; }
    render();
  }
  return modules[id];
}

// ---------------------------------------------------------------- screens

function joinScreen() {
  const stored = localStorage.getItem('ps-name') || '';
  const input = h('input', {
    class: 'field', value: stored, maxlength: 16,
    placeholder: 'Your name', autocomplete: 'off',
  });
  const go = () => {
    const name = input.value.trim();
    if (!name) { toast('Pick a name first', true); return; }
    localStorage.setItem('ps-name', name);
    localStorage.setItem('ps-named', '1');
    net.send({ t: 'setName', name });
    render();
  };
  return h('div', { class: 'screen stack', style: 'justify-content:center;min-height:100vh;padding-bottom:40px;' },
    wordmark(),
    h('p', { class: 'center dim', style: 'margin:8px 0 20px' }, 'Who’s playing?'),
    input,
    h('button', { class: 'tok primary big', onclick: go }, 'Let’s play →'),
  );
}

function wordmark() {
  const letters = 'PARTY STATION'.split('');
  return h('div', { class: 'wordmark' }, letters.map(ch =>
    ch === ' ' ? h('span', { class: 'gap' }) : h('span', {}, ch)));
}

// Landing prompt: retro games on the emulator, or Party Station's own games?
function chooseScreen() {
  const emuGames = (sync.emu?.systems || []).reduce((n, s) => n + s.games.length, 0);
  return h('div', { class: 'screen stack', style: 'justify-content:center;min-height:100vh;padding-bottom:40px' },
    wordmark(),
    h('p', { class: 'center dim', style: 'margin:8px 0 20px' }, 'What are we playing?'),
    h('button', {
      class: 'game-tile cat-cards', style: 'flex:1;min-height:150px;justify-content:center',
      onclick: () => { hubMode = 'party'; render(); },
    },
      h('span', { class: 'g-icon' }, '🃏'),
      h('span', { class: 'g-name' }, 'Party Games'),
      h('span', { class: 'g-sub' }, 'Card games — phones and controllers')),
    h('button', {
      class: 'game-tile cat-arcade', style: 'flex:1;min-height:150px;justify-content:center',
      onclick: () => { hubMode = 'retro'; render(); },
    },
      h('span', { class: 'g-icon' }, '🕹️'),
      h('span', { class: 'g-name' }, 'Retro Games'),
      h('span', { class: 'g-sub' }, sync.emu?.available
        ? `${emuGames} classics on the emulator`
        : 'Real classics — add your ROMs')),
  );
}

function hubTopbar(title) {
  return h('div', { class: 'topbar' },
    h('div', {},
      h('div', { class: 'eyebrow' }, 'Party Station'),
      h('h1', {}, title),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'tok small ghost', onclick: () => { hubMode = null; render(); } }, '⇄'),
      h('button', { class: 'tok small', onclick: settingsSheet, 'aria-label': 'Settings' }, '⚙️ ' + (sync.you?.name || '')),
    ),
  );
}

function hubScreen() {
  if (hubMode === 'retro') return retroScreen();
  const games = sync.games;
  return h('div', { class: 'screen', style: 'display:flex;flex-direction:column;min-height:100vh;padding-bottom:24px' },
    hubTopbar('Pick a game'),
    sync.tvCount === 0 && h('div', { class: 'banner', style: 'margin-bottom:12px;font-size:13px;' },
      '📺 No big screen yet — open ', h('b', {}, location.host + '/tv'), ' on the TV for the full experience.'),
    h('div', { class: 'game-grid', style: 'flex:1;grid-auto-rows:1fr;align-content:stretch' }, games.map(g => {
      const save = sync.saves[g.id];
      return h('button', { class: `game-tile cat-${g.category}`, onclick: () => gameSheet(g, save) },
        save && h('span', { class: 'g-save' }, 'SAVED'),
        h('span', { class: 'g-icon' }, g.icon),
        h('span', { class: 'g-name' }, g.name),
        h('span', { class: 'g-sub' }, `${g.minPlayers === g.maxPlayers ? g.minPlayers : g.minPlayers + '–' + g.maxPlayers} players`),
        h('span', { class: 'g-sub' }, g.tagline),
      );
    })),
    h('div', { class: 'divider' }),
    h('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, `Here now (${sync.players.length})`),
    h('div', { class: 'row wrap' }, sync.players.map(p => chipEl(p))),
  );
}

function retroScreen() {
  return h('div', { class: 'screen' },
    hubTopbar('Retro games'),
    sync.emu?.available
      ? cabinetGrid()
      : h('div', { class: 'stack', style: 'margin-top:10px' },
        h('div', { style: 'font-size:56px;text-align:center' }, '🕹️'),
        h('p', { class: 'center dim' }, 'No retro games yet.'),
        h('p', { class: 'dim', style: 'font-size:14px' },
          'Add ROMs of games you own from any laptop or phone at ',
          h('b', {}, location.host + '/roms'), ' — they appear here within a moment.'),
        h('a', { class: 'tok primary big', style: 'text-align:center', href: '/roms' }, '⬆️ Add ROMs'),
        h('p', { class: 'dim', style: 'font-size:13px' },
          'If the emulator itself is missing, re-run the setup script on the Pi — it installs RetroArch automatically.')),
  );
}

function cabinetGrid() {
  return h('div', { class: 'stack' },
    (sync.emu?.systems || []).map(s => h('div', {},
      h('div', { class: 'eyebrow', style: 'margin:6px 0 8px' }, `${s.icon} ${s.name}`),
      h('div', { class: 'game-grid' }, s.games.map(g =>
        h('button', {
          class: 'game-tile cat-arcade', style: 'min-height:0',
          onclick: () => {
            const sheet2 = sheet(`${s.icon} ${g.title}`,
              h('p', { class: 'dim', style: 'margin-bottom:14px' },
                `Launches in the emulator on the TV. Exit there (Select+Start) to come back to Party Station.`),
              h('button', {
                class: 'tok primary big',
                onclick: () => { net.send({ t: 'emuLaunch', system: s.id, file: g.file }); sheet2.remove(); },
              }, '▶ Play on the big screen'));
          },
        },
          h('span', { class: 'g-icon', style: 'font-size:24px' }, s.icon),
          h('span', { class: 'g-name', style: 'font-size:14px' }, g.title)))),
    )),
    h('p', { class: 'dim', style: 'font-size:12px;margin-top:10px' },
      'Add ROMs of games you own at ', h('b', {}, location.host + '/roms'),
      ' (or scp them into ~/RetroPie/roms/incoming) — they show up here within a moment.'),
  );
}

function emulatorScreen() {
  const e = sync.emulator;
  return h('div', { class: 'screen stack center', style: 'padding-top:22vh' },
    h('div', { style: 'font-size:64px' }, e.icon || '🕹️'),
    h('h1', {}, e.title),
    h('p', { class: 'dim' }, `Running in the ${e.system} emulator on the big screen.`),
    e.system?.startsWith('Arcade') && h('p', { class: 'dim', style: 'font-size:13px' },
      '🪙 Arcade rules: tap Select on the controller to insert a coin, then press Start.'),
    h('p', { class: 'dim', style: 'font-size:13px' }, 'Exit in the emulator (hold Select, press Start) to return to Party Station.'),
    h('div', { class: 'actionbar' },
      h('button', {
        class: 'tok danger', onclick: () => {
          const s = sheet('Force-quit the emulator?',
            h('p', { class: 'dim', style: 'margin-bottom:12px' }, 'Unsaved emulator progress will be lost.'),
            h('div', { class: 'row' },
              h('button', { class: 'tok ghost grow', onclick: () => s.remove() }, 'Never mind'),
              h('button', { class: 'tok danger grow', onclick: () => { net.send({ t: 'emuKill' }); s.remove(); } }, 'Force quit')));
        },
      }, '⛔ Force quit')),
  );
}

function gameSheet(g, save) {
  const s = sheet(`${g.icon} ${g.name}`,
    h('p', { class: 'dim', style: 'margin-bottom:16px' }, g.tagline),
    save && h('div', { class: 'banner', style: 'margin-bottom:12px' },
      `💾 Saved game with ${save.seats.map(x => x.name).join(', ')}`,
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'tok good grow', onclick: () => { net.send({ t: 'resumeGame', gameId: g.id }); s.remove(); } }, 'Resume'),
        h('button', { class: 'tok small danger', onclick: () => { net.send({ t: 'deleteSave', gameId: g.id }); s.remove(); } }, 'Discard'),
      )),
    h('button', {
      class: 'tok primary big', onclick: () => { net.send({ t: 'openLobby', gameId: g.id }); s.remove(); },
    }, save ? 'Start a new game' : 'Open a table'),
  );
}

function settingsSheet() {
  const input = h('input', { class: 'field', value: sync.you?.name || '', maxlength: 16 });
  sheet('Settings',
    h('div', { class: 'stack' },
      h('div', { class: 'eyebrow' }, 'Your name'),
      input,
      h('button', {
        class: 'tok', onclick: e => {
          localStorage.setItem('ps-name', input.value.trim());
          net.send({ t: 'setName', name: input.value.trim() });
          toast('Name updated');
        },
      }, 'Save name'),
      h('div', { class: 'divider' }),
      h('div', { class: 'eyebrow' }, 'Wi-Fi & display'),
      h('p', { class: 'dim', style: 'font-size:14px' },
        'Move the station to another Wi-Fi network, or cap the TV output at 1080p.'),
      h('a', { class: 'tok', style: 'text-align:center', href: '/settings' }, '📶 Network & display'),
      h('div', { class: 'divider' }),
      h('div', { class: 'eyebrow' }, 'Big screen'),
      h('p', { class: 'dim', style: 'font-size:14px' },
        `On the TV, open a browser to `, h('b', {}, location.host + '/tv'),
        `. Screens connected: ${sync.tvCount}.`),
      h('div', { class: 'eyebrow' }, 'Retro ROMs'),
      h('p', { class: 'dim', style: 'font-size:14px' },
        'Add games you own at ', h('a', { href: '/roms', style: 'color:inherit' }, h('b', {}, location.host + '/roms')), '.'),
      h('div', { class: 'divider' }),
      h('div', { class: 'eyebrow' }, 'Software'),
      h('p', { class: 'dim', style: 'font-size:14px' }, `Version: ${sync.version || 'unknown'}`),
      sync.updateError && h('p', { class: 'dim', style: 'font-size:13px;color:var(--bad,#e66)' },
        `⚠️ Last update check failed: ${sync.updateError}`),
      sync.updating
        ? h('div', { class: 'banner hot' }, 'Updating… the station will restart itself.')
        : sync.updateAvailable
          ? h('button', { class: 'tok primary', onclick: () => net.send({ t: 'applyUpdate' }) }, '⬇️ Install update now')
          : h('button', { class: 'tok ghost', onclick: () => { net.send({ t: 'checkUpdate' }); toast('Checking for updates…'); } }, 'Check for updates'),
    ),
  );
}

function lobbyScreen() {
  const L = sync.lobby;
  const g = sync.games.find(x => x.id === L.gameId);
  return h('div', { class: 'screen' },
    h('div', { class: 'topbar' },
      h('div', {},
        h('div', { class: 'eyebrow' }, 'Setting up'),
        h('h1', {}, `${g.icon} ${g.name}`),
      )),
    h('div', { class: 'stack' },
      h('div', { class: 'eyebrow' }, `Table (${L.seats.length}/${g.maxPlayers})`),
      h('div', { class: 'row wrap' },
        L.seats.map((s2, i) => chipEl(s2)),
        L.youAreHost && g.bots !== false && L.seats.length < g.maxPlayers
          && h('button', { class: 'tok small', onclick: () => net.send({ t: 'addBot' }) }, '+ 🤖 Add bot'),
      ),
      L.youAreHost && L.seats.some(s2 => s2.bot)
        && h('button', {
          class: 'tok small ghost', onclick: () => net.send({ t: 'removeBot', i: L.seats.filter(x => x.bot).length - 1 }),
        }, 'Remove a bot'),
      g.options.length ? h('div', { class: 'divider' }) : null,
      ...g.options.map(o => h('div', { class: 'spread' },
        h('span', {}, o.label),
        L.youAreHost
          ? h('select', {
            class: 'field',
            onchange: e => net.send({ t: 'setOption', key: o.key, value: e.target.value }),
          }, o.choices.map(c => h('option', { value: c.v, selected: String(L.options[o.key]) === String(c.v) }, c.label)))
          : h('b', {}, g.options.length && (o.choices.find(c => String(c.v) === String(L.options[o.key]))?.label ?? '')),
      )),
      h('p', { class: 'dim center', style: 'font-size:13px;margin-top:8px' },
        L.youAreHost
          ? (L.seats.length < g.minPlayers ? `Starting now fills empty seats with bots (needs ${g.minPlayers}).` : 'Everyone in? Hit start!')
          : `Waiting for ${L.hostName} to start the game…`),
    ),
    h('div', { class: 'actionbar' },
      L.youAreHost
        ? [h('button', { class: 'tok ghost', onclick: () => net.send({ t: 'cancelLobby' }) }, 'Cancel'),
           h('button', { class: 'tok primary', onclick: () => net.send({ t: 'start' }) }, '▶ Start')]
        : L.youJoined
          ? h('button', { class: 'tok ghost', onclick: () => net.send({ t: 'leaveLobby' }) }, 'Leave table')
          : h('button', { class: 'tok primary', onclick: () => net.send({ t: 'joinLobby' }) }, 'Join table'),
    ),
  );
}

// Mini table view: the same 2D scene the TV draws (game modules ship both the
// phone controller and the TV renderer), scaled to fit the phone. Private
// hands stay private — privOf yields nothing, so other hands render face-down.
// Portrait phones are width-bound (the scale is pinned by screen width), so
// the logical canvas stretches TALLER — a rounder felt — soaking up vertical
// room that otherwise sat empty between the table and your hand. Whose turn
// it is reads off the table itself: the active seat glows marquee-gold.
const MINI_W = 720, MINI_H_MIN = 440, MINI_H_MAX = 720;
function miniTable(mod, G) {
  const w = Math.min(window.innerWidth || 400, 560) - 32; // .screen padding
  const vh = window.innerHeight || 700;
  // Vertical budget: whatever the header (~55px), a two-row fanned hand
  // (~240px), and the action bar (~175px with margins) don't need — clamped
  // so short screens keep a table and tall ones don't drown the controls.
  const budget = Math.max(vh * 0.30, Math.min(vh * 0.52, vh - 470));
  let k = w / MINI_W;
  const H = Math.max(MINI_H_MIN, Math.min(MINI_H_MAX, Math.round(budget / k)));
  k = Math.min(k, budget / H); // short/landscape screens shrink instead
  const inner = h('div', {
    class: 'mini-tv-inner',
    style: `width:${MINI_W}px;height:${H}px;transform:scale(${k.toFixed(4)})`,
  });
  mod.tv.render2d(inner, {
    pub: G.pub, seats: G.seats, game: G,
    peeked: new Set(), padSeats: {}, privOf: () => null,
  });
  return h('div', {
    class: 'mini-tv',
    style: `height:${Math.round(H * k)}px;width:${Math.round(MINI_W * k)}px;margin:0 auto 10px`,
  }, inner);
}

function gameScreen() {
  const G = sync.game;
  const g = sync.games.find(x => x.id === G.gameId);
  const key = G.gameId + ':' + (sync.phase === 'game');
  if (scratchKey !== key) { scratchKey = key; scratch = {}; }
  const mod = modules[G.gameId];
  if (!mod) { loadModule(G.gameId); return h('div', { class: 'screen center dim' }, 'Loading…'); }

  // Real-time arcade: fullscreen gamepad (or spectator note).
  if (G.mode === 'relay') {
    if (G.yourSeat >= 0 && mod.player?.pad) {
      return padScreen(mod, g, G);
    }
    padActive = false;
    return h('div', { class: 'screen stack center', style: 'padding-top:30vh' },
      h('h1', {}, `${g.icon} ${g.name}`),
      h('p', { class: 'dim' }, 'Playing on the big screen — you’re spectating this one.'),
      relayScoreEl(),
    );
  }

  padActive = false;
  // Flex column so games spread over the whole phone screen — the fanned
  // hand (.hand, margin-top:auto) sinks to the bottom like held cards.
  const container = h('div', { style: 'flex:1;display:flex;flex-direction:column' });
  const showTable = tableView && !!mod.tv?.render2d;
  const ctx = {
    sync, game: G, pub: G.pub, priv: G.priv, you: G.yourSeat, seats: G.seats,
    send: a => net.send({ t: 'act', a }),
    state: scratch, toast,
    rerender: render,
    // The mini table is on-screen — games can skip re-stating what it shows.
    tableShown: showTable,
    typing: () => container.contains(document.activeElement) && document.activeElement.tagName === 'INPUT',
  };
  if (mod.error || !mod.player) {
    mount(container, h('p', { class: 'dim center' }, 'This game’s controller failed to load.'));
  } else {
    mod.player.render(container, ctx);
  }

  return h('div', { class: 'screen', style: 'display:flex;flex-direction:column;min-height:100vh' },
    h('div', { class: 'topbar game-top' },
      h('div', { class: 'row', style: 'gap:8px' }, h('span', { style: 'font-size:18px' }, g.icon), h('h2', {}, g.name)),
      h('div', { class: 'row' },
        G.yourSeat < 0 && h('span', { class: 'dim', style: 'font-size:13px' }, 'spectating'),
        mod.tv?.render2d && h('button', {
          class: 'tok small' + (tableView ? '' : ' ghost'),
          onclick: () => {
            tableView = !tableView;
            localStorage.setItem('ps-tableview', tableView ? '1' : '');
            render();
          },
          'aria-label': tableView ? 'Hide table view' : 'Show table view',
        }, '📺'),
        (G.yourSeat >= 0 || G.youAreHost) && h('button', {
          class: 'tok small ghost',
          onclick: () => confirmQuit(),
        }, '💾 Exit'),
      )),
    showTable ? miniTable(mod, G) : null,
    // dropped players / takeover
    G.seats.some(s => s.bot) && G.yourSeat < 0
      ? h('div', { class: 'banner', style: 'margin-bottom:10px;font-size:13px' },
        'Take over a bot seat: ',
        h('div', { class: 'row wrap', style: 'margin-top:8px' },
          G.seats.map((s, i) => s.bot
            ? h('button', { class: 'tok small', onclick: () => net.send({ t: 'takeover', seat: i }) }, `${s.name} 🤖`)
            : null)))
      : null,
    G.youAreHost ? disconnectedBanner(G) : null,
    container,
  );
}

function disconnectedBanner(G) {
  const gone = G.seats.map((s, i) => (!s.bot && s.connected === false) ? i : null).filter(v => v != null);
  if (!gone.length) return null;
  return h('div', { class: 'banner', style: 'margin-bottom:10px;font-size:13px' },
    gone.map(i => h('div', { class: 'spread' },
      h('span', {}, `${G.seats[i].name} disconnected`),
      h('button', { class: 'tok small', onclick: () => net.send({ t: 'botify', seat: i }) }, 'Let a bot play'))));
}

function confirmQuit() {
  const s = sheet('Leave this game?',
    h('p', { class: 'dim', style: 'margin-bottom:14px' }, 'This ends the game for the whole table. Progress is saved automatically — resume from the game tile later.'),
    h('div', { class: 'row' },
      h('button', { class: 'tok ghost grow', onclick: () => s.remove() }, 'Keep playing'),
      h('button', { class: 'tok danger grow', onclick: () => { net.send({ t: 'quitGame' }); s.remove(); } }, 'Save & exit'),
    ));
}

// Arcade (relay) games have no saves — quitting just ends the match.
function confirmQuitRelay() {
  const s = sheet('End this arcade game?',
    h('p', { class: 'dim', style: 'margin-bottom:14px' }, 'This ends the match for everyone — arcade games aren’t saved.'),
    h('div', { class: 'row' },
      h('button', { class: 'tok ghost grow', onclick: () => s.remove() }, 'Keep playing'),
      h('button', { class: 'tok danger grow', onclick: () => { net.send({ t: 'quitGame' }); s.remove(); } }, 'End game'),
    ));
}

let lastRelayScore = null;
function relayScoreEl() {
  return h('div', { id: 'relay-score', class: 'banner center', style: 'font-size:24px' },
    lastRelayScore || '');
}

function padScreen(mod, g, G) {
  padActive = true;
  const el = h('div', {});
  requestAnimationFrame(() => {
    import('./ui.js').then(({ gamepad }) => gamepad(el, mod.player.pad, m => net.send(m)));
  });
  return h('div', {},
    h('div', { style: 'position:fixed;top:12px;left:0;right:0;text-align:center;z-index:5' },
      h('span', { class: 'banner', style: 'font-size:14px' }, `${g.icon} ${G.seats[G.yourSeat].name}`),
      ' ',
      h('span', { id: 'relay-score', class: 'banner', style: 'font-size:14px' }, lastRelayScore || ''),
      ' ',
      h('button', {
        class: 'tok small danger', style: 'vertical-align:middle',
        onclick: () => confirmQuitRelay(),
        'aria-label': 'End game',
      }, '✕'),
    ),
    el);
}

net.onExtra(m => {
  if (m.t === 'relayScore') {
    lastRelayScore = m.d;
    const el = document.getElementById('relay-score');
    if (el) el.textContent = m.d;
  }
});

function gameoverScreen() {
  const G = sync.game;
  const g = sync.games.find(x => x.id === G.gameId);
  return h('div', { class: 'screen stack center', style: 'padding-top:18vh' },
    h('div', { style: 'font-size:64px' }, g.icon),
    h('h1', {}, G.over?.title || 'Game over'),
    h('div', { class: 'stack', style: 'gap:4px;margin-top:8px' },
      (G.over?.lines || []).map(l => h('div', { class: 'dim' }, l))),
    h('div', { class: 'actionbar' },
      h('button', { class: 'tok primary big', onclick: () => net.send({ t: 'backToHub' }) }, 'Back to games')),
  );
}

// ---------------------------------------------------------------- render

// Rotating the phone changes the widths the mini table and fanned hand are
// sized against — re-render in-game so both fit the new orientation.
window.addEventListener('resize', () => { if (sync?.phase === 'game') render(); });

function render() {
  if (!sync) return;
  if (!localStorage.getItem('ps-named')) { mount(root, joinScreen()); return; }
  document.body.style.overflow = padActive ? 'hidden' : '';
  if (sync.emulator) { mount(root, emulatorScreen()); return; }
  switch (sync.phase) {
    case 'hub': mount(root, hubMode ? hubScreen() : chooseScreen()); break;
    case 'lobby': mount(root, lobbyScreen()); break;
    case 'game': mount(root, gameScreen()); break;
    case 'gameover': mount(root, gameoverScreen()); break;
  }
}
