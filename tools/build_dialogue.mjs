#!/usr/bin/env node
// tools/build_dialogue.mjs — the story dialogue's shipped clips and script table. No API calls.
//
// usage: node tools/build_dialogue.mjs [--retrim]
//   1. Trim step (tools/voice_chain.mjs, the chain of tools/build_awacs.mjs: trim, x1.07 tempo, -18 LUFS, MP3 mono
//      48 kbps 24 kHz; WSO lines per the WSO recipe: tight gaps, x1.15): assets/dialogue/raw/<id>.mp3
//      (tools/gen_dialogue_tts.mjs) -> assets/dialogue/<id>.mp3, for clips whose shipped file is missing (all with
//      --retrim). A line with several takes (raw/<id>_t<k>.mp3) has every take processed into
//      assets/voice_audition/wso_takes/<id>_t<k>.mp3 (alternates for the designer, not shipped) and the best one, by
//      speaking rate and pauses (tools/voice_measure.mjs), shipped; tools/dialogue_takes.json records the pick. To swap
//      in another take, copy it over assets/dialogue/<id>.mp3 and set its pick in that file. A "source" entry there
//      ships a take picked from an audition round as is (Mainspring: assets/voice_audition/mainspring2/<id>_xy.mp3).
//   2. Script step: js/dialogue_data.js = every line of tools/dialogue_lines.mjs with its clip length and priority, and
//      no audio: the game fetches a mission's clips when the mission loads (js/radio.js), so the page itself stays small.
//      tools/build.mjs copies assets/dialogue/*.mp3 next to the built page.
//
// Priorities (js/radio.js): 'plot' lines are always queued and never dropped; 'flavor' lines wait for a quiet channel
// and are dropped when their phase ends first. Head lines (no after/with) are flavor when the WSO says them on start,
// phase start, phase clear or first kill, and plot otherwise; a chained line takes its head line's priority. MUSIC
// rows are 'cue' (never dropped). Pool, tunnel and death lines are scheduled by js/radio.js itself.
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { measure, takeScore } from './voice_measure.mjs';
import { DIALOGUE_LINES } from './dialogue_lines.mjs';
import { DIALOGUE_VOICES, WSO_TTS, MAINSPRING_TTS } from './dialogue_voices.mjs';
import { voiceChain, duration } from './voice_chain.mjs';
import { AWACS_VOICE } from './awacs_lines.mjs';

const RETRIM = process.argv.includes('--retrim');
const RAW = 'assets/dialogue/raw', OUT = 'assets/dialogue', JS = 'js/dialogue_data.js';
const STD = voiceChain({ kbps: 48, rate: 24000, lufs: -18, tempo: AWACS_VOICE.tempo });
const WSO = voiceChain({ kbps: 48, rate: 24000, lufs: -18, tempo: WSO_TTS.tempo, maxGap: WSO_TTS.maxGap });
const MS = voiceChain({ kbps: 48, rate: 24000, lufs: -18, tempo: MAINSPRING_TTS.tempo, maxGap: MAINSPRING_TTS.maxGap });
const TAKES_DIR = 'assets/voice_audition/wso_takes', PICKS = 'tools/dialogue_takes.json';
const picks = existsSync(PICKS) ? JSON.parse(readFileSync(PICKS, 'utf8')) : {};
const rawFiles = existsSync(RAW) ? readdirSync(RAW) : [];
mkdirSync(OUT, { recursive: true });

const byId = Object.fromEntries(DIALOGUE_LINES.map((l) => [l.id, l]));
const FLAVOR_ON = new Set(['start', 'phase', 'clear', 'firstKill']);
function priority(l, depth = 0) {
  if (l.music) return 'cue';
  const t = l.trigger, head = t.after || t.with || t.fallbackFor;
  if (head && byId[head] && depth < 20) { const p = priority(byId[head], depth + 1); return p === 'cue' ? 'plot' : p; }
  if (t.on === 'pool' || t.on === 'deathMainspring' || /^tunnel/.test(t.on)) return 'critical';
  return l.speaker === 'WSO' && FLAVOR_ON.has(t.on) ? 'flavor' : 'plot';
}

let trimmed = 0, bytes = 0, seconds = 0;
const out = [];
for (const l of DIALOGUE_LINES) {
  const e = { id: l.id, speaker: l.speaker, pri: priority(l), ...l.trigger };
  if (l.mission) e.mission = l.mission;
  if (l.gate) e.gate = l.gate;
  if (l.music) { e.music = l.music; out.push(e); continue; }
  const raw = `${RAW}/${l.id}.mp3`, mp3 = `${OUT}/${l.id}.mp3`, chain = l.speaker === 'WSO' ? WSO : l.speaker === 'MAINSPRING' && l.id !== 'typical' ? MS : STD;   // ("Typical." is a first-batch take)
  const src = picks[l.id] && picks[l.id].source;   // a take picked from an audition round, shipped as processed there
  if (src) { if (!existsSync(src)) throw new Error(`${l.id}: missing ${src}`); copyFileSync(src, mp3); }
  const takes = src ? [] : rawFiles.filter((f) => f.startsWith(l.id + '_t') && /_t\d+\.mp3$/.test(f) && f.slice(l.id.length + 2, -4).match(/^\d+$/)).sort();
  if (takes.length && (RETRIM || !existsSync(mp3) || !picks[l.id] || picks[l.id].takes.length !== takes.length)) {
    mkdirSync(TAKES_DIR, { recursive: true });
    const scored = takes.map((f) => {
      const k = Number(f.slice(l.id.length + 2, -4)), out = `${TAKES_DIR}/${l.id}_t${k}.mp3`;
      chain.trim(`${RAW}/${f}`, out); trimmed++;
      const m = measure(`${RAW}/${f}`, l.text);
      return { k, rate: +m.rate.toFixed(2), artic: +m.artic.toFixed(2), maxPause: m.maxPause, score: +takeScore(m).toFixed(2) };
    });
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    copyFileSync(`${TAKES_DIR}/${l.id}_t${best.k}.mp3`, mp3);
    picks[l.id] = { pick: best.k, takes: scored };
    console.log(`  takes ${l.id.padEnd(11)} ${scored.map((t) => `t${t.k} ${t.rate} syl/s ${t.maxPause} ms`).join(' | ')} -> t${best.k}`);
  } else if (!src && !takes.length && (RETRIM || !existsSync(mp3))) {
    if (!existsSync(raw)) throw new Error(`missing ${raw} (generate it with tools/gen_dialogue_tts.mjs)`);
    const { I, gain } = chain.trim(raw, mp3); trimmed++;
    console.log(`  trim ${l.id.padEnd(10)} ${I.toFixed(1)} LUFS -> gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB, ${duration(mp3).toFixed(2)} s`);
  }
  const dur = Math.round(duration(mp3) * 1000) / 1000;
  bytes += statSync(mp3).size; seconds += dur;
  e.text = l.text; e.dur = dur;
  out.push(e);
}

const voiced = out.filter((e) => !e.music);
let js = `// js/dialogue_data.js — GENERATED by tools/build_dialogue.mjs from tools/dialogue_lines.mjs. Do not edit.\n`;
js += `// Story dialogue: ${voiced.length} lines, ${seconds.toFixed(1)} s, clips in assets/dialogue/<id>.mp3 (MP3 mono 48 kbps 24 kHz,\n`;
js += `// fetched per mission by js/radio.js). Voices: AWACS ${DIALOGUE_VOICES.AWACS.voice}, WSO ${DIALOGUE_VOICES.WSO.catalog}, MAINSPRING ${DIALOGUE_VOICES.MAINSPRING.voice}.\n`;
js += `// Entry: { id, speaker, pri: plot | flavor | critical | cue, on?, n?, key?, after?, with?, hold?, mission?, gate?, text?, dur?, music? }\n`;
js += `export const DIALOGUE_PATH = 'assets/dialogue/';\n`;
js += `export const DIALOGUE = [\n`;
for (const e of out) js += `  ${JSON.stringify(e)},\n`;
js += `];\n`;
writeFileSync(JS, js);
writeFileSync(PICKS, JSON.stringify(Object.fromEntries(Object.entries(picks).filter(([id]) => out.some((e) => e.id === id)).sort()), null, 1) + '\n');
console.log(`${trimmed ? `trimmed ${trimmed} clip(s); ` : ''}${voiced.length} clips, ${seconds.toFixed(1)} s, ${(bytes / 1024).toFixed(1)} KB of MP3; ${JS} ${(js.length / 1024).toFixed(1)} KB`);
const counts = {}; for (const e of out) counts[e.pri] = (counts[e.pri] || 0) + 1;
console.log('priorities: ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
