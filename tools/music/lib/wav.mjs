// Minimal, defensive RIFF/WAVE reader + writer (PCM 8/16/24/32-bit int, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE).
// Input files are untrusted data: every chunk size is bounds-checked; nothing is executed.
import { readFileSync, writeFileSync } from 'node:fs';

/** @returns {{ sampleRate:number, channels:Float32Array[], frames:number, loops:{start:number,end:number}[] }} */
export function readWav(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error(`not a WAV: ${path}`);
  let fmt = null, dataOff = -1, dataLen = 0; const loops = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = tag(o); let size = dv.getUint32(o + 4, true); const body = o + 8;
    if (body + size > buf.length) size = buf.length - body; // truncated file: clamp
    if (id === 'fmt ' && size >= 16) {
      let format = dv.getUint16(body, true);
      const ch = dv.getUint16(body + 2, true), sr = dv.getUint32(body + 4, true), bits = dv.getUint16(body + 14, true);
      if (format === 0xFFFE && size >= 26) format = dv.getUint16(body + 24, true); // extensible: first 2 bytes of subformat GUID
      fmt = { format, ch, sr, bits, blockAlign: dv.getUint16(body + 12, true) };
    } else if (id === 'data') { dataOff = body; dataLen = size; }
    else if (id === 'smpl' && size >= 36) {
      const n = dv.getUint32(body + 28, true);
      for (let i = 0; i < n && body + 36 + i * 24 + 24 <= body + size; i++) {
        const lo = body + 36 + i * 24;
        loops.push({ start: dv.getUint32(lo + 8, true), end: dv.getUint32(lo + 12, true) });
      }
    }
    o = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error(`WAV missing fmt/data: ${path}`);
  const { format, ch, sr, bits } = fmt;
  if (ch < 1 || ch > 8 || sr < 8000 || sr > 384000) throw new Error(`unsupported WAV params ${ch}ch ${sr}Hz: ${path}`);
  const bps = bits >> 3, frameBytes = bps * ch;
  if (!frameBytes) throw new Error(`bad bit depth ${bits}: ${path}`);
  const frames = Math.floor(dataLen / frameBytes);
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++, p += bps) {
      let v;
      if (format === 3) v = bps === 4 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      else if (bps === 2) v = dv.getInt16(p, true) / 32768;
      else if (bps === 3) { let x = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); if (x & 0x800000) x |= ~0xFFFFFF; v = x / 8388608; }
      else if (bps === 4) v = dv.getInt32(p, true) / 2147483648;
      else if (bps === 1) v = (buf[p] - 128) / 128;
      else throw new Error(`unsupported sample width ${bits}: ${path}`);
      out[c][i] = Number.isFinite(v) ? v : 0;
    }
  }
  return { sampleRate: sr, channels: out, frames, loops };
}

/** Write float channels as 16-bit PCM (dither optional) or 32-bit float WAV. */
export function writeWav(path, channels, sampleRate, { float = false, dither = true } = {}) {
  const ch = channels.length, n = channels[0].length, bps = float ? 4 : 2;
  const dataLen = n * ch * bps, buf = Buffer.alloc(44 + dataLen), dv = new DataView(buf.buffer);
  buf.write('RIFF', 0); dv.setUint32(4, 36 + dataLen, true); buf.write('WAVE', 8);
  buf.write('fmt ', 12); dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, bps * 8, true);
  buf.write('data', 36); dv.setUint32(40, dataLen, true);
  let p = 44, seed = 22222;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = channels[c][i];
    if (float) { dv.setFloat32(p, v, true); p += 4; }
    else {
      const d = dither ? (rnd() - rnd()) : 0; // TPDF dither, 1 LSB
      let x = Math.round(v * 32767 + d); x = x > 32767 ? 32767 : x < -32768 ? -32768 : x;
      dv.setInt16(p, x, true); p += 2;
    }
  }
  writeFileSync(path, buf);
}
