// QA helper: renders a log-frequency spectrogram (+ RMS strip and optional bar grid) of a WAV to PNG.
// usage: node tools/music/qa_spectrogram.mjs in.wav out.png [width=1800] [bpm] [offsetSec] [t0] [t1]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { readWav } from './lib/wav.mjs';
import { fft } from './lib/dsp.mjs';

const [inp, outp, wArg = '1800', bpmArg = '', offArg = '0', t0Arg = '', t1Arg = ''] = process.argv.slice(2);
const w = readWav(inp), sr = w.sampleRate;
const mid = new Float32Array(w.frames); for (const c of w.channels) for (let i = 0; i < w.frames; i++) mid[i] += c[i] / w.channels.length;
const t0 = t0Arg ? +t0Arg : 0, t1 = t1Arg ? +t1Arg : w.frames / sr;
const W = +wArg, H = 520, RMSH = 70, N = 4096, fmin = 30, fmax = 16000;
const img = new Uint8Array((H + RMSH) * W * 3);
const re = new Float64Array(N), im = new Float64Array(N);
const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const color = (v) => { // v 0..1 -> inferno-ish
  const stops = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
  const x = Math.max(0, Math.min(0.9999, v)) * (stops.length - 1), i = Math.floor(x), f = x - i;
  return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
};
const rmsCol = [];
for (let x = 0; x < W; x++) {
  const t = t0 + (t1 - t0) * (x + 0.5) / W, c = Math.round(t * sr) - N / 2;
  let e = 0;
  for (let i = 0; i < N; i++) { const v = mid[c + i] || 0; re[i] = v * win[i]; im[i] = 0; e += v * v; }
  rmsCol.push(10 * Math.log10(e / N + 1e-12));
  fft(re, im);
  for (let y = 0; y < H; y++) {
    const f = fmin * Math.pow(fmax / fmin, 1 - (y + 0.5) / H);
    const b = f * N / sr, b0 = Math.floor(b), fr = b - b0;
    const m0 = Math.hypot(re[b0], im[b0]), m1 = Math.hypot(re[b0 + 1], im[b0 + 1]);
    const db = 20 * Math.log10((m0 * (1 - fr) + m1 * fr) / (N / 4) + 1e-9);
    const [r, g, bl] = color((db + 90) / 90);
    const o = (y * W + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = bl;
  }
}
// RMS strip (-50..0 dBFS)
for (let x = 0; x < W; x++) {
  const hgt = Math.round(Math.max(0, Math.min(1, (rmsCol[x] + 50) / 50)) * (RMSH - 4));
  for (let y = 0; y < RMSH; y++) { const o = ((H + y) * W + x) * 3; const on = (RMSH - y) <= hgt; img[o] = on ? 90 : 20; img[o + 1] = on ? 200 : 20; img[o + 2] = on ? 255 : 30; }
}
// octave lines (C notes) and bar grid
for (let oct = 1; oct <= 9; oct++) {
  const f = 32.7032 * Math.pow(2, oct - 1); if (f < fmin || f > fmax) continue;
  const y = Math.round(H * (1 - Math.log(f / fmin) / Math.log(fmax / fmin)));
  for (let x = 0; x < W; x += 3) { const o = (y * W + x) * 3; img[o] = 120; img[o + 1] = 120; img[o + 2] = 120; }
}
if (bpmArg) {
  const bar = 240 / +bpmArg; const off = +offArg;
  for (let k = Math.ceil((t0 - off) / bar); off + k * bar <= t1; k++) {
    const x = Math.round((off + k * bar - t0) / (t1 - t0) * W); if (x < 0 || x >= W) continue;
    const strong = k % 4 === 0;
    for (let y = 0; y < H + RMSH; y += strong ? 1 : 4) { const o = (y * W + x) * 3; img[o] = 255; img[o + 1] = 255; img[o + 2] = 255; }
  }
}
// PNG encode
const raw = Buffer.alloc((W * 3 + 1) * (H + RMSH));
for (let y = 0; y < H + RMSH; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H + RMSH, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
writeFileSync(outp, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`spectrogram ${outp} (${W}x${H + RMSH}), ${t0.toFixed(2)}..${t1.toFixed(2)} s; grey lines = C1..C9`);
