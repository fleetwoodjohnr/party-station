// Shared bits of the settings UI, used by both front-ends: the phone page
// (/settings) and the TV's on-screen menu in tv.js. Keeping the API calls and
// the formatting in one place is what stops the two drifting apart.

// Phones must unlock with the code shown on the TV; the TV itself is on
// loopback and is trusted without one (see server/settings.js). Session
// storage, not local: closing the tab should re-lock the station.
const TOKEN_KEY = 'ps-settings-token';

export function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

export function setToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

// Every call resolves to the parsed body. Failures throw an Error carrying the
// server's own sentence, plus `.needPin` when the fix is "go unlock first" —
// the callers use that to swap in the code prompt rather than show an error.
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res, data;
  try {
    res = await fetch(`/api/settings${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    // A dropped connection is the expected outcome of switching Wi-Fi, so the
    // message has to make sense in that case too.
    const err = new Error('Lost contact with the station.');
    err.connectionLost = true;
    throw err;
  }
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(data?.err || 'That didn’t work.');
    if (data?.needPin) {
      err.needPin = true;
      setToken(null); // an expired token is worse than none
    }
    throw err;
  }
  return data || {};
}

export const state = () => api('/');
export const scan = () => api('/wifi/scan');
export const connect = (ssid, password) => api('/wifi/connect', { method: 'POST', body: { ssid, password } });
export const forget = ssid => api('/wifi/forget', { method: 'POST', body: { ssid } });
export const setDisplay = mode => api('/display', { method: 'POST', body: { mode } });
export const reboot = () => api('/reboot', { method: 'POST' });
export const requestPin = () => api('/pin', { method: 'POST' });

export async function unlock(pin) {
  const r = await api('/unlock', { method: 'POST', body: { pin } });
  if (r.token) setToken(r.token);
  return r;
}

// ------------------------------------------------------------- formatting

// Four bars, filled by signal strength. Text rather than an image so it works
// on the TV at any size and needs no assets.
export function bars(signal) {
  const n = signal == null ? 0 : Math.max(0, Math.min(4, Math.round(signal / 25)));
  return '▂▄▆█'.slice(0, n).padEnd(4, '·');
}

export function signalWord(signal) {
  if (signal == null) return '';
  if (signal >= 70) return 'strong';
  if (signal >= 45) return 'ok';
  if (signal >= 25) return 'weak';
  return 'very weak';
}

// The address to read out to guests: mDNS name first (it survives a DHCP
// lease change), with the raw IP as the fallback that always works.
export function joinAddresses(info) {
  const out = [];
  if (info?.host) out.push(info.host);
  for (const ip of info?.ips || []) out.push(ip);
  return out;
}

export const MODE_LABEL = {
  '1080p': '1080p — recommended on a Pi 4',
  native: 'Native — whatever the TV asks for',
};
