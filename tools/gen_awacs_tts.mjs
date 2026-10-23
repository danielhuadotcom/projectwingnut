#!/usr/bin/env node
// tools/gen_awacs_tts.mjs — (re)generate AWACS Claude raw clips with the Gemini API TTS. Only needed for NEW lines:
// the shipped clips are rebuilt offline by tools/build_awacs.mjs.
//
// usage: node tools/gen_awacs_tts.mjs [--only key1,key2 | --only key_n] [--takes N] [--out DIR] [--force]
//   The API key is read from the GEMINI_API_KEY environment variable only (export it in your shell first);
//   it is never printed or written anywhere.
//   Writes DIR/<key>_<n>.mp3 (DIR defaults to assets/awacs/raw), or DIR/<key>_<n>_t<k>.mp3 when --takes > 1
//   (listen, keep the best take as <key>_<n>.mp3). Existing files are skipped unless --force.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AWACS_VOICE, awacsVariants } from './awacs_lines.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const only = opt('--only', '') ? opt('--only', '').split(',') : null;
const takes = Math.max(1, Number(opt('--takes', 1)) | 0);
const outDir = opt('--out', 'assets/awacs/raw');
const force = args.includes('--force');
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY in the environment first.'); process.exit(1); }
const redact = (s) => String(s).split(KEY).join('<redacted>');

const jobs = [];
for (const v of awacsVariants()) {
  if (only && !only.includes(v.key) && !only.includes(`${v.key}_${v.n}`)) continue;
  for (let t = 1; t <= takes; t++) {
    const out = join(outDir, takes > 1 ? `${v.key}_${v.n}_t${t}.mp3` : `${v.key}_${v.n}.mp3`);
    if (!force && existsSync(out)) continue;
    jobs.push({ ...v, out });
  }
}
mkdirSync(outDir, { recursive: true });
console.log(`${jobs.length} clip(s) to generate with ${AWACS_VOICE.voice} / ${AWACS_VOICE.model}`);

async function synth(job) {
  const body = {
    contents: [{ parts: [{ text: job.text, speechMetadata: { style: job.style } }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { languageCode: AWACS_VOICE.languageCode, voiceConfig: { prebuiltVoiceConfig: { voiceName: AWACS_VOICE.voice } } },
      responseFormat: { audio: { mimeType: 'AUDIO_MP3' } },   // service default bitrate / sample rate
    },
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res, txt;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AWACS_VOICE.model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      txt = await res.text();
    } catch (e) { console.log(`  ${job.out}: ${redact(e.message)} (retry ${attempt})`); await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
    if (!res.ok) {
      console.log(`  ${job.out}: HTTP ${res.status} ${redact(txt).slice(0, 300)}`);
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }
      return false;
    }
    const parts = JSON.parse(txt).candidates?.[0]?.content?.parts ?? [];
    const audio = parts.filter(p => p.inlineData).map(p => Buffer.from(p.inlineData.data, 'base64'));
    if (!audio.length) { console.log(`  ${job.out}: no audio in response`); return false; }
    writeFileSync(job.out, Buffer.concat(audio));
    console.log(`  ok ${job.out}`);
    return true;
  }
  return false;
}
let next = 0, failed = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) if (!(await synth(jobs[next++]))) failed++; }));
if (failed) { console.log(`${failed} clip(s) failed`); process.exit(1); }
