// Formant-preserving pitch shift used to build "virtual" samples where the library has holes in its key coverage
// (VSCO 2 CE's French horn jumps from C4 to D5). Method: resample for pitch, then per STFT frame multiply the spectrum
// by E(f*k)/E(f), where E is the frame's cepstrally smoothed spectral envelope — this moves the envelope back to where
// it was before resampling (the resampled envelope is E_orig(f/k)), so the horn keeps its body instead of sounding
// pinched (shift up) or tubby (shift down).
import { fft } from './dsp.mjs';

function resample(x, k) { // read x at rate k (k>1 = pitch up / shorter), windowed-sinc 16 taps
  const n = Math.floor((x.length - 1) / k), y = new Float32Array(n);
  const fc = Math.min(1, 1 / k) * 0.97, half = 8;
  for (let i = 0; i < n; i++) {
    const p = i * k, ip = Math.floor(p), fr = p - ip; let s = 0, ws = 0;
    for (let j = -half + 1; j <= half; j++) {
      const idx = ip + j; if (idx < 0 || idx >= x.length) continue;
      const t = j - fr; const sinc = t === 0 ? 1 : Math.sin(Math.PI * fc * t) / (Math.PI * fc * t);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * t / half);
      const c = fc * sinc * w; s += x[idx] * c; ws += c;
    }
    y[i] = ws ? s / ws : 0;
  }
  return y;
}

/** Shift stereo channels by `semis` semitones keeping the spectral envelope. f0 = fundamental after the shift (Hz). */
export function formantShift(channels, sr, semis, f0) {
  const k = Math.pow(2, semis / 12);
  const res = channels.map((c) => resample(c, k));
  const n = res[0].length, N = 2048, hop = 256;
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const Q = Math.max(12, Math.min(N / 4, Math.floor(0.6 * sr / f0))); // lifter: keep quefrencies below ~0.6 period
  const out = res.map(() => new Float64Array(n + N));
  const norm = new Float64Array(n + N);
  const re = new Float64Array(N), im = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N);
  const spec = res.map(() => ({ re: new Float64Array(N), im: new Float64Array(N) }));
  const logE = new Float64Array(N / 2 + 1), G = new Float64Array(N / 2 + 1);
  for (let start = -N + hop; start < n; start += hop) {
    // envelope from the mid signal
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) { const idx = start + i; if (idx < 0 || idx >= n) continue; let m = 0; for (const c of res) m += c[idx]; re[i] = (m / res.length) * win[i]; }
    fft(re, im);
    for (let b = 0; b < N; b++) { cr[b] = Math.log(Math.hypot(re[b], im[b]) + 1e-7); ci[b] = 0; }
    fft(cr, ci, true); for (let b = 0; b < N; b++) { cr[b] /= N; ci[b] = 0; }
    for (let q = Q; q <= N - Q; q++) cr[q] = 0;
    fft(cr, ci);
    for (let b = 0; b <= N / 2; b++) logE[b] = cr[b];
    for (let b = 0; b <= N / 2; b++) {
      const fb = b * k; let le;
      if (fb >= N / 2) le = logE[N / 2]; else { const i0 = Math.floor(fb), fr = fb - i0; le = logE[i0] * (1 - fr) + logE[i0 + 1] * fr; }
      const g = le - logE[b]; G[b] = Math.exp(Math.max(-1.7, Math.min(1.4, g))); // clamp to about -15..+12 dB
    }
    for (let c = 0; c < res.length; c++) {
      const S = spec[c]; S.re.fill(0); S.im.fill(0);
      for (let i = 0; i < N; i++) { const idx = start + i; if (idx < 0 || idx >= n) continue; S.re[i] = res[c][idx] * win[i]; }
      fft(S.re, S.im);
      for (let b = 0; b <= N / 2; b++) { S.re[b] *= G[b]; S.im[b] *= G[b]; if (b > 0 && b < N / 2) { S.re[N - b] *= G[b]; S.im[N - b] *= G[b]; } }
      fft(S.re, S.im, true);
      for (let i = 0; i < N; i++) { const idx = start + i; if (idx < 0 || idx >= n) continue; out[c][idx] += (S.re[i] / N) * win[i]; }
    }
    for (let i = 0; i < N; i++) { const idx = start + i; if (idx >= 0 && idx < n) norm[idx] += win[i] * win[i]; }
  }
  return out.map((o) => { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = norm[i] > 1e-6 ? o[i] / norm[i] : 0; return r; });
}
