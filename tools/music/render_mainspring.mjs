// Offline render of "Mainspring" (score_mainspring.mjs), an audition piece: sampler -> per-track EQ -> buses -> dark
// convolution hall -> master (lib/master.mjs) -> seamless loop (LEAD-copy seam, as render.mjs) -> WAV + MP3.
// usage: node --max-old-space-size=8192 tools/music/render_mainspring.mjs [--qa] [--no-encode]
// Output: tools/music/out/mainspring.wav (float master, used by the QA tools and crossfade_test.mjs),
//         assets/music_audition/mainspring_v1.mp3, tools/music/out/mainspring.json (loop points, loudness), and the
//         shipped track assets/music/mainspring.opus|mp3|json (encode_track.mjs).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SampleBank } from './lib/sampler.mjs';
import { createOrchestra, renderTrack } from './lib/orchestra.mjs';
import { extendOrchestra } from './lib/orchestra_ext.mjs';
import { eq, loudness, segmentLoudness, octaveSpectrum, dbToGain, gainToDb } from './lib/dsp.mjs';
import { addHall, masterBus, seamFromLeadCopies, encodeMp3, ffLoudness } from './lib/master.mjs';
import { writeWav } from './lib/wav.mjs';
import { encodeTrack } from './encode_track.mjs';
import { buildScore, T } from './score_mainspring.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const AUD = join(ROOT, 'assets', 'music_audition');
const NAME = 'mainspring', VERSION = 'v1';
const SR = 48000;
const TARGET_LUFS = -13.2, CEILING_DBTP = -1.8; // "Ceiling Unlimited" reads -13.3 LUFS / -1.5 dBTP (ffmpeg EBU R128 on its MP3); -13.2 here lands this MP3 on the same reading so the game can cut between them
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
const BUS_GAIN = { str: 0, brass: 0, winds: 0, clock: 0, perc: 0 };
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
if (args.has('--qa')) {
  const mixSeg = segmentLoudness([mixL, mixR], SR, segs);
  console.log('  track LUFS by section (relative to the dry mix of that section):');
  console.log('  ' + 'track'.padEnd(10) + score.sections.map(([n]) => n.padStart(7)).join(''));
  console.log('  ' + 'MIX'.padEnd(10) + mixSeg.map((v) => v.toFixed(1).padStart(7)).join(''));
  for (const [name, v] of qa) console.log('  ' + name.padEnd(10) + v.map((x, i) => (x < -90 ? '' : (x - mixSeg[i]).toFixed(1)).padStart(7)).join(''));
}

// ------------------------------------------------------------------------------------------------ hall (larger, darker than the theme's)
addHall([mixL, mixR], [sendL, sendR], SR, { rt60: 2.9, rt60Low: 3.3, rt60High: 1.1, preDelay: 0.032, length: 4.6, wetDb: -3.0, shelfHz: 6000, shelfDb: -5, seed: 41 });
log('reverb applied');

// ------------------------------------------------------------------------------------------------ master
const { out } = masterBus([mixL, mixR], SR, {
  targetLufs: TARGET_LUFS, ceilingDbtp: CEILING_DBTP, measure: [0, LE], log, comp: { thresholdDb: -24, ratio: 2.2, kneeDb: 10, attack: 0.04, release: 0.5 },
  eqChain: [['highpass', 26, { q: 0.6 }], ['highpass', 26, { q: 0.9 }], ['lowshelf', 70, { gainDb: -1 }], ['peak', 240, { q: 0.8, gainDb: -1.5 }], ['peak', 420, { q: 0.9, gainDb: -1.5 }],
    ['peak', 3000, { q: 0.8, gainDb: 0.5 }], ['highshelf', 5000, { gainDb: 2.0 }], ['highshelf', 11000, { gainDb: 1.5 }]],
});

// ------------------------------------------------------------------------------------------------ loop
const [FL, FR] = seamFromLeadCopies(out, SR, LS, LE, { log });
const total = FL.length;
const finalL = loudness([FL, FR], SR), loopOnly = loudness([FL.subarray(LS, LE), FR.subarray(LS, LE)], SR);
if (args.has('--qa')) {
  const seg = segmentLoudness([FL, FR], SR, segs);
  console.log('  master LUFS by section: ' + score.sections.map(([n], i) => `${n} ${seg[i].toFixed(1)}`).join(' | '));
  let em = 0, es = 0; for (let i = 0; i < total; i++) { const m = FL[i] + FR[i], d = FL[i] - FR[i]; em += m * m; es += d * d; }
  console.log(`  stereo: side/mid energy ${(10 * Math.log10(es / em)).toFixed(1)} dB`);
  const oct = octaveSpectrum([FL, FR], SR); const ref = oct[5][1];
  console.log('  master octave spectrum (dB re 1 kHz): ' + oct.map(([f, d]) => `${f >= 1000 ? f / 1000 + 'k' : f} ${(d - ref).toFixed(1)}`).join(' | '));
}
log(`final: ${finalL.integrated.toFixed(2)} LUFS integrated (loop region ${loopOnly.integrated.toFixed(2)}), short-term max ${finalL.shortTermMax.toFixed(1)}, min ${finalL.shortTermMin.toFixed(1)}`);
const wavPath = join(OUT, `${NAME}.wav`);
writeWav(wavPath, [FL, FR], SR, { float: true });
log(`wrote ${wavPath} (${(total / SR).toFixed(3)} s)`);

const meta = { title: score.title, bpm: score.bpm, loopStart: score.loopStart, loopEnd: score.loopEnd, duration: total / SR, sampleRate: SR,
  lufs: +finalL.integrated.toFixed(2), loopLufs: +loopOnly.integrated.toFixed(2), sections: Object.fromEntries(score.sections.map(([n, a, b]) => [n, [+T(a).toFixed(3), +T(b).toFixed(3)]])) };
if (!args.has('--no-encode')) {
  const mp3 = join(AUD, `${NAME}_${VERSION}.mp3`);
  encodeMp3(wavPath, mp3, `${score.title} (audition ${VERSION})`, 192);
  meta.mp3 = { file: mp3, ...ffLoudness(mp3) };
  log(`encoded ${mp3}: ffmpeg EBU R128 I ${meta.mp3.I} LUFS, LRA ${meta.mp3.LRA} LU, true peak ${meta.mp3.TP} dBFS`);
}
writeFileSync(join(OUT, `${NAME}.json`), JSON.stringify(meta, null, 2));
if (!args.has('--no-encode')) encodeTrack(NAME, wavPath, meta);   // the shipped track: assets/music/<NAME>.opus|mp3|json
log('done');
