// Performance beacons: the TV renderer posts frame-time stats every few
// seconds (POST /api/perf); we stamp each one with what the machine itself
// reports, so a bench run on the Pi can be judged from anywhere via
// /api/status. Everything here fails soft — a dev box without /proc or a
// thermal zone just reports nulls.
import fs from 'fs';

let last = null;
let run = null;        // summary of the current/most recent run (by run id)
let lastLog = 0;

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function meminfo() {
  const t = read('/proc/meminfo');
  if (!t) return {};
  const kb = k => Number(t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0);
  return {
    memTotalMB: Math.round(kb('MemTotal') / 1024),
    memAvailMB: Math.round(kb('MemAvailable') / 1024),
    swapUsedMB: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024),
  };
}

// Proportional set size of every kiosk Chromium process (the kiosk runs
// with --user-data-dir=…/party-station-kiosk). PSS splits shared pages
// fairly, so the sum is the browser's real footprint. Same-user only.
function kioskPssMB() {
  let total = 0, n = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    const cmd = read(`/proc/${pid}/cmdline`);
    if (!cmd || !cmd.includes('party-station-kiosk')) continue;
    const roll = read(`/proc/${pid}/smaps_rollup`);
    const kb = Number(roll?.match(/^Pss:\s+(\d+)/m)?.[1]);
    if (kb) { total += kb; n++; }
  }
  return n ? Math.round(total / 1024) : null;
}

function socTempC() {
  const t = Number(read('/sys/class/thermal/thermal_zone0/temp'));
  return t ? Math.round(t / 100) / 10 : null;
}

// Raspberry Pi firmware throttle flags (0x0 = never throttled). Bit 0/2 =
// under-voltage/throttled now; bits 16/18 = it happened since boot.
function throttled() {
  const t = read('/sys/devices/platform/soc/soc:firmware/get_throttled');
  return t == null ? null : t.trim();
}

export function sysStats() {
  return { ...meminfo(), kioskPssMB: kioskPssMB(), socTempC: socTempC(), throttled: throttled() };
}

const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : undefined);

export function record(b) {
  const rec = {
    at: new Date().toISOString(),
    run: String(b.run || '').slice(0, 32),
    scene: String(b.scene || '').slice(0, 32),
    preset: String(b.preset || '').slice(0, 16),
    gpu: String(b.gpu || '').slice(0, 120),
    final: !!b.final,
    fps: num(b.fps), p50: num(b.p50), p95: num(b.p95), p99: num(b.p99), worst: num(b.worst),
    frames: num(b.frames), draws: num(b.draws), tris: num(b.tris),
    heapMB: num(b.heapMB), scale: num(b.scale), zombies: num(b.zombies), cap: num(b.cap),
    ...sysStats(),
  };
  last = rec;
  if (!run || run.id !== rec.run) {
    run = {
      id: rec.run, scene: rec.scene, gpu: rec.gpu, startedAt: rec.at, beacons: 0,
      swapStartMB: rec.swapUsedMB, minMemAvailMB: rec.memAvailMB, maxKioskPssMB: rec.kioskPssMB,
      maxTempC: rec.socTempC, worstP95: rec.p95, final: null,
    };
  }
  run.beacons++;
  run.minMemAvailMB = Math.min(run.minMemAvailMB ?? Infinity, rec.memAvailMB ?? Infinity);
  run.maxKioskPssMB = Math.max(run.maxKioskPssMB ?? 0, rec.kioskPssMB ?? 0) || null;
  run.maxTempC = Math.max(run.maxTempC ?? 0, rec.socTempC ?? 0) || null;
  run.worstP95 = Math.max(run.worstP95 ?? 0, rec.p95 ?? 0);
  run.swapGrowthMB = (rec.swapUsedMB ?? 0) - (run.swapStartMB ?? 0);
  run.throttled = rec.throttled;
  if (rec.final) run.final = rec;
  if (rec.final || Date.now() - lastLog > 60_000) {
    lastLog = Date.now();
    console.log(`perf: ${rec.scene} ${rec.preset} fps=${rec.fps} p50=${rec.p50}ms p95=${rec.p95}ms`
      + ` draws=${rec.draws} z=${rec.zombies} memAvail=${rec.memAvailMB}MB swap=${rec.swapUsedMB}MB`
      + ` kiosk=${rec.kioskPssMB}MB ${rec.socTempC}°C${rec.final ? ' (final)' : ''}`);
  }
}

// A bench is starting: the next beacon opens a fresh run summary.
export function resetRun() { run = null; }

export function summary() {
  return last ? { last, run } : null;
}
