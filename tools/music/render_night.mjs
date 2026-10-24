// Offline render of "Night Shift" (score_night.mjs), an audition piece synthesised from scratch (lib/synth.mjs; no
// samples): instrument patches -> sidechain-style pumping -> ping-pong delay + convolution hall -> circular fold (every
// tail past the loop end is added back onto the loop start, so the loop is seamless by construction) -> master with a
// circular warm-up (lib/master.mjs) -> WAV + MP3.
// usage: node --max-old-space-size=8192 tools/music/render_night.mjs [--qa] [--no-encode]
// Output: tools/music/out/night.wav, assets/music_audition/night_v1.mp3, tools/music/out/night.json, and the shipped
//         track assets/music/night.opus|mp3|json (encode_track.mjs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, loudness, segmentLoudness, octaveSpectrum, dbToGain } from './lib/dsp.mjs';
import { synthNote, kick, hat, clap, rim, shaker, riser, pingPong, duckCurve } from './lib/synth.mjs';
import { addHall, masterBus, wrapReport, encodeMp3, ffLoudness } from './lib/master.mjs';
import { writeWav } from './lib/wav.mjs';
import { encodeTrack } from './encode_track.mjs';
import { buildScore, T, BEAT } from './score_night.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const AUD = join(ROOT, 'assets', 'music_audition');
const NAME = 'night', VERSION = 'v1';
const SR = 48000;
const TARGET_LUFS = -13.2, CEILING_DBTP = -1.8; // "Ceiling Unlimited" reads -13.3 LUFS / -1.5 dBTP (ffmpeg EBU R128 on its MP3); -13.2 here lands this MP3 on the same reading
const TAIL = 8, WARM = 6, POSTROLL = 0.5;
const args = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true }); mkdirSync(AUD, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const score = buildScore();
const LOOP = Math.round(score.loopEnd * SR), N = LOOP + TAIL * SR;
const A = score.autos;
log(`score: ${score.notes.length} notes, ${score.drums.length} hits, loop 0..${score.loopEnd.toFixed(3)} s`);

// ------------------------------------------------------------------------------------------------ patches
const lfo = (period, depth, phase = 0) => (t) => 1 + depth * Math.sin(2 * Math.PI * (t / period + phase));
const PATCH = {
  pad: { osc: [{ type: 'saw', gain: 0.8, unison: 5, spread: 16 }, { type: 'pulse', width: 0.36, gain: 0.45, unison: 3, spread: 9, octave: -1 }],
    filt: { cutoff: 650, env: 1.1, keytrack: 0.3, res: 0.9, a: 1.4, d: 2.5, s: 0.45, r: 1.8, poles: 4 }, amp: { a: 0.9, d: 1.2, s: 0.85, r: 1.7 }, stereo: 0.95, drift: 3, gain: 0.16,
    cut: (t) => A.padCut(t) * lfo(8 * 4 * BEAT, 0.18)(t) },
  sub: { osc: [{ type: 'sine', gain: 1 }, { type: 'tri', gain: 0.15, octave: 1 }], filt: { cutoff: 260, env: 0, keytrack: 0, res: 0.7, a: 0.01, d: 0.1, s: 1, r: 0.4, poles: 2 },
    amp: { a: 0.35, d: 0.5, s: 0.95, r: 0.6 }, stereo: 0, gain: 0.5 },
  bass: { osc: [{ type: 'saw', gain: 0.6 }, { type: 'pulse', width: 0.42, gain: 0.32, detune: -7 }, { type: 'sine', gain: 0.45, octave: -1 }],
    filt: { cutoff: 210, env: 2.4, keytrack: 0.5, res: 1.15, a: 0.003, d: 0.24, s: 0.12, r: 0.1, poles: 4, velAmt: 1.3 }, amp: { a: 0.004, d: 0.35, s: 0.72, r: 0.07 },
    drive: 1.6, glide: 0.05, stereo: 0.1, gain: 0.34, cut: (t) => A.bassCut(t) },
  bassPad: { osc: [{ type: 'saw', gain: 0.5, unison: 2, spread: 10 }, { type: 'sine', gain: 0.9, octave: -1 }],
    filt: { cutoff: 160, env: 0.8, keytrack: 0.4, res: 0.9, a: 1.5, d: 2, s: 0.4, r: 1.2, poles: 4 }, amp: { a: 0.5, d: 1, s: 0.9, r: 1.2 }, stereo: 0.3, gain: 0.3 },
  acid: { osc: [{ type: 'saw', gain: 0.75 }, { type: 'sine', gain: 0.45, octave: -1 }],
    filt: { cutoff: 190, env: 3.1, keytrack: 0.6, res: 3.6, a: 0.002, d: 0.17, s: 0.06, r: 0.08, poles: 4, velAmt: 1.8 }, amp: { a: 0.003, d: 0.3, s: 0.7, r: 0.06 },
    drive: 2.4, glide: 0.06, stereo: 0.1, gain: 0.3, cut: (t) => A.bassCut(t) * lfo(4 * 4 * BEAT, 0.35, 0.25)(t) },
  arp: { osc: [{ type: 'tri', gain: 0.7 }, { type: 'saw', gain: 0.32, detune: 6 }, { type: 'pulse', width: 0.25, gain: 0.18, detune: -5, octave: 1 }],
    filt: { cutoff: 1500, env: 1.7, keytrack: 0.4, res: 1.1, a: 0.001, d: 0.14, s: 0.08, r: 0.2, poles: 4, velAmt: 0.8 }, amp: { a: 0.002, d: 0.28, s: 0.18, r: 0.22 },
    stereo: 0.4, drift: 2, gain: 0.15, cut: (t) => A.arpCut(t) * lfo(6 * 4 * BEAT, 0.25)(t) },
  lead: { osc: [{ type: 'pulse', width: 0.4, gain: 0.6 }, { type: 'saw', gain: 0.45, unison: 2, spread: 9 }],
    filt: { cutoff: 1500, env: 0.9, keytrack: 0.5, res: 1.0, a: 0.04, d: 0.5, s: 0.55, r: 0.3, poles: 4, velAmt: 0.6 }, amp: { a: 0.025, d: 0.35, s: 0.8, r: 0.28 },
    vib: { rate: 4.9, depth: 14, delay: 0.28 }, glide: 0.07, drift: 3, stereo: 0.35, gain: 0.12, cut: (t) => A.leadCut(t) },
};
PATCH.leadFar = { ...PATCH.lead, filt: { ...PATCH.lead.filt, cutoff: 700, env: 0.5 }, gain: 0.1, cut: null };
PATCH.lead2 = { ...PATCH.lead, filt: { ...PATCH.lead.filt, cutoff: 1100 }, gain: 0.075 };

// mix: gain (dB), pan, reverb send, delay send, sidechain depth
const MIX = {
  pad: { db: 0, pan: 0, rev: 0.42, dly: 0.0, duck: 0.5 }, sub: { db: -9, pan: 0, rev: 0, dly: 0, duck: 0.65 },
  bass: { db: 0, pan: 0, rev: 0.04, dly: 0, duck: 0.45 }, bassPad: { db: -2, pan: 0, rev: 0.12, dly: 0, duck: 0 }, acid: { db: -1, pan: 0.05, rev: 0.08, dly: 0.12, duck: 0.45 },
  arp: { db: 3, pan: -0.18, rev: 0.32, dly: 0.34, duck: 0.4 }, lead: { db: 3, pan: 0.08, rev: 0.3, dly: 0.26, duck: 0.15 },
  leadFar: { db: 3, pan: 0.25, rev: 0.75, dly: 0.5, duck: 0 }, lead2: { db: 3, pan: -0.15, rev: 0.32, dly: 0.2, duck: 0.15 },
  kick: { db: -7, pan: 0, rev: 0.02, dly: 0, duck: 0 }, hat: { db: 6, pan: 0, rev: 0.1, dly: 0.04, duck: 0.15 }, ohat: { db: 3, pan: 0, rev: 0.14, dly: 0, duck: 0.25 },
  clap: { db: 2, pan: 0, rev: 0.34, dly: 0.05, duck: 0 }, rim: { db: -9, pan: 0, rev: 0.4, dly: 0.42, duck: 0 }, shaker: { db: -4, pan: 0, rev: 0.12, dly: 0, duck: 0.2 },
  fx: { db: -4, pan: 0, rev: 0.45, dly: 0.1, duck: 0.2 },
};
const EQ = {
  pad: [['highpass', 180], ['peak', 300, { q: 0.8, gainDb: -3 }]], sub: [['highpass', 28], ['lowpass', 180]], bass: [['highpass', 30], ['peak', 250, { q: 1, gainDb: -3 }]],
  bassPad: [['highpass', 30]], acid: [['highpass', 32], ['peak', 300, { q: 1, gainDb: -2 }]], arp: [['highpass', 220]], lead: [['highpass', 200], ['peak', 2800, { q: 1, gainDb: 1 }]],
  leadFar: [['highpass', 300], ['lowpass', 4500]], lead2: [['highpass', 220]], kick: [['highpass', 28], ['peak', 300, { q: 1.2, gainDb: -3 }]],
  hat: [['highpass', 4000]], ohat: [['highpass', 4500]], clap: [['highpass', 300]], rim: [['highpass', 600]], shaker: [['highpass', 3000]], fx: [['highpass', 200]],
};

// ------------------------------------------------------------------------------------------------ render instruments
const stems = {};
const stem = (k) => (stems[k] ||= [new Float32Array(N), new Float32Array(N)]);
for (const n of score.notes) {
  const inst = n.inst === 'bass' && n.soft ? 'bassPad' : n.inst, p = PATCH[inst];
  synthNote(stem(inst), SR, { ...n, cutoff: p.cut || undefined, pan: (MIX[inst].pan || 0) + (n.pan || 0) }, p);
}
log('synth voices rendered');
const kicks = score.drums.filter((d) => d.inst === 'kick');
for (const d of score.drums) {
  const out = stem(d.inst);
  if (d.inst === 'kick') kick(out, SR, { t: d.t, vel: d.vel, seed: d.seed, decay: 0.3 });
  else if (d.inst === 'hat') hat(out, SR, { t: d.t, vel: d.vel, seed: d.seed, pan: d.pan, decay: 0.032 + 0.02 * d.vel });
  else if (d.inst === 'ohat') hat(out, SR, { t: d.t, vel: d.vel, seed: d.seed, pan: -(d.pan || 0), decay: 0.2, tone: 0.92 });
  else if (d.inst === 'clap') clap(out, SR, { t: d.t, vel: d.vel, seed: d.seed, tail: d.tail ?? 0.17 });
  else if (d.inst === 'rim') rim(out, SR, { t: d.t, vel: d.vel, seed: d.seed, pan: d.pan || 0 });
  else if (d.inst === 'shaker') shaker(out, SR, { t: d.t, vel: d.vel, seed: d.seed, pan: d.pan || 0 });
}
for (const f of score.fx) if (f.type === 'riser') riser(stem('fx'), SR, { ...f, seed: Math.round(f.t0 * 1000) });
log('drums + fx rendered');

// ------------------------------------------------------------------------------------------------ mix: EQ, pump, sends
const duck = {};
const mixL = new Float32Array(N), mixR = new Float32Array(N);
const revL = new Float32Array(N), revR = new Float32Array(N), dlyL = new Float32Array(N), dlyR = new Float32Array(N);
const segs = score.sections.map(([, a, b]) => [T(a), T(b)]);
const qa = [];
for (const [k, [L, R]] of Object.entries(stems)) {
  if (EQ[k]) eq([L, R], SR, EQ[k]);
  const m = MIX[k], g = dbToGain(m.db);
  const dc = m.duck ? (duck[m.duck] ||= duckCurve(N, SR, kicks, { depth: m.duck, release: 0.32, period: score.loopEnd })) : null;
  for (let i = 0; i < N; i++) {
    const gg = g * (dc ? dc[i] : 1), l = L[i] * gg, r = R[i] * gg;
    L[i] = l; R[i] = r; mixL[i] += l; mixR[i] += r;
    revL[i] += l * m.rev; revR[i] += r * m.rev; dlyL[i] += l * m.dly; dlyR[i] += r * m.dly;
  }
  if (args.has('--qa')) qa.push([k, segmentLoudness([L, R], SR, segs)]);
}
if (args.has('--qa')) {
  const mixSeg = segmentLoudness([mixL, mixR], SR, segs);
  console.log('  stem LUFS by section (relative to the dry mix of that section):');
  console.log('  ' + 'stem'.padEnd(9) + score.sections.map(([n]) => n.padStart(8)).join(''));
  console.log('  ' + 'MIX'.padEnd(9) + mixSeg.map((v) => v.toFixed(1).padStart(8)).join(''));
  for (const [name, v] of qa) console.log('  ' + name.padEnd(9) + v.map((x, i) => (x < -90 ? '' : (x - mixSeg[i]).toFixed(1)).padStart(8)).join(''));
}
// dotted-8th ping-pong delay (its output also feeds the hall a little)
{
  const wet = pingPong([mixL, mixR], SR, { time: 0.75 * BEAT, feedback: 0.46, wet: 0.55, lp: 3000, hp: 300, input: [dlyL, dlyR] });
  for (let i = 0; i < N; i++) { revL[i] += wet[0][i] * 0.25; revR[i] += wet[1][i] * 0.25; }
}
// night hall: long, dark, gently pumped by the kick
{
  const dry = [Float32Array.from(mixL), Float32Array.from(mixR)];
  addHall([mixL, mixR], [revL, revR], SR, { rt60: 3.6, rt60Low: 3.4, rt60High: 1.5, preDelay: 0.045, length: 6, wetDb: -2.5, hp: 180, shelfHz: 5000, shelfDb: -5, seed: 77 });
  const dc = duckCurve(N, SR, kicks, { depth: 0.25, release: 0.4, period: score.loopEnd });
  for (let i = 0; i < N; i++) { mixL[i] = dry[0][i] + (mixL[i] - dry[0][i]) * dc[i]; mixR[i] = dry[1][i] + (mixR[i] - dry[1][i]) * dc[i]; }
}
log('delay + reverb applied');

// ------------------------------------------------------------------------------------------------ circular fold
for (let i = LOOP; i < N; i++) { mixL[i - LOOP] += mixL[i]; mixR[i - LOOP] += mixR[i]; }
const loopL = mixL.subarray(0, LOOP), loopR = mixR.subarray(0, LOOP);
{ let e = 0, s = 0; const n = Math.round(0.5 * SR); for (let i = 0; i < n; i++) { e += mixL[LOOP + i] ** 2; s += loopL[i] ** 2; } log(`fold: tail energy added onto the first 0.5 s = ${(10 * Math.log10(e / (s + 1e-20) + 1e-20)).toFixed(1)} dB re loop head`); }

// ------------------------------------------------------------------------------------------------ master (circular warm-up)
const W = WARM * SR, PR = Math.round(POSTROLL * SR);
const ext = [new Float32Array(W + LOOP + PR + SR), new Float32Array(W + LOOP + PR + SR)];
for (let c = 0; c < 2; c++) {
  const src = c ? loopR : loopL, dst = ext[c];
  for (let i = 0; i < dst.length; i++) dst[i] = src[(((i - W) % LOOP) + LOOP) % LOOP];
}
const { out } = masterBus(ext, SR, {
  targetLufs: TARGET_LUFS, ceilingDbtp: CEILING_DBTP, measure: [W, W + LOOP], log,
  comp: { thresholdDb: -20, ratio: 1.7, kneeDb: 8, attack: 0.02, release: 0.3 },
  eqChain: [['highpass', 24, { q: 0.7 }], ['peak', 180, { q: 0.8, gainDb: -1 }], ['peak', 300, { q: 0.8, gainDb: -2 }], ['highshelf', 5000, { gainDb: 1.5 }], ['highshelf', 12000, { gainDb: 1.0 }]],
});
const total = LOOP + PR;
const FL = out[0].slice(W, W + total), FR = out[1].slice(W, W + total);
for (let i = 0; i < 480; i++) { const g = i / 480; FL[total - 1 - i] *= g; FR[total - 1 - i] *= g; }
{ // the wrap: compare with the same samples in the warm-up copy (identical input history)
  let d = 0, s = 0; for (let i = 0; i < SR; i++) { d += (out[0][W + i] - out[0][W + LOOP + i]) ** 2; s += out[0][W + i] ** 2; }
  log(`seam check: master output at loop start vs after one full loop = ${(10 * Math.log10(d / s + 1e-20)).toFixed(1)} dB (compressor/limiter state at the wrap)`);
}
wrapReport([FL, FR], SR, 1, LOOP + 1, log); // (offset by one sample so the 'following second' window exists: the step LOOP -> 1 equals the wrap)
const finalL = loudness([FL.subarray(0, LOOP), FR.subarray(0, LOOP)], SR);
if (args.has('--qa')) {
  const seg = segmentLoudness([FL, FR], SR, segs);
  console.log('  master LUFS by section: ' + score.sections.map(([n], i) => `${n} ${seg[i].toFixed(1)}`).join(' | '));
  let em = 0, es = 0; for (let i = 0; i < total; i++) { const m = FL[i] + FR[i], d = FL[i] - FR[i]; em += m * m; es += d * d; }
  console.log(`  stereo: side/mid energy ${(10 * Math.log10(es / em)).toFixed(1)} dB`);
  const oct = octaveSpectrum([FL, FR], SR); const ref = oct[5][1];
  console.log('  master octave spectrum (dB re 1 kHz): ' + oct.map(([f, d]) => `${f >= 1000 ? f / 1000 + 'k' : f} ${(d - ref).toFixed(1)}`).join(' | '));
}
log(`final: ${finalL.integrated.toFixed(2)} LUFS integrated (loop), short-term max ${finalL.shortTermMax.toFixed(1)}, min ${finalL.shortTermMin.toFixed(1)}`);
const wavPath = join(OUT, `${NAME}.wav`);
writeWav(wavPath, [FL, FR], SR, { float: true });
log(`wrote ${wavPath} (${(total / SR).toFixed(3)} s; loop 0..${score.loopEnd.toFixed(3)} s + ${POSTROLL} s copy of the loop head)`);
const meta = { title: score.title, bpm: score.bpm, loopStart: 0, loopEnd: score.loopEnd, duration: total / SR, sampleRate: SR, lufs: +finalL.integrated.toFixed(2),
  sections: Object.fromEntries(score.sections.map(([n, a, b]) => [n, [+T(a).toFixed(3), +T(b).toFixed(3)]])) };
if (!args.has('--no-encode')) {
  const mp3 = join(AUD, `${NAME}_${VERSION}.mp3`);
  encodeMp3(wavPath, mp3, `${score.title} (audition ${VERSION})`, 192);
  meta.mp3 = { file: mp3, ...ffLoudness(mp3) };
  log(`encoded ${mp3}: ffmpeg EBU R128 I ${meta.mp3.I} LUFS, LRA ${meta.mp3.LRA} LU, true peak ${meta.mp3.TP} dBFS`);
}
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(meta, null, 2));
if (!args.has('--no-encode')) encodeTrack(NAME, wavPath, meta);   // the shipped track: assets/music/<NAME>.opus|mp3|json
log('done');
