#!/usr/bin/env node
// tools/gen_dialogue_tts.mjs — generate the story dialogue's raw TTS clips (Gemini API TTS) for every voiced line of
// tools/dialogue_lines.mjs: assets/dialogue/raw/<id>.mp3 (not checked in). tools/build_dialogue.mjs trims them into the
// shipped clips. Voices and style directions: tools/dialogue_voices.mjs.
//
// usage: node tools/gen_dialogue_tts.mjs [--only id1,id2] [--speaker WSO] [--takes N] [--skip-keep] [--force] [--dry]
//   The API key is read from the GEMINI_API_KEY environment variable only; it is never printed or written anywhere
//   (error text is redacted). Existing raw files are skipped unless --force; a failed request is retried (rate limits,
//   server errors), nothing else. --takes N writes raw/<id>_t<k>.mp3 (k = 1..N); tools/build_dialogue.mjs keeps the best
//   by speaking rate and pauses. --skip-keep leaves out the designer-approved takes (dialogue_voices.mjs KEEP). WSO
//   and Mainspring lines are generated at temperature 1.0 (WSO_TTS, MAINSPRING_TTS).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOGUE_LINES } from './dialogue_lines.mjs';
import { DIALOGUE_MODEL, DIALOGUE_VOICES, styleFor, KEEP, WSO_TTS, MAINSPRING_TTS } from './dialogue_voices.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const only = opt('--only', '') ? opt('--only', '').split(',') : null;
const force = args.includes('--force'), dry = args.includes('--dry'), skipKeep = args.includes('--skip-keep');
const speaker = opt('--speaker', ''), takes = Math.max(1, Number(opt('--takes', 1)) | 0);
const OUT = 'assets/dialogue/raw';
const KEY = process.env.GEMINI_API_KEY;
if (!KEY && !dry) { console.error('Set GEMINI_API_KEY in the environment first.'); process.exit(1); }
const redact = (s) => (KEY ? String(s).split(KEY).join('<redacted>') : String(s));

const jobs = [];
for (const l of DIALOGUE_LINES) {
  if (l.music || (only && !only.includes(l.id)) || (speaker && l.speaker !== speaker) || (skipKeep && KEEP.has(l.id))) continue;
  for (let k = 1; k <= takes; k++) {
    const out = join(OUT, takes > 1 ? `${l.id}_t${k}.mp3` : `${l.id}.mp3`);
    if (!force && existsSync(out)) continue;
    jobs.push({ ...l, ...styleFor(l), voice: DIALOGUE_VOICES[l.speaker], temperature: l.speaker === 'WSO' ? WSO_TTS.temperature : l.speaker === 'MAINSPRING' ? MAINSPRING_TTS.temperature : undefined, out });
  }
}
mkdirSync(OUT, { recursive: true });
console.log(`${jobs.length} clip(s) to generate (${DIALOGUE_MODEL})`);
if (dry) { for (const j of jobs) console.log(`  ${j.id} ${j.voice.voice} [${j.styleName}] ${j.text}`); process.exit(0); }

async function synth(job) {
  const body = {
    contents: [{ parts: [{ text: job.text, speechMetadata: { style: job.style } }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { languageCode: job.voice.languageCode, voiceConfig: { prebuiltVoiceConfig: { voiceName: job.voice.voice } } },
      responseFormat: { audio: { mimeType: 'AUDIO_MP3' } },
    },
  };
  if (job.temperature != null) body.generationConfig.temperature = job.temperature;
  for (let attempt = 1; attempt <= 6; attempt++) {
    let res, txt;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${DIALOGUE_MODEL}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      txt = await res.text();
    } catch (e) { console.log(`  ${job.id}: ${redact(e && e.message)} (retry ${attempt})`); await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    if (!res.ok) {
      console.log(`  ${job.id}: HTTP ${res.status} ${redact(txt).slice(0, 300)}`);
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * attempt)); continue; }
      return false;
    }
    let parts = [];
    try { parts = JSON.parse(txt).candidates?.[0]?.content?.parts ?? []; } catch (e) { /* no audio */ }
    const audio = parts.filter((p) => p.inlineData).map((p) => Buffer.from(p.inlineData.data, 'base64'));
    if (!audio.length) { console.log(`  ${job.id}: no audio in response (retry ${attempt})`); await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    writeFileSync(job.out, Buffer.concat(audio));
    console.log(`  ok ${job.out.split('/').pop()} (${job.speaker}, ${job.styleName})`);
    return true;
  }
  return false;
}
let next = 0, failed = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) if (!(await synth(jobs[next++]))) failed++; }));
if (failed) { console.log(`${failed} clip(s) failed`); process.exit(1); }
