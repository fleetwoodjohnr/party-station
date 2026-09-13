// Self-update from GitHub. Periodically fetches origin/main; when the app is idle
// (no game running) it pulls, reinstalls deps, and exits — systemd restarts it
// with the new code. Also exposes a manual "update now" path for the settings UI.
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_INTERVAL = 15 * 60 * 1000;
const UPDATE_REPO = 'https://github.com/fleetwoodjohnr/party-station.git';

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, timeout: 60000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });
}

function npm(args) {
  return new Promise((resolve, reject) => {
    execFile('npm', args, { cwd: ROOT, timeout: 5 * 60 * 1000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });
}

export const status = {
  version: null,        // short hash + date of running commit
  updateAvailable: false,
  updating: false,
  lastCheck: 0,
  error: null,
};

export async function init({ isIdle, onStatusChange }) {
  try {
    status.version = await git(['log', '-1', '--format=%h (%cs)']);
  } catch {
    status.version = 'dev (not a git checkout)';
    return; // no git — nothing to update from
  }
  const tick = async () => {
    try {
      await check();
      if (status.updateAvailable && isIdle()) await apply();
    } catch (e) {
      status.error = e.message;
    }
    onStatusChange?.();
  };
  setInterval(tick, CHECK_INTERVAL);
  setTimeout(tick, 30 * 1000); // first check shortly after boot
}

// Concurrent checks (the settings button + the 15-minute tick) race
// git fetch on the same ref and one loses noisily — share one in-flight
// check instead.
let inFlight = null;
export function check() {
  if (!inFlight) {
    inFlight = (async () => {
      // Do not trust a checkout's saved remote forever. Older Party Station
      // installs were cloned from atlas-navigate, and changing only the
      // installer would leave those boxes fetching the old repository.
      let origin = '';
      try { origin = await git(['remote', 'get-url', 'origin']); } catch {}
      if (origin) await git(['remote', 'set-url', 'origin', UPDATE_REPO]);
      else await git(['remote', 'add', 'origin', UPDATE_REPO]);
      await git(['fetch', 'origin', 'main']);
      const local = await git(['rev-parse', 'HEAD']);
      const remote = await git(['rev-parse', 'origin/main']);
      status.updateAvailable = local !== remote;
      status.lastCheck = Date.now();
      status.error = null;
      return status.updateAvailable;
    })().finally(() => { inFlight = null; });
  }
  return inFlight;
}

export async function apply() {
  if (status.updating) return;
  status.updating = true;
  try {
    await git(['reset', '--hard', 'origin/main']);
    await npm(['ci', '--omit=dev', '--no-audit', '--no-fund']);
    console.log('Update applied; restarting…');
    // systemd (Restart=always) brings us back up on the new code.
    setTimeout(() => process.exit(0), 800);
  } catch (e) {
    status.updating = false;
    status.error = e.message;
    throw e;
  }
}
