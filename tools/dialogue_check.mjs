#!/usr/bin/env node
// tools/dialogue_check.mjs — every scripted line has a clip, and every clip has a line.
//   Checks tools/dialogue_lines.mjs (the script) against assets/dialogue/*.mp3 (the shipped clips) and js/dialogue_data.js
//   (the table the game reads: same ids, texts and speakers; clip lengths match the files). Exit code 1 on any problem.
// usage: node tools/dialogue_check.mjs
import { readdirSync, existsSync } from 'node:fs';
import { DIALOGUE_LINES } from './dialogue_lines.mjs';
import { DIALOGUE } from '../js/dialogue_data.js';
import { duration } from './voice_chain.mjs';

const problems = [];
const voiced = DIALOGUE_LINES.filter((l) => !l.music);
const clips = new Set(readdirSync('assets/dialogue').filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4)));
for (const l of voiced) if (!clips.has(l.id)) problems.push(`no clip for ${l.id} (${l.speaker}: "${l.text}")`);
const ids = new Set(voiced.map((l) => l.id));
for (const c of clips) if (!ids.has(c)) problems.push(`clip ${c}.mp3 has no line in the script`);
const data = Object.fromEntries(DIALOGUE.map((e) => [e.id, e]));
for (const l of DIALOGUE_LINES) {
  const e = data[l.id];
  if (!e) { problems.push(`${l.id} missing from js/dialogue_data.js (run tools/build_dialogue.mjs)`); continue; }
  if (l.music) { if (!e.music) problems.push(`${l.id}: cue lost its music action`); continue; }
  if (e.text !== l.text || e.speaker !== l.speaker) problems.push(`${l.id}: js/dialogue_data.js is stale (text or speaker)`);
  const f = `assets/dialogue/${l.id}.mp3`;
  if (existsSync(f) && Math.abs(duration(f) - e.dur) > 0.02) problems.push(`${l.id}: clip length ${duration(f).toFixed(3)} s, table says ${e.dur}`);
}
for (const id of Object.keys(data)) if (!DIALOGUE_LINES.some((l) => l.id === id)) problems.push(`js/dialogue_data.js has ${id}, the script does not`);
console.log(`${voiced.length} scripted lines, ${clips.size} clips, ${DIALOGUE_LINES.length - voiced.length} music cues`);
if (problems.length) { console.log('DIALOGUE_CHECK FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('DIALOGUE_CHECK OK');
