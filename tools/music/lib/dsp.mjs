// DSP toolkit for the offline renderer: FFT convolution, RBJ biquads, envelope followers, compressor, true-peak-ish
// limiter, BS.1770 loudness, deterministic noise, synthetic hall impulse responses. Float32/Float64 arrays only.

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-12, g));

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function hash32(...xs) { // small stable hash of numbers/strings -> uint32
  let h = 2166136261 >>> 0;
  for (const x of xs) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ------------------------------------------------------------------------------------------------ FFT (in place)
const twiddleCache = new Map();
function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) { t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) }; for (let i = 0; i < n / 2; i++) { t.cos[i] = Math.cos(-2 * Math.PI * i / n); t.sin[i] = Math.sin(-2 * Math.PI * i / n); } twiddleCache.set(n, t); }
  return t;
}
/** Iterative radix-2 complex FFT. inverse=true computes the unscaled inverse. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = inverse ? -sin[k * step] : sin[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Overlap-add FFT convolution of signal x with impulse response h. Returns Float32Array of length x.length + h.length - 1. */
export function convolve(x, h, outLen = x.length + h.length - 1) {
  const m = h.length;
  let n = 1; while (n < 4 * m) n <<= 1; n = Math.max(n, 1 << 15);
  const block = n - m + 1;
  const Hr = new Float64Array(n), Hi = new Float64Array(n);
  for (let i = 0; i < m; i++) Hr[i] = h[i];
  fft(Hr, Hi);
  const out = new Float32Array(outLen);
  const Xr = new Float64Array(n), Xi = new Float64Array(n);
  for (let start = 0; start < x.length; start += block) {
    Xr.fill(0); Xi.fill(0);
    const len = Math.min(block, x.length - start);
    let any = false;
    for (let i = 0; i < len; i++) { const v = x[start + i]; Xr[i] = v; if (v !== 0) any = true; }
    if (!any) continue;
    fft(Xr, Xi);
    for (let k = 0; k < n; k++) { const r = Xr[k] * Hr[k] - Xi[k] * Hi[k], i2 = Xr[k] * Hi[k] + Xi[k] * Hr[k]; Xr[k] = r; Xi[k] = i2; }
    fft(Xr, Xi, true);
    const lim = Math.min(n, outLen - start);
    for (let i = 0; i < lim; i++) out[start + i] += Xr[i] / n;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ biquads (RBJ)
export function biquadCoefs(type, f0, sr, { q = 0.7071, gainDb = 0, slope = 1 } = {}) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * Math.min(f0, sr * 0.49) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  let alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': case 'highshelf': {
      alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2); const sa = 2 * Math.sqrt(A) * alpha;
      if (type === 'lowshelf') { b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa); a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa; }
      else { b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa); a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; }
      break;
    }
    default: throw new Error('biquad type ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
/** Filter buffer in place (transposed direct form II, double precision state). */
export function biquad(buf, c) {
  let z1 = 0, z2 = 0; const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; const y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; buf[i] = y; }
  return buf;
}
/** Apply a chain of [type, f0, opts] filters to each channel in place. */
export function eq(channels, sr, chainSpec) {
  for (const [type, f0, opts] of chainSpec) { const c = biquadCoefs(type, f0, sr, opts); for (const ch of channels) biquad(ch, c); }
  return channels;
}

// ------------------------------------------------------------------------------------------------ dynamics
/** Stereo-linked feed-forward compressor (soft knee, RMS detector). Returns gain-reduction stats. */
export function compress([L, R], sr, { thresholdDb = -18, ratio = 2, kneeDb = 6, attack = 0.02, release = 0.25, rmsTime = 0.01, makeupDb = 0 } = {}) {
  const ar = Math.exp(-1 / (attack * sr)), rr = Math.exp(-1 / (release * sr)), rm = Math.exp(-1 / (rmsTime * sr));
  let ms = 0, grDb = 0, maxGr = 0, sumGr = 0; const mk = dbToGain(makeupDb);
  for (let i = 0; i < L.length; i++) {
    const p = Math.max(L[i] * L[i], R[i] * R[i]);
    ms = rm * ms + (1 - rm) * p;
    const lev = 10 * Math.log10(ms + 1e-20);
    const over = lev - thresholdDb;
    let target = 0;
    if (over > kneeDb / 2) target = over * (1 - 1 / ratio);
    else if (over > -kneeDb / 2) { const x = over + kneeDb / 2; target = (1 - 1 / ratio) * x * x / (2 * kneeDb); }
    grDb = target > grDb ? ar * grDb + (1 - ar) * target : rr * grDb + (1 - rr) * target;
    const g = dbToGain(-grDb) * mk; L[i] *= g; R[i] *= g;
    if (grDb > maxGr) maxGr = grDb; sumGr += grDb;
  }
  return { maxGr, avgGr: sumGr / L.length };
}

/**
 * Lookahead brickwall limiter. Gain = moving-average(sliding-min(required gain)) so the reduction ramps in smoothly
 * over the lookahead window and is guaranteed <= the requirement at every (4x-interpolated) peak; slow release.
 */
export function limit([L, R], sr, { ceilingDb = -1, lookahead = 0.004, release = 0.12 } = {}) {
  const n = L.length, la = Math.max(2, Math.round(lookahead * sr)), ceil = dbToGain(ceilingDb);
  const isp = (x, i) => { // max |x| over the sample and 3 cubic-interpolated inter-sample points
    const xm1 = x[i > 0 ? i - 1 : 0], x0 = x[i], x1 = x[i + 1 < n ? i + 1 : n - 1], x2 = x[i + 2 < n ? i + 2 : n - 1];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    let m = Math.abs(x0);
    for (let k = 1; k < 4; k++) { const t = k / 4; const v = Math.abs(((c3 * t + c2) * t + c1) * t + x0); if (v > m) m = v; }
    return m;
  };
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.max(isp(L, i), isp(R, i)); req[i] = p > ceil ? ceil / p : 1; }
  // g1[o] = min(req[o .. o+la])
  const g1 = new Float32Array(n); const dq = new Int32Array(n + 1); let h = 0, t = 0;
  for (let i = 0; i < n + la; i++) {
    if (i < n) { while (t > h && req[dq[t - 1]] >= req[i]) t--; dq[t++] = i; }
    const o = i - la; if (o < 0) continue;
    while (h < t && dq[h] < o) h++;
    g1[o] = req[dq[h]];
  }
  for (let o = Math.max(0, n - la); o < n; o++) { let m = 1; for (let j = o; j < n; j++) m = Math.min(m, req[j]); g1[o] = m; }
  // g2 = trailing moving average of g1 over la samples (<= req at peaks), g3 = slow release (only when rising)
  const rr = Math.exp(-1 / (release * sr));
  let acc = 0, g3 = 1, maxGr = 0; let over1 = 0, over3 = 0;
  const win = new Float32Array(la); win.fill(1); acc = la; let wi = 0;
  for (let i = 0; i < n; i++) {
    acc += g1[i] - win[wi]; win[wi] = g1[i]; wi = (wi + 1) % la;
    const g2 = acc / la;
    g3 = g2 < g3 ? g2 : rr * g3 + (1 - rr) * g2;
    L[i] *= g3; R[i] *= g3;
    const gr = -gainToDb(g3); if (gr > maxGr) maxGr = gr; if (gr > 1) over1++; if (gr > 3) over3++;
  }
  return { maxGr, pctOver1dB: 100 * over1 / n, pctOver3dB: 100 * over3 / n };
}

// ------------------------------------------------------------------------------------------------ loudness (ITU-R BS.1770-4)
function kWeight(x, sr) {
  const y = Float64Array.from(x);
  // stage 1: high shelf (+4 dB @ ~1.7 kHz), stage 2: RLB high-pass (~38 Hz) — coefficients via bilinear design (pyloudnorm style)
  const shelf = (() => { const G = 4.0, Q = 1 / Math.SQRT2, fc = 1681.974450955533; const A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / sr, alpha = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
    const b0 = A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha), b1 = -2 * A * ((A - 1) + (A + 1) * cw), b2 = A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
    const a0 = (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha, a1 = 2 * ((A - 1) - (A + 1) * cw), a2 = (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }; })();
  const hp = biquadCoefs('highpass', 38.13547087602444, sr, { q: 0.5003270373238773 });
  biquad(y, shelf); biquad(y, hp);
  return y;
}
/** Ungated K-weighted loudness (LUFS-ish) of each [t0, t1) segment (seconds) of a stereo signal. */
export function segmentLoudness(channels, sr, segments) {
  const kw = channels.map((c) => kWeight(c, sr));
  return segments.map(([a, b]) => {
    const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(kw[0].length, Math.round(b * sr)); let z = 0;
    for (const c of kw) { let s = 0; for (let i = i0; i < i1; i++) s += c[i] * c[i]; z += s / Math.max(1, i1 - i0); }
    return -0.691 + 10 * Math.log10(z + 1e-20);
  });
}
/** Energy per octave band (dB, relative) via Goertzel-free FFT averaging over the whole signal. */
export function octaveSpectrum(channels, sr, centers = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
  const N = 8192, hop = 4096; const acc = new Float64Array(N / 2 + 1); let frames = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= channels[0].length; s += hop) {
    for (let i = 0; i < N; i++) { let m = 0; for (const c of channels) m += c[s + i]; re[i] = m / channels.length * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im); for (let b = 0; b <= N / 2; b++) acc[b] += re[b] * re[b] + im[b] * im[b]; frames++;
  }
  return centers.map((fc) => { const lo = fc / Math.SQRT2, hi = fc * Math.SQRT2; let e = 0; for (let b = Math.ceil(lo * N / sr); b <= Math.min(N / 2, Math.floor(hi * N / sr)); b++) e += acc[b]; return [fc, 10 * Math.log10(e / frames + 1e-20)]; });
}

/** Integrated loudness (LUFS) + short-term max + loudness range-ish. */
export function loudness(channels, sr) {
  const kw = channels.map((c) => kWeight(c, sr));
  const blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const ms = [];
  for (let s = 0; s + blk <= kw[0].length; s += hop) {
    let z = 0; for (const c of kw) { let a = 0; for (let i = s; i < s + blk; i++) a += c[i] * c[i]; z += a / blk; }
    ms.push(z);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
  const abs = ms.filter((z) => L(z) > -70);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rel = L(mean(abs)) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  const integrated = L(mean(gated));
  // short-term (3 s) max
  const st = []; const per = 30; // 3 s = 30 hops of 100 ms (blocks of 400ms averaged approx)
  for (let i = 0; i + per <= ms.length; i++) { let z = 0; for (let j = i; j < i + per; j++) z += ms[j]; st.push(L(z / per)); }
  return { integrated, shortTermMax: Math.max(...st), shortTermMin: Math.min(...st.filter((x) => x > -70)) };
}

// ------------------------------------------------------------------------------------------------ reverb IR
/**
 * Synthetic concert-hall impulse response (stereo pair of decorrelated responses):
 * early reflections (sparse taps over 5..80 ms) + exponentially decaying noise tail with frequency-dependent RT60
 * (realised by crossfading three band-limited noise tails with different decay rates), soft onset, and pre-delay.
 */
export function hallIR(sr, { rt60 = 2.4, rt60Low = 2.9, rt60High = 1.3, preDelay = 0.022, length = 3.6, seed = 7, erGain = 0.55, tailGain = 1, density = 1 } = {}) {
  const n = Math.round(length * sr);
  const out = [];
  for (let c = 0; c < 2; c++) {
    const r = rng(seed * 31 + c * 977);
    const ir = new Float32Array(n);
    const pd = Math.round(preDelay * sr);
    // early reflections
    const nEr = Math.round(18 * density);
    for (let k = 0; k < nEr; k++) {
      const t = 0.004 + Math.pow(r(), 1.4) * 0.075;
      const idx = pd + Math.round(t * sr);
      if (idx < n) ir[idx] += (r() < 0.5 ? -1 : 1) * erGain * Math.exp(-t / 0.05) * (0.4 + 0.6 * r());
    }
    // diffuse tail in three bands
    const bands = [
      { type: 'lowpass', f: 400, rt: rt60Low },
      { type: 'bandpass', f: 1500, rt: rt60, q: 0.5 },
      { type: 'highpass', f: 4000, rt: rt60High },
    ];
    for (const b of bands) {
      const noise = new Float64Array(n);
      for (let i = pd; i < n; i++) noise[i] = (r() * 2 - 1);
      const cf = biquadCoefs(b.type, b.f, sr, { q: b.q || 0.7071 });
      biquad(noise, cf); if (b.type !== 'bandpass') biquad(noise, cf);
      const k = Math.log(1000) / (b.rt * sr); // amplitude decays 60 dB over rt
      for (let i = pd; i < n; i++) {
        const t = (i - pd) / sr;
        const onset = 1 - Math.exp(-t / 0.018); // diffuse build-up
        ir[i] += tailGain * noise[i] * Math.exp(-k * (i - pd)) * onset * 0.5;
      }
    }
    // fade the very end to avoid truncation clicks
    const fade = Math.round(0.25 * sr);
    for (let i = n - fade; i < n; i++) ir[i] *= 0.5 + 0.5 * Math.cos(Math.PI * (i - (n - fade)) / fade);
    out.push(ir);
  }
  // normalise energy so a unit send yields roughly unit-level wet signal
  let e = 0; for (const ir of out) for (let i = 0; i < n; i++) e += ir[i] * ir[i];
  const g = 1 / Math.sqrt(e / 2);
  for (const ir of out) for (let i = 0; i < n; i++) ir[i] *= g;
  return out;
}
