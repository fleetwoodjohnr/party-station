// Headless-browser smoke test for Dead of Night: opens the TV page in
// Chrome, starts the bench through /api/bench, screenshots it, and fails on
// any page error or console error. Talks the DevTools protocol over `ws`
// (already a dependency) — no puppeteer needed.
// Usage: CHROME=/path/to/chrome PORT=8090 [SCENE=classic] node scripts/night-smoke.js [secs] [outdir]
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

const PORT = process.env.PORT || 8090;
const BASE = `http://127.0.0.1:${PORT}`;
const SECS = Number(process.argv[2] || 12);
const OUT = process.argv[3] || os.tmpdir();
const CHROME = process.env.CHROME || 'chromium';
const DBG = 9333 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'night-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', `${BASE}/tv?mode=party`,
], { stdio: 'ignore' });

const errors = [];
let id = 0;
const pending = new Map();
let ws;
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

function done(code) {
  try { chrome.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
setTimeout(() => { console.error('✗ smoke timed out'); done(1); }, (SECS + 60) * 1000);

(async () => {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
      target = list.find(t => t.type === 'page');
    } catch {}
  }
  if (!target) { console.error('✗ chrome did not start'); return done(1); }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|\/api\/art|\/api\/profiles/.test(m.params.entry.url || '')) {
      errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');
  await sleep(2500);
  const scene = process.env.SCENE ? `&scene=${process.env.SCENE}` : '';
  const r = await fetch(`${BASE}/api/bench?secs=${SECS}${scene}`, { method: 'POST' });
  const body = await r.json();
  if (!body.ok) { console.error('✗ bench refused:', body.err); return done(1); }
  console.log('✓ bench started');
  const shot = async name => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    console.log('  screenshot', f);
  };
  const tag = process.env.SCENE || 'flythrough';
  await sleep(SECS * 250 + 3000); await shot(`night-${tag}-1.png`);
  await sleep(SECS * 500); await shot(`night-${tag}-2.png`);
  let final = null;
  for (let i = 0; i < 40 && !final; i++) {
    await sleep(500);
    const st = await (await fetch(`${BASE}/api/status`)).json();
    if (st.perf?.run?.final) final = st.perf.run;
  }
  if (!final) errors.push('no final perf beacon arrived');
  else console.log('✓ final beacon:', JSON.stringify(final.final));
  if (errors.length) { console.error('✗ page errors:\n  ' + errors.join('\n  ')); return done(1); }
  console.log('✓ no page errors');
  done(0);
})().catch(e => { console.error('✗', e); done(1); });
