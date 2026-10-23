// QA helper: per-bar loudness (ungated K-weighted, LUFS-ish) of a rendered WAV, drawn as a text bar chart.
// usage: node tools/music/qa_bars.mjs file.wav [bpm=128] [offset=0]
import { readWav } from './lib/wav.mjs';
import { segmentLoudness } from './lib/dsp.mjs';
const [f, bpmA = '128', offA = '0'] = process.argv.slice(2);
const w = readWav(f), bar = 240 / +bpmA, off = +offA;
const n = Math.floor((w.frames / w.sampleRate - off) / bar);
const segs = Array.from({ length: n }, (_, i) => [off + i * bar, off + (i + 1) * bar]);
const heads = Array.from({ length: n }, (_, i) => [off + i * bar, off + i * bar + 0.4]);
const L = segmentLoudness(w.channels, w.sampleRate, segs), H = segmentLoudness(w.channels, w.sampleRate, heads);
for (let i = 0; i < n; i++) {
  const v = L[i]; const len = Math.max(0, Math.round((v + 30) * 2));
  console.log(`bar ${String(i + 1).padStart(2)} ${v.toFixed(1).padStart(6)} (downbeat ${H[i].toFixed(1).padStart(6)}) ${'#'.repeat(len)}`);
}
