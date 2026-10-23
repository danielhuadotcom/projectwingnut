// Per-sample analysis shared by analyze.mjs and the virtual-sample generator.
function yinFrame(x, s, P0, sr) {
  const tmin = Math.max(2, Math.floor(P0 * Math.pow(2, -0.3))), tmax = Math.ceil(P0 * Math.pow(2, 0.3));
  const W = Math.max(1024, Math.ceil(2.5 * tmax));
  if (s + W + tmax + 2 >= x.length) return null;
  let e0 = 0; for (let j = 0; j < W; j++) e0 += x[s + j] * x[s + j];
  if (e0 < 1e-9) return null;
  const d = new Float64Array(tmax + 2);
  let best = Infinity, bt = -1;
  for (let t = tmin - 1; t <= tmax + 1; t++) {
    let acc = 0, e1 = 0;
    for (let j = 0; j < W; j++) { const a = x[s + j], b = x[s + j + t]; const df = a - b; acc += df * df; e1 += b * b; }
    d[t] = acc / (e0 + e1);
    if (t >= tmin && t <= tmax && d[t] < best) { best = d[t]; bt = t; }
  }
  if (bt < 0 || best > 0.35) return null;
  const a = d[bt - 1], b = d[bt], c = d[bt + 1];
  const den = a - 2 * b + c; const shift = den > 0 ? 0.5 * (a - c) / den : 0;
  return { f0: sr / (bt + shift), q: best };
}

/** channels: Float32Array[]; key: expected MIDI (or undefined for unpitched); isShort: articulation hint */
export function analyzeSample(channels, sr, key, isShort = false) {
  const frames = channels[0].length;
  const x = new Float32Array(frames);
  for (const ch of channels) for (let i = 0; i < frames; i++) x[i] += ch[i] / channels.length;
  let peak = 0; for (const ch of channels) for (let i = 0; i < frames; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  const hop = Math.max(1, Math.round(sr / 1000)); const nEnv = Math.floor(frames / hop);
  const env = new Float32Array(nEnv);
  for (let k = 0; k < nEnv; k++) { let s = 0; for (let j = k * hop; j < (k + 1) * hop; j++) s += x[j] * x[j]; env[k] = Math.sqrt(s / hop); }
  let emax = 0; for (let k = 0; k < nEnv; k++) if (env[k] > emax) emax = env[k];
  const firstAbove = (thr, from = 0) => { for (let k = from; k < nEnv; k++) if (env[k] >= thr) return k; return nEnv - 1; };
  const on40 = firstAbove(emax * 0.01), on20 = firstAbove(emax * 0.1);
  let lmax = 0; for (let k = on40; k < Math.min(nEnv, on40 + 800); k++) if (env[k] > lmax) lmax = env[k];
  const t50 = firstAbove(lmax * 0.5, on40) - on40;
  let tPeak = on40; for (let k = on40; k < Math.min(nEnv, on40 + 800); k++) if (env[k] > env[tPeak]) tPeak = k;
  let end = nEnv - 1; while (end > 0 && env[end] < emax * 0.001) end--;
  const win = 300, earlyWin = 150;
  let body = 0;
  for (let k = on40; k + win <= nEnv; k += 25) { let s = 0; for (let j = k; j < k + win; j++) s += env[j] * env[j]; body = Math.max(body, Math.sqrt(s / win)); }
  if (body === 0) { let s = 0; for (let j = on40; j < nEnv; j++) s += env[j] * env[j]; body = Math.sqrt(s / Math.max(1, nEnv - on40)); }
  let early = 0; { let s = 0; const m = Math.min(nEnv - on40, earlyWin); for (let j = on40; j < on40 + m; j++) s += env[j] * env[j]; early = Math.sqrt(s / Math.max(1, m)); }
  const rec = { sr, ch: channels.length, frames, peak: +peak.toFixed(5), onset: on40 * hop, onset20: on20 * hop,
    t50: t50 / 1000, tPeak: (tPeak - on40) / 1000, end: end * hop,
    bodyDb: +(20 * Math.log10(body + 1e-9)).toFixed(2), earlyDb: +(20 * Math.log10(early + 1e-9)).toFixed(2) };
  if (key !== undefined) {
    const fexp = 440 * Math.pow(2, (key - 69) / 12), P0 = sr / fexp;
    const a0 = on40 * hop + Math.round((isShort ? 0.03 : 0.45) * sr);
    const a1 = Math.min(end * hop - Math.round(0.3 * sr), on40 * hop + Math.round((isShort ? 0.16 : 3.5) * sr));
    const est = []; const nf = isShort ? 4 : 14;
    for (let i = 0; i < nf; i++) {
      const s = Math.round(a0 + (a1 - a0) * (i / (nf - 1)));
      if (s < 0) continue;
      const r = yinFrame(x, s, P0, sr); if (r) est.push(r.f0);
    }
    est.sort((a, b) => a - b);
    rec.key = key;
    if (est.length >= Math.max(2, nf / 3)) { const f0 = est[Math.floor(est.length / 2)]; rec.f0 = +f0.toFixed(3); rec.cents = +(1200 * Math.log2(f0 / fexp)).toFixed(1); rec.nf = est.length; }
    else rec.cents = null;
  }
  return rec;
}
