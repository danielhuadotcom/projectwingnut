// Offline render of the score: sampler -> per-track EQ -> buses -> convolution hall -> master (EQ, glue compression,
// loudness normalisation, true-peak limiting) -> seamless loop construction -> WAV + Opus/MP3 + climax preview.
// usage: node tools/music/render.mjs [--no-encode] [--stems]
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SampleBank } from './lib/sampler.mjs';
import { createOrchestra, renderTrack } from './lib/orchestra.mjs';
import { renderChoir } from './lib/choir.mjs';
import { eq, convolve, hallIR, compress, limit, loudness, segmentLoudness, octaveSpectrum, dbToGain, gainToDb } from './lib/dsp.mjs';
import { writeWav } from './lib/wav.mjs';
import { buildScore, T } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const ASSETS = join(ROOT, 'assets', 'music');
const NAME = 'wingnut_theme';
const SR = 48000;
const TARGET_LUFS = -13.0, CEILING_DBTP = -1.5; // headroom for lossy-codec overshoot
const POSTROLL = 0.5, XFADE = 0.25, PREROLL_COPY = 1.0;
const args = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true }); mkdirSync(ASSETS, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const analysis = JSON.parse(readFileSync(join(OUT, 'analysis.json'), 'utf8'));
const bank = new SampleBank(join(HERE, 'downloads', 'vsco2ce'), analysis, OUT);
const orch = createOrchestra(bank, join(HERE, 'downloads', 'vsco2ce-sfz'));
const score = buildScore();
const LS = Math.round(score.loopStart * SR), LE = Math.round(score.loopEnd * SR);
const frames = LE + Math.round(4.5 * SR);
log(`score: ${Object.values(score.tracks).reduce((a, t) => a + t.notes.length, 0)} notes, loop ${score.loopStart}s..${score.loopEnd}s`);

// ------------------------------------------------------------------------------------------------ tracks -> buses
const mixL = new Float32Array(frames), mixR = new Float32Array(frames);
const sendL = new Float32Array(frames), sendR = new Float32Array(frames);
const BUS_GAIN = { str: 0, brass: 0, perc: 0, winds: 0, choir: 0 };
const stems = {};
const addStem = (name, bus, L, R, send) => {
  const g = dbToGain(BUS_GAIN[bus] || 0);
  for (let i = 0; i < frames; i++) { const l = L[i] * g, r = R[i] * g; mixL[i] += l; mixR[i] += r; sendL[i] += l * send; sendR[i] += r * send; }
  if (args.has('--stems')) { const s = (stems[bus] ||= [new Float32Array(frames), new Float32Array(frames)]); for (let i = 0; i < frames; i++) { s[0][i] += L[i] * g; s[1][i] += R[i] * g; } }
};
const levels = [];
// QA: per-section loudness of every track (dry, post-EQ) so balance decisions are made on numbers
const SECTIONS = [['intro', 1, 3], ['lead', 3, 5], ['A1', 5, 13], ['A2', 13, 21], ['B1', 21, 29], ['B2', 29, 37], ['C1', 37, 45], ['C2', 45, 53], ['Br1', 53, 57], ['Br2', 57, 63]];
const segs = SECTIONS.map(([, a, b]) => [T(a), T(b)]);
const qa = [];
for (const tr of Object.values(score.tracks)) {
  if (!tr.notes.length) continue;
  const r = renderTrack(orch, bank, tr, SR, frames);
  if (tr.eq) eq([r.L, r.R], SR, tr.eq);
  let e = 0, pk = 0; for (let i = 0; i < frames; i++) { e += r.L[i] * r.L[i] + r.R[i] * r.R[i]; pk = Math.max(pk, Math.abs(r.L[i]), Math.abs(r.R[i])); }
  levels.push(`${tr.name}:${tr.notes.length}n/${r.voices}v rms ${(10 * Math.log10(e / (2 * frames) + 1e-12)).toFixed(1)} pk ${gainToDb(pk).toFixed(1)}`);
  addStem(tr.name, tr.bus, r.L, r.R, tr.send ?? 0.3);
  if (args.has('--qa')) qa.push([tr.name, segmentLoudness([r.L, r.R], SR, segs)]);
}
log('tracks rendered'); console.log('  ' + levels.join('\n  '));
{
  const [L, R] = renderChoir(score.choir, SR, frames, { voices: 6 });
  eq([L, R], SR, [['highpass', 140], ['peak', 3000, { q: 1, gainDb: -3 }], ['lowpass', 7000]]);
  const g = dbToGain(-13); for (let i = 0; i < frames; i++) { L[i] *= g; R[i] *= g; }
  addStem('choir', 'choir', L, R, 0.65);
  if (args.has('--qa')) qa.push(['choir', segmentLoudness([L, R], SR, segs)]);
  log('choir rendered');
}

if (args.has('--qa')) {
  const mixSeg = segmentLoudness([mixL, mixR], SR, segs);
  console.log('  track LUFS by section (relative to the dry mix of that section):');
  console.log('  ' + 'track'.padEnd(9) + SECTIONS.map(([n]) => n.padStart(7)).join(''));
  console.log('  ' + 'MIX'.padEnd(9) + mixSeg.map((v) => v.toFixed(1).padStart(7)).join(''));
  for (const [name, v] of qa) console.log('  ' + name.padEnd(9) + v.map((x, i) => (x < -90 ? '' : (x - mixSeg[i]).toFixed(1)).padStart(7)).join(''));
}
// ------------------------------------------------------------------------------------------------ hall reverb
{
  eq([sendL, sendR], SR, [['highpass', 140], ['highshelf', 7000, { gainDb: -4 }]]);
  const [irLL, irRR] = hallIR(SR, { rt60: 2.3, rt60Low: 2.7, rt60High: 1.15, preDelay: 0.026, length: 3.8, seed: 11 });
  const [irLR, irRL] = hallIR(SR, { rt60: 2.3, rt60Low: 2.7, rt60High: 1.15, preDelay: 0.034, length: 3.8, seed: 29, erGain: 0.3 });
  const wl = convolve(sendL, irLL, frames), wr = convolve(sendR, irRR, frames);
  const xl = convolve(sendR, irRL, frames), xr = convolve(sendL, irLR, frames);
  const WET = dbToGain(-3.5), X = 0.35;
  if (args.has('--qa')) {
    const wetL = Float32Array.from(wl, (v, i) => WET * (v + X * xl[i])), wetR = Float32Array.from(wr, (v, i) => WET * (v + X * xr[i]));
    const dry = segmentLoudness([mixL, mixR], SR, [[T(5), T(53)]])[0], wet = segmentLoudness([wetL, wetR], SR, [[T(5), T(53)]])[0];
    console.log(`  reverb return ${(wet - dry).toFixed(1)} LU relative to dry (bars 5-52)`);
  }
  for (let i = 0; i < frames; i++) { mixL[i] += WET * (wl[i] + X * xl[i]); mixR[i] += WET * (wr[i] + X * xr[i]); }
  log('reverb applied');
}

// ------------------------------------------------------------------------------------------------ master
const master = [mixL, mixR];
eq(master, SR, [['highpass', 26, { q: 0.6 }], ['highpass', 26, { q: 0.9 }], ['lowshelf', 95, { gainDb: 2.5 }], ['peak', 480, { q: 0.9, gainDb: -2 }],
  ['peak', 3000, { q: 0.8, gainDb: 1 }], ['highshelf', 5000, { gainDb: 3.5 }], ['highshelf', 11000, { gainDb: 2.5 }]]);
// fade the very first samples in, so the file never starts on a step
for (let i = 0; i < 480; i++) { const g = i / 480; mixL[i] *= g; mixR[i] *= g; }
let L0 = loudness(master, SR);
log(`pre-master loudness ${L0.integrated.toFixed(2)} LUFS (short-term max ${L0.shortTermMax.toFixed(1)})`);
{ const g = dbToGain(-18 - L0.integrated); for (let i = 0; i < frames; i++) { mixL[i] *= g; mixR[i] *= g; } }
const comp = compress(master, SR, { thresholdDb: -21, ratio: 1.8, kneeDb: 8, attack: 0.03, release: 0.35, rmsTime: 0.02 });
log(`glue compressor: max GR ${comp.maxGr.toFixed(1)} dB, avg ${comp.avgGr.toFixed(2)} dB`);
// find the gain that lands the limited result on target loudness (2 refinement passes)
let gainDb = TARGET_LUFS - loudness(master, SR).integrated, out = null, lim = null;
for (let pass = 0; pass < 3; pass++) {
  const g = dbToGain(gainDb);
  const cand = [Float32Array.from(mixL, (x) => x * g), Float32Array.from(mixR, (x) => x * g)];
  lim = limit(cand, SR, { ceilingDb: CEILING_DBTP - 0.2, lookahead: 0.004, release: 0.12 });
  const L = loudness(cand, SR).integrated;
  log(`  pass ${pass}: gain ${gainDb.toFixed(2)} dB -> ${L.toFixed(2)} LUFS, limiter max GR ${lim.maxGr.toFixed(1)} dB (>1 dB ${lim.pctOver1dB.toFixed(1)}% of time, >3 dB ${lim.pctOver3dB.toFixed(2)}%)`);
  out = cand;
  if (Math.abs(L - TARGET_LUFS) < 0.1) break;
  gainDb += TARGET_LUFS - L;
}

// ------------------------------------------------------------------------------------------------ loop construction
// The two LEAD blocks (bars 3-4 and 63-64) are note-for-note identical, so the audio before loopEnd already matches
// the audio before loopStart (reverb pre-roll included). Measure that, then make the wrap sample-continuous:
//  - crossfade the last XFADE seconds before loopEnd into the matching audio before loopStart
//  - after loopEnd append POSTROLL seconds copied from loopStart (decoders with a small offset still loop cleanly)
const [OL, OR] = out;
{
  const n = Math.round(0.75 * SR); let ed = 0, es = 0;
  for (let i = 1; i <= n; i++) { const a = OL[LS - i] - OL[LE - i], b = OR[LS - i] - OR[LE - i]; ed += a * a + b * b; es += OL[LE - i] ** 2 + OR[LE - i] ** 2; }
  log(`seam check: pre-roll mismatch over last 0.75 s = ${(10 * Math.log10(ed / es + 1e-20)).toFixed(1)} dB relative to signal`);
  let ed2 = 0, es2 = 0;
  for (let i = 0; i < n; i++) { const a = OL[LS + i] - OL[LE + i], b = OR[LS + i] - OR[LE + i]; ed2 += a * a + b * b; es2 += OL[LS + i] ** 2 + OR[LS + i] ** 2; }
  log(`seam check: rendered continuation mismatch over first 0.75 s = ${(10 * Math.log10(ed2 / es2 + 1e-20)).toFixed(1)} dB (replaced by copy)`);
}
// Seam construction: the last PREROLL_COPY seconds before loopEnd are replaced by the audio before loopStart (the
// identical LEAD bars incl. the early attacks of the head's notes), reached through an XFADE crossfade placed
// PREROLL_COPY before loopEnd where both LEAD renders agree to within the tails of earlier material.
const F = Math.round(XFADE * SR), PR = Math.round(POSTROLL * SR), X = Math.round(PREROLL_COPY * SR), total = LE + PR;
const FL = new Float32Array(total), FR = new Float32Array(total);
FL.set(OL.subarray(0, LE)); FR.set(OR.subarray(0, LE));
{
  let ed = 0, es = 0;
  for (let i = 0; i < F; i++) { const a = LE - X - F + i, b = LS - X - F + i; ed += (OL[a] - OL[b]) ** 2 + (OR[a] - OR[b]) ** 2; es += OL[a] ** 2 + OR[a] ** 2; }
  log(`seam check: mismatch inside the crossfade window = ${(10 * Math.log10(ed / es + 1e-20)).toFixed(1)} dB relative to signal`);
}
for (let i = 0; i < F; i++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / F); const a = LE - X - F + i, b = LS - X - F + i; FL[a] = (1 - w) * OL[a] + w * OL[b]; FR[a] = (1 - w) * OR[a] + w * OR[b]; }
for (let j = 0; j < X; j++) { FL[LE - X + j] = OL[LS - X + j]; FR[LE - X + j] = OR[LS - X + j]; }
for (let j = 0; j < PR; j++) { FL[LE + j] = OL[LS + j]; FR[LE + j] = OR[LS + j]; }
for (let i = 0; i < 480; i++) { const g = i / 480; FL[total - 1 - i] *= g; FR[total - 1 - i] *= g; }
{ // continuity at the wrap: compare the step loopEnd-1 -> loopStart with typical sample-to-sample steps
  let typical = 0; for (let i = LS; i < LS + SR; i++) typical = Math.max(typical, Math.abs(FL[i] - FL[i - 1]));
  const step = Math.max(Math.abs(FL[LS] - FL[LE - 1]), Math.abs(FR[LS] - FR[LE - 1]));
  log(`wrap step ${step.toFixed(4)} vs max step in surrounding second ${typical.toFixed(4)}`);
}
const finalL = loudness([FL, FR], SR);
if (args.has('--qa')) {
  const seg = segmentLoudness([FL, FR], SR, segs);
  console.log('  master LUFS by section: ' + SECTIONS.map(([n], i) => `${n} ${seg[i].toFixed(1)}`).join(' | '));
  let em = 0, es = 0; for (let i = 0; i < total; i++) { const m = FL[i] + FR[i], d = FL[i] - FR[i]; em += m * m; es += d * d; }
  console.log(`  stereo: side/mid energy ${(10 * Math.log10(es / em)).toFixed(1)} dB`);
  const oct = octaveSpectrum([FL, FR], SR); const ref = oct[5][1];
  console.log('  master octave spectrum (dB re 1 kHz): ' + oct.map(([f, d]) => `${f >= 1000 ? f / 1000 + 'k' : f} ${(d - ref).toFixed(1)}`).join(' | '));
}
const loopOnly = loudness([FL.subarray(LS, LE), FR.subarray(LS, LE)], SR);
log(`final: ${finalL.integrated.toFixed(2)} LUFS integrated (loop region ${loopOnly.integrated.toFixed(2)}), short-term max ${finalL.shortTermMax.toFixed(1)}, min ${finalL.shortTermMin.toFixed(1)}`);
const wavPath = join(OUT, `${NAME}.wav`);
writeWav(wavPath, [FL, FR], SR, { float: true });
if (args.has('--stems')) for (const [bus, [l, r]] of Object.entries(stems)) writeWav(join(OUT, `stem_${bus}.wav`), [l.subarray(0, total), r.subarray(0, total)], SR, { float: true });
log(`wrote ${wavPath} (${(total / SR).toFixed(3)} s)`);

const meta = { title: score.title, bpm: score.bpm, loopStart: score.loopStart, loopEnd: score.loopEnd, duration: total / SR, sampleRate: SR,
  lufs: +finalL.integrated.toFixed(2), sections: { intro: [0, T(5)], A: [T(5), T(21)], B: [T(21), T(37)], climax: [T(37), T(53)], bridge: [T(53), T(65)] } };

// ------------------------------------------------------------------------------------------------ encode
if (!args.has('--no-encode')) {
  const ff = (a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
  const opus = join(ASSETS, `${NAME}.opus`), mp3 = join(ASSETS, `${NAME}.mp3`), prev = join(ASSETS, `${NAME}_climax_preview.mp3`);
  ff(['-i', wavPath, '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'constrained', '-compression_level', '10', '-application', 'audio', '-frame_duration', '20', '-metadata', `title=${score.title}`, opus]);
  ff(['-i', wavPath, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', String(SR), '-metadata', `title=${score.title}`, mp3]);
  // preview = the climax (bars 37-52 are exactly 30 s): start half a beat early to catch the swell, fade over the final diminuendo
  const ps = T(37) - 0.5, pe = ps + 30;
  ff(['-ss', String(ps), '-t', '30', '-i', wavPath, '-af', 'afade=t=in:st=0:d=0.35,afade=t=out:st=28.6:d=1.4', '-c:a', 'libmp3lame', '-b:a', '192k', '-metadata', `title=${score.title} (climax preview)`, prev]);
  meta.files = { opus: { bytes: statSync(opus).size, kbps: 96 }, mp3: { bytes: statSync(mp3).size, kbps: 128 } };
  meta.preview = { file: `${NAME}_climax_preview.mp3`, from: ps, to: pe };
  log(`encoded: opus ${(meta.files.opus.bytes / 1024).toFixed(0)} KB, mp3 ${(meta.files.mp3.bytes / 1024).toFixed(0)} KB, preview ${(statSync(prev).size / 1024).toFixed(0)} KB`);
}
writeFileSync(join(ASSETS, `${NAME}.json`), JSON.stringify(meta, null, 2));
log('done');
