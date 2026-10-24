// Offline render of "Sortie" (score_epic_v4.mjs by default; --v3 / --v2 / --v1 render the earlier versions), the main battle theme
// (audition): sampler -> per-track EQ -> buses
// (+ synthesised choir pad, as render.mjs) -> convolution hall -> master (lib/master.mjs) -> seamless loop (LEAD-copy
// seam for v1; v2 loops the whole piece from its opening hit, so it is folded circularly with a mastering warm-up,
// as render_night.mjs) -> WAV + MP3.
// usage: node --max-old-space-size=8192 tools/music/render_epic.mjs [--v1|--v2|--v3] [--qa] [--no-encode]   (default: v4)
// Output: tools/music/out/epic_v2.wav (epic.wav for v1), assets/music_audition/epic_v2.mp3 (epic_v1.mp3), .json meta in out/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SampleBank } from './lib/sampler.mjs';
import { createOrchestra, renderTrack } from './lib/orchestra.mjs';
import { extendOrchestra } from './lib/orchestra_ext.mjs';
import { eq, loudness, segmentLoudness, octaveSpectrum, dbToGain, gainToDb } from './lib/dsp.mjs';
import { addHall, masterBus, seamFromLeadCopies, wrapReport, encodeMp3, ffLoudness } from './lib/master.mjs';
import { writeWav } from './lib/wav.mjs';
import { encodeTrack } from './encode_track.mjs';
import { renderChoir } from './lib/choir.mjs';
import { synthNote, kick, riser, shepard } from './lib/synth.mjs';
const V1 = process.argv.includes('--v1'), V2 = process.argv.includes('--v2'), V3 = process.argv.includes('--v3'); // default: v4 (score_epic_v4.mjs)
const V4 = !V1 && !V2 && !V3;
const { buildScore, T } = await import(V1 ? './score_epic.mjs' : V2 ? './score_epic_v2.mjs' : V3 ? './score_epic_v3.mjs' : './score_epic_v4.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const AUD = join(ROOT, 'assets', 'music_audition');
const VERSION = V1 ? 'v1' : V2 ? 'v2' : V3 ? 'v3' : 'v4', NAME = V1 ? 'epic' : `epic_${VERSION}`;
const SR = 48000;
const TARGET_LUFS = -13.2, CEILING_DBTP = -1.8; // lands the MP3 at about -13.4 LUFS (ffmpeg EBU R128), matching the other tracks
const args = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true }); mkdirSync(AUD, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const analysis = JSON.parse(readFileSync(join(OUT, 'analysis.json'), 'utf8'));
const bank = new SampleBank(join(HERE, 'downloads', 'vsco2ce'), analysis, OUT);
const orch = extendOrchestra(createOrchestra(bank, join(HERE, 'downloads', 'vsco2ce-sfz')), bank, join(HERE, 'downloads', 'vsco2ce-sfz'));
const score = buildScore();
const LS = Math.round(score.loopStart * SR), LE = Math.round(score.loopEnd * SR);
const frames = LE + Math.round(5 * SR);
log(`score: ${Object.values(score.tracks).reduce((a, t) => a + t.notes.length, 0)} notes, loop ${score.loopStart.toFixed(3)}s..${score.loopEnd.toFixed(3)}s`);

// ------------------------------------------------------------------------------------------------ tracks -> buses
const mixL = new Float32Array(frames), mixR = new Float32Array(frames);
const sendL = new Float32Array(frames), sendR = new Float32Array(frames);
const BUS_GAIN = { str: 0, brass: 0, winds: 0, perc: 0, choir: 0 };
const segs = score.sections.map(([, a, b]) => [T(a), T(b)]);
const qa = [], levels = [];
for (const tr of Object.values(score.tracks)) {
  if (!tr.notes.length) continue;
  const r = renderTrack(orch, bank, tr, SR, frames);
  if (tr.eq) eq([r.L, r.R], SR, tr.eq);
  const g = dbToGain(BUS_GAIN[tr.bus] || 0), send = tr.send ?? 0.3;
  let e = 0, pk = 0;
  for (let i = 0; i < frames; i++) {
    const l = r.L[i] * g, rr = r.R[i] * g; mixL[i] += l; mixR[i] += rr; sendL[i] += l * send; sendR[i] += rr * send;
    e += l * l + rr * rr; pk = Math.max(pk, Math.abs(l), Math.abs(rr));
  }
  levels.push(`${tr.name}:${tr.notes.length}n/${r.voices}v rms ${(10 * Math.log10(e / (2 * frames) + 1e-12)).toFixed(1)} pk ${gainToDb(pk).toFixed(1)}`);
  if (args.has('--qa')) qa.push([tr.name, segmentLoudness([r.L, r.R], SR, segs)]);
}
log('tracks rendered'); console.log('  ' + levels.join('\n  '));
{ // choir pad (climax), as in render.mjs
  const [L, R] = renderChoir(score.choir, SR, frames, { voices: 6 });
  eq([L, R], SR, [['highpass', 140], ['peak', 3000, { q: 1, gainDb: -3 }], ['lowpass', 7000]]);
  const g = dbToGain(-14);
  for (let i = 0; i < frames; i++) { const l = L[i] * g, r = R[i] * g; mixL[i] += l; mixR[i] += r; sendL[i] += l * 0.65; sendR[i] += r * 0.65; }
  if (args.has('--qa')) qa.push(['choir', segmentLoudness([Float32Array.from(L, (x) => x * g), Float32Array.from(R, (x) => x * g)], SR, segs)]);
  log('choir rendered');
}
if (args.has('--qa')) {
  const mixSeg = segmentLoudness([mixL, mixR], SR, segs);
  console.log('  track LUFS by section (relative to the dry mix of that section):');
  console.log('  ' + 'track'.padEnd(10) + score.sections.map(([n]) => n.padStart(7)).join(''));
  console.log('  ' + 'MIX'.padEnd(10) + mixSeg.map((v) => v.toFixed(1).padStart(7)).join(''));
  for (const [name, v] of qa) console.log('  ' + name.padEnd(10) + v.map((x, i) => (x < -90 ? '' : (x - mixSeg[i]).toFixed(1)).padStart(7)).join(''));
}

// hybrid synth layer (v4): sub pulse, drone, impacts, reverse swells, Shepard riser (lib/synth.mjs)
if (score.synth && score.synth.length) {
  const SP = {
    sub: { osc: [{ type: 'sine', gain: 1 }, { type: 'tri', gain: 0.12, octave: 1 }], filt: { cutoff: 220, env: 0.5, keytrack: 0, res: 0.7, a: 0.002, d: 0.1, s: 0.6, r: 0.08, poles: 2 }, amp: { a: 0.004, d: 0.15, s: 0.7, r: 0.06 }, stereo: 0, gain: 0.55 },
    drone: { osc: [{ type: 'saw', gain: 0.6, unison: 4, spread: 12 }, { type: 'sine', gain: 0.8, octave: 0 }], filt: { cutoff: 140, env: 0.6, keytrack: 0, res: 1.0, a: 3, d: 4, s: 0.6, r: 2, poles: 4 }, amp: { a: 1.5, d: 2, s: 0.9, r: 2.5 }, stereo: 0.8, drift: 4, gain: 0.3 },
  };
  const SMIX = { sub: [-9, 0.0], drone: [-10, 0.25], impact: [-7, 0.12], reverse: [-2, 0.35], shepard: [-3, 0.3] }; // dB, reverb send
  const st = {}; const buf = (k) => (st[k] ||= [new Float32Array(frames), new Float32Array(frames)]);
  for (const e of score.synth) {
    if (e.inst === 'sub' || e.inst === 'drone') synthNote(buf(e.inst), SR, { t: e.t, dur: e.dur, midi: e.midi, vel: e.vel, seed: Math.round(e.t * 1000) + e.midi }, SP[e.inst]);
    else if (e.inst === 'impact') kick(buf('impact'), SR, { t: e.t, vel: e.vel, seed: Math.round(e.t * 1000), tune: 46, decay: 0.7, punch: 2.2, click: 0.2 });
    else if (e.inst === 'reverse') riser(buf('reverse'), SR, { t0: e.t0, t1: e.t1, f0: 400, f1: 6000, gain: e.gain, seed: Math.round(e.t0 * 1000), reverse: true });
    else if (e.inst === 'shepard') shepard(buf('shepard'), SR, { t0: e.t0, t1: e.t1, gain: e.gain, seed: Math.round(e.t0 * 1000) });
  }
  for (const [k, [L, R]] of Object.entries(st)) {
    const [db, send] = SMIX[k], g = dbToGain(db);
    if (k === 'sub') eq([L, R], SR, [['highpass', 38], ['lowpass', 180]]);
    if (k === 'drone') eq([L, R], SR, [['highpass', 40], ['lowpass', 900]]);
    for (let i = 0; i < frames; i++) { const l = L[i] * g, r = R[i] * g; mixL[i] += l; mixR[i] += r; sendL[i] += l * send; sendR[i] += r * send; }
    if (args.has('--qa')) qa.push(['syn:' + k, segmentLoudness([Float32Array.from(L, (x) => x * g), Float32Array.from(R, (x) => x * g)], SR, segs)]);
  }
  if (args.has('--qa')) { const ms = segmentLoudness([mixL, mixR], SR, segs); for (const [n, v] of qa.filter(([n]) => n.startsWith('syn:'))) console.log('  ' + n.padEnd(10) + v.map((x, i) => (x < -90 ? '' : (x - ms[i]).toFixed(1)).padStart(7)).join('')); }
  log('synth layer rendered');
}
// fade-out (v3+): gain ramp to silence on the dry mix and the reverb send; the hall tail continues and folds under bar 1
if (score.fade) {
  const [f0, f1] = score.fade.map((t) => Math.round(t * SR));
  for (let i = f0; i < frames; i++) { const x = Math.min(1, (i - f0) / (f1 - f0)), g = Math.cos(x * Math.PI / 2); mixL[i] *= g; mixR[i] *= g; sendL[i] *= g; sendR[i] *= g; }
}
// ------------------------------------------------------------------------------------------------ hall (as the theme's)
addHall([mixL, mixR], [sendL, sendR], SR, V4 ? { rt60: 3.1, rt60Low: 3.4, rt60High: 1.4, preDelay: 0.034, length: 5, wetDb: -3.0, seed: 11 } : { rt60: 2.3, rt60Low: 2.7, rt60High: 1.15, preDelay: 0.026, length: 3.8, wetDb: -3.5, seed: 11 });
log('reverb applied');

// ------------------------------------------------------------------------------------------------ master + loop
const MASTER = { targetLufs: TARGET_LUFS, ceilingDbtp: CEILING_DBTP, log, comp: { thresholdDb: -24, ratio: 2.2, kneeDb: 10, attack: 0.04, release: 0.5 },
  eqChain: [['highpass', 26, { q: 0.6 }], ['highpass', 26, { q: 0.9 }], ['lowshelf', 90, { gainDb: V1 ? 1 : V2 ? 2.5 : V3 ? 3 : 0 }], ['peak', 260, { q: 0.8, gainDb: -1.5 }], ['peak', 480, { q: 0.9, gainDb: -2 }],
    ['peak', 3000, { q: 0.8, gainDb: V4 ? 2.5 : 1 }], ['highshelf', 5000, { gainDb: V1 || V2 ? 3 : V3 ? 1.5 : 4 }], ['highshelf', 11000, { gainDb: V1 || V2 ? 2 : V3 ? 0.5 : 2.5 }]] };
let FL, FR, fileLS, fileLE; // loop points in the output file (samples)
if (score.seam === 'circular') {
  // v2: the loop is the whole piece and starts on the hit. Fold the audio before loopStart (pre-attacks of bar 1) onto
  // the loop end and everything after loopEnd (the release's tails) onto the loop start, so the loop is circular.
  const L = LE - LS;
  const loop = [mixL, mixR].map((ch) => { const x = new Float32Array(L); for (let i = 0; i < frames; i++) { const j = ((((i - LS) % L) + L) % L); x[j] += ch[i]; } return x; });
  const W = 6 * SR, PR = Math.round(0.5 * SR);
  const ext = loop.map((x) => { const y = new Float32Array(W + L + PR + SR); for (let i = 0; i < y.length; i++) y[i] = x[(((i - W) % L) + L) % L]; return y; });
  const { out } = masterBus(ext, SR, { ...MASTER, measure: [W, W + L] });
  { let d = 0, e = 0; for (let i = 0; i < SR; i++) { d += (out[0][W + i] - out[0][W + L + i]) ** 2; e += out[0][W + i] ** 2; } log(`seam check: master output at loop start vs after one full loop = ${(10 * Math.log10(d / e + 1e-20)).toFixed(1)} dB`); }
  // The file is exactly one loop: no post-roll copy of the head (a whole-file loop would otherwise play the bar-1 hit
  // twice) and no end fade. The master output is circular, so the last sample flows straight into the first.
  FL = out[0].slice(W, W + L); FR = out[1].slice(W, W + L);
  fileLS = 0; fileLE = L;
  { const step = Math.max(Math.abs(FL[0] - FL[L - 1]), Math.abs(FR[0] - FR[L - 1])); let typ = 0; for (let i = 1; i < SR; i++) typ = Math.max(typ, Math.abs(FL[i] - FL[i - 1]), Math.abs(FR[i] - FR[i - 1]));
    let tail = 0; for (let i = L - Math.round(0.5 * SR); i < L; i++) tail = Math.max(tail, Math.abs(FL[i]), Math.abs(FR[i]));
    log(`wrap (file end -> file start) step ${step.toFixed(4)} vs max step in the first second ${typ.toFixed(4)}; peak in the last 0.5 s ${(20 * Math.log10(tail)).toFixed(1)} dBFS`); }
} else {
  const { out } = masterBus([mixL, mixR], SR, { ...MASTER, measure: [0, LE] });
  [FL, FR] = seamFromLeadCopies(out, SR, LS, LE, { log });
  fileLS = LS; fileLE = LE;
}
const total = FL.length, shift = score.seam === 'circular' ? score.loopStart : 0;
const fsegs = segs.map(([a, b]) => [a - shift, b - shift]);
const finalL = loudness([FL, FR], SR), loopOnly = loudness([FL.subarray(fileLS, fileLE), FR.subarray(fileLS, fileLE)], SR);
if (args.has('--qa')) {
  const seg = segmentLoudness([FL, FR], SR, fsegs);
  console.log('  master LUFS by section: ' + score.sections.map(([n], i) => `${n} ${seg[i].toFixed(1)}`).join(' | '));
  let em = 0, es = 0; for (let i = 0; i < total; i++) { const m = FL[i] + FR[i], d = FL[i] - FR[i]; em += m * m; es += d * d; }
  console.log(`  stereo: side/mid energy ${(10 * Math.log10(es / em)).toFixed(1)} dB`);
  const oct = octaveSpectrum([FL, FR], SR); const ref = oct[5][1];
  console.log('  master octave spectrum (dB re 1 kHz): ' + oct.map(([f, d]) => `${f >= 1000 ? f / 1000 + 'k' : f} ${(d - ref).toFixed(1)}`).join(' | '));
}
log(`final: ${finalL.integrated.toFixed(2)} LUFS integrated (loop region ${loopOnly.integrated.toFixed(2)}), short-term max ${finalL.shortTermMax.toFixed(1)}, min ${finalL.shortTermMin.toFixed(1)}`);
const wavPath = join(OUT, `${NAME}.wav`);
writeWav(wavPath, [FL, FR], SR, { float: true });
log(`wrote ${wavPath} (${(total / SR).toFixed(3)} s; loop ${(fileLS / SR).toFixed(3)}..${(fileLE / SR).toFixed(3)} s)`);

const meta = { title: score.title, bpm: score.bpm, tempo: score.tempo, loopStart: fileLS / SR, loopEnd: fileLE / SR, duration: total / SR, sampleRate: SR,
  lufs: +finalL.integrated.toFixed(2), loopLufs: +loopOnly.integrated.toFixed(2), sections: Object.fromEntries(score.sections.map(([n, a, b]) => [n, [+(T(a) - shift).toFixed(3), +(T(b) - shift).toFixed(3)]])) };
if (!args.has('--no-encode')) {
  const mp3 = join(AUD, `epic_${VERSION}.mp3`);
  encodeMp3(wavPath, mp3, `${score.title} (audition ${VERSION})`, 192);
  meta.mp3 = { file: mp3, ...ffLoudness(mp3) };
  log(`encoded ${mp3}: ffmpeg EBU R128 I ${meta.mp3.I} LUFS, LRA ${meta.mp3.LRA} LU, true peak ${meta.mp3.TP} dBFS`);
}
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(meta, null, 2));
if (VERSION === 'v4' && !args.has('--no-encode')) encodeTrack('epic', wavPath, meta);   // the shipped 'epic' track: assets/music/epic.opus|mp3|json
log('done');
