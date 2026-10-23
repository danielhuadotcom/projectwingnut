// js/music.js — PROJECT WINGNUT soundtrack player ("Ceiling Unlimited").
// The score is rendered offline (tools/music/) and shipped as base64 Ogg Opus (+ MP3 fallback) in js/music_data.js.
// At runtime we only decode it once and play a looping AudioBufferSourceNode — no synthesis cost.
//
// Graph (all on AudioFX's context, audioFX.ctx, created by audioFX.unlock() on the first user gesture):
//   source ─► fade gain (per play) ─► low-pass (muffle) ─► duck gain ─► volume gain ─► ctx.destination
// The music goes straight to the destination rather than through AudioFX's SFX compressor: it is already mastered,
// and explosions should not pump it. Use setVolume() to balance it against AudioFX.setMaster().
//
// Every method is safe before unlock (no context yet -> no-op), idempotent, and a no-op after dispose().
// Typical use:  const music = new Music(audioFX);  ...on first gesture: audioFX.unlock(); music.play();
//               pause menu: music.setMuffled(true) · radio chatter: music.duck(true/false) · game over: music.stop()
import { MUSIC } from './music_data.js';

const DEFAULT_VOLUME = 0.5;   // the track is mastered to about -13 LUFS; 0.5 sits it under the SFX
const DUCK_GAIN = 0.5;        // -6 dB while radio chatter plays
const MUFFLE_HZ = 650;        // low-pass corner for pause / title screens
const OPEN_HZ = 20000;

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0); // NaN -> 0

function base64ToArrayBuffer(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64).buffer;
  const bin = atob(b64), n = bin.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
/** decodeAudioData with both the promise and the legacy callback signature (old Safari). */
function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
    try { const p = ctx.decodeAudioData(arrayBuffer, ok, fail); if (p && typeof p.then === 'function') p.then(ok, fail); } catch (e) { fail(e); }
  });
}
/** Cancel automation and glide a param to v (linear or exponential), starting from its current value. */
function glide(param, ctx, v, time, exp = false) {
  const now = ctx.currentTime;
  try { param.cancelScheduledValues(now); } catch (e) { /* ignore */ }
  let cur = param.value; if (!Number.isFinite(cur)) cur = v;
  try {
    param.setValueAtTime(cur, now);
    if (exp && cur > 0 && v > 0) param.exponentialRampToValueAtTime(v, now + time); else param.linearRampToValueAtTime(v, now + time);
  } catch (e) { try { param.value = v; } catch (e2) { /* ignore */ } }
}

export class Music {
  /**
   * @param audioFX  the game's AudioFX instance (we use audioFX.ctx once unlock() has created it)
   * @param opts     { volume = 0.5, data = MUSIC }  (data: { opus, mp3?, loopStart, loopEnd, bpm, title })
   */
  constructor(audioFX, opts = {}) {
    this.audioFX = audioFX || null;
    this.data = opts.data || MUSIC;
    this.title = (this.data && this.data.title) || '';
    this.bpm = (this.data && this.data.bpm) || 0;
    this.buffer = null;          // decoded AudioBuffer
    this.format = null;          // 'opus' | 'mp3' once decoded
    this._volume = clamp01(opts.volume ?? DEFAULT_VOLUME);
    this._ducked = false;
    this._muffled = false;
    this._wantPlay = false;
    this._playOpts = null;
    this._ctx = null;            // context our nodes belong to
    this._nodes = null;          // { lp, duck, vol }
    this._voice = null;          // { src, fade, startedAt, offset }
    this._decoding = null;       // in-flight decode promise
    this._disposed = false;
  }

  /** true once the track is decoded and can start instantly */
  get ready() { return !!this.buffer; }
  /** true while a source is running (or scheduled) */
  get playing() { return !!this._voice; }
  get loopStart() { return +this.data.loopStart || 0; }
  get loopEnd() { return +this.data.loopEnd || 0; }
  get duration() { return this.buffer ? this.buffer.duration : (+this.data.duration || 0); }
  /** playback position in seconds within the file (wraps inside the loop), or 0 when stopped */
  get position() {
    const v = this._voice, ctx = this._ctx; if (!v || !ctx) return 0;
    let p = v.offset + Math.max(0, ctx.currentTime - v.startedAt);
    const a = this.loopStart, b = this.loopEnd;
    if (b > a && p >= b) p = a + ((p - a) % (b - a));
    return p;
  }

  /** The AudioContext to use (AudioFX's), or null before unlock / after dispose. Rebuilds our nodes if it changed. */
  _context() {
    if (this._disposed) return null;
    const c = this.audioFX && this.audioFX.ctx;
    const ctx = c && c.state !== 'closed' ? c : null;
    if (ctx !== this._ctx) { // first use, or AudioFX disposed / recreated its context
      if (this._ctx) this._teardown(true);
      if (ctx) this._buildGraph(ctx);
    }
    return ctx;
  }

  _buildGraph(ctx) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8; lp.frequency.value = this._muffled ? MUFFLE_HZ : OPEN_HZ;
    const duck = ctx.createGain(); duck.gain.value = this._ducked ? DUCK_GAIN : 1;
    const vol = ctx.createGain(); vol.gain.value = this._volume;
    lp.connect(duck); duck.connect(vol); vol.connect(ctx.destination);
    this._ctx = ctx; this._nodes = { lp, duck, vol };
  }

  _teardown(keepBuffer) {
    this._stopVoice(0);
    if (this._nodes) { for (const n of Object.values(this._nodes)) { try { n.disconnect(); } catch (e) { /* ignore */ } } }
    this._nodes = null; this._ctx = null;
    if (!keepBuffer) this.buffer = null;
  }

  /**
   * Decode the embedded track (once). Resolves true when ready, false before unlock / on failure.
   * Prefers Opus; falls back to MP3 if this browser cannot decode Ogg Opus.
   */
  preload() {
    if (this.buffer) return Promise.resolve(true);
    const ctx = this._context();
    if (!ctx || !this.data) return Promise.resolve(false);
    if (this._decoding) return this._decoding;
    this._decoding = (async () => {
      for (const fmt of ['opus', 'mp3']) {
        const b64 = this.data[fmt];
        if (!b64) continue;
        try {
          const buf = await decode(ctx, base64ToArrayBuffer(b64));
          if (!buf || !(buf.duration > 1)) throw new Error('empty buffer');
          if (this._disposed) return false;
          this.buffer = buf; this.format = fmt;
          break;
        } catch (e) { /* try the next format */ }
      }
      this._decoding = null;
      if (!this.buffer) return false;
      if (this._wantPlay && !this._voice) this._startVoice();
      return true;
    })();
    return this._decoding;
  }

  /**
   * Start the music (idempotent: no-op while already playing). Before unlock it only records the intent; call it
   * again (or preload()) after audioFX.unlock() — e.g. from the same gesture handler.
   * @param opts { skipIntro = false  start at loopStart instead of 0,  fadeIn = seconds (default 0.03, or 1.0 with skipIntro),
   *               at = start position in seconds (debug/testing, overrides skipIntro) }
   */
  play(opts = {}) {
    if (this._disposed) return;
    this._wantPlay = true; this._playOpts = opts || {};
    if (this._voice) return;
    const ctx = this._context(); if (!ctx) return;
    if (this.buffer) this._startVoice(); else this.preload();
  }

  _startVoice() {
    const ctx = this._ctx, buf = this.buffer; if (!ctx || !buf || !this._nodes || this._voice) return;
    const o = this._playOpts || {};
    const src = ctx.createBufferSource(); src.buffer = buf;
    let a = this.loopStart, b = this.loopEnd;
    if (!(b > a) || b > buf.duration) { a = 0; b = buf.duration; }
    src.loop = true; src.loopStart = a; src.loopEnd = b;
    const fade = ctx.createGain();
    let offset = o.skipIntro ? a : 0;
    if (Number.isFinite(+o.at) && o.at !== undefined && o.at !== null) offset = Math.max(0, Math.min(b - 0.01, +o.at));
    const fadeIn = Math.max(0.005, +(o.fadeIn ?? (o.skipIntro ? 1.0 : 0.03)) || 0.03);
    const t0 = ctx.currentTime + 0.02;
    fade.gain.setValueAtTime(0, t0); fade.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    src.connect(fade); fade.connect(this._nodes.lp);
    const voice = { src, fade, startedAt: t0, offset };
    src.onended = () => { try { src.disconnect(); fade.disconnect(); } catch (e) { /* ignore */ } if (this._voice === voice) this._voice = null; };
    try { src.start(t0, offset); } catch (e) { try { src.disconnect(); fade.disconnect(); } catch (e2) { /* ignore */ } return; }
    this._voice = voice;
  }

  _stopVoice(fadeTime) {
    const v = this._voice; if (!v) return;
    this._voice = null;
    const ctx = this._ctx;
    try {
      if (ctx && fadeTime > 0) { glide(v.fade.gain, ctx, 0, fadeTime); v.src.stop(ctx.currentTime + fadeTime + 0.02); }
      else { v.src.stop(); }
    } catch (e) { try { v.src.disconnect(); v.fade.disconnect(); } catch (e2) { /* ignore */ } }
  }

  /** Stop (with a short fade). Idempotent; the next play() starts from the top (or loopStart with skipIntro). */
  stop(opts = {}) {
    this._wantPlay = false;
    if (this._disposed) return;
    this._stopVoice(Math.max(0, +(opts.fade ?? 0.5) || 0));
  }

  /** Music volume 0..1 (default 0.5). Remembered before unlock. */
  setVolume(v) {
    if (!Number.isFinite(+v)) return;
    this._volume = clamp01(+v);
    const ctx = this._context(); if (!ctx || !this._nodes) return;
    glide(this._nodes.vol.gain, ctx, this._volume, 0.08);
  }

  /** Dip ~6 dB while radio chatter plays (fast attack, gentle release). Idempotent. */
  duck(on) {
    on = !!on; if (on === this._ducked && this._nodes) return;
    this._ducked = on;
    const ctx = this._context(); if (!ctx || !this._nodes) return;
    glide(this._nodes.duck.gain, ctx, on ? DUCK_GAIN : 1, on ? 0.12 : 0.6);
  }

  /** Low-pass "behind the door" sound for pause / title screens. Idempotent. */
  setMuffled(on) {
    on = !!on; if (on === this._muffled && this._nodes) return;
    this._muffled = on;
    const ctx = this._context(); if (!ctx || !this._nodes) return;
    glide(this._nodes.lp.frequency, ctx, on ? MUFFLE_HZ : OPEN_HZ, on ? 0.35 : 0.5, true);
  }

  /** Stop immediately and release everything (does not close AudioFX's context). */
  dispose() {
    if (this._disposed) return;
    this._wantPlay = false;
    this._teardown(false);
    this._disposed = true;
    this.data = null; this._decoding = null;
  }
}
