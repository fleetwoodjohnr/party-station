// Dead of Night's sound, synthesized in WebAudio: no audio files to load
// (fast start, works offline, nothing in RAM but one second of noise).
// Positional cues use a stereo pan + distance gain — cheaper than HRTF
// panners on a Pi. Zombie voices are capped so a horde can't swamp it.
let ctx = null, master = null, noise = null;
let groans = 0;
const MAX_GROANS = 6;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const safe = fn => (...a) => { try { return fn(...a); } catch { return undefined; } };

function out(pan = 0, vol = 1) {
  const g = ctx.createGain();
  g.gain.value = vol;
  if (pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(master);
  } else g.connect(master);
  return g;
}

// Filtered noise burst with an exponential decay.
function burst({ dur = 0.2, vol = 0.5, type = 'lowpass', freq = 2000, q = 0.7, pan = 0, at = 0, sweep = 0 }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  src.connect(f).connect(g).connect(out(pan));
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

function tone(freq, dur, { type = 'sine', vol = 0.2, glide = 0, at = 0, pan = 0, attack = 0.005 } = {}) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out(pan));
  o.start(t);
  o.stop(t + dur + 0.05);
}

const GUNS = {
  pistol: () => { burst({ dur: 0.16, vol: 0.9, freq: 3200, sweep: 600 }); tone(140, 0.09, { type: 'triangle', vol: 0.5, glide: 50 }); },
  smg: () => { burst({ dur: 0.1, vol: 0.7, freq: 2600, sweep: 700 }); tone(110, 0.06, { type: 'triangle', vol: 0.35, glide: 50 }); },
  shotgun: () => {
    burst({ dur: 0.45, vol: 1.1, freq: 1400, sweep: 180 });
    tone(80, 0.25, { type: 'sine', vol: 0.8, glide: 35 });
    burst({ dur: 0.08, vol: 0.4, type: 'highpass', freq: 3000, at: 0.42 }); // pump: chk
    burst({ dur: 0.08, vol: 0.4, type: 'highpass', freq: 2500, at: 0.55 });
  },
  revolver: () => { burst({ dur: 0.3, vol: 1.1, freq: 2400, sweep: 300 }); tone(95, 0.16, { type: 'triangle', vol: 0.7, glide: 40 }); },
  rifle: () => { burst({ dur: 0.14, vol: 0.85, freq: 3600, sweep: 500 }); tone(120, 0.07, { type: 'triangle', vol: 0.45, glide: 45 }); },
  marksman: () => { burst({ dur: 0.26, vol: 1.0, freq: 3000, sweep: 350 }); tone(100, 0.12, { type: 'triangle', vol: 0.6, glide: 40 }); },
  sniper: () => {
    burst({ dur: 0.55, vol: 1.2, freq: 2600, sweep: 160 }); tone(70, 0.3, { type: 'sine', vol: 0.9, glide: 30 });
    burst({ dur: 0.06, vol: 0.35, type: 'bandpass', freq: 1800, q: 3, at: 0.7 }); burst({ dur: 0.06, vol: 0.35, type: 'bandpass', freq: 2200, q: 3, at: 0.95 });
  },
  launcher: () => { burst({ dur: 0.18, vol: 0.6, freq: 900, sweep: 200 }); tone(160, 0.12, { type: 'sine', vol: 0.5, glide: 70 }); },
};

export const audio = {
  volume: safe(v => { ac(); master.gain.value = v; }),
  unlock: safe(() => ac()),
  gun: safe(kind => { ac(); (GUNS[kind] || GUNS.pistol)(); }),
  dry: safe(() => { ac(); burst({ dur: 0.04, vol: 0.3, type: 'highpass', freq: 4000 }); }),
  reload: safe(() => {
    ac();
    burst({ dur: 0.05, vol: 0.35, type: 'bandpass', freq: 2400, q: 3 });
    burst({ dur: 0.06, vol: 0.4, type: 'bandpass', freq: 1800, q: 3, at: 0.35 });
  }),
  reloaded: safe(() => { ac(); burst({ dur: 0.07, vol: 0.45, type: 'bandpass', freq: 2800, q: 2 }); }),
  shell: safe(() => { ac(); burst({ dur: 0.05, vol: 0.3, type: 'bandpass', freq: 2000, q: 4 }); }),
  swap: safe(() => { ac(); burst({ dur: 0.12, vol: 0.25, type: 'bandpass', freq: 1200, q: 1.5 }); }),
  hitmark: safe(head => { ac(); tone(head ? 2400 : 1700, 0.05, { type: 'square', vol: 0.08 }); }),
  kill: safe(head => { ac(); burst({ dur: 0.18, vol: 0.5, freq: 500, sweep: 120 }); if (head) tone(900, 0.12, { type: 'triangle', vol: 0.12, glide: 300 }); }),
  knife: safe(() => { ac(); burst({ dur: 0.18, vol: 0.35, type: 'bandpass', freq: 3000, q: 1, sweep: 900 }); }),
  hurt: safe(() => {
    ac();
    tone(70, 0.3, { type: 'sine', vol: 0.9, glide: 40 });
    burst({ dur: 0.25, vol: 0.5, freq: 900, sweep: 200 });
  }),
  heartbeat: safe(() => { ac(); tone(55, 0.12, { vol: 0.6 }); tone(50, 0.14, { vol: 0.5, at: 0.18 }); }),
  board: safe((pan, vol) => { ac(); burst({ dur: 0.3, vol: 0.7 * vol, type: 'bandpass', freq: 700, q: 1.2, pan }); burst({ dur: 0.12, vol: 0.5 * vol, type: 'highpass', freq: 2500, pan, at: 0.05 }); }),
  hammer: safe(() => { ac(); for (let i = 0; i < 2; i++) { tone(180, 0.06, { type: 'square', vol: 0.18, at: i * 0.16 }); burst({ dur: 0.05, vol: 0.35, type: 'bandpass', freq: 1600, q: 3, at: i * 0.16 }); } }),
  buy: safe(() => { ac(); [1319, 1760, 2637].forEach((f, i) => tone(f, 0.14, { type: 'triangle', vol: 0.12, at: i * 0.07 })); }),
  denied: safe(() => { ac(); tone(150, 0.22, { type: 'sawtooth', vol: 0.12 }); }),
  door: safe(() => { ac(); burst({ dur: 0.9, vol: 0.5, freq: 400, sweep: 120 }); tone(90, 0.6, { type: 'sawtooth', vol: 0.08, glide: 60 }); }),
  step: safe(sprint => { ac(); burst({ dur: 0.07, vol: sprint ? 0.16 : 0.1, freq: 380 }); }),
  land: safe(() => { ac(); burst({ dur: 0.12, vol: 0.3, freq: 300 }); }),
  // A zombie close by: detuned growl through a vowel-ish band, panned.
  groan: safe((pan, vol, pitch = 1) => {
    ac();
    if (groans >= MAX_GROANS || vol < 0.03) return;
    groans++;
    const t = ctx.currentTime, dur = 0.7 + Math.random() * 0.9;
    const o = ctx.createOscillator(), o2 = ctx.createOscillator();
    o.type = 'sawtooth'; o2.type = 'sawtooth';
    const f0 = (70 + Math.random() * 50) * pitch;
    o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 0.8, t + dur);
    o2.frequency.setValueAtTime(f0 * 1.51, t); o2.frequency.linearRampToValueAtTime(f0 * 1.2, t + dur);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(500 + Math.random() * 300, t); bp.frequency.linearRampToValueAtTime(320, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * vol, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp); o2.connect(bp); bp.connect(g).connect(out(pan));
    o.start(t); o2.start(t); o.stop(t + dur); o2.stop(t + dur);
    o.onended = () => { groans--; };
  }),
  swipe: safe((pan, vol) => { ac(); burst({ dur: 0.22, vol: 0.4 * vol, type: 'bandpass', freq: 1400, q: 1, sweep: 400, pan }); }),
  roundStart: safe(() => {
    ac();
    // Low, uneasy swell: a minor chord that sags.
    [55, 65.4, 82.4].forEach((f, i) => tone(f, 3.2, { type: 'sawtooth', vol: 0.09, glide: f * 0.94, attack: 0.8, at: i * 0.05 }));
    tone(220, 2.4, { type: 'triangle', vol: 0.06, glide: 196, attack: 1.2 });
  }),
  roundEnd: safe(() => { ac(); [392, 349, 311, 262].forEach((f, i) => tone(f, 0.9, { type: 'triangle', vol: 0.09, at: i * 0.32 })); }),
  gameOver: safe(() => { ac(); [196, 185, 165, 131].forEach((f, i) => tone(f, 1.6, { type: 'sawtooth', vol: 0.08, at: i * 0.5, glide: f * 0.97 })); }),
  ui: safe(kind => {
    ac();
    if (kind === 'blip') tone(520, 0.05, { type: 'square', vol: 0.05 });
    else if (kind === 'select') { tone(392, 0.07, { type: 'square', vol: 0.06 }); tone(587, 0.1, { type: 'square', vol: 0.06, at: 0.06 }); }
    else if (kind === 'back') tone(330, 0.1, { type: 'square', vol: 0.05, glide: 200 });
  }),
  boom: safe((pan, vol) => {
    ac();
    burst({ dur: 1.1, vol: 1.3 * vol, freq: 900, sweep: 60, pan });
    tone(48, 0.7, { type: 'sine', vol: 1.0 * vol, glide: 28 });
    burst({ dur: 0.5, vol: 0.4 * vol, type: 'highpass', freq: 2000, at: 0.05, pan });
  }),
  bounce: safe(() => { ac(); tone(700 + Math.random() * 300, 0.04, { type: 'square', vol: 0.05 }); }),
  throwIt: safe(() => { ac(); burst({ dur: 0.18, vol: 0.2, type: 'bandpass', freq: 900, q: 1, sweep: 2000 }); }),
  fire: safe((pan, vol) => { ac(); for (let i = 0; i < 4; i++) burst({ dur: 0.12, vol: 0.25 * vol, type: 'bandpass', freq: 1200 + Math.random() * 1500, q: 2, pan, at: i * 0.09 }); }),
  splat: safe((pan, vol) => { ac(); burst({ dur: 0.3, vol: 0.5 * vol, type: 'lowpass', freq: 700, sweep: 200, pan }); }),
  spit: safe((pan, vol) => { ac(); burst({ dur: 0.35, vol: 0.5 * vol, type: 'bandpass', freq: 600, q: 4, sweep: 1600, pan }); }),
  scream: safe((pan, vol) => {
    ac();
    for (const f of [620, 930, 1240]) tone(f, 1.1, { type: 'sawtooth', vol: 0.05 * vol, glide: f * 1.4, pan, attack: 0.08 });
  }),
  roar: safe((pan, vol) => { ac(); tone(55, 1.6, { type: 'sawtooth', vol: 0.3 * vol, glide: 38, pan, attack: 0.15 }); burst({ dur: 1.4, vol: 0.6 * vol, freq: 500, sweep: 120, pan }); }),
  slam: safe(() => { ac(); tone(40, 0.6, { type: 'sine', vol: 1.1, glide: 25 }); burst({ dur: 0.7, vol: 0.9, freq: 400, sweep: 60 }); }),
  zap: safe(() => { ac(); burst({ dur: 0.12, vol: 0.35, type: 'highpass', freq: 3500 }); tone(110 + Math.random() * 40, 0.12, { type: 'square', vol: 0.12 }); }),
  armor: safe(() => { ac(); tone(1900, 0.08, { type: 'triangle', vol: 0.12 }); burst({ dur: 0.08, vol: 0.3, type: 'highpass', freq: 4000 }); }),
  perk: safe(id => {
    ac();
    const tunes = { ironhide: [196, 247, 294, 392], quickhands: [523, 659, 784, 1047], secondwind: [392, 523, 659, 523], doubletap: [330, 330, 494, 659], steadyaim: [440, 554, 659, 880], stamina: [349, 440, 523, 698] };
    (tunes[id] || tunes.ironhide).forEach((f, i) => tone(f, 0.22, { type: 'square', vol: 0.06, at: i * 0.16 }));
    burst({ dur: 0.4, vol: 0.25, type: 'highpass', freq: 3000, at: 0.7 }); // the can opening
  }),
  crate: safe(() => { ac(); [659, 784, 880, 1047, 880, 784, 659, 784, 988, 1175].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.06, at: i * 0.28 })); }),
  power: safe(() => { ac(); [523, 784, 1047, 1568].forEach((f, i) => tone(f, 0.18, { type: 'square', vol: 0.07, at: i * 0.08 })); }),
  powerEnd: safe(() => { ac(); [784, 523].forEach((f, i) => tone(f, 0.2, { type: 'square', vol: 0.05, at: i * 0.12 })); }),
  rankUp: safe(() => { ac(); [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, i === 4 ? 0.6 : 0.14, { type: 'triangle', vol: 0.1, at: i * 0.11 })); }),
  victory: safe(() => { ac(); [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, 1.2, { type: 'triangle', vol: 0.08, at: i * 0.25 })); }),
  // Night wind: looping filtered noise that slowly breathes.
  ambience: safe(on => {
    ac();
    if (on && !audio._wind) {
      const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.6;
      const g = ctx.createGain(); g.gain.value = 0.05;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lg = ctx.createGain(); lg.gain.value = 0.035;
      lfo.connect(lg).connect(g.gain);
      src.connect(f).connect(g).connect(master);
      src.start(); lfo.start();
      audio._wind = { src, lfo };
    } else if (!on && audio._wind) {
      audio._wind.src.stop(); audio._wind.lfo.stop(); audio._wind = null;
    }
  }),
};
