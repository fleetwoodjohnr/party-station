// Thin wrapper around the privileged helper (scripts/psctl, installed as
// /usr/local/sbin/party-station-ctl).
//
// The server runs unprivileged, so anything needing root — switching Wi-Fi,
// capping the display mode — goes through `sudo -n party-station-ctl <cmd>`.
// The helper always answers with one JSON object, so callers get data or a
// clean Error, never raw shell output.
//
// Every Pi-only side effect is gated on isPi() the same way server/audio.js
// does it, so a dev box degrades to a clear "not supported here" instead of
// spraying ENOENT.
import { execFile } from 'child_process';
import fs from 'fs';

const HELPER = '/usr/local/sbin/party-station-ctl';
const TIMEOUT_MS = 45000; // net-connect waits up to 30s on nmcli, plus slack

let piCache = null;
export function isPi() {
  if (piCache === null) {
    try {
      piCache = fs.readFileSync('/proc/device-tree/model', 'utf8')
        .toLowerCase().includes('raspberry pi');
    } catch { piCache = false; }
  }
  return piCache;
}

export function available() {
  try { return isPi() && fs.existsSync(HELPER); } catch { return false; }
}

// Run a helper subcommand. `stdin` is written to the child's stdin and never
// appears in argv — that's how Wi-Fi passphrases stay out of /proc, which is
// world-readable.
export function run(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) {
      reject(new Error(isPi()
        ? 'The system helper isn’t installed — re-run the Party Station setup script.'
        : 'This only works on the Raspberry Pi that runs the station.'));
      return;
    }
    const child = execFile('sudo', ['-n', HELPER, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        // The helper reports failure as {"err":"..."} plus a non-zero exit, so
        // parse stdout first and prefer its message over the exec error.
        let parsed = null;
        try { parsed = JSON.parse(String(stdout || '').trim()); } catch {}
        if (parsed && typeof parsed === 'object' && parsed.err) {
          reject(new Error(parsed.err));
          return;
        }
        if (err) {
          if (err.killed) { reject(new Error('That took too long and was stopped.')); return; }
          // Always log what actually went wrong: the message below is a
          // friendly summary, and without the real stderr a misconfigured
          // unit file is very hard to tell apart from a missing sudoers rule.
          console.error('sysctl:', args.join(' '), '->', String(stderr || err.message).trim());
          const hint = /sudo|password|not allowed|no new privileges/i.test(String(stderr || ''))
            ? 'The helper isn’t permitted to run — check /etc/sudoers.d/party-station '
              + 'and that the service unit sets neither NoNewPrivileges nor a CapabilityBoundingSet.'
            : 'The system helper failed.';
          reject(new Error(hint));
          return;
        }
        if (!parsed) { reject(new Error('The system helper returned nothing usable.')); return; }
        resolve(parsed);
      });
    if (stdin != null) {
      // scripts/psctl reads one line. Terminate it explicitly: Bash's `read`
      // returns failure at EOF even after collecting bytes, which caused the
      // old helper to replace every secured-network password with "".
      child.stdin.end(String(stdin) + '\n');
    } else {
      child.stdin.end();
    }
  });
}

// ------------------------------------------------------------------ display

// Cached because emulator launches read it on every game start, and a shell
// round-trip in that path would add latency for no reason. Invalidated
// whenever we change the mode ourselves.
let displayCache = null;

export async function displayGet() {
  if (displayCache) return displayCache;
  displayCache = await run(['display-get']);
  return displayCache;
}

export async function displaySet(mode) {
  const res = await run(['display-set', mode]);
  displayCache = null;
  return res;
}

// Synchronous best-effort read for the emulator launch path: returns the last
// known mode without blocking, defaulting to the capped mode on a Pi. A Pi 4
// cannot drive 4K, so guessing "1080p" is the safe direction to be wrong in.
export function displayModeNow() {
  if (displayCache) return displayCache.mode;
  if (!available()) return null;
  return '1080p';
}

// Warm the cache at boot so displayModeNow() is accurate by the time anyone
// launches a game.
export function init() {
  if (!available()) return;
  displayGet().catch(() => {});
}
