// js/awacs.js — PROJECT WINGNUT: "AWACS Claude", the radio controller. Pre-generated TTS lines (js/awacs_clips.js:
// base64 MP3, built by tools/build_awacs.mjs) are decoded once into AudioBuffers and played one at a time through a cheap
// radio chain into AudioFX's master bus. No network, no per-frame work while idle.
//
//   const awacs = new Awacs(audioFX, { onSubtitle: (text, seconds, key) => hud.subtitle(text, seconds) });
//   audioFX.unlock(); awacs.preload();   // after the user gesture; idempotent (say() also starts it lazily)
//   awacs.say('kill', { priority: 2 });   // event keys = Object.keys(AWACS_CLIPS), see awacs.keys
//   awacs.update(dt);                     // every frame: advances the queue
// The game schedules its radio with js/radio.js, which uses only the direct calls (clipBuffer, transmit,
// cutTransmission): one channel for AWACS, the WSO and Mainspring. say() and its queue remain for simple use and tests.
//
// Radio chain (built once per AudioContext):
//   voice + squelch noise ─► highpass 320 Hz ─► presence +3 dB @ 1.8 kHz ─► lowpass 3200 Hz ─► tanh drive ─► lowpass 3600 Hz (Q 0.5) ─► out ─► AudioFX master
import { AWACS_CLIPS } from './awacs_clips.js';

const DEFAULT_COOLDOWN = 6;     // s before the same event may speak again
const COOLDOWNS = { kill: 2, groundKill: 2, missileIncoming: 4, pullUp: 4 };
const MAX_PENDING = 2;          // lines waiting for the channel
const MAX_WAIT = 5;             // s a queued line may wait before it is dropped as stale
const LEAD = 0.01;              // s scheduling lead
const KEY_UP = 0.07;            // s from the squelch click to the voice
const TAIL = 0.13;              // s squelch tail after the voice
const GAP = 0.25;               // s of radio silence between transmissions
const PREEMPT = 0.09;           // s from cutting a line to the next key-up
const SQ_CLICK = 0.55, SQ_BED = 0.03, SQ_TAIL = 0.35, FLOOR = 0.0005; // squelch noise envelope levels
const OUT_LEVEL = 0.9;          // chain output gain at volume 1

let DRIVE_CURVE = null;
/** Gentle tanh saturation, normalised so full scale stays full scale (~+7 dB on quiet passages, soft peaks). */
function driveCurve() {
  if (DRIVE_CURVE) return DRIVE_CURVE;
  const n = 2048, D = 2.2, k = Math.tanh(D);
  DRIVE_CURVE = new Float32Array(n);
  for (let i = 0; i < n; i++) DRIVE_CURVE[i] = Math.tanh(D * ((i / (n - 1)) * 2 - 1)) / k;
  return DRIVE_CURVE;
}
function biquad(ctx, type, freq, Q) {
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; return f;
}
function makeNoise(ctx) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * 0.5)), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
/** base64 MP3 -> AudioBuffer (promise and legacy callback forms of decodeAudioData). */
function decodeClip(ctx, b64) {
  const bin = atob(b64), n = bin.length, bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  return new Promise((resolve, reject) => {
    let p;
    try { p = ctx.decodeAudioData(bytes.buffer, resolve, reject); } catch (e) { reject(e); return; }
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

export class Awacs {
  /**
   * @param audioFX  the game's AudioFX (uses audioFX.ctx, created by audioFX.unlock(); may still be null here)
   * @param onSubtitle  called as onSubtitle(text, seconds, eventKey) when a line goes on air
   */
  constructor(audioFX, { onSubtitle } = {}) {
    this.fx = audioFX || null;
    this.onSubtitle = typeof onSubtitle === 'function' ? onSubtitle : null;
    this._events = {};
    this._clipCount = 0;
    for (const key of Object.keys(AWACS_CLIPS)) {
      const clips = AWACS_CLIPS[key].map((c) => ({ text: c.text, data: c.data, buffer: null }));
      this._events[key] = { key, clips, last: -1, lastAt: -1e9 };
      this._clipCount += clips.length;
    }
    this._decoded = 0;
    this._decodePromise = null;
    this._ctx = null;            // context the radio chain belongs to
    this._chain = null;
    this._noise = null;
    this._volume = 1;
    // the transmission on air (record reused, never reallocated)
    this._cur = { active: false, key: '', priority: 0, voiceEnd: 0, free: 0, src: null, vg: null, ns: null, ng: null };
    this._pending = [];
    for (let i = 0; i < MAX_PENDING; i++) this._pending.push({ active: false, key: '', priority: 0, t: 0 });
    this._nPending = 0;
    this._busy = false;          // something on air or queued: update() has work to do
    this._disposed = false;
  }

  /** Event keys with clips. */
  get keys() { return Object.keys(this._events); }
  get clipCount() { return this._clipCount; }
  get decodedCount() { return this._decoded; }
  /** True while a transmission (voice + squelch tail) is on air. */
  get speaking() { const c = this._cur; return !!(c.active && this._ctx && this._ctx.currentTime < c.voiceEnd + TAIL); }

  /**
   * Decode every clip once (needs audioFX.ctx: call after audioFX.unlock()). Idempotent; resolves true when all clips
   * are decoded, false if the AudioContext does not exist yet (just call it again later) or a clip failed to decode.
   */
  async preload() {
    if (this._disposed) return false;
    const ctx = this.fx && this.fx.ctx;
    if (!ctx) return false;
    this._ensureGraph(ctx);
    if (!this._decodePromise) this._decodePromise = this._decodeAll(ctx);
    return this._decodePromise;
  }

  /**
   * Request a radio line. priority: higher preempts a lower-priority line on air; cooldown (s) overrides the per-event
   * default (6 s; kill / groundKill 2 s; missileIncoming / pullUp 4 s). Returns true if the line is playing or queued.
   */
  say(eventKey, { priority = 1, cooldown } = {}) {
    if (this._disposed) return false;
    const e = this._events[eventKey];
    const ctx = this.fx && this.fx.ctx;
    if (!e || !ctx) return false;
    if (!this._decodePromise || this._ctx !== ctx) this.preload();   // lazy start; queued lines wait for decoding
    let pr = +priority || 0;
    const cd = cooldown !== undefined ? (+cooldown || 0) : (COOLDOWNS[eventKey] ?? DEFAULT_COOLDOWN);
    const now = ctx.currentTime, cur = this._cur;
    if (now - e.lastAt < cd) return false;                                      // event cooldown
    if (cur.active && cur.key === eventKey && now < cur.voiceEnd) return false; // already on air
    for (let i = 0; i < MAX_PENDING; i++) {                                     // already queued: merge (keep max priority)
      const s = this._pending[i];
      if (s.active && s.key === eventKey) { if (s.priority > pr) pr = s.priority; s.active = false; this._nPending--; }
    }
    const free = !cur.active || now >= cur.free;
    if (free && this._nPending === 0 && this._start(e, pr, now, 0)) return true;
    if (!free && pr > cur.priority) {                                           // higher priority breaks in
      const onAir = now < cur.voiceEnd + TAIL;
      if (onAir) this._cut(now);
      if (this._start(e, pr, now, onAir ? PREEMPT : 0)) return true;
    }
    return this._enqueue(eventKey, pr, now);
  }

  /** Call every frame. Zero work while idle; never allocates except WebAudio nodes when a queued line starts. */
  update(dt) {
    if (!this._busy) return;
    const ctx = this._ctx;
    if (!ctx || this._disposed) { this._busy = false; return; }
    if (!this.fx || this.fx.ctx !== ctx) { this.stop(); return; }    // AudioFX disposed / context replaced
    const now = ctx.currentTime, cur = this._cur;
    if (cur.active && now >= cur.free) cur.active = false;
    if (!cur.active && this._nPending > 0) this._next(now);
    if (!cur.active && this._nPending === 0) this._busy = false;
  }

  /** Cut the line on air (with a squelch) and drop the queue, e.g. on pause or mission restart. */
  stop() {
    if (this._ctx && this._cur.active) this._cut(this._ctx.currentTime);
    for (let i = 0; i < MAX_PENDING; i++) this._pending[i].active = false;
    this._nPending = 0;
    this._busy = false;
  }

  /** Radio volume 0..2 (default 1); also scaled by AudioFX's master volume. Remembered before preload. */
  setVolume(v) {
    v = +v;
    this._volume = v > 0 ? (v < 2 ? v : 2) : 0;   // NaN -> 0
    if (!this._chain) return;
    const g = this._chain.out.gain, now = this._ctx.currentTime;
    try { g.cancelScheduledValues(now); } catch (e) { /* ignore */ }
    g.setTargetAtTime(this._volume * OUT_LEVEL, now, 0.05);
  }

  /** Stop, disconnect and free the decoded clips. The instance is dead afterwards (all methods no-op). */
  dispose() {
    if (this._disposed) return;
    this.stop();
    this._disposed = true;
    this._teardown();
    for (const key in this._events) { const clips = this._events[key].clips; for (let i = 0; i < clips.length; i++) clips[i].buffer = null; }
    this._decoded = 0;
    this.onSubtitle = null;
    this.fx = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  _ensureGraph(ctx) {
    if (this._ctx === ctx && this._chain) return;
    if (this._chain) this._teardown();
    this._ctx = ctx;
    const input = ctx.createGain();
    const hp = biquad(ctx, 'highpass', 320, 1);       // Q in dB: slight edge resonance, radio-like
    const presence = biquad(ctx, 'peaking', 1800, 0.9); presence.gain.value = 3;
    // The shaper's input is already band-limited (lp1), so no oversampling is needed (its decimation filter could ring
    // past full scale). After it only a critically damped lowpass (linear Q 0.5 = -6.02 dB: WebAudio lowpass/highpass Q
    // is in dB), whose impulse response is non-negative, so it cannot overshoot: output peaks stay <= OUT_LEVEL.
    const drive = ctx.createWaveShaper(); drive.curve = driveCurve();
    const lp1 = biquad(ctx, 'lowpass', 3200, 1), lp2 = biquad(ctx, 'lowpass', 3600, -6.02);
    const out = ctx.createGain(); out.gain.value = this._volume * OUT_LEVEL;
    input.connect(hp); hp.connect(presence); presence.connect(lp1); lp1.connect(drive); drive.connect(lp2); lp2.connect(out);
    const N = this.fx && this.fx.ctx === ctx ? this.fx._nodes : null;       // read-only use of AudioFX's master bus
    out.connect((N && N.master) || ctx.destination);
    this._chain = { input, hp, presence, lp1, drive, lp2, out };
    this._noise = makeNoise(ctx);
  }

  _teardown() {
    if (this._chain) for (const k in this._chain) { try { this._chain[k].disconnect(); } catch (e) { /* ignore */ } }
    this._chain = null; this._noise = null; this._ctx = null;
    this._cur.active = false;
  }

  async _decodeAll(ctx) {
    const todo = [];
    for (const key in this._events) for (const c of this._events[key].clips) if (!c.buffer) todo.push(c);
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !this._disposed) {
        const c = todo[next++];
        try { c.buffer = await decodeClip(ctx, c.data); this._decoded++; } catch (e) { console.warn('[awacs] cannot decode clip "' + c.text + '":', e && e.message); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (this._disposed) { for (const c of todo) c.buffer = null; return false; }
    return this._decoded === this._clipCount;
  }

  /** Random decoded variant, never the one used last time (unless it is the only one). -1 if none decoded yet. */
  _pickVariant(e) {
    const clips = e.clips;
    let n = 0;
    for (let i = 0; i < clips.length; i++) if (clips[i].buffer && i !== e.last) n++;
    if (n === 0) return e.last >= 0 && clips[e.last].buffer ? e.last : -1;
    let r = Math.floor(Math.random() * n);
    for (let i = 0; i < clips.length; i++) if (clips[i].buffer && i !== e.last && r-- === 0) return i;
    return -1;
  }

  _enqueue(key, pr, now) {
    let slot = null;
    for (let i = 0; i < MAX_PENDING; i++) if (!this._pending[i].active) { slot = this._pending[i]; break; }
    if (!slot) {        // full: replace the lowest-priority (then oldest) entry if the new line outranks it
      for (let i = 0; i < MAX_PENDING; i++) {
        const s = this._pending[i];
        if (!slot || s.priority < slot.priority || (s.priority === slot.priority && s.t < slot.t)) slot = s;
      }
      if (pr <= slot.priority) return false;
      this._nPending--;
    }
    slot.active = true; slot.key = key; slot.priority = pr; slot.t = now;
    this._nPending++;
    this._busy = true;
    return true;
  }

  /** Channel is free: start the best queued line (highest priority, then oldest); drop stale ones. */
  _next(now) {
    let best = null;
    for (let i = 0; i < MAX_PENDING; i++) {
      const s = this._pending[i];
      if (!s.active) continue;
      if (now - s.t > MAX_WAIT) { s.active = false; this._nPending--; continue; }
      if (!best || s.priority > best.priority || (s.priority === best.priority && s.t < best.t)) best = s;
    }
    if (best && this._start(this._events[best.key], best.priority, now, 0)) { best.active = false; this._nPending--; }
  }

  /** Put one line on air: squelch click, voice, squelch tail. False if no clip of this event is decoded yet. */
  _start(e, pr, now, delay) {
    if (!this._chain) return false;
    const vi = this._pickVariant(e);
    if (vi < 0) return false;
    const clip = e.clips[vi];
    this._transmit(clip.buffer, e.key, pr, now, delay);
    e.last = vi; e.lastAt = now;
    if (this.onSubtitle) { try { this.onSubtitle(clip.text, clip.buffer.duration, e.key); } catch (err) { console.error(err); } }
    return true;
  }

  // ---- direct transmissions (js/radio.js schedules them; no queue, cooldown or subtitle here) ----------------------
  /** Decoded buffer of AWACS event `key`, variant i (0-based), or null (not decoded yet / no such clip). */
  clipBuffer(key, i) { const e = this._events[key]; const c = e && e.clips[i]; return (c && c.buffer) || null; }
  /** The AudioContext the radio chain plays on (null before unlock), creating the chain if needed. */
  context() { const ctx = this.fx && this.fx.ctx; if (!ctx || this._disposed) return null; this._ensureGraph(ctx); return ctx; }
  /** Put `buffer` on air now through the radio chain (squelch click, voice, squelch tail), first breaking off whatever
   *  is on air (breakIn: with a short squelch burst before the new key-up). Returns the voice length (s), 0 if no audio. */
  transmit(buffer, { breakIn = false, label = 'radio' } = {}) {
    const ctx = this.context();
    if (!ctx || !buffer || !this._chain) return 0;
    const now = ctx.currentTime, onAir = this._cur.active && now < this._cur.voiceEnd + TAIL;
    if (onAir) this._cut(now);
    this._transmit(buffer, label, 9, now, onAir && breakIn ? PREEMPT : 0);
    return buffer.duration;
  }
  /** Break off the transmission on air (short squelch burst). */
  cutTransmission() { if (this._ctx && this._cur.active) this._cut(this._ctx.currentTime); }

  _transmit(buffer, key, pr, now, delay) {
    const ctx = this._ctx, input = this._chain.input, cur = this._cur;
    const t0 = now + LEAD + delay, tv = t0 + KEY_UP, dur = buffer.duration, tEnd = tv + dur + TAIL;
    const src = ctx.createBufferSource(); src.buffer = buffer;
    const vg = ctx.createGain();
    src.connect(vg); vg.connect(input);
    src.start(tv);
    const ns = ctx.createBufferSource(); ns.buffer = this._noise; ns.loop = true;
    const ng = ctx.createGain(), g = ng.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(SQ_CLICK, t0 + 0.004);          // key-up click
    g.exponentialRampToValueAtTime(SQ_BED, t0 + 0.05);        // faint hiss under the voice
    g.setValueAtTime(SQ_BED, tv + dur);
    g.linearRampToValueAtTime(SQ_TAIL, tv + dur + 0.012);     // release squelch
    g.exponentialRampToValueAtTime(FLOOR, tEnd);
    g.setValueAtTime(0, tEnd + 0.002);
    ns.connect(ng); ng.connect(input);
    ns.start(t0, Math.random() * 0.4);
    ns.stop(tEnd + 0.01);
    ns.onended = () => { for (const n of [src, vg, ns, ng]) { try { n.disconnect(); } catch (err) { /* ignore */ } } };
    cur.active = true; cur.key = key; cur.priority = pr; cur.voiceEnd = tv + dur; cur.free = tEnd + GAP;
    cur.src = src; cur.vg = vg; cur.ns = ns; cur.ng = ng;
    this._busy = true;
  }

  /** Break off the line on air: 30 ms voice fade and a short squelch burst. */
  _cut(now) {
    const c = this._cur;
    if (!c.active) return;
    try {
      const g = c.vg.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.03);
      c.src.stop(now + 0.035);
    } catch (e) { /* already stopped */ }
    try {
      const n = c.ng.gain;
      n.cancelScheduledValues(now); n.setValueAtTime(Math.max(FLOOR, n.value), now);
      n.linearRampToValueAtTime(SQ_TAIL, now + 0.01); n.exponentialRampToValueAtTime(FLOOR, now + PREEMPT - 0.005);
      c.ns.stop(now + PREEMPT);
    } catch (e) { /* already stopped */ }
    c.active = false;
  }
}
