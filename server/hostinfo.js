// Where phones can actually reach this station.
//
// The TV kiosk loads http://localhost/tv, so anything derived from the
// browser's own URL says "localhost" — useless to a guest holding a phone.
// The server is the only party that knows the real answer, so it computes it
// here and ships it to clients in the sync payload.
//
// Cached briefly: broadcast() calls this on every state change, but the
// addresses do change under us when someone switches Wi-Fi, so the cache has
// to expire rather than being computed once at boot.
import os from 'os';

const TTL_MS = 5000;
let cache = null;
let cachedAt = 0;

export function addresses(force = false) {
  const now = Date.now();
  if (!force && cache && now - cachedAt < TTL_MS) return cache;
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
  cache = {
    // mDNS advertises the machine's real hostname — only the Pi is actually
    // named "party-station", so don't hardcode it.
    host: `${os.hostname().toLowerCase()}.local`,
    ips,
  };
  cachedAt = now;
  return cache;
}

export function invalidate() { cache = null; }

// The single address to put on the TV: the mDNS name if we have one, else the
// first real IP. Port is included only when it isn't the default.
export function joinUrl(port) {
  const { host, ips } = addresses();
  const suffix = !port || Number(port) === 80 ? '' : `:${port}`;
  return `${host || ips[0] || 'party-station.local'}${suffix}`;
}

// Other Party Stations on the LAN (for co-op "Join a friend"): probe the
// /24 around each of our addresses for anything answering /api/status like
// a station does. ~250 tiny requests, 48 at a time, 700 ms timeout — a few
// seconds, only when someone opens the join screen, cached for 20 s.
let lanCache = null, lanAt = 0, lanBusy = null;
export function lanStations(port = 80) {
  if (lanCache && Date.now() - lanAt < 20000) return Promise.resolve(lanCache);
  if (lanBusy) return lanBusy;
  const mine = new Set(addresses(true).ips);
  const targets = [];
  for (const ip of mine) {
    const base = ip.split('.').slice(0, 3).join('.');
    for (let k = 1; k < 255; k++) { const t = `${base}.${k}`; if (!mine.has(t)) targets.push(t); }
  }
  const found = [];
  const probe = async ip => {
    try {
      const r = await fetch(`http://${ip}:${port}/api/status`, { signal: AbortSignal.timeout(700) });
      const s = await r.json();
      if (s && s.ok && s.version) found.push({ ip, name: s.name || ip, version: s.version, playing: !!s.playing });
    } catch {}
  };
  lanBusy = (async () => {
    for (let i = 0; i < targets.length; i += 48) await Promise.all(targets.slice(i, i + 48).map(probe));
    lanCache = found.sort((a, b) => a.name.localeCompare(b.name));
    lanAt = Date.now();
    lanBusy = null;
    return lanCache;
  })();
  return lanBusy;
}
