// Offline multi-sample instrument engine for the VSCO 2 CE samples.
//  - Articulation: regions from an SFZ file (key/velocity mapping, round robins) + our analysis (loudness, onset, tuning).
//  - Voices are rendered sample-accurately with an 8-tap Kaiser-windowed-sinc resampler (44.1 kHz source -> 48 kHz out,
//    pitch shift folded into the ratio), crossfaded dynamic layers following a dynamics curve, optional crossfade looping
//    for notes longer than the recording, attack/legato fades and release envelopes, then panned into a stereo buffer.
import { join } from 'node:path';
import { readWav } from './wav.mjs';
import { parseSfz } from './sfz.mjs';
import { dbToGain } from './dsp.mjs';

// ------------------------------------------------------------------------------------------------ sample bank
export class SampleBank {
  /** root: downloaded library; outDir: where virtual/ samples live */
  constructor(root, analysis, outDir) { this.root = root; this.outDir = outDir; this.analysis = analysis; this.cache = new Map(); }
  get(rel) {
    let s = this.cache.get(rel);
    if (!s) {
      const w = readWav(rel.startsWith('virtual/') ? join(this.outDir, rel) : join(this.root, rel));
      const L = w.channels[0], R = w.channels[1] || w.channels[0];
      if (!/Percussion|Timpani/i.test(rel)) for (const ch of w.channels) declick(ch); // isolated digital spikes only
      s = { rel, sr: w.sampleRate, L, R, frames: w.frames, info: this.analysis[rel] || {} };
      this.cache.set(rel, s);
    }
    return s;
  }
}

/** Repair isolated single-sample spikes (recording/editing clicks): a sample far from both neighbours that agree. */
export function declick(x) {
  let n = 0;
  for (let i = 1; i + 1 < x.length; i++) {
    const a = x[i - 1], b = x[i + 1], m = 0.5 * (a + b);
    if (Math.abs(x[i] - m) > 0.2 && Math.abs(a - b) < 0.1) { x[i] = m; n++; }
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ resampling kernel
const TAPS = 8, PHASES = 512;
const kernelCache = new Map();
function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; }
function kernel(cutoff) { // cutoff in (0,1], fraction of source Nyquist
  const key = Math.round(cutoff * 50) / 50;
  let k = kernelCache.get(key);
  if (k) return k;
  k = new Float32Array((PHASES + 1) * TAPS);
  const beta = 7.0, i0b = besselI0(beta);
  for (let ph = 0; ph <= PHASES; ph++) {
    const frac = ph / PHASES; let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = (j - (TAPS / 2 - 1)) - frac; // taps at -3..4 relative to floor(pos)
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * key * x) / (Math.PI * key * x);
      const r = x / (TAPS / 2); const win = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const v = key * sinc * win; k[ph * TAPS + j] = v; sum += v;
    }
    for (let j = 0; j < TAPS; j++) k[ph * TAPS + j] /= sum;
  }
  kernelCache.set(key, k);
  return k;
}

// ------------------------------------------------------------------------------------------------ articulation
/**
 * @param bank SampleBank
 * @param sfzPath path to .sfz
 * @param opts { kind:'sus'|'short', targetDb, tuneMax (cents), advanceK, advanceMax, filter(region)->bool }
 */
export class Articulation {
  constructor(bank, name, regions, opts = {}) {
    this.bank = bank; this.name = name;
    this.kind = opts.kind || 'sus';
    this.dynRangeDb = opts.dynRangeDb ?? 22;
    this.advanceK = opts.advanceK ?? (this.kind === 'sus' ? 0.5 : 0.35);
    this.advanceMax = opts.advanceMax ?? (this.kind === 'sus' ? 0.09 : 0.03);
    this.ring = opts.ring ?? 0;          // minimum hold before the release starts (one-shots that should ring)
    this.release = opts.release;         // default release time (s)
    const target = opts.targetDb ?? -20;
    const tuneMax = opts.tuneMax ?? (this.kind === 'sus' ? 35 : 22);
    this.regions = regions.filter((r) => bank.analysis[r.sample]).map((r) => {
      const a = bank.analysis[r.sample];
      const lev = this.kind === 'sus' ? a.bodyDb : Math.max(a.earlyDb, a.bodyDb - 3);
      const cents = (typeof a.cents === 'number' && Math.abs(a.cents) <= tuneMax && (a.nf || 0) >= 3) ? a.cents : 0;
      return { ...r, lev, norm: dbToGain(Math.min(30, target - lev)), cents, a };
    });
    // per-layer loudness smoothing: pull each sample 50% toward its layer median (keeps register character, kills outliers)
    const byLayer = new Map();
    for (const r of this.regions) { const k = r.lovel + '-' + r.hivel; if (!byLayer.has(k)) byLayer.set(k, []); byLayer.get(k).push(r); }
    for (const arr of byLayer.values()) {
      const med = arr.map((r) => r.lev).sort((a, b) => a - b)[arr.length >> 1];
      for (const r of arr) { const lev = med + Math.max(-4, Math.min(4, r.lev - med)) * 0.5; r.norm = dbToGain(Math.min(30, target - lev)); }
    }
    if (!this.regions.length) throw new Error(`articulation ${name}: no regions`);
  }
  static fromSfz(bank, name, sfzPath, opts = {}) {
    let regs = parseSfz(sfzPath);
    if (opts.filter) regs = regs.filter(opts.filter);
    return new Articulation(bank, name, regs, opts);
  }
  /** Regions covering midi (nearest key fallback), grouped into dynamic layers sorted soft->loud, honouring round robin. */
  layersFor(midi, rr = 0) {
    const m = Math.round(midi);
    let cand = this.regions.filter((r) => m >= r.lokey && m <= r.hikey);
    if (!cand.length) { // nearest key centre
      let best = Infinity; for (const r of this.regions) best = Math.min(best, Math.abs(r.key - midi));
      cand = this.regions.filter((r) => Math.abs(r.key - midi) === best);
    }
    const layers = new Map();
    for (const r of cand) { const k = r.lovel * 1000 + r.hivel; if (!layers.has(k)) layers.set(k, []); layers.get(k).push(r); }
    const out = [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([k, arr]) => {
      arr.sort((a, b) => a.seqPosition - b.seqPosition || (a.sample < b.sample ? -1 : 1));
      const r = arr[((rr % arr.length) + arr.length) % arr.length];
      return { region: r, pos: ((r.lovel + r.hivel) / 2) / 127 };
    });
    // normalise positions to span 0..1 so every layer is reachable regardless of the SFZ velocity split
    if (out.length > 1) { const p0 = out[0].pos, p1 = out[out.length - 1].pos; for (const l of out) l.pos = (l.pos - p0) / (p1 - p0); }
    else if (out.length === 1) out[0].pos = 0.5;
    return out;
  }
}

/** Equal-power weights of each layer for dynamic d (0..1). */
export function layerWeights(layers, d) {
  const w = new Array(layers.length).fill(0);
  if (layers.length === 1) { w[0] = 1; return w; }
  if (d <= layers[0].pos) { w[0] = 1; return w; }
  for (let i = 0; i + 1 < layers.length; i++) {
    const a = layers[i].pos, b = layers[i + 1].pos;
    if (d <= b) { const x = (d - a) / (b - a); w[i] = Math.cos(x * Math.PI / 2); w[i + 1] = Math.sin(x * Math.PI / 2); return w; }
  }
  w[layers.length - 1] = 1; return w;
}

// ------------------------------------------------------------------------------------------------ voice rendering
/**
 * Render one voice (one region) into out = [L, R] (Float32Array at outSr).
 * v = { region, sample, midi, tOn (s, sample onset lands here), tOff (s, release starts), release (s), gainFn(tSec)->linear,
 *       offset (s into the sample after onset), attack (s fade-in), pan (-1..1), width (0..1+), detune (cents), loop (bool), hardEnd (s),
 *       vib (optional delayed pitch vibrato, see below) }
 */
export function renderVoice(out, outSr, v) {
  const s = v.sample, r = v.region, src = s.sr;
  const semis = v.midi - r.key - (r.cents || 0) / 100 + (v.detune || 0) / 100;
  const ratio = Math.pow(2, semis / 12) * src / outSr;
  const cutoff = ratio > 1 ? Math.max(0.5, 1 / ratio) * 0.97 : 0.97;
  const K = kernel(cutoff);
  const onset = Math.max(0, (s.info.onset || 0) - Math.round(0.0015 * src));
  const startPos = onset + Math.round((v.offset || 0) * src);
  const endPos = Math.min(s.frames - 4, (s.info.end || s.frames) + Math.round(0.05 * src));
  const tStart = v.tOn;
  const relEnd = v.tOff + v.release;
  // usable source length and loop setup
  const neededSrc = (Math.min(relEnd, v.hardEnd ?? Infinity) - tStart) * outSr * ratio;
  let loopStart = -1, loopEnd = -1, xf = 0;
  if (v.loop && startPos + neededSrc > endPos - 0.4 * src) {
    renderVoice.loops = (renderVoice.loops || 0) + 1;
    if (process.env.MUSIC_DEBUG_LOOPS) console.log(`  loop: ${s.rel} midi ${v.midi} needs ${(neededSrc / src).toFixed(2)}s of ${((endPos - startPos) / src).toFixed(2)}s`);
    const avail = endPos - startPos;
    loopEnd = startPos + Math.floor(avail * 0.82); loopStart = startPos + Math.floor(avail * 0.38);
    xf = Math.min(Math.floor(0.3 * src), Math.floor((loopEnd - loopStart) * 0.45));
  }
  const L = s.L, R = s.R, oL = out[0], oR = out[1];
  const i0 = Math.max(0, Math.ceil(tStart * outSr));
  let pos = startPos + (i0 - tStart * outSr) * ratio;
  const iEnd = Math.min(oL.length, Math.ceil(Math.min(relEnd, v.hardEnd ?? Infinity) * outSr));
  // pan / width matrix
  const pan = Math.max(-1, Math.min(1, v.pan || 0)), width = v.width ?? 1;
  const ang = (pan + 1) * Math.PI / 4, gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;
  const mm = 0.5, ss = 0.5 * width;
  const aLL = (mm + ss) * gl, aLR = (mm - ss) * gl, aRL = (mm - ss) * gr, aRR = (mm + ss) * gr;
  const norm = r.norm * (v.gain ?? 1);
  const attack = Math.max(v.attack || 0, 0.0025), release = Math.max(0.005, v.release); // >= 2.5 ms fade-in: no start clicks
  const CB = 32; // control block
  let gPrev = null;
  const read = (p) => {
    const ip = Math.floor(p); const fr = p - ip; const k = Math.round(fr * PHASES) * TAPS;
    let sl = 0, sr2 = 0; const b = ip - 3;
    if (b < 0 || b + TAPS >= s.frames) {
      for (let j = 0; j < TAPS; j++) { const idx = b + j; if (idx < 0 || idx >= s.frames) continue; const w = K[k + j]; sl += L[idx] * w; sr2 += R[idx] * w; }
    } else {
      for (let j = 0; j < TAPS; j++) { const w = K[k + j]; sl += L[b + j] * w; sr2 += R[b + j] * w; }
    }
    rl = sl; rr = sr2;
  };
  let rl = 0, rr = 0;
  // optional dynamics-driven brightness: 2-pole low-pass whose cutoff follows lpFn(t) (Hz), updated per control block
  const lpFn = v.lpFn; let fb0 = 1, fb1 = 0, fb2 = 0, fa1 = 0, fa2 = 0, zl1 = 0, zl2 = 0, zr1 = 0, zr2 = 0;
  const setLp = (fc) => {
    const w0 = 2 * Math.PI * Math.min(fc, outSr * 0.45) / outSr, al = Math.sin(w0) / (2 * 0.6), cw = Math.cos(w0), a0 = 1 + al;
    fb0 = (1 - cw) / 2 / a0; fb1 = (1 - cw) / a0; fb2 = fb0; fa1 = -2 * cw / a0; fa2 = (1 - al) / a0;
  };
  // v.vib = { t0, delay, rise, depth (cents), rate (Hz), phase }: vibrato fading in `delay` s after t0 over `rise` s
  const vib = v.vib;
  const vibMul = (t) => { const tt = t - vib.t0 - vib.delay; if (tt <= 0) return 1; const k = Math.min(1, tt / vib.rise);
    return Math.pow(2, vib.depth * k * Math.sin(2 * Math.PI * vib.rate * (t - vib.t0) + (vib.phase || 0)) / 1200); };
  for (let i = i0; i < iEnd; i += CB) {
    const n = Math.min(CB, iEnd - i);
    const rat = vib ? ratio * vibMul(i / outSr) : ratio; // optional delayed vibrato (pitch), per control block
    const t1 = (i + n) / outSr;
    const env = (t) => {
      let g = v.gainFn ? v.gainFn(t) : 1;
      const tt = t - tStart; if (attack > 0 && tt < attack) g *= 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, tt) / attack);
      if (t > v.tOff) { const x = Math.min(1, (t - v.tOff) / release); g *= Math.pow(1 - x, 2.2); }
      return g * norm;
    };
    const ga = gPrev ?? env(i / outSr), gb = env(t1); gPrev = gb;
    if (lpFn) setLp(lpFn(i / outSr));
    if (ga === 0 && gb === 0) { pos += n * rat; if (loopEnd > 0) while (pos >= loopEnd) pos -= loopEnd - loopStart; continue; }
    for (let j = 0; j < n; j++) {
      if (pos >= endPos) return;
      const g = ga + (gb - ga) * (j / n);
      let xl, xr;
      if (loopEnd > 0 && pos >= loopEnd - xf) {
        const w = (pos - (loopEnd - xf)) / xf;
        read(pos); const al = rl, ar2 = rr;
        read(pos - (loopEnd - loopStart));
        const ca = Math.cos(w * Math.PI / 2), cb = Math.sin(w * Math.PI / 2);
        xl = al * ca + rl * cb; xr = ar2 * ca + rr * cb;
      } else { read(pos); xl = rl; xr = rr; }
      if (lpFn) {
        const yl = fb0 * xl + zl1; zl1 = fb1 * xl - fa1 * yl + zl2; zl2 = fb2 * xl - fa2 * yl; xl = yl;
        const yr = fb0 * xr + zr1; zr1 = fb1 * xr - fa1 * yr + zr2; zr2 = fb2 * xr - fa2 * yr; xr = yr;
      }
      const idx = i + j;
      oL[idx] += g * (aLL * xl + aLR * xr);
      oR[idx] += g * (aRL * xl + aRR * xr);
      pos += rat;
      if (loopEnd > 0 && pos >= loopEnd) pos -= loopEnd - loopStart;
    }
  }
}
