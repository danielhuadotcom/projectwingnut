// Shared back end for the audition renders (render_mainspring.mjs, render_night.mjs): hall reverb, mastering (EQ, glue
// compression, loudness-targeted true-peak limiting), seamless loop construction and encoding. Same signal chain and
// seam technique as render.mjs (which is left untouched so "Ceiling Unlimited" renders bit-identically).
import { execFileSync, spawnSync } from 'node:child_process';
import { eq, convolve, hallIR, compress, limit, loudness, dbToGain } from './dsp.mjs';

/** Stereo convolution hall from a send bus, mixed into [mixL, mixR]. Returns the wet signal's loudness offset (LU). */
export function addHall([mixL, mixR], [sendL, sendR], sr, o = {}) {
  const frames = mixL.length;
  const { rt60 = 2.4, rt60Low = 2.8, rt60High = 1.2, preDelay = 0.026, length = 4.0, wetDb = -3.5, cross = 0.35, hp = 140, shelfHz = 7000, shelfDb = -4, seed = 11 } = o;
  eq([sendL, sendR], sr, [['highpass', hp], ['highshelf', shelfHz, { gainDb: shelfDb }]]);
  const [irLL, irRR] = hallIR(sr, { rt60, rt60Low, rt60High, preDelay, length, seed });
  const [irLR, irRL] = hallIR(sr, { rt60, rt60Low, rt60High, preDelay: preDelay + 0.008, length, seed: seed + 18, erGain: 0.3 });
  const wl = convolve(sendL, irLL, frames), wr = convolve(sendR, irRR, frames);
  const xl = convolve(sendR, irRL, frames), xr = convolve(sendL, irLR, frames);
  const W = dbToGain(wetDb);
  for (let i = 0; i < frames; i++) { mixL[i] += W * (wl[i] + cross * xl[i]); mixR[i] += W * (wr[i] + cross * xr[i]); }
}

/**
 * Master bus: EQ, normalise to -18 LUFS, glue compressor, then find the gain that lands the true-peak-limited result on
 * the loudness target. `measure` (optional [i0, i1)) restricts the loudness measurement, e.g. to the loop region.
 * Returns the limited stereo pair (new arrays) and stats.
 */
export function masterBus([L, R], sr, { eqChain, targetLufs = -13, ceilingDbtp = -1.5, comp = {}, measure = null, log = console.log }) {
  const frames = L.length;
  if (eqChain) eq([L, R], sr, eqChain);
  for (let i = 0; i < 480; i++) { const g = i / 480; L[i] *= g; R[i] *= g; }
  const meas = (a, b) => loudness(measure ? [a.subarray(measure[0], measure[1]), b.subarray(measure[0], measure[1])] : [a, b], sr);
  const L0 = meas(L, R);
  log(`pre-master loudness ${L0.integrated.toFixed(2)} LUFS (short-term max ${L0.shortTermMax.toFixed(1)})`);
  { const g = dbToGain(-18 - L0.integrated); for (let i = 0; i < frames; i++) { L[i] *= g; R[i] *= g; } }
  const c = compress([L, R], sr, { thresholdDb: -21, ratio: 1.8, kneeDb: 8, attack: 0.03, release: 0.35, rmsTime: 0.02, ...comp });
  log(`glue compressor: max GR ${c.maxGr.toFixed(1)} dB, avg ${c.avgGr.toFixed(2)} dB`);
  let gainDb = targetLufs - meas(L, R).integrated, out = null, lim = null;
  for (let pass = 0; pass < 4; pass++) {
    const g = dbToGain(gainDb);
    const cand = [Float32Array.from(L, (x) => x * g), Float32Array.from(R, (x) => x * g)];
    lim = limit(cand, sr, { ceilingDb: ceilingDbtp - 0.2, lookahead: 0.004, release: 0.12 });
    const lu = meas(cand[0], cand[1]).integrated;
    log(`  pass ${pass}: gain ${gainDb.toFixed(2)} dB -> ${lu.toFixed(2)} LUFS, limiter max GR ${lim.maxGr.toFixed(1)} dB (>1 dB ${lim.pctOver1dB.toFixed(1)}% of time, >3 dB ${lim.pctOver3dB.toFixed(2)}%)`);
    out = cand;
    if (Math.abs(lu - targetLufs) < 0.1) {
      // where does the limiter work hardest? (top 6 moments, 50 ms resolution) — for balancing, not used by the chain
      const hop = Math.round(0.05 * sr), worst = [];
      for (let s0 = 0; s0 + hop <= frames; s0 += hop) {
        let gr = 0; for (let i = s0; i < s0 + hop; i++) { const a = Math.abs(L[i] * g), b = Math.abs(cand[0][i]); if (a > 1e-4) gr = Math.max(gr, 20 * Math.log10(a / Math.max(b, 1e-9))); }
        worst.push([gr, s0 / sr]);
      }
      worst.sort((a, b) => b[0] - a[0]);
      log('  limiter hot spots: ' + worst.slice(0, 6).map(([gr, t]) => `${t.toFixed(2)}s ${gr.toFixed(1)}dB`).join(', '));
      break;
    }
    gainDb += targetLufs - lu;
  }
  return { out, comp: c, lim };
}

/**
 * Seam construction for scores whose material before loopEnd is a note-for-note copy of the material before loopStart
 * (the LEAD blocks): the last prerollCopy seconds before loopEnd are replaced by the audio before loopStart, reached via
 * an equal-power crossfade, and postroll seconds copied from loopStart follow loopEnd (decoder-offset safety).
 */
export function seamFromLeadCopies([OL, OR], sr, LS, LE, { xfade = 0.25, postroll = 0.5, prerollCopy = 1.0, log = console.log } = {}) {
  const db = (e, s) => (10 * Math.log10(e / s + 1e-20)).toFixed(1);
  {
    const n = Math.round(0.75 * sr); let ed = 0, es = 0;
    for (let i = 1; i <= n; i++) { const a = OL[LS - i] - OL[LE - i], b = OR[LS - i] - OR[LE - i]; ed += a * a + b * b; es += OL[LE - i] ** 2 + OR[LE - i] ** 2; }
    log(`seam check: pre-roll mismatch over last 0.75 s = ${db(ed, es)} dB relative to signal`);
  }
  const F = Math.round(xfade * sr), PR = Math.round(postroll * sr), X = Math.round(prerollCopy * sr), total = LE + PR;
  const FL = new Float32Array(total), FR = new Float32Array(total);
  FL.set(OL.subarray(0, LE)); FR.set(OR.subarray(0, LE));
  {
    let ed = 0, es = 0;
    for (let i = 0; i < F; i++) { const a = LE - X - F + i, b = LS - X - F + i; ed += (OL[a] - OL[b]) ** 2 + (OR[a] - OR[b]) ** 2; es += OL[a] ** 2 + OR[a] ** 2; }
    log(`seam check: mismatch inside the crossfade window = ${db(ed, es)} dB relative to signal`);
  }
  for (let i = 0; i < F; i++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / F); const a = LE - X - F + i, b = LS - X - F + i; FL[a] = (1 - w) * OL[a] + w * OL[b]; FR[a] = (1 - w) * OR[a] + w * OR[b]; }
  for (let j = 0; j < X; j++) { FL[LE - X + j] = OL[LS - X + j]; FR[LE - X + j] = OR[LS - X + j]; }
  for (let j = 0; j < PR; j++) { FL[LE + j] = OL[LS + j]; FR[LE + j] = OR[LS + j]; }
  for (let i = 0; i < 480; i++) { const g = i / 480; FL[total - 1 - i] *= g; FR[total - 1 - i] *= g; }
  wrapReport([FL, FR], sr, LS, LE, log);
  return [FL, FR];
}

/** Continuity at the wrap: the step loopEnd-1 -> loopStart compared with the largest sample step around loopStart. */
export function wrapReport([L, R], sr, LS, LE, log = console.log) {
  let typical = 0; for (let i = LS; i < LS + sr; i++) typical = Math.max(typical, Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
  const step = Math.max(Math.abs(L[LS] - L[LE - 1]), Math.abs(R[LS] - R[LE - 1]));
  log(`wrap step ${step.toFixed(4)} vs max step in the following second ${typical.toFixed(4)}`);
  return { step, typical };
}

export function encodeMp3(wavPath, mp3Path, title, kbps = 192) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wavPath, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-metadata', `title=${title}`, mp3Path], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** ffmpeg's EBU R128 meter on a file (independent check of our own loudness numbers): { I, LRA, TP }. */
export function ffLoudness(path) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const tail = String(r.stderr || '').split('Summary:').pop();
  const num = (re) => { const m = re.exec(tail); return m ? +m[1] : NaN; };
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}
