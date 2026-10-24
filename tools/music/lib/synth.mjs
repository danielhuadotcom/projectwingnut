// Small offline subtractive synthesiser + drum synth for the electronic audition piece (render_night.mjs). No samples.
//  - band-limited oscillators (PolyBLEP saw / pulse, triangle, sine), unison with detune + stereo spread, slow drift
//  - zero-delay-feedback state-variable filters (Cytomic/TPT SVF); 2 cascaded = 24 dB/oct with resonance on the last
//  - ADSR envelopes for amp and filter, per-voice soft saturation
//  - drums: sine kick with pitch/amp envelopes and click, 808-style metallic hats (six square partials + noise),
//    multi-burst clap, rim, shaker, noise riser
//  - FX: tempo-synced ping-pong delay with filtered feedback, sidechain-style gain curve from kick times
import { rng } from './dsp.mjs';

const TAU = Math.PI * 2;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** TPT state-variable filter (one channel). mode: 'lp' | 'bp' | 'hp'. */
export class SVF {
  constructor(sr) { this.sr = sr; this.ic1 = 0; this.ic2 = 0; this.set(1000, 0.707); }
  set(fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 10, this.sr * 0.47) / this.sr), k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.k = k;
  }
  lp(x) { const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3; this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2; return v2; }
  bp(x) { const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3; this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2; return v1; }
  hp(x) { const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3; this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2; return x - this.k * v1 - v2; }
}

/** ADSR value at time t after note-on for a note held `dur` seconds (release starts at dur, from the level reached). */
export function adsr(t, dur, a, d, s, r) {
  const seg = (tt) => (tt < a ? tt / a : tt < a + d ? 1 - (1 - s) * (tt - a) / d : s);
  if (t < 0) return 0;
  if (t < dur) return seg(t);
  const l = seg(dur), x = (t - dur) / r;
  return x >= 1 ? 0 : l * Math.pow(1 - x, 2);
}

const softclip = (x) => (x > 3 ? 1 : x < -3 ? -1 : x * (27 + x * x) / (27 + 9 * x * x));

/**
 * Render a subtractive-synth note into [L, R].
 * n = { t, dur, midi, vel (0..1), pan, glideFrom (midi), seed, cutoff (Hz multiplier fn of t, optional), gain }
 * p = patch { osc:[{ type:'saw'|'pulse'|'tri'|'sine', gain, octave, detune (cents), unison, spread (cents), width (pulse) }],
 *             noise, amp:{a,d,s,r}, filt:{ cutoff, env (octaves), keytrack (0..1), res (q), a,d,s,r, poles:2|4, velAmt (octaves) },
 *             drive, stereo (0..1 unison spread), vib:{ rate, depth (cents), delay }, drift (cents), gain, glide (s) }
 */
export function synthNote([L, R], sr, n, p) {
  const r = rng(n.seed >>> 0 || 1);
  const amp = p.amp, f = p.filt;
  const tEnd = n.t + n.dur + amp.r;
  const i0 = Math.max(0, Math.floor(n.t * sr)), i1 = Math.min(L.length, Math.ceil(tEnd * sr));
  if (i1 <= i0) return;
  // oscillator bank (unison voices with fixed detune offsets, random phases, own pan)
  const voices = [];
  for (const o of p.osc) {
    const u = o.unison || 1;
    for (let k = 0; k < u; k++) {
      const off = u === 1 ? 0 : (k / (u - 1) - 0.5) * 2; // -1..1
      voices.push({ type: o.type, gain: (o.gain ?? 1) / Math.sqrt(u), oct: o.octave || 0, cents: (o.detune || 0) + off * (o.spread || 0) + (r() - 0.5) * 2,
        width: o.width ?? 0.5, ph: r(), pan: off * (p.stereo ?? 0.5), tri: 0 });
    }
  }
  const nPan = clamp(n.pan || 0, -1, 1);
  const fl = [new SVF(sr), new SVF(sr)], fr = [new SVF(sr), new SVF(sr)];
  const poles = f.poles || 4, q = f.res ?? 0.8;
  const baseHz = mtof(n.midi);
  const vibD = p.vib ? p.vib.depth : 0, vibR = p.vib ? p.vib.rate : 0, vibDel = p.vib ? p.vib.delay || 0 : 0, vibPh = r() * TAU;
  const driftPh = r() * TAU, driftR = 0.07 + 0.1 * r(), driftD = p.drift || 0;
  const g0 = (p.gain ?? 1) * (n.gain ?? 1) * (0.25 + 0.75 * (n.vel ?? 0.8));
  const velOct = (f.velAmt || 0) * ((n.vel ?? 0.8) - 0.7);
  const CB = 16; let fc = 0, fcNext = 0;
  const cutoffAt = (t) => {
    const tt = t - n.t;
    const fenv = adsr(tt, n.dur, f.a, f.d, f.s, f.r);
    const kt = Math.pow(baseHz / 261.6, f.keytrack ?? 0.5);
    return f.cutoff * kt * Math.pow(2, (f.env || 0) * fenv + velOct) * (n.cutoff ? n.cutoff(t) : 1);
  };
  let noiseS = 0;
  for (let i = i0; i < i1; i += CB) {
    const m = Math.min(CB, i1 - i);
    fc = cutoffAt(i / sr); fcNext = cutoffAt((i + m) / sr);
    const fcm = Math.sqrt(fc * fcNext);
    for (const s of fl) s.set(fcm, poles === 4 ? 0.54 : q); for (const s of fr) s.set(fcm, poles === 4 ? 0.54 : q);
    fl[1].set(fcm, q); fr[1].set(fcm, q);
    for (let j = 0; j < m; j++) {
      const idx = i + j, t = idx / sr, tt = t - n.t;
      let semis = 0;
      if (n.glideFrom !== undefined && p.glide) semis = (n.glideFrom - n.midi) * Math.max(0, 1 - tt / p.glide);
      let cents = driftD * Math.sin(TAU * driftR * tt + driftPh);
      if (vibD && tt > vibDel) cents += vibD * Math.min(1, (tt - vibDel) / 0.4) * Math.sin(TAU * vibR * tt + vibPh);
      const pitchMul = Math.pow(2, semis / 12 + cents / 1200);
      let sl = 0, sr2 = 0;
      for (const v of voices) {
        const fq = baseHz * pitchMul * Math.pow(2, v.oct + v.cents / 1200), dt = fq / sr;
        v.ph += dt; if (v.ph >= 1) v.ph -= 1;
        let x;
        if (v.type === 'saw') x = 2 * v.ph - 1 - blep(v.ph, dt);
        else if (v.type === 'pulse') { x = (v.ph < v.width ? 1 : -1) + blep(v.ph, dt) - blep((v.ph - v.width + 1) % 1, dt); }
        else if (v.type === 'tri') { const sq = (v.ph < 0.5 ? 1 : -1) + blep(v.ph, dt) - blep((v.ph + 0.5) % 1, dt); v.tri = 0.999 * v.tri + 4 * dt * sq; x = v.tri; }
        else x = Math.sin(TAU * v.ph);
        x *= v.gain;
        const pl = 0.5 - 0.5 * v.pan, pr = 0.5 + 0.5 * v.pan;
        sl += x * pl * 2; sr2 += x * pr * 2;
      }
      if (p.noise) { noiseS = r() * 2 - 1; sl += p.noise * noiseS; sr2 += p.noise * noiseS; }
      // filter
      let yl = sl, yr = sr2;
      if (poles === 4) { yl = fl[1].lp(fl[0].lp(yl)); yr = fr[1].lp(fr[0].lp(yr)); } else { yl = fl[1].lp(yl); yr = fr[1].lp(yr); }
      const e = adsr(tt, n.dur, amp.a, amp.d, amp.s, amp.r) * g0;
      if (p.drive) { yl = softclip(yl * p.drive) / p.drive; yr = softclip(yr * p.drive) / p.drive; }
      const gl = Math.cos((nPan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((nPan + 1) * Math.PI / 4) * Math.SQRT2;
      L[idx] += yl * e * gl; R[idx] += yr * e * gr;
    }
  }
}

// ------------------------------------------------------------------------------------------------ drums
/** Kick: sine with exponential pitch drop, amplitude decay, short filtered click, gentle saturation. */
export function kick([L, R], sr, { t, vel = 0.9, seed = 1, tune = 47, decay = 0.42, punch = 3.2, click = 0.35 }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t * sr)), n = Math.round((decay * 2.2) * sr);
  let ph = 0; const hp = new SVF(sr); hp.set(1800, 0.7); const lpc = new SVF(sr); lpc.set(6000, 0.7);
  const g = 0.9 * (0.35 + 0.65 * vel);
  for (let j = 0; j < n && i0 + j < L.length; j++) {
    const tt = j / sr;
    const f = tune * (1 + punch * Math.exp(-tt / 0.028) + 0.4 * Math.exp(-tt / 0.12));
    ph += f / sr;
    const a = (tt < 0.002 ? tt / 0.002 : 1) * Math.exp(-tt / decay) * (tt > decay * 1.6 ? Math.max(0, 1 - (tt - decay * 1.6) / (decay * 0.6)) : 1);
    let x = Math.sin(TAU * ph) * a;
    const c = lpc.lp(hp.hp(r() * 2 - 1)) * click * Math.exp(-tt / 0.006);
    x = softclip((x + c) * 1.6) / 1.2;
    L[i0 + j] += x * g; R[i0 + j] += x * g;
  }
}

const HAT_RATIOS = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1523];
/** Hat: six detuned square partials (808 recipe) + noise through band/high-pass, exponential decay. */
export function hat([L, R], sr, { t, vel = 0.6, seed = 1, decay = 0.045, pan = 0, tone = 1, base = 410 }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t * sr)), n = Math.round(decay * 7 * sr);
  const ph = HAT_RATIOS.map(() => r()); const bp = new SVF(sr); bp.set(9500 * tone, 1.1); const hp = new SVF(sr); hp.set(7200 * tone, 0.7);
  const g = 0.32 * (0.2 + 0.8 * vel) * vel;
  const gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
  for (let j = 0; j < n && i0 + j < L.length; j++) {
    const tt = j / sr; let m = 0;
    for (let k = 0; k < 6; k++) { ph[k] += base * HAT_RATIOS[k] * (1 + 0.003 * k) / sr; ph[k] -= Math.floor(ph[k]); m += ph[k] < 0.5 ? 1 : -1; }
    const x = hp.hp(bp.bp(m / 6 * 0.6 + (r() * 2 - 1) * 0.7));
    const a = (tt < 0.0008 ? tt / 0.0008 : 1) * Math.exp(-tt / decay);
    L[i0 + j] += x * a * g * gl; R[i0 + j] += x * a * g * gr;
  }
}

/** Clap: three quick noise bursts then a diffuse tail, band-passed around 1.1 kHz, slightly widened. */
export function clap([L, R], sr, { t, vel = 0.7, seed = 1, tail = 0.16 }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t * sr)), n = Math.round((tail * 6 + 0.04) * sr);
  const bl = new SVF(sr), br = new SVF(sr); bl.set(1150, 1.4); br.set(1250, 1.4);
  const hp = new SVF(sr); hp.set(500, 0.7); const hp2 = new SVF(sr); hp2.set(500, 0.7);
  const bursts = [0, 0.0105 + 0.002 * r(), 0.0215 + 0.002 * r()];
  const g = 1.6 * (0.3 + 0.7 * vel) * vel;
  for (let j = 0; j < n && i0 + j < L.length; j++) {
    const tt = j / sr; let a = 0;
    for (const b of bursts) if (tt >= b) a = Math.max(a, Math.exp(-(tt - b) / 0.0065));
    if (tt >= 0.03) a = Math.max(a, 0.55 * Math.exp(-(tt - 0.03) / tail));
    const nl = r() * 2 - 1, nr = 0.7 * nl + 0.3 * (r() * 2 - 1);
    L[i0 + j] += hp.hp(bl.bp(nl)) * a * g; R[i0 + j] += hp2.hp(br.bp(nr)) * a * g;
  }
}

/** Rim / click: short resonant ping plus a tick of noise. */
export function rim([L, R], sr, { t, vel = 0.5, seed = 1, freq = 1650, pan = 0 }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t * sr)), n = Math.round(0.08 * sr);
  const bp = new SVF(sr); bp.set(freq, 7);
  const g = 0.9 * vel, gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
  for (let j = 0; j < n && i0 + j < L.length; j++) {
    const tt = j / sr, ex = j < 48 ? (r() * 2 - 1) : 0;
    const x = bp.bp(ex * 3) * Math.exp(-tt / 0.018) + ex * 0.15 * Math.exp(-tt / 0.002);
    L[i0 + j] += x * g * gl; R[i0 + j] += x * g * gr;
  }
}

/** Shaker: band-passed noise grain with a soft attack. */
export function shaker([L, R], sr, { t, vel = 0.4, seed = 1, pan = 0, len = 0.07 }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t * sr)), n = Math.round(len * 2.5 * sr);
  const bp = new SVF(sr); bp.set(6500, 0.9);
  const g = 0.5 * vel, gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
  for (let j = 0; j < n && i0 + j < L.length; j++) {
    const tt = j / sr, a = tt < len * 0.35 ? tt / (len * 0.35) : Math.exp(-(tt - len * 0.35) / (len * 0.4));
    const x = bp.bp(r() * 2 - 1) * a;
    L[i0 + j] += x * g * gl; R[i0 + j] += x * g * gr;
  }
}

/** Noise riser / swell over [t0, t1]: band-pass sweeping upward, amplitude following `shape` (0..1 over the span). */
export function riser([L, R], sr, { t0, t1, f0 = 300, f1 = 7000, gain = 0.2, seed = 1, q = 2, reverse = false }) {
  const r = rng(seed), i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(L.length, Math.floor(t1 * sr));
  const bl = new SVF(sr), br = new SVF(sr);
  for (let i = i0; i < i1; i++) {
    const x = (i - i0) / (i1 - i0), f = f0 * Math.pow(f1 / f0, x);
    if ((i - i0) % 16 === 0) { bl.set(f, q); br.set(f * 1.03, q); }
    const a = gain * (reverse ? Math.pow(x, 3) : Math.pow(x, 2)) * (x > 0.97 ? (1 - x) / 0.03 : 1);
    L[i] += bl.bp(r() * 2 - 1) * a; R[i] += br.bp(r() * 2 - 1) * a;
  }
}

// ------------------------------------------------------------------------------------------------ FX
/** Ping-pong delay (in place add of the wet signal): time in s, feedback, damping low-pass in the loop. */
export function pingPong([L, R], sr, { time, feedback = 0.42, wet = 0.3, lp = 3500, hp = 250, input = null }) {
  const [IL, IR] = input || [L, R];
  const d = Math.round(time * sr), n = L.length;
  const bufL = new Float32Array(d), bufR = new Float32Array(d);
  const lpl = new SVF(sr), lpr = new SVF(sr), hpl = new SVF(sr), hpr = new SVF(sr);
  lpl.set(lp, 0.6); lpr.set(lp, 0.6); hpl.set(hp, 0.6); hpr.set(hp, 0.6);
  let w = 0; const outL = new Float32Array(n), outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dl = bufL[w], dr = bufR[w];
    const inMono = 0.5 * (IL[i] + IR[i]);
    // cross-feedback: left echo feeds right and vice versa (ping-pong), mono input enters on the left
    bufL[w] = hpl.hp(lpl.lp(inMono + dr * feedback));
    bufR[w] = hpr.hp(lpr.lp(dl * feedback));
    outL[i] = dl; outR[i] = dr;
    w = (w + 1) % d;
  }
  for (let i = 0; i < n; i++) { L[i] += outL[i] * wet; R[i] += outR[i] * wet; }
  return [outL, outR];
}

/** Sidechain-style gain curve: dips by `depth` (0..1) at every kick time and recovers over `release` s. `period`
 *  (optional) makes the curve periodic (a kick at t also ducks t + period, for circular loops). */
export function duckCurve(n, sr, kicks, { depth = 0.5, attack = 0.006, release = 0.3, curve = 2.2, period = 0 } = {}) {
  const g = new Float32Array(n).fill(1);
  const times = period ? kicks.flatMap((k) => [k.t, k.t + period, k.t - period]) : kicks.map((k) => k.t);
  const vels = period ? kicks.flatMap((k) => [k.vel, k.vel, k.vel]) : kicks.map((k) => k.vel);
  times.forEach((t, j) => {
    const d = depth * Math.min(1, (vels[j] ?? 1) * 1.1);
    const i0 = Math.max(0, Math.floor((t - attack) * sr)), i1 = Math.min(n, Math.ceil((t + release) * sr));
    for (let i = i0; i < i1; i++) {
      const tt = i / sr - t;
      const env = tt < 0 ? 1 - (-tt / attack) : Math.pow(1 - tt / release, curve);
      const v = 1 - d * Math.max(0, env);
      if (v < g[i]) g[i] = v;
    }
  });
  return g;
}

/** Shepard-style riser over [t0, t1]: octave-spaced partials glide upward continuously (`rate` octaves per second) under
 *  a fixed bell-shaped spectral window, so the pitch seems to rise forever; amplitude grows with `curve`. */
export function shepard([L, R], sr, { t0, t1, base = 55, octaves = 7, rate = 0.35, gain = 0.15, curve = 2, seed = 1 }) {
  const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(L.length, Math.floor(t1 * sr));
  const r = rng(seed), ph = Array.from({ length: octaves }, () => r()), ph2 = Array.from({ length: octaves }, () => r());
  const center = Math.log2(base) + octaves / 2;
  for (let i = i0; i < i1; i++) {
    const tt = (i - i0) / sr, x = (i - i0) / (i1 - i0);
    const env = gain * Math.pow(x, curve) * (x > 0.985 ? (1 - x) / 0.015 : 1) * Math.min(1, tt / 0.05);
    let sl = 0, sr2 = 0;
    for (let k = 0; k < octaves; k++) {
      const lf = Math.log2(base) + ((k + rate * tt) % octaves), f = Math.pow(2, lf);
      const w = Math.exp(-0.5 * Math.pow((lf - center) / (octaves / 6), 2));
      ph[k] += f / sr; ph[k] -= Math.floor(ph[k]); ph2[k] += f * 1.004 / sr; ph2[k] -= Math.floor(ph2[k]);
      // slightly bright partials (sine + a little 2nd harmonic), detuned pair for width
      sl += w * (Math.sin(TAU * ph[k]) + 0.25 * Math.sin(2 * TAU * ph[k])); sr2 += w * (Math.sin(TAU * ph2[k]) + 0.25 * Math.sin(2 * TAU * ph2[k]));
    }
    L[i] += sl * env / octaves * 2; R[i] += sr2 * env / octaves * 2;
  }
}
