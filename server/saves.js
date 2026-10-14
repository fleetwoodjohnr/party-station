// Auto-save of in-progress games. One JSON file per game id under data/saves/.
// Real-time games keep long-lived profiles (settings, progression, worlds)
// under data/profiles/<game>/<key>.json — see saveProfile().
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'saves');
const PROFILES = path.join(ROOT, 'data', 'profiles');
fs.mkdirSync(DIR, { recursive: true });

const timers = new Map();

function fileFor(gameId) {
  return path.join(DIR, gameId.replace(/[^a-z0-9-]/gi, '_') + '.json');
}

// Write-then-rename: a power cut mid-write leaves the old file intact
// instead of a truncated one.
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Debounced write: games save after every action, so coalesce bursts.
export function save(gameId, payload) {
  clearTimeout(timers.get(gameId));
  timers.set(gameId, setTimeout(() => {
    timers.delete(gameId);
    try {
      writeAtomic(fileFor(gameId), JSON.stringify({ ...payload, at: Date.now() }));
    } catch (e) {
      console.error('save failed for', gameId, e.message);
    }
  }, 400));
}

export function load(gameId) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(gameId), 'utf8'));
  } catch {
    return null;
  }
}

export function clear(gameId) {
  clearTimeout(timers.get(gameId));
  timers.delete(gameId);
  try { fs.unlinkSync(fileFor(gameId)); } catch {}
}

// Summaries for the hub screen ("Resume" badges).
export function summaries() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(DIR); } catch {}
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out[d.gameId] = { at: d.at, seats: d.seats.map(s => ({ name: s.name, bot: !!s.bot })) };
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- profiles
// Keys are client-chosen (settings, slot1, …), so both parts are squeezed to
// a safe filename. The previous good copy is kept as .bak and read back if
// the main file is ever unreadable.
const safe = s => String(s).toLowerCase().replace(/[^a-z0-9-]/g, '_').slice(0, 40) || '_';
const profileFile = (game, key) => path.join(PROFILES, safe(game), safe(key) + '.json');

export function loadProfile(game, key) {
  const file = profileFile(game, key);
  for (const f of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
  return null;
}

export function saveProfile(game, key, data) {
  const file = profileFile(game, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data);
  try {
    JSON.parse(fs.readFileSync(file, 'utf8')); // only a readable file becomes the backup
    fs.copyFileSync(file, file + '.bak');
  } catch {}
  writeAtomic(file, text);
}

export function listProfiles(game) {
  try {
    return fs.readdirSync(path.join(PROFILES, safe(game)))
      .filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  } catch { return []; }
}
