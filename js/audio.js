// js/audio.js — PROJECT WINGNUT audio. Real recorded sound effects (CC0 / CC BY, see assets/sfx/LICENSES.md) are
// embedded as base64 Ogg Opus in js/sfx_data.js and decoded once, asynchronously, right after unlock(). They are
// layered with WebAudio synthesis (wind, sub rumble, warning tones, UI cues). Until the samples are decoded, or if
// decoding fails (e.g. a browser without Opus support), every sound uses its synthesized fallback. Nothing plays until
// unlock() is called from a user gesture; every method is a safe no-op before that (and after dispose()).
//
// Graph:  one-shot voices ─┐                                  ┌─► pauseGate ─┐
//         engine layers ───┼─► buses engine / sfx / warn ─────┘              ├─► master ─► limiter comp ─► trim ─► safety clip ─► out
//         warning tones ───┘   bus ui (never paused) ────────────────────────┘
// Engine layers: [sample roar | sample turbine | sample afterburner | synth whine/roar/thunder (fallback)] + synth sub
// rumble + soft low crackle ─► engine mix ─► low shelf ─► lowpass 2.3 kHz ─► engine bus; synth wind ─► engine bus.
import { SFX } from './sfx_data.js';

const MAX_VOICES = 24;           // simultaneous one-shot voices (gun, explosions, ui cues ...)
const GUN_MIN_INTERVAL = 0.035;  // s between gun voices
const GUN_LEVEL = 0.55;          // player cannon buzz level (sfx bus)
const GUN_RPS = 100;             // M61 Vulcan, 6000 rounds/min: the buzz's fundamental
const GUN_IDLE_RATE = 0.55;      // buzz playback rate while spun down (spin-up / spin-down glide between)
const GUN_IDLE_STOP = 1.5;       // s after the trigger is released before the buzz loop is stopped (its tail is long gone)
const WILHELM_COOLDOWN = 6;      // s between easter-egg screams
const NOISE_SECONDS = 2;         // length of the looped noise buffers
const SCHED_INTERVAL_MS = 80;    // JS timer for the beep scheduler
const SCHED_AHEAD = 0.35;        // s of audio-clock look-ahead scheduled per tick
const FLOOR = 0.0005;            // exponential ramps cannot reach 0
const ENGINE_TAU = 0.2;          // s, smoothing of throttle-driven engine params (throttle jumps 0.2 / 0.6 / 1.0)
const ENGINE_LEVEL = 1.4;        // engine bus gain while alive
// Master limiter: threshold -9 dB, knee 6, ratio 6. DynamicsCompressorNode adds automatic make-up gain
// (pow(1 / curve(0 dBFS), 0.6) in the WebKit/Blink/Gecko kernel = +3.31 dB for these settings); COMP_TRIM cancels it
// so the master chain is unity gain below the threshold and only ever turns loud peaks down.
const COMP_THRESHOLD = -9, COMP_KNEE = 6, COMP_RATIO = 6, COMP_TRIM = 0.6834;
const EMPTY_OPTS = Object.freeze({});
// Missiles. Player launches alternate hardpoint sides (stereo start LAUNCH_PAN, drifting to centre as the motor pulls
// ahead) with a Haas-delayed, darker copy on the far side for width. Other launches within REMOTE_LAUNCH_MAX m are heard
// distance-attenuated / dulled / delayed. Pass-by: FLYBY_PEAK must match tools/build_sfx.mjs (s from the start of
// SFX.missile_flyby to its closest-approach peak); a missile predicted to pass within FLYBY_RADIUS m inside the next
// FLYBY_LEAD s triggers it once, scheduled so the peak lands on the closest approach.
const LAUNCH_PAN = 0.45, HAAS_DELAY = 0.017, REMOTE_LAUNCH_MAX = 2500, REMOTE_LAUNCH_GAP = 0.15;
const FLYBY_PEAK = 0.42, FLYBY_RADIUS = 70, FLYBY_LEAD = 0.6, FLYBY_SCAN2 = 700 * 700, FLYBY_GAP = 0.2;

function clamp01(v) { return v > 1 ? 1 : v < 0 ? 0 : (v === v ? v : 0); } // NaN -> 0
function setP(param, v) { try { param.value = v; } catch (e) { /* ignore */ } }
function chain(...nodes) { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

/** Attack / (hold) / exponential-decay envelope on a gain AudioParam. */
function env(param, t0, peak, attack, decay, hold = 0) {
  const p = Math.max(peak, FLOOR);
  param.setValueAtTime(FLOOR, t0);
  param.linearRampToValueAtTime(p, t0 + attack);
  if (hold > 0) param.setValueAtTime(p, t0 + attack + hold);
  param.exponentialRampToValueAtTime(FLOOR, t0 + attack + hold + decay);
}
/** Click-free gate pulse: 0 -> level -> 0 over `dur` seconds starting at t. */
function beep(param, t, dur, level) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(level, t + 0.004);
  param.setValueAtTime(level, t + Math.max(0.005, dur - 0.006));
  param.linearRampToValueAtTime(0, t + dur);
}
/** Cancel pending automation and glide the param to `v` (no cancelAndHoldAtTime: missing in Firefox). */
function glideTo(param, now, v, dt = 0.01) {
  try { param.cancelScheduledValues(now); } catch (e) { /* ignore */ }
  let cur = param.value; if (!Number.isFinite(cur)) cur = 0;
  param.setValueAtTime(cur, now);
  param.linearRampToValueAtTime(v, now + dt);
}

/**
 * One second of M61 Vulcan fire, seamlessly loopable: GUN_RPS shots, each a short dark crack plus a damped low thump,
 * with slight timing and level jitter so it rips instead of humming. Tails past the end wrap into the head.
 */
function makeGunBuzz(ctx) {
  const sr = ctx.sampleRate, n = Math.floor(sr), per = n / GUN_RPS, len = Math.floor(sr * 0.03), raw = new Float32Array(n);
  for (let k = 0; k < GUN_RPS; k++) {
    const t0 = Math.round(k * per + (Math.random() - 0.5) * per * 0.12), a = 0.85 + Math.random() * 0.3;
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      lp += (Math.random() * 2 - 1 - lp) * 0.35;
      raw[(t0 + i + n) % n] += a * (lp * Math.exp(-t / 0.0018) + 0.8 * Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t / 0.006));
    }
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(raw[i]));
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i] * 0.9 / (peak || 1);
  return buf;
}

/** setTargetAtTime unless `p` already glides to (nearly) `v` with the same time constant: setEngine runs at ~40 Hz and
 *  most of its ~20 parameters hold still, so this keeps the automation event lists short. Allocation-free. */
function glide(p, v, now, tau) {
  const last = p._wnV;
  if (last !== undefined && p._wnTau === tau && Math.abs(v - last) <= 0.002 * Math.abs(v) + 1e-6) return;
  p._wnV = v; p._wnTau = tau;
  p.setTargetAtTime(v, now, tau);
}

function makeNoise(ctx, kind) {
  const sr = ctx.sampleRate, n = Math.max(4, Math.floor(sr * NOISE_SECONDS));
  // generate n + xf samples and fold the extra tail into the head: the loop wrap d[n-1] -> d[0] is then continuous
  // (no click every NOISE_SECONDS, which matters for the low-frequency brown/pink beds)
  const xf = Math.min(n >> 2, Math.floor(sr * 0.02)), m = n + xf, raw = new Float32Array(m);
  if (kind === 'white') {
    for (let i = 0; i < m; i++) raw[i] = Math.random() * 2 - 1;
  } else if (kind === 'pink') { // Paul Kellet's refined pink filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < m; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  } else { // brown: leaky integrator of white
    let last = 0;
    for (let i = 0; i < m; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; raw[i] = last * 3.5; }
  }
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i];
  for (let i = 0; i < xf; i++) { const t = i / xf; d[i] = raw[i] * t + raw[n + i] * (1 - t); }
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  if (peak > 0) { const k = 0.9 / peak; for (let i = 0; i < n; i++) d[i] *= k; }
  return buf;
}
function loopSource(ctx, buffer) {
  const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.loopStart = 0; s.loopEnd = buffer.duration; return s;
}
function makeSoftClipCurve() {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(2.5 * x); }
  return c;
}
/** Output safety stage: transparent below 0.8, smooth knee above, never exceeds ~0.95 (no hard digital clipping). */
function makeSafetyCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
  }
  return c;
}
function b64ToArrayBuffer(b64) {
  const bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}
/** decodeAudioData as a promise, also for the old callback-only Safari signature. */
function decodeAudio(ctx, ab) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = (b) => { if (!done) { done = true; if (b) resolve(b); else reject(new Error('empty buffer')); } };
    const bad = (e) => { if (!done) { done = true; reject(e || new Error('decode failed')); } };
    try { const p = ctx.decodeAudioData(ab, ok, bad); if (p && typeof p.then === 'function') p.then(ok, bad); } catch (e) { bad(e); }
  });
}
const nextTick = () => new Promise((r) => setTimeout(r, 0));

// UI cue note lists: t = onset (s), f = Hz (f2 = glide target), d = length, w = waveform, lp = lowpass Hz, g = level
const UI_CUES = {
  select: [{ t: 0, f: 880, d: 0.05, g: 0.25 }, { t: 0.07, f: 1320, d: 0.06, g: 0.25 }],
  start: [{ t: 0, f: 523.25, d: 0.11 }, { t: 0.11, f: 659.25, d: 0.11 }, { t: 0.22, f: 783.99, d: 0.32 }],
  kill: [{ t: 0, f: 1567.98, d: 0.12, w: 'sine' }, { t: 0.1, f: 1174.66, d: 0.12, w: 'sine' }, { t: 0.2, f: 987.77, d: 0.36, w: 'sine' }],
  wave: [{ t: 0, f: 523.25, d: 0.12, w: 'square', lp: 2500, g: 0.16 }, { t: 0.14, f: 659.25, d: 0.12, w: 'square', lp: 2500, g: 0.16 },
    { t: 0.28, f: 783.99, d: 0.12, w: 'square', lp: 2500, g: 0.16 }, { t: 0.42, f: 1046.5, d: 0.5, w: 'square', lp: 2500, g: 0.18 }],
  dead: [{ t: 0, f: 220, f2: 55, d: 1.3, w: 'sawtooth', lp: 900, lp2: 180, g: 0.35 }],
};

export class AudioFX {
  constructor() {
    this.ready = false;        // true once the AudioContext + graph exist (unlock() succeeded)
    this.ctx = null;
    this._disposed = false;
    this._masterVol = 0.6;
    this._paused = false;
    this._voices = [];         // one-shot voice records { end, nodes[] }
    this._lastGun = -1;
    this._gunOn = false;
    this._lastWilhelm = -1e9;
    this._lastBlast = null;    // outputs of the newest explosion voice, for spareLastBlast()
    this._lockState = 'none';
    this._missileWarnOn = false;
    this._mslSide = 1;         // hardpoint side of the next player launch (+1 right / -1 left), alternates
    this._lastRemoteLaunch = -1;
    this._lastFlyby = -1;
    this._pullUpOn = false;
    this._schedTimer = 0;
    this._engineLast = -1;
    this._engineAlive = true;
    this._engineSamples = false; // true once the sampled engine loops replaced the synthesized layers
    this._abOn = false;
    this._crackleNext = 0;
    this._thunderNext = 0;
    this._thunderMod = 1;
    this._gustNext = 0;
    this._gust = 1;
    this._nodes = null;
    this._buffers = null;
    // decoded samples: name -> [{ buffer, gain, loopStart, loopEnd }]
    this._sfx = null;
    this._sfxState = 'none';   // 'none' | 'loading' | 'ready' | 'failed'
    this._sfxCounts = { decoded: 0, failed: 0, total: 0 };
    this._lastVariant = Object.create(null);
    let resolve = null;
    this._sfxDone = new Promise((r) => { resolve = r; });
    this._sfxResolve = resolve;
  }

  /** True when the context is actually producing sound (not suspended by autoplay policy). */
  get running() { return !!(this.ctx && this.ctx.state === 'running'); }
  /** Number of one-shot voices currently alive (debug / HUD). */
  get activeVoices() {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime; let n = 0;
    for (const v of this._voices) if (v.end > now) n++;
    return n;
  }
  /** True while setPaused(true) is in effect. */
  get paused() { return this._paused; }
  /** True once every embedded sample has been decoded (individual sounds switch over as soon as they are ready). */
  get samplesReady() { return this._sfxState === 'ready'; }
  /** { state: 'none'|'loading'|'ready'|'failed', decoded, failed, total } */
  get sampleStatus() { return { state: this._sfxState, decoded: this._sfxCounts.decoded, failed: this._sfxCounts.failed, total: this._sfxCounts.total }; }
  /** Promise resolving to { decoded, failed } once sample decoding has finished (after unlock()). */
  whenSamplesReady() { return this._sfxDone; }

  /** Create/resume the AudioContext and build the persistent graph. Call from a user gesture; safe to call repeatedly. */
  unlock() {
    if (this._disposed) return;
    if (!this.ctx) {
      const g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
      const AC = g && (g.AudioContext || g.webkitAudioContext);
      if (!AC) return;
      let ctx = null;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; } }
      if (!ctx) return;
      this.ctx = ctx;
      try { this._buildGraph(); } catch (e) {
        this.ctx = null; this._nodes = null; this._buffers = null;
        try { const p = ctx.close(); if (p && p.catch) p.catch(() => {}); } catch (e2) { /* ignore */ }
        return;
      }
      this.ready = true;
      this._loadSamples();     // async, non-blocking; sounds switch from synth to samples as they decode
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { const p = ctx.resume(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Persistent graph
  // ---------------------------------------------------------------------------------------------------------------
  _buildGraph() {
    const ctx = this.ctx;
    const N = this._nodes = {};
    N.master = ctx.createGain(); N.master.gain.value = this._masterVol;
    // gentle limiter (make-up gain cancelled by compTrim) and a soft safety clipper: headroom, never digital clipping
    N.comp = ctx.createDynamicsCompressor();
    setP(N.comp.threshold, COMP_THRESHOLD); setP(N.comp.knee, COMP_KNEE); setP(N.comp.ratio, COMP_RATIO);
    setP(N.comp.attack, 0.003); setP(N.comp.release, 0.2);
    N.compTrim = ctx.createGain(); N.compTrim.gain.value = COMP_TRIM;
    N.safety = ctx.createWaveShaper(); N.safety.curve = makeSafetyCurve(); try { N.safety.oversample = 'none'; } catch (e) { /* ignore */ }
    chain(N.master, N.comp, N.compTrim, N.safety, ctx.destination);
    // game buses go through the pause gate; the UI bus (menu clicks) and anything routed straight into master do not
    // effects volume (settings) sits after the pause gate; the radio (AWACS) and UI bypass both
    N.fxVol = ctx.createGain(); N.fxVol.gain.value = this._fxVol ?? 1; N.fxVol.connect(N.master);
    N.pauseGate = ctx.createGain(); N.pauseGate.gain.value = this._paused ? 0 : 1; N.pauseGate.connect(N.fxVol);
    N.engineBus = ctx.createGain(); N.engineBus.gain.value = 0; N.engineBus.connect(N.pauseGate);
    N.sfxBus = ctx.createGain(); N.sfxBus.gain.value = 1.15; N.sfxBus.connect(N.pauseGate);
    N.warnBus = ctx.createGain(); N.warnBus.gain.value = 0.45; N.warnBus.connect(N.pauseGate);
    N.uiBus = ctx.createGain(); N.uiBus.gain.value = 0.7; N.uiBus.connect(N.master);
    // soft clipper for near-explosion "overload crunch" (synth fallback only)
    N.crunch = ctx.createWaveShaper(); N.crunch.curve = makeSoftClipCurve(); try { N.crunch.oversample = 'none'; } catch (e) { /* ignore */ }
    N.crunchGain = ctx.createGain(); N.crunchGain.gain.value = 0.8;
    N.crunch.connect(N.crunchGain); N.crunchGain.connect(N.sfxBus);
    this._buffers = { white: makeNoise(ctx, 'white'), pink: makeNoise(ctx, 'pink'), brown: makeNoise(ctx, 'brown') };
    this._buildEngine();
    this._buildWarnings();
    this._buildGun();
  }

  /** Player cannon: a looped Vulcan buzz gated by gunLoop(). Spin-up / spin-down glide its rate. The looping source
   *  only exists while the gun is in use (_gunSource): GUN_IDLE_STOP s after the last burst it is stopped and dropped. */
  _buildGun() {
    const ctx = this.ctx, G = this._nodes.gun = {};
    G.buffer = makeGunBuzz(ctx); G.src = null; G.offAt = 0;
    G.body = ctx.createBiquadFilter(); G.body.type = 'peaking'; G.body.frequency.value = 160; G.body.Q.value = 0.8; G.body.gain.value = 5;
    G.tone = ctx.createBiquadFilter(); G.tone.type = 'lowpass'; G.tone.frequency.value = 3200; G.tone.Q.value = 0.6;
    G.shape = ctx.createWaveShaper(); G.shape.curve = makeSoftClipCurve();
    G.gain = ctx.createGain(); G.gain.gain.value = 0;
    chain(G.body, G.tone, G.shape, G.gain, this._nodes.sfxBus);
  }
  _gunSource() {
    const G = this._nodes.gun;
    if (G.src) return G.src;
    const s = G.src = this.ctx.createBufferSource(); s.buffer = G.buffer; s.loop = true; s.playbackRate.value = GUN_IDLE_RATE;
    s.connect(G.body);
    try { s.start(this.ctx.currentTime, Math.random() * 0.9); } catch (e) { /* ignore */ }
    return s;
  }

  _buildEngine() {
    const ctx = this.ctx, N = this._nodes, B = this._buffers;
    const E = N.engine = {};
    // engine mix: everything except wind -> low shelf (weight) -> lowpass (no hiss/static above ~2 kHz) -> engine bus
    E.mix = ctx.createGain(); E.mix.gain.value = 1;
    E.tone = ctx.createBiquadFilter(); E.tone.type = 'lowshelf'; E.tone.frequency.value = 120; E.tone.gain.value = 3;
    E.toneLP = ctx.createBiquadFilter(); E.toneLP.type = 'lowpass'; E.toneLP.frequency.value = 2300; E.toneLP.Q.value = 0.6;
    chain(E.mix, E.tone, E.toneLP, N.engineBus);
    // a) turbine whine (synth fallback, kept well under the roar): two detuned oscillators -> bandpass -> gain (+ whistle)
    E.whineOsc1 = ctx.createOscillator(); E.whineOsc1.type = 'sawtooth'; E.whineOsc1.frequency.value = 90;
    E.whineOsc2 = ctx.createOscillator(); E.whineOsc2.type = 'triangle'; E.whineOsc2.frequency.value = 90 * 1.012;
    E.whistle = ctx.createOscillator(); E.whistle.type = 'sine'; E.whistle.frequency.value = 90 * 9;
    E.whineBP = ctx.createBiquadFilter(); E.whineBP.type = 'bandpass'; E.whineBP.frequency.value = 220; E.whineBP.Q.value = 1.0;
    E.whineGain = ctx.createGain(); E.whineGain.gain.value = 0;
    E.whistleGain = ctx.createGain(); E.whistleGain.gain.value = 0;
    E.whineOsc1.connect(E.whineBP); E.whineOsc2.connect(E.whineBP); chain(E.whineBP, E.whineGain, E.mix);
    chain(E.whistle, E.whistleGain, E.mix);
    // b) exhaust roar (synth fallback): pink noise -> lowpass (160..900 Hz) -> gain
    E.roarSrc = loopSource(ctx, B.pink);
    E.roarLP = ctx.createBiquadFilter(); E.roarLP.type = 'lowpass'; E.roarLP.frequency.value = 200; E.roarLP.Q.value = 0.7;
    E.roarGain = ctx.createGain(); E.roarGain.gain.value = 0;
    chain(E.roarSrc, E.roarLP, E.roarGain, E.mix);
    // c) afterburner thunder (synth fallback): brown noise -> lowpass 240 Hz -> gain (slow random swell in setEngine)
    E.abSrc = loopSource(ctx, B.brown);
    E.abLP = ctx.createBiquadFilter(); E.abLP.type = 'lowpass'; E.abLP.frequency.value = 240; E.abLP.Q.value = 0.9;
    E.abGain = ctx.createGain(); E.abGain.gain.value = 0;
    chain(E.abSrc, E.abLP, E.abGain, E.mix);
    // d) soft, low crackle under the afterburner (both modes): white -> bandpass 420 Hz -> lowpass 900 Hz -> pop gate
    E.crackleSrc = loopSource(ctx, B.white);
    E.crackleHP = ctx.createBiquadFilter(); E.crackleHP.type = 'bandpass'; E.crackleHP.frequency.value = 420; E.crackleHP.Q.value = 0.8;
    E.crackleLP = ctx.createBiquadFilter(); E.crackleLP.type = 'lowpass'; E.crackleLP.frequency.value = 900; E.crackleLP.Q.value = 0.5;
    E.crackleGate = ctx.createGain(); E.crackleGate.gain.value = 0;
    E.crackleGain = ctx.createGain(); E.crackleGain.gain.value = 0;
    chain(E.crackleSrc, E.crackleHP, E.crackleLP, E.crackleGate, E.crackleGain, E.mix);
    // e) sub rumble (both modes): brown noise -> lowpass 70..120 Hz -> gain
    E.subSrc = loopSource(ctx, B.brown);
    E.subLP = ctx.createBiquadFilter(); E.subLP.type = 'lowpass'; E.subLP.frequency.value = 80; E.subLP.Q.value = 0.8;
    E.subGain = ctx.createGain(); E.subGain.gain.value = 0;
    chain(E.subSrc, E.subLP, E.subGain, E.mix);
    // f) wind (both modes): pink noise -> two lowpasses (280..930 Hz) -> gain; a soft whoosh, never a hiss
    E.windSrc = loopSource(ctx, B.pink);
    E.windBP = ctx.createBiquadFilter(); E.windBP.type = 'lowpass'; E.windBP.frequency.value = 300; E.windBP.Q.value = 0.6;
    E.windLP = ctx.createBiquadFilter(); E.windLP.type = 'lowpass'; E.windLP.frequency.value = 1000; E.windLP.Q.value = 0.5;
    E.windGain = ctx.createGain(); E.windGain.gain.value = 0;
    chain(E.windSrc, E.windBP, E.windLP, E.windGain, N.engineBus);
    const t = ctx.currentTime;
    for (const o of [E.whineOsc1, E.whineOsc2, E.whistle]) { try { o.start(t); } catch (e) { /* ignore */ } }
    for (const s of [E.roarSrc, E.abSrc, E.crackleSrc, E.subSrc, E.windSrc]) { try { s.start(t, Math.random() * (NOISE_SECONDS - 0.1)); } catch (e) { /* ignore */ } }
  }

  /** Swap the synthesized engine core for the sampled loops (called once the engine samples are decoded). */
  _attachEngineSamples() {
    const S = this._sfx, N = this._nodes;
    if (this._engineSamples || !S || !N || !N.engine || !S.engine) return;
    const ctx = this.ctx, E = N.engine, t = ctx.currentTime + 0.02;
    const make = (rec) => {
      if (!rec) return null;
      const s = ctx.createBufferSource(); s.buffer = rec.buffer; s.loop = true;
      s.loopStart = rec.loopStart; s.loopEnd = rec.loopEnd > rec.loopStart ? rec.loopEnd : rec.buffer.duration;
      const g = ctx.createGain(); g.gain.value = 0; s.connect(g); g.connect(E.mix);
      try { s.start(t, s.loopStart + Math.random() * 0.9 * (s.loopEnd - s.loopStart)); } catch (e) { /* ignore */ }
      return [s, g];
    };
    const r = make(S.engine[0]), tb = make(S.engine_turbine && S.engine_turbine[0]), ab = make(S.afterburner && S.afterburner[0]);
    E.sRoarSrc = r[0]; E.sRoarGain = r[1]; E.sRoarLevel = S.engine[0].gain;
    if (tb) { E.sTurbSrc = tb[0]; E.sTurbGain = tb[1]; E.sTurbLevel = S.engine_turbine[0].gain; }
    if (ab) { E.sAbSrc = ab[0]; E.sAbGain = ab[1]; E.sAbLevel = S.afterburner[0].gain; }
    this._engineSamples = true;
    this._engineLast = -1;     // apply the new mix on the next setEngine() call (smoothed crossfade from the synth layers)
    // the synthesized whine / whistle / roar fade out (setEngine) and are then stopped and unplugged for good
    E.synthEnd = t + 10 * ENGINE_TAU;
    for (const o of [E.whineOsc1, E.whineOsc2, E.whistle, E.roarSrc]) { try { o.stop(E.synthEnd); } catch (e) { /* ignore */ } }
    E.roarSrc.onended = () => { for (const n of [E.whineBP, E.whineGain, E.whistleGain, E.roarLP, E.roarGain]) { try { n.disconnect(); } catch (e) { /* ignore */ } } };
  }

  /**
   * Continuous engine mix. Call every frame; parameters are smoothed with setTargetAtTime (~0.2 s, so throttle jumps
   * between brake / cruise / boost glide instead of stepping) and automation events are rate-limited to ~40 Hz and posted
   * only for parameters whose target moved (glide).
   * alive=false fades the whole engine out over ~1 s. Allocation-free.
   */
  setEngine(opts) {
    if (!this.ready || !this._nodes || !this._nodes.engine) return;
    const o = opts || EMPTY_OPTS;
    const thr = clamp01(+o.throttle || 0), spd = clamp01(+o.speedFrac || 0);
    const ab = !!o.afterburner, alive = o.alive !== false;
    const ctx = this.ctx, E = this._nodes.engine, N = this._nodes, now = ctx.currentTime;
    if (now - this._engineLast < 0.025 && alive === this._engineAlive && ab === this._abOn) return;
    this._engineLast = now; this._engineAlive = alive;
    const TAU = ENGINE_TAU, TAB = 0.25;
    // afterburner "thunder": slow random swells (rolling), shared by the sampled and synthesized afterburner layers
    if (ab) {
      if (now >= this._thunderNext) { this._thunderMod = 0.78 + 0.44 * Math.random(); this._thunderNext = now + 0.14 + 0.24 * Math.random(); }
    } else this._thunderMod = 1;
    const abLevel = ab ? this._thunderMod : 0;
    if (this._engineSamples) {
      const sr = 0.84 + 0.28 * thr + 0.05 * spd;                            // deep turbofan roar: pitch & level with throttle
      glide(E.sRoarSrc.playbackRate, sr, now, TAU);
      glide(E.sRoarGain.gain, E.sRoarLevel * (0.2 + 0.3 * thr), now, TAU);
      if (E.sTurbSrc) {                                                     // turbine body under the roar, spools faster
        glide(E.sTurbSrc.playbackRate, 0.78 + 0.46 * thr + 0.04 * spd, now, TAU);
        glide(E.sTurbGain.gain, E.sTurbLevel * (0.1 + 0.16 * thr), now, TAU);
      }
      if (E.sAbSrc) {
        glide(E.sAbSrc.playbackRate, 0.94 + 0.08 * thr, now, TAU);
        glide(E.sAbGain.gain, E.sAbLevel * 0.42 * abLevel, now, ab ? 0.12 : TAB);
      }
      if (now < E.synthEnd) {                                               // synthesized core fades out (then is stopped)
        glide(E.whineGain.gain, 0, now, TAU); glide(E.whistleGain.gain, 0, now, TAU); glide(E.roarGain.gain, 0, now, TAU);
      }
      glide(E.abGain.gain, 0.1 * abLevel, now, ab ? 0.12 : TAB);   // a little extra synthetic low thunder
    } else {
      const f = 70 + 230 * thr + 20 * spd;                                  // turbine fundamental 70..320 Hz
      glide(E.whineOsc1.frequency, f, now, TAU);
      glide(E.whineOsc2.frequency, f * 1.012, now, TAU);
      glide(E.whistle.frequency, f * 7, now, TAU);
      glide(E.whineBP.frequency, f * 2.2, now, TAU);
      glide(E.whineGain.gain, 0.005 + 0.014 * thr, now, TAU);
      glide(E.whistleGain.gain, 0.0005 + 0.0015 * thr * thr, now, TAU);
      glide(E.roarLP.frequency, 160 + 560 * thr + 180 * spd, now, TAU);
      glide(E.roarGain.gain, 0.1 + 0.26 * thr, now, TAU);
      glide(E.abGain.gain, 0.6 * abLevel, now, ab ? 0.12 : TAB);
    }
    // sub rumble (both modes): grows with throttle, big push with the afterburner
    glide(E.subLP.frequency, 70 + 50 * thr, now, TAU);
    glide(E.subGain.gain, 0.04 + 0.06 * thr + (ab ? 0.08 : 0), now, ab ? 0.15 : TAU);
    // soft low crackle under the afterburner: sparse pops on a 420 Hz band, quiet
    glide(E.crackleGain.gain, ab ? 0.05 : 0, now, TAB);
    if (ab) {
      if (now >= this._crackleNext) {
        const level = Math.random() < 0.45 ? 0 : 0.35 + 0.65 * Math.random();
        glide(E.crackleGate.gain, level, now, 0.008);
        this._crackleNext = now + 0.03 + Math.random() * 0.07;
      }
    } else this._crackleNext = 0;
    this._abOn = ab;
    // wind: low-passed whoosh with slow gusts; never more than a soft bed under the engine
    if (now >= this._gustNext) { this._gust = 0.75 + 0.5 * Math.random(); this._gustNext = now + 0.4 + 0.6 * Math.random(); }
    glide(E.windBP.frequency, 280 + 650 * spd, now, 0.3);
    glide(E.windGain.gain, (0.01 + 0.05 * spd * spd) * this._gust, now, 0.35);
    glide(N.engineBus.gain, alive ? ENGINE_LEVEL : 0, now, alive ? 0.15 : 0.3); // dead: ~1 s fade-out
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pause
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Pause / resume game audio: engine, wind, sfx and warning buses ramp to silence in ~80 ms (back up in ~120 ms on
   * resume). The UI bus (menu clicks) and anything routed straight into the master (AWACS radio) stay audible.
   * New one-shots are ignored while paused. Idempotent; remembered if called before unlock().
   */
  setPaused(on) {
    on = !!on;
    if (on === this._paused) return;
    this._paused = on;
    if (on) this.gunLoop(false);
    if (!this.ready || !this._nodes) return;
    glideTo(this._nodes.pauseGate.gain, this.ctx.currentTime, on ? 0 : 1, on ? 0.08 : 0.12);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Samples
  // ---------------------------------------------------------------------------------------------------------------
  /** Decode every embedded sample once (async; started by unlock()). Sounds switch over individually as they land. */
  _loadSamples() {
    if (this._sfxState !== 'none' || !this.ctx) return this._sfxDone;
    this._sfxState = 'loading';
    const ctx = this.ctx, out = this._sfx = Object.create(null), counts = this._sfxCounts;
    const names = Object.keys(SFX || {});
    for (const name of names) counts.total += Array.isArray(SFX[name]) ? SFX[name].length : 1;
    (async () => {
      for (const name of names) {
        const def = SFX[name], list = Array.isArray(def) ? def : [def], recs = [];
        for (const d of list) {
          if (this._disposed || this.ctx !== ctx) break;
          try {
            const buffer = await decodeAudio(ctx, b64ToArrayBuffer(d.data));
            if (this._disposed || this.ctx !== ctx) break;
            recs.push({ buffer, gain: typeof d.gain === 'number' ? d.gain : 1, loopStart: +d.loopStart || 0, loopEnd: +d.loopEnd || buffer.duration });
            counts.decoded++;
          } catch (e) { counts.failed++; }
        }
        if (this._disposed || this.ctx !== ctx) break;
        if (recs.length) out[name] = recs;
        if (out.engine && !this._engineSamples && name !== 'engine' && (out.engine_turbine || !SFX.engine_turbine) && (out.afterburner || !SFX.afterburner)) this._attachEngineSamples();
        await nextTick();      // keep the main thread responsive between files
      }
      if (!this._disposed && this.ctx === ctx) {
        if (out.engine && !this._engineSamples) this._attachEngineSamples();
        this._sfxState = counts.decoded > 0 ? 'ready' : 'failed';
      }
      this._sfxResolve({ decoded: counts.decoded, failed: counts.failed });
    })().catch(() => { this._sfxState = 'failed'; this._sfxResolve({ decoded: counts.decoded, failed: counts.failed }); });
    return this._sfxDone;
  }
  /** Pick a variant index, avoiding immediate repeats. */
  _pick(name, list) {
    const n = list.length; if (n <= 1) return 0;
    const last = this._lastVariant[name];
    let i = Math.floor(Math.random() * n);
    if (i === last) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this._lastVariant[name] = i;
    return i;
  }
  /** Play one decoded sample record as a bounded voice. Returns { v, src, g, f } or null (voice budget exhausted). */
  _sample(rec, t0, rate, gain, dest, lowpass = 0, lowPriority = false) {
    const ctx = this.ctx, dur = rec.buffer.duration / rate;
    const v = this._voice(t0 + dur + 0.05, lowPriority);
    if (!v) return null;
    const src = ctx.createBufferSource(); src.buffer = rec.buffer; src.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = gain * rec.gain;
    v.nodes.push(src, g);
    let f = null;
    if (lowpass > 0) { f = this._filter(v, 'lowpass', lowpass, 0.7); chain(src, f, g); } else src.connect(g);
    g.connect(dest);
    src.start(t0);
    this._finish(v, src);
    return { v, src, g, f };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // One-shot voice helpers (bounded: MAX_VOICES simultaneous)
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Reserve a voice that ends at audio time `end`; null when the budget is exhausted. Low-priority voices
   * (distant explosions, which sit in the queue for their whole propagation delay) may only use half the budget
   * so they can never starve gunfire / hits / UI cues.
   */
  _voice(end, lowPriority = false) {
    const now = this.ctx.currentTime, V = this._voices;
    for (let i = V.length - 1; i >= 0; i--) if (V[i].end <= now) { V[i] = V[V.length - 1]; V.pop(); }
    if (V.length >= (lowPriority ? MAX_VOICES >> 1 : MAX_VOICES)) return null;
    const v = { end, nodes: [] };
    V.push(v);
    return v;
  }
  /** When the voice's longest source ends, disconnect its nodes so the graph never accumulates garbage. */
  _finish(v, src) {
    src.onended = () => { for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } } v.nodes.length = 0; v.end = 0; };
  }
  _osc(v, type, freq, t0, t1) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    v.nodes.push(o); o.start(t0); o.stop(t1); return o;
  }
  _noise(v, kind, t0, t1, rate = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = this._buffers[kind]; s.loop = true; s.playbackRate.value = rate;
    v.nodes.push(s); s.start(t0, Math.random() * (NOISE_SECONDS - 0.1)); s.stop(t1); return s;
  }
  _filter(v, type, freq, Q) {
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (Q !== undefined) f.Q.value = Q;
    v.nodes.push(f); return f;
  }
  _gain(v, value) { const g = this.ctx.createGain(); g.gain.value = value; v.nodes.push(g); return g; }

  // ---------------------------------------------------------------------------------------------------------------
  // One-shots (sample when decoded, synthesized fallback otherwise). Ignored while paused.
  // ---------------------------------------------------------------------------------------------------------------
  /**
   * Player cannon trigger state, called every frame: true while rounds are going out. Spins the Vulcan buzz up
   * (~60 ms to full rate) and back down with a short tail on release. Idempotent.
   */
  gunLoop(on) {
    on = !!on && !this._paused;
    if (!this.ready || !this._nodes) return;
    const G = this._nodes.gun, now = this.ctx.currentTime;
    if (on === this._gunOn) {
      // idle well past the release tail: stop the loop (no buzz chain running between bursts)
      if (!on && G.src && now - G.offAt > GUN_IDLE_STOP) { try { G.src.stop(); } catch (e) { /* ignore */ } try { G.src.disconnect(); } catch (e) { /* ignore */ } G.src = null; }
      return;
    }
    this._gunOn = on;
    if (!on) G.offAt = now;
    const r = (on ? this._gunSource() : G.src || this._gunSource()).playbackRate, g = G.gain.gain;
    for (const p of [r, g]) { try { p.cancelScheduledValues(now); } catch (e) { /* ignore */ } p.setValueAtTime(p.value, now); }
    if (on) { r.setTargetAtTime(1, now, 0.05); g.setTargetAtTime(GUN_LEVEL, now, 0.012); }
    else { r.setTargetAtTime(GUN_IDLE_RATE, now, 0.1); g.setTargetAtTime(0, now + 0.015, 0.06); }
  }

  /** Per round fired. Rate-limited to one voice per 35 ms; slight random pitch so bursts don't sound robotic. */
  gunFire() {
    if (!this.ready || this._paused) return;
    const now = this.ctx.currentTime;
    if (now - this._lastGun < GUN_MIN_INTERVAL) return;
    this._lastGun = now;
    const S = this._sfx && this._sfx.gun;
    if (S) { this._sample(S[this._pick('gun', S)], now, 0.94 + Math.random() * 0.12, 0.9 + Math.random() * 0.1, this._nodes.sfxBus); return; }
    const t0 = now, v = this._voice(t0 + 0.1);
    if (!v) return;
    const S2 = this._nodes.sfxBus, pitch = 0.9 + Math.random() * 0.2;
    const n = this._noise(v, 'white', t0, t0 + 0.1, pitch);
    const bp = this._filter(v, 'bandpass', 950 * pitch, 0.9);
    const lp = this._filter(v, 'lowpass', 3500, 0.7);
    const g = this._gain(v, 0); chain(n, bp, lp, g, S2);
    env(g.gain, t0, 0.5, 0.002, 0.058);
    const o = this._osc(v, 'sine', 120 * pitch, t0, t0 + 0.1);
    o.frequency.exponentialRampToValueAtTime(65, t0 + 0.06);
    const og = this._gain(v, 0); chain(o, og, S2);
    env(og.gain, t0, 0.5, 0.002, 0.06);
    this._finish(v, o);
  }

  /** Stereo panner on a voice (a plain gain where StereoPannerNode is missing: mono). */
  _panner(v, pan) {
    const ctx = this.ctx;
    if (typeof ctx.createStereoPanner !== 'function') return this._gain(v, 1);
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); v.nodes.push(p); return p;
  }

  /**
   * Missile launch: soft ignition thump, then a dark roar and air-rush whoosh tearing away (doppler drop and
   * lowpass recession baked into SFX.missile). distance 0 = the player's own shot (alternating hardpoint side, Haas
   * width); distance > 0 m = someone else's launch (attenuated, dulled, delayed by distance/340 s, low priority, panned
   * by `pan` -1..1). Launches further than REMOTE_LAUNCH_MAX are silent.
   */
  missileLaunch(distance = 0, pan = 0) {
    if (!this.ready || this._paused) return;
    let d = +distance; if (!(d > 0)) d = 0;
    const now = this.ctx.currentTime, S = this._sfx && this._sfx.missile, B = this._nodes.sfxBus;
    if (d > 0) {
      if (d > REMOTE_LAUNCH_MAX || !S || now - this._lastRemoteLaunch < REMOTE_LAUNCH_GAP) return;
      this._lastRemoteLaunch = now;
      const rec = S[this._pick('missile', S)], rate = 0.93 + Math.random() * 0.1, t0 = now + Math.min(d / 340, 2);
      const v = this._voice(t0 + rec.buffer.duration / rate + 0.05, true);
      if (!v) return;
      const src = this.ctx.createBufferSource(); src.buffer = rec.buffer; src.playbackRate.value = rate; v.nodes.push(src);
      const lp = this._filter(v, 'lowpass', Math.max(600, 16000 / (1 + d / 250)), 0.7);
      const g = this._gain(v, rec.gain * 0.85 * Math.max(0.05, Math.min(1, Math.pow(120 / Math.max(d, 120), 0.75))));
      chain(src, lp, g, this._panner(v, pan * 0.8), B);
      src.start(t0); this._finish(v, src);
      return;
    }
    const t0 = now;
    if (S) {
      const rec = S[this._pick('missile', S)], rate = 0.96 + Math.random() * 0.08, dur = rec.buffer.duration / rate;
      const side = this._mslSide; this._mslSide = -side;
      const v = this._voice(t0 + dur + HAAS_DELAY + 0.05);
      if (!v) return;
      const src = this.ctx.createBufferSource(); src.buffer = rec.buffer; src.playbackRate.value = rate; v.nodes.push(src);
      const g = this._gain(v, rec.gain), p = this._panner(v, side * LAUNCH_PAN);
      chain(src, g, p, B);
      if (p.pan) { p.pan.setValueAtTime(side * LAUNCH_PAN, t0 + 0.05); p.pan.linearRampToValueAtTime(side * 0.08, t0 + 0.8); }
      // width / space: a short-delayed, darker copy on the far side (Haas: still localised to the near side)
      const dl = this.ctx.createDelay(0.05); dl.delayTime.value = HAAS_DELAY; v.nodes.push(dl);
      const lp = this._filter(v, 'lowpass', 2800, 0.6), g2 = this._gain(v, rec.gain * 0.38);
      chain(src, dl, lp, g2, this._panner(v, -side * 0.7), B);
      src.start(t0); this._finish(v, src);
      return;
    }
    const dur = 1.2, v = this._voice(t0 + dur + 0.05);
    if (!v) return;
    const S2 = this._nodes.sfxBus;
    const n = this._noise(v, 'pink', t0, t0 + dur + 0.05, 1);
    const lp = this._filter(v, 'lowpass', 200, 1.2);
    lp.frequency.setValueAtTime(200, t0);
    lp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.22);
    lp.frequency.exponentialRampToValueAtTime(600, t0 + dur);
    const g = this._gain(v, 0); chain(n, lp, g, S2);
    g.gain.setValueAtTime(FLOOR, t0);
    g.gain.linearRampToValueAtTime(0.9, t0 + 0.06);
    g.gain.setValueAtTime(0.9, t0 + 0.3);
    g.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur);
    const o = this._osc(v, 'sine', 90, t0, t0 + 0.5);
    o.frequency.exponentialRampToValueAtTime(45, t0 + 0.4);
    const og = this._gain(v, 0); chain(o, og, S2);
    env(og.gain, t0, 0.6, 0.01, 0.4);
    this._finish(v, n);
  }

  /** Someone else's missile launch heard from the camera: distance and stereo side from world position `pos`. */
  missileLaunchAt(pos, camera) {
    if (!this.ready || this._paused || !pos || !camera) return;
    const c = camera.position, dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > REMOTE_LAUNCH_MAX) return;
    const e = camera.matrixWorld.elements;      // column 0 = camera right
    this.missileLaunch(Math.max(d, 40), (dx * e[0] + dy * e[1] + dz * e[2]) / Math.max(d, 1));
  }

  /**
   * Missile pass-by whoosh. `lead` s until closest approach, `miss` m closest distance, pan at closest approach and
   * `sweep` (-1..1, the pan direction the missile crosses in). No synthesized fallback (silent until decoded).
   */
  missileFlyby(lead, miss, pan = 0, sweep = 0) {
    if (!this.ready || this._paused) return;
    const S = this._sfx && this._sfx.missile_flyby, now = this.ctx.currentTime;
    if (!S || now - this._lastFlyby < FLYBY_GAP) return;
    this._lastFlyby = now;
    const rec = S[this._pick('missile_flyby', S)], off = Math.max(0, FLYBY_PEAK - lead), t0 = now + Math.max(0, lead - FLYBY_PEAK);
    const rest = rec.buffer.duration - off, v = this._voice(t0 + rest + 0.05);
    if (!v || rest <= 0.1) return;
    const src = this.ctx.createBufferSource(); src.buffer = rec.buffer; v.nodes.push(src);
    const k = Math.max(0, Math.min(1, miss / FLYBY_RADIUS));
    const g = this._gain(v, rec.gain * (1.1 - 0.75 * k)), lp = this._filter(v, 'lowpass', 18000 - 12000 * k, 0.7);
    const P = (x) => Math.max(-1, Math.min(1, x)), pk = P(pan), p = this._panner(v, P(pk - 0.6 * sweep));
    chain(src, lp, g, p, this._nodes.sfxBus);
    if (p.pan) {
      const tp = t0 + FLYBY_PEAK - off;
      if (tp > t0) { p.pan.setValueAtTime(P(pk - 0.6 * sweep), t0); p.pan.linearRampToValueAtTime(pk, tp); } else p.pan.setValueAtTime(pk, t0);
      p.pan.linearRampToValueAtTime(P(pk + 0.7 * sweep), Math.max(tp, t0) + 0.5);
    }
    src.start(t0, off); this._finish(v, src);
  }

  /**
   * Once per frame: find missiles (not the player's own) about to pass close to the player and fire missileFlyby.
   * Closest-point-of-approach from relative position / velocity; allocation-free, a few flops per missile.
   */
  trackMissiles(missiles, player, camera) {
    if (!this.ready || this._paused || !missiles || !player || !player.alive || !(this._sfx && this._sfx.missile_flyby)) return;
    const P = player.position, V = player.velocity, e = camera && camera.matrixWorld.elements;
    for (let i = 0; i < missiles.length; i++) {
      const m = missiles[i];
      if (!m.alive || m.owner === player || m._wnFlyby === m.id || m.age < 0.25) continue;
      const rx = m.position.x - P.x, ry = m.position.y - P.y, rz = m.position.z - P.z;
      if (rx * rx + ry * ry + rz * rz > FLYBY_SCAN2) continue;
      const vx = m.velocity.x - V.x, vy = m.velocity.y - V.y, vz = m.velocity.z - V.z, vv = vx * vx + vy * vy + vz * vz;
      if (vv < 2500) continue;                                   // < 50 m/s closure: no whoosh
      const tca = -(rx * vx + ry * vy + rz * vz) / vv;
      if (tca < 0 || tca > FLYBY_LEAD) continue;
      const cx = rx + vx * tca, cy = ry + vy * tca, cz = rz + vz * tca, miss = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (miss > FLYBY_RADIUS) continue;
      m._wnFlyby = m.id;                                         // once per launch (missiles are pooled; id is per shot)
      let pan = 0, sweep = 0;
      if (e) { pan = (cx * e[0] + cy * e[1] + cz * e[2]) / Math.max(miss, 8); sweep = (vx * e[0] + vy * e[1] + vz * e[2]) / Math.sqrt(vv); }
      this.missileFlyby(tca, miss, pan, sweep);
    }
  }

  /**
   * Boom. `distance` in meters: full level below 100 m, ~0.15 at 3 km, delayed by distance/340 s (max 4 s), duller
   * with distance. Samples: near (< 250 m) / mid (< 900 m) / far variants. Near explosions add a sub-bass drop.
   */
  explosion(distance) {
    if (!this.ready || this._paused) return;
    let d = +distance; if (!Number.isFinite(d) || d < 0) d = 0;
    const atten = d <= 100 ? 1 : Math.max(0.05, Math.pow(100 / d, 0.56));
    const t0 = this.ctx.currentTime + Math.min(d / 340, 4);
    const S2 = this._nodes.sfxBus, S = this._sfx && this._sfx.explosion;
    if (S) {
      const idx = Math.min(S.length - 1, d < 250 ? 0 : d < 900 ? 1 : 2);
      const lp = Math.max(450, Math.min(16000, 20000 / (1 + d / 140)));
      const r = this._sample(S[idx], t0, 0.9 + Math.random() * 0.14, atten, S2, lp, atten < 0.3);
      if (r) this._lastBlast = { outs: [r.g], at: this.ctx.currentTime };
      if (r && atten > 0.45) {
        const o = this._osc(r.v, 'sine', 50, t0, t0 + 0.8);
        o.frequency.exponentialRampToValueAtTime(28, t0 + 0.7);
        const og = this._gain(r.v, 0); chain(o, og, S2);
        env(og.gain, t0, 0.55 * atten, 0.012, 0.65);
        this._lastBlast.outs.push(og);
      }
      return;
    }
    const dur = 1.5 + 1.0 * atten;
    const v = this._voice(t0 + dur + 0.1, atten < 0.3);   // > ~860 m counts as low priority
    if (!v) return;
    const n = this._noise(v, 'brown', t0, t0 + dur + 0.1, 1);
    const lp = this._filter(v, 'lowpass', 120, 0.8);
    lp.frequency.setValueAtTime(120, t0); lp.frequency.exponentialRampToValueAtTime(60, t0 + dur);
    const g = this._gain(v, 0); chain(n, lp, g, S2);
    env(g.gain, t0, 1.3 * atten, 0.012, dur - 0.012);
    const f2 = 1500 * (0.4 + 0.6 * atten);                          // mid "crack" so far booms still read
    const n2 = this._noise(v, 'pink', t0, t0 + 0.6, 1);
    const lp2 = this._filter(v, 'lowpass', f2, 0.7);
    lp2.frequency.setValueAtTime(f2, t0); lp2.frequency.exponentialRampToValueAtTime(200, t0 + 0.5);
    const g2 = this._gain(v, 0); chain(n2, lp2, g2, atten > 0.5 ? this._nodes.crunch : S2);
    env(g2.gain, t0, 0.7 * atten, 0.005, 0.45);
    this._lastBlast = { outs: [g, g2], at: this.ctx.currentTime };
    if (atten > 0.45) {
      const o = this._osc(v, 'sine', 48, t0, t0 + 0.7);
      o.frequency.exponentialRampToValueAtTime(26, t0 + 0.6);
      const og = this._gain(v, 0); chain(o, og, S2);
      env(og.gain, t0, 0.9 * atten, 0.01, 0.6);
      this._lastBlast.outs.push(og);
    }
    this._finish(v, n);
  }
  /** Let the explosion started this instant (the player's own, just before setPaused(true) on death) play out: its
   *  outputs move from the gated sfx bus to the effects volume after the pause gate. */
  spareLastBlast() {
    const b = this._lastBlast; this._lastBlast = null;
    if (!b || !this.ready || this.ctx.currentTime - b.at > 0.1) return;
    for (const o of b.outs) { try { o.disconnect(); o.connect(this._nodes.fxVol); } catch (e) { /* ignore */ } }
  }

  /** Countermeasure flares: a quick string of pops over a hiss (one burst ~0.6-0.9 s). */
  flare() {
    if (!this.ready || this._paused) return;
    const t0 = this.ctx.currentTime, S = this._sfx && this._sfx.flare;
    if (S) { this._sample(S[this._pick('flare', S)], t0, 0.95 + Math.random() * 0.1, 1, this._nodes.sfxBus); return; }
    const v = this._voice(t0 + 0.9);
    if (!v) return;
    const S2 = this._nodes.sfxBus;
    const n = this._noise(v, 'white', t0, t0 + 0.9, 1);
    const bp = this._filter(v, 'bandpass', 1400, 0.8);
    const lp = this._filter(v, 'lowpass', 3000, 0.7);
    const g = this._gain(v, 0); chain(n, bp, lp, g, S2);
    env(g.gain, t0, 0.16, 0.02, 0.8);
    for (let i = 0; i < 6; i++) {
      const tp = t0 + i * 0.09 + Math.random() * 0.02;
      const o = this._osc(v, 'triangle', 420 + Math.random() * 200, tp, tp + 0.05);
      o.frequency.exponentialRampToValueAtTime(140, tp + 0.045);
      const og = this._gain(v, 0); chain(o, og, S2);
      env(og.gain, tp, 0.2, 0.001, 0.04);
    }
    this._finish(v, n);
  }

  /** AOA limiter off (on = true) / back on: a short airy gust, a low rising one going in, a softer falling one out. */
  aoaLimiter(on) {
    if (!this.ready || this._paused) return;
    const t0 = this.ctx.currentTime, d = on ? 0.55 : 0.4;
    const v = this._voice(t0 + d);
    if (!v) return;
    const n = this._noise(v, 'white', t0, t0 + d, 1);
    const bp = this._filter(v, 'bandpass', on ? 380 : 700, 1.1);
    bp.frequency.exponentialRampToValueAtTime(on ? 900 : 320, t0 + d * 0.9);
    const g = this._gain(v, 0); chain(n, bp, g, this._nodes.sfxBus);
    env(g.gain, t0, on ? 0.5 : 0.3, on ? 0.12 : 0.05, d - (on ? 0.14 : 0.07));
    this._finish(v, n);
  }

  /** Player took a hit: metallic thud. */
  hit() {
    if (!this.ready || this._paused) return;
    const t0 = this.ctx.currentTime, S = this._sfx && this._sfx.hit;
    if (S) { this._sample(S[this._pick('hit', S)], t0, 0.94 + Math.random() * 0.12, 1, this._nodes.sfxBus); return; }
    const v = this._voice(t0 + 0.35);
    if (!v) return;
    const S2 = this._nodes.sfxBus;
    const n = this._noise(v, 'white', t0, t0 + 0.35, 1);
    const bp = this._filter(v, 'bandpass', 600, 2.5);
    const g = this._gain(v, 0); chain(n, bp, g, S2);
    env(g.gain, t0, 0.8, 0.003, 0.3);
    const o = this._osc(v, 'sine', 180, t0, t0 + 0.3);
    o.frequency.exponentialRampToValueAtTime(110, t0 + 0.25);
    const og = this._gain(v, 0); chain(o, og, S2);
    env(og.gain, t0, 0.6, 0.003, 0.25);
    const r = this._osc(v, 'triangle', 2400 + Math.random() * 300, t0, t0 + 0.2);
    const rg = this._gain(v, 0); chain(r, rg, S2);
    env(rg.gain, t0, 0.1, 0.002, 0.18);
    this._finish(v, n);
  }

  /** Player's bullets hit something: short metallic tick. */
  impact() {
    if (!this.ready || this._paused) return;
    const t0 = this.ctx.currentTime, S = this._sfx && this._sfx.impact;
    if (S) { this._sample(S[this._pick('impact', S)], t0, 0.9 + Math.random() * 0.24, 1, this._nodes.sfxBus); return; }
    const v = this._voice(t0 + 0.06);
    if (!v) return;
    const S2 = this._nodes.sfxBus;
    const n = this._noise(v, 'white', t0, t0 + 0.06, 1);
    const hp = this._filter(v, 'bandpass', 2400, 1.2);
    const g = this._gain(v, 0); chain(n, hp, g, S2);
    env(g.gain, t0, 0.24, 0.001, 0.039);
    const o = this._osc(v, 'sine', 1800 + Math.random() * 500, t0, t0 + 0.05);
    const og = this._gain(v, 0); chain(o, og, S2);
    env(og.gain, t0, 0.1, 0.001, 0.03);
    this._finish(v, n);
  }

  /**
   * Easter egg: Wilhelm-style scream (a CC0 recreation, not the 1951 recording). Call when an enemy jet is destroyed
   * near the player. Plays immediately (no propagation delay); `distance` (m, optional) softens it a little beyond
   * 200 m. Internally limited to one scream per 6 s. Returns true when it played.
   */
  wilhelm(distance = 0) {
    if (!this.ready || this._paused) return false;
    const t0 = this.ctx.currentTime;
    if (t0 - this._lastWilhelm < WILHELM_COOLDOWN) return false;
    let d = +distance; if (!Number.isFinite(d) || d < 0) d = 0;
    const gain = d <= 200 ? 1 : Math.max(0.3, Math.pow(200 / d, 0.5));
    const S = this._sfx && this._sfx.wilhelm;
    if (S) {
      if (!this._sample(S[0], t0, 0.97 + Math.random() * 0.06, gain, this._nodes.sfxBus)) return false;
      this._lastWilhelm = t0;
      return true;
    }
    // synthesized fallback: a sawtooth "aaah" through three vowel formants with the scream's rise, wobble and fall
    const dur = 0.85, v = this._voice(t0 + dur + 0.05);
    if (!v) return false;
    this._lastWilhelm = t0;
    const S2 = this._nodes.sfxBus;
    const o = this._osc(v, 'sawtooth', 330, t0, t0 + dur);
    o.frequency.linearRampToValueAtTime(560, t0 + 0.06);
    o.frequency.linearRampToValueAtTime(520, t0 + 0.38);
    o.frequency.linearRampToValueAtTime(600, t0 + 0.44);
    o.frequency.exponentialRampToValueAtTime(300, t0 + dur);
    const vib = this._osc(v, 'sine', 7, t0, t0 + dur), vibG = this._gain(v, 12); chain(vib, vibG); vibG.connect(o.frequency);
    const out = this._gain(v, 0); out.connect(S2);
    for (const [fq, q, lv] of [[800, 6, 1], [1150, 7, 0.6], [2700, 9, 0.18]]) { const bp = this._filter(v, 'bandpass', fq, q); const bg = this._gain(v, lv); chain(o, bp, bg, out); }
    out.gain.setValueAtTime(FLOOR, t0);
    out.gain.linearRampToValueAtTime(0.9 * gain, t0 + 0.05);
    out.gain.setValueAtTime(0.9 * gain, t0 + 0.5);
    out.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur);
    this._finish(v, o);
    return true;
  }

  /** Short UI cues: 'select' | 'start' | 'kill' | 'wave' | 'dead'. Played on the UI bus (audible while paused). */
  ui(kind) {
    if (!this.ready) return;
    const seq = UI_CUES[kind];
    if (!seq) return;
    const t0 = this.ctx.currentTime, U = this._nodes.uiBus;
    let end = 0; for (const n of seq) end = Math.max(end, n.t + n.d + 0.06);
    const v = this._voice(t0 + end);
    if (!v) return;
    let lastOsc = null, lastEnd = -1;
    for (const n of seq) {
      const a = t0 + n.t, b = a + n.d;
      const o = this._osc(v, n.w || 'triangle', n.f, a, b + 0.06);
      if (n.f2) o.frequency.exponentialRampToValueAtTime(n.f2, b);
      const g = this._gain(v, 0);
      if (n.lp) {
        const lp = this._filter(v, 'lowpass', n.lp, 0.7);
        if (n.lp2) { lp.frequency.setValueAtTime(n.lp, a); lp.frequency.exponentialRampToValueAtTime(n.lp2, b); }
        chain(o, lp, g, U);
      } else chain(o, g, U);
      env(g.gain, a, n.g || 0.3, 0.008, n.d - 0.008);
      if (b > lastEnd) { lastEnd = b; lastOsc = o; }
    }
    if (lastOsc) this._finish(v, lastOsc);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Continuous warning tones (idempotent). Beep patterns are scheduled ~0.35 s ahead on the audio clock by a JS timer.
  // ---------------------------------------------------------------------------------------------------------------
  _buildWarnings() {
    const ctx = this.ctx, N = this._nodes;
    const W = N.warn = {};
    // lock tone: square -> lowpass (softer) -> tremolo gain (LFO-driven when locked) -> gate
    W.lockOsc = ctx.createOscillator(); W.lockOsc.type = 'square'; W.lockOsc.frequency.value = 1100;
    W.lockLP = ctx.createBiquadFilter(); W.lockLP.type = 'lowpass'; W.lockLP.frequency.value = 3500; W.lockLP.Q.value = 0.5;
    W.lockTrem = ctx.createGain(); W.lockTrem.gain.value = 1;
    W.lockGate = ctx.createGain(); W.lockGate.gain.value = 0;
    W.lfo = ctx.createOscillator(); W.lfo.type = 'sine'; W.lfo.frequency.value = 25;
    W.lfoDepth = ctx.createGain(); W.lfoDepth.gain.value = 0;
    W.lfo.connect(W.lfoDepth); W.lfoDepth.connect(W.lockTrem.gain);
    chain(W.lockOsc, W.lockLP, W.lockTrem, W.lockGate, N.warnBus);
    // RWR: alternating 900/1200 Hz square beeps at 6 Hz
    W.rwrOsc = ctx.createOscillator(); W.rwrOsc.type = 'square'; W.rwrOsc.frequency.value = 900;
    W.rwrLP = ctx.createBiquadFilter(); W.rwrLP.type = 'lowpass'; W.rwrLP.frequency.value = 3000; W.rwrLP.Q.value = 0.5;
    W.rwrGate = ctx.createGain(); W.rwrGate.gain.value = 0;
    chain(W.rwrOsc, W.rwrLP, W.rwrGate, N.warnBus);
    // pull-up "whoop": rising 400 -> 900 Hz sweep twice a second
    W.puOsc = ctx.createOscillator(); W.puOsc.type = 'sawtooth'; W.puOsc.frequency.value = 400;
    W.puLP = ctx.createBiquadFilter(); W.puLP.type = 'lowpass'; W.puLP.frequency.value = 2200; W.puLP.Q.value = 1.0;
    W.puGate = ctx.createGain(); W.puGate.gain.value = 0;
    chain(W.puOsc, W.puLP, W.puGate, N.warnBus);
    // AOA limiter off: a soft held tone, two sines a fifth apart with a slow swell
    W.aoaOsc1 = ctx.createOscillator(); W.aoaOsc1.type = 'sine'; W.aoaOsc1.frequency.value = 523;
    W.aoaOsc2 = ctx.createOscillator(); W.aoaOsc2.type = 'sine'; W.aoaOsc2.frequency.value = 784;
    W.aoaMix2 = ctx.createGain(); W.aoaMix2.gain.value = 0.45;
    W.aoaSwell = ctx.createGain(); W.aoaSwell.gain.value = 0.8;
    W.aoaLfo = ctx.createOscillator(); W.aoaLfo.type = 'sine'; W.aoaLfo.frequency.value = 3;
    W.aoaLfoDepth = ctx.createGain(); W.aoaLfoDepth.gain.value = 0.2;
    W.aoaGate = ctx.createGain(); W.aoaGate.gain.value = 0;
    W.aoaLfo.connect(W.aoaLfoDepth); W.aoaLfoDepth.connect(W.aoaSwell.gain);
    W.aoaOsc1.connect(W.aoaSwell); chain(W.aoaOsc2, W.aoaMix2, W.aoaSwell);
    chain(W.aoaSwell, W.aoaGate, N.warnBus);
    const t = ctx.currentTime;
    for (const s of [W.lockOsc, W.lfo, W.rwrOsc, W.puOsc, W.aoaOsc1, W.aoaOsc2, W.aoaLfo]) { try { s.start(t); } catch (e) { /* ignore */ } }
    W.lockNext = 0; W.rwrNext = 0; W.rwrHigh = false; W.puNext = 0;
  }

  _ensureScheduler() {
    if (this._schedTimer || this._disposed) return;
    this._schedTimer = setInterval(() => this._schedule(), SCHED_INTERVAL_MS);
    this._schedule();
  }

  _schedule() {
    if (!this.ready || !this._nodes) { if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = 0; } return; }
    const W = this._nodes.warn, now = this.ctx.currentTime, horizon = now + SCHED_AHEAD;
    let any = false;
    if (this._lockState === 'seeking') {
      any = true;
      if (W.lockNext < now) W.lockNext = now + 0.01;
      while (W.lockNext < horizon) { beep(W.lockGate.gain, W.lockNext, 0.06, 1); W.lockNext += 0.45; }
    }
    if (this._missileWarnOn) {
      any = true;
      if (W.rwrNext < now) W.rwrNext = now + 0.01;
      while (W.rwrNext < horizon) {
        W.rwrOsc.frequency.setValueAtTime(W.rwrHigh ? 1200 : 900, W.rwrNext); W.rwrHigh = !W.rwrHigh;
        beep(W.rwrGate.gain, W.rwrNext, 0.11, 1);
        W.rwrNext += 1 / 6;
      }
    }
    if (this._pullUpOn) {
      any = true;
      if (W.puNext < now) W.puNext = now + 0.01;
      while (W.puNext < horizon) {
        const t = W.puNext;
        W.puOsc.frequency.setValueAtTime(400, t); W.puOsc.frequency.exponentialRampToValueAtTime(900, t + 0.36);
        beep(W.puGate.gain, t, 0.38, 0.9);
        W.puNext += 0.5;
      }
    }
    if (!any && this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = 0; }
  }

  /** 'none' | 'seeking' (1100 Hz beep 60 ms every 450 ms) | 'locked' (1300 Hz with 25 Hz tremolo). Idempotent. */
  lockTone(state) {
    if (!this.ready) return;
    const s = (state === 'seeking' || state === 'locked') ? state : 'none';
    if (s === this._lockState) return;
    this._lockState = s;
    const W = this._nodes.warn, now = this.ctx.currentTime;
    W.lockNext = 0;
    if (s === 'none') {
      glideTo(W.lockGate.gain, now, 0);
      W.lfoDepth.gain.setTargetAtTime(0, now, 0.01); W.lockTrem.gain.setTargetAtTime(1, now, 0.01);
    } else if (s === 'seeking') {
      glideTo(W.lockGate.gain, now, 0, 0.005);
      W.lockOsc.frequency.setValueAtTime(1100, now);
      W.lfoDepth.gain.setTargetAtTime(0, now, 0.01); W.lockTrem.gain.setTargetAtTime(1, now, 0.01);
      this._ensureScheduler();
    } else {
      W.lockOsc.frequency.setValueAtTime(1300, now);
      W.lockTrem.gain.setTargetAtTime(0.5, now, 0.01); W.lfoDepth.gain.setTargetAtTime(0.5, now, 0.01);
      glideTo(W.lockGate.gain, now, 1);
    }
  }

  /** RWR beeper on/off. Idempotent. */
  missileWarning(on) {
    if (!this.ready) return;
    on = !!on;
    if (on === this._missileWarnOn) return;
    this._missileWarnOn = on;
    const W = this._nodes.warn;
    W.rwrNext = 0; W.rwrHigh = false;
    if (on) this._ensureScheduler(); else glideTo(W.rwrGate.gain, this.ctx.currentTime, 0);
  }

  /** Terrain "whoop whoop" on/off. Idempotent. */
  pullUpWarning(on) {
    if (!this.ready) return;
    on = !!on;
    if (on === this._pullUpOn) return;
    this._pullUpOn = on;
    const W = this._nodes.warn;
    W.puNext = 0;
    if (on) this._ensureScheduler(); else glideTo(W.puGate.gain, this.ctx.currentTime, 0);
  }

  /** AOA limiter soft tone on/off (held while the limiter is off). Idempotent. */
  aoaTone(on) {
    if (!this.ready) return;
    on = !!on;
    if (on === this._aoaToneOn) return;
    this._aoaToneOn = on;
    const g = this._nodes.warn.aoaGate.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setTargetAtTime(on ? 0.11 : 0, now, on ? 0.06 : 0.08);
  }

  /** Master volume 0..1 (default 0.6). Remembered if called before unlock. */
  /** Effects volume (engine, weapons, explosions, warnings), 0..1; remembered before unlock. */
  setSfxVolume(v) {
    this._fxVol = Math.max(0, Math.min(1.5, Number(v) || 0));
    if (this._nodes && this._nodes.fxVol) this._nodes.fxVol.gain.setTargetAtTime(this._fxVol, this.ctx.currentTime, 0.05);
  }
  setMaster(v) {
    v = clamp01(+v);
    this._masterVol = v;
    if (!this.ready || !this._nodes) return;
    this._nodes.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Stop everything and close the AudioContext. The instance is dead afterwards (all methods no-op). */
  dispose() {
    this._disposed = true;
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = 0; }
    const ctx = this.ctx;
    this.ready = false;
    if (this._nodes) {
      const E = this._nodes.engine, W = this._nodes.warn, srcs = [];
      if (E) srcs.push(E.whineOsc1, E.whineOsc2, E.whistle, E.roarSrc, E.abSrc, E.crackleSrc, E.subSrc, E.windSrc, E.sRoarSrc, E.sTurbSrc, E.sAbSrc);
      if (W) srcs.push(W.lockOsc, W.lfo, W.rwrOsc, W.puOsc, W.aoaOsc1, W.aoaOsc2, W.aoaLfo);
      if (this._nodes.gun) srcs.push(this._nodes.gun.src);
      for (const s of srcs) { if (s) { try { s.stop(); } catch (e) { /* ignore */ } } }
      try { this._nodes.master.disconnect(); } catch (e) { /* ignore */ }
    }
    for (const v of this._voices) { for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } } }
    this._voices.length = 0;
    this._nodes = null; this._buffers = null; this.ctx = null; this._sfx = null; this._engineSamples = false;
    if (this._sfxState === 'none') this._sfxResolve({ decoded: 0, failed: 0 });
    this._lockState = 'none'; this._missileWarnOn = false; this._pullUpOn = false; this._gunOn = false; this._aoaToneOn = false;
    if (ctx) { try { const p = ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) { /* ignore */ } }
  }
}
