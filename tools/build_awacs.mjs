#!/usr/bin/env node
// tools/build_awacs.mjs — rebuild js/awacs_clips.js from assets/awacs/*.mp3 + tools/awacs_lines.mjs. No API calls.
//
// usage: node tools/build_awacs.mjs [--retrim] [--kbps 48] [--rate 24000] [--lufs -18] [--tempo 1.07]
//   1. Trim step (needs ffmpeg; runs for clips whose shipped file is missing, or for all with --retrim).
//      The raw TTS masters are not checked in: regenerate them with tools/gen_awacs_tts.mjs first. Without them the
//      shipped clips in assets/awacs/ are packed as-is.
//        assets/awacs/raw/<key>_<n>.mp3 (TTS master: MP3 44.1 kHz mono 128 kbps, the service default)
//        -> trim leading/trailing silence (sustained 10 ms RMS > -46 dBFS = speech; keep 50 ms pre-roll / 100 ms tail)
//        -> pitch-preserving time-stretch (speaking rate x1.07; the TTS API has no rate parameter)
//        -> loudness-normalise to --lufs (EBU R128 integrated), -1 dBFS peak limiter, 5 ms / 30 ms fades
//        -> assets/awacs/<key>_<n>.mp3 (MP3 mono CBR; 48 kbps @ 24 kHz is transparent behind the 300-3200 Hz radio chain)
//   2. Pack step (pure Node): base64 of every shipped clip + its subtitle text -> js/awacs_clips.js
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { AWACS_VOICE, AWACS_LINES, awacsVariants } from './awacs_lines.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const RETRIM = args.includes('--retrim');
const KBPS = opt('--kbps', 48), RATE = opt('--rate', 24000), LUFS = opt('--lufs', -18), TEMPO = opt('--tempo', AWACS_VOICE.tempo);
const RAW = 'assets/awacs/raw', OUT = 'assets/awacs', JS = 'js/awacs_clips.js';

const THRESH_DB = -46, PRE_ROLL = 0.05, TAIL = 0.10, WIN = 0.01; // trim: 10 ms RMS windows, sustained-signal edges
function ffmpeg(argv, what) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...argv], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.status !== 0) throw new Error(`ffmpeg ${what} failed: ${(p.stderr || '').slice(-400)}`);
  return p.stderr; // ffmpeg logs (incl. the ebur128 summary) go to stderr
}
const duration = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());

/**
 * Speech span [start, end] in seconds: first/last 10 ms RMS window above THRESH_DB that belongs to sustained signal
 * (3 of 4 consecutive windows above threshold), so isolated clicks / mouth noise in the silence are ignored.
 */
function speechSpan(raw) {
  const p = spawnSync('ffmpeg', ['-v', 'error', '-i', raw, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (p.status !== 0) throw new Error(`ffmpeg decode of ${raw} failed`);
  const x = new Float32Array(p.stdout.buffer, p.stdout.byteOffset, p.stdout.length >> 2);
  const n = Math.max(1, Math.round(RATE * WIN)), W = Math.floor(x.length / n), thr = Math.pow(10, THRESH_DB / 20);
  const on = new Uint8Array(W);
  for (let w = 0; w < W; w++) { let e = 0; for (let i = w * n; i < (w + 1) * n; i++) e += x[i] * x[i]; on[w] = Math.sqrt(e / n) > thr ? 1 : 0; }
  const sustained = (w) => on[w] && (on[w] + (on[w + 1] || 0) + (on[w + 2] || 0) + (on[w + 3] || 0) >= 3 || on[w] + (on[w - 1] || 0) + (on[w - 2] || 0) + (on[w - 3] || 0) >= 3);
  let a = 0; while (a < W && !sustained(a)) a++;
  let b = W - 1; while (b > a && !sustained(b)) b--;
  const dur = x.length / RATE;
  if (a >= W) return [0, dur];
  return [Math.max(0, a * WIN - PRE_ROLL), Math.min(dur, (b + 1) * WIN + TAIL)];
}
function trim(raw, out) {
  const [t0, t1] = speechSpan(raw);
  const pre = `atrim=start=${t0.toFixed(3)}:end=${t1.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${TEMPO}`;
  const log = ffmpeg(['-i', raw, '-af', `${pre},ebur128=peak=true`, '-f', 'null', '-'], `analysis of ${raw}`);
  const m = [...log.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop();
  const I = m ? Number(m[1]) : NaN;
  const gain = Number.isFinite(I) && I > -60 ? Math.max(-12, Math.min(15, LUFS - I)) : 0;
  const af = [pre, `volume=${gain.toFixed(2)}dB`, 'alimiter=limit=0.891:attack=3:release=60:level=0:latency=1',
    'afade=t=in:st=0:d=0.005', 'areverse', 'afade=t=in:st=0:d=0.03', 'areverse'].join(',');
  ffmpeg(['-y', '-i', raw, '-af', af, '-ac', '1', '-ar', String(RATE), '-c:a', 'libmp3lame', '-b:a', `${KBPS}k`,
    '-map_metadata', '-1', '-id3v2_version', '0', out], `encode of ${raw}`);
  return { I, gain };
}

const variants = awacsVariants();
let trimmed = 0, rawBytes = 0, shipBytes = 0, seconds = 0, rawSeconds = 0;
const clips = {};
for (const v of variants) {
  const name = `${v.key}_${v.n}.mp3`, raw = `${RAW}/${name}`, out = `${OUT}/${name}`;
  if (!existsSync(raw) && !existsSync(out)) throw new Error(`missing ${raw} (generate it with tools/gen_awacs_tts.mjs)`);
  if (existsSync(raw)) { rawBytes += statSync(raw).size; rawSeconds += duration(raw); }
  if (RETRIM || !existsSync(out)) {
    const { I, gain } = trim(raw, out); trimmed++;
    console.log(`  trim ${name.padEnd(24)} ${I.toFixed(1)} LUFS -> gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB, ${duration(out).toFixed(2)} s`);
  }
  const buf = readFileSync(out);
  const dur = duration(out);
  shipBytes += buf.length; seconds += dur;
  (clips[v.key] ||= []).push({ text: v.text, dur: Math.round(dur * 1000) / 1000, data: buf.toString('base64') });
}

let js = `// js/awacs_clips.js — GENERATED by tools/build_awacs.mjs from assets/awacs/*.mp3 + tools/awacs_lines.mjs. Do not edit.\n`;
js += `// AWACS Claude radio lines: ${variants.length} clips / ${Object.keys(clips).length} events, ${seconds.toFixed(1)} s, `;
js += `MP3 mono ${KBPS} kbps ${RATE} Hz. Voice "${AWACS_VOICE.voice}" (${AWACS_VOICE.model}), speaking rate x${TEMPO}.\n`;
js += `// Shape: AWACS_CLIPS[eventKey] = [{ text (subtitle), dur (s), data (base64 MP3) }, ...]\n`;
js += `export const AWACS_CLIPS = {\n`;
for (const key of Object.keys(AWACS_LINES)) {
  js += `  ${key}: [\n`;
  for (const c of clips[key]) js += `    { text: ${JSON.stringify(c.text)}, dur: ${c.dur}, data: '${c.data}' },\n`;
  js += `  ],\n`;
}
js += `};\n`;
writeFileSync(JS, js);
const b64 = Object.values(clips).flat().reduce((a, c) => a + c.data.length, 0);
console.log(`${trimmed ? `trimmed ${trimmed} clip(s); ` : ''}${variants.length} clips, ${Object.keys(clips).length} events, ${seconds.toFixed(1)} s shipped (raw masters ${rawSeconds.toFixed(1)} s, ${(rawBytes / 1024).toFixed(0)} KB)`);
console.log(`shipped MP3 ${(shipBytes / 1024).toFixed(1)} KB, base64 ${(b64 / 1024).toFixed(1)} KB, ${JS} ${(js.length / 1024).toFixed(1)} KB`);
