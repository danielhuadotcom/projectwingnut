#!/usr/bin/env node
// tools/dialogue_from_draft.mjs — regenerate tools/dialogue_lines.mjs from DIALOGUE_DRAFT.md (the designer-approved
// script; local only, gitignored). The generated file is the checked-in source of truth for the voice pipeline
// (tools/gen_dialogue_tts.mjs, tools/build_dialogue.mjs, tools/dialogue_check.mjs).
//
// usage: node tools/dialogue_from_draft.mjs [--draft DIALOGUE_DRAFT.md] [--check]
//   --check: parse and report only, write nothing.
//
// Every script row becomes one entry with a stable id:
//   mission rows   m<NN>_<#>   (m11_6b: the row numbered 6b in M11)
//   death row      typical     ("Typical.", any mission while Mainspring is in the fight)
//   tunnel rows    tunnel_<n>  (T1..T3)
//   WSO pool rows  wso_<n>     (W1..W13), each with the AWACS event key it may replace
// Triggers are parsed from the draft's trigger column into { on, n?, after?, with? } (see TRIGGERS below). MUSIC rows
// become cues ({ music: { action, track?, fade } }) with no clip.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DRAFT = opt('--draft', 'DIALOGUE_DRAFT.md');
const CHECK = args.includes('--check');
const src = readFileSync(DRAFT, 'utf8');

// Per-line additions the draft states in prose rather than in its trigger column (kept here, next to the parser).
const EXTRA = {
  // M21: "Just you and me now" fires once her wingmen are down (on Mercenary she flies with four unmarked Q10s);
  // without wingmen it follows #3 at once.
  m21_4: { gate: 'alone' },
};

// Extra lock-on calls (not in the draft's table; the notes ask for a pool of 8 or more). Reviewed for LLM-isms.
const LOCK_EXTRA = ['Locked up!', 'Got tone— send it!', 'Gotcha— FIRE!', 'Good lock, good lock!', 'Hold it there— shoot!',
  "Painted 'em— your shot!", 'Hard lock— NOW!', 'Solid tone! Let it fly!'];
const rows = (block) => block.split('\n').filter((l) => /^\|\s*[^-|]/.test(l) && !/^\|\s*#\s*\|/.test(l))
  .map((l) => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
const sections = src.split(/\n(?=## )/);
const lines = [], problems = [];

function parseTrigger(t, mission) {
  let s = t.replace(/\(NEW\)/g, '').replace(/\([^)]*\)/g, '').trim();
  const tr = {};
  const m = s.match(/,?\s*after\s*#?\s*(\w+)\s*$/i);
  if (m) { tr.after = `m${mission}_${m[1]}`; s = s.slice(0, m.index).trim().replace(/,$/, ''); }
  const w = s.match(/^with\s*#?\s*(\w+)$/i);
  if (w) { tr.with = `m${mission}_${w[1]}`; s = ''; }
  if (!s) { if (!tr.after && !tr.with) problems.push(`M${mission}: empty trigger "${t}"`); return tr; }
  let k;
  if (s === 'start') tr.on = 'start';
  else if ((k = s.match(/^phase (\d+) start$/))) { tr.on = 'phase'; tr.n = +k[1]; }
  else if ((k = s.match(/^phase (\d+) clear$/))) { tr.on = 'clear'; tr.n = +k[1]; }
  else if (s === 'complete') tr.on = 'complete';
  else if (s === 'glassfall start') tr.on = 'glassfall';
  else if ((k = s.match(/^detonation (\d+)$/))) { tr.on = 'detonation'; tr.n = +k[1]; }
  else if (s === 'first kill') tr.on = 'firstKill';
  else if ((k = s.match(/^boss (\d+)%$/))) { tr.on = 'boss'; tr.n = +k[1]; }
  else problems.push(`M${mission}: unknown trigger "${t}"`);
  return tr;
}
function parseMusic(text) {
  // "→ MAINSPRING THEME (crossfade 1 s)", "→ CUT (silence, SFX and voice only)", "→ RESUME mission track (fade in 4 s)"
  const t = text.replace(/^→\s*/, '');
  const fade = +((t.match(/(\d+(?:\.\d+)?)\s*s\b/) || [])[1] ?? NaN);
  if (/^CUT/i.test(t)) return { action: 'cut', fade: Number.isFinite(fade) ? fade : 0.15 };
  if (/^RESUME/i.test(t)) return { action: 'resume', fade: Number.isFinite(fade) ? fade : 4 };
  const name = t.replace(/\(.*\)/, '').trim().toLowerCase().replace(/\s+theme$/, '').replace(/\s+track$/, '').replace(/\s+/g, '_');
  return { action: 'play', track: name, fade: Number.isFinite(fade) ? fade : 2 };
}

for (const sec of sections) {
  const head = sec.split('\n')[0];
  let mm;
  if ((mm = head.match(/^## M(\d+)\s+(.*)$/))) {
    const mission = String(+mm[1]).padStart(2, '0');
    for (const [num, trig, speaker, text, note = ''] of rows(sec)) {
      const id = `m${mission}_${num}`;
      const e = { id, mission: +mm[1], speaker: speaker.toUpperCase(), trigger: parseTrigger(trig, mission), text: '', note };
      if (e.speaker === 'MUSIC') e.music = parseMusic(text); else e.text = text;
      Object.assign(e, EXTRA[id] || {});
      lines.push(e);
    }
  } else if (/^## Any mission: death with Mainspring/.test(head)) {
    for (const [, , speaker, text, note = ''] of rows(sec)) lines.push({ id: 'typical', speaker: speaker.toUpperCase(), trigger: { on: 'deathMainspring' }, text, note });
  } else if (/^## Tunnel run/.test(head)) {
    const on = { T1: 'tunnelApproach', T2: 'tunnelEnter', T3: 'tunnelExit' };
    for (const [num, , speaker, text, note = ''] of rows(sec)) {
      if (!on[num]) { problems.push(`tunnel row ${num}`); continue; }
      lines.push({ id: `tunnel_${num.slice(1)}`, speaker: speaker.toUpperCase(), trigger: { on: on[num] }, text, note });
    }
  } else if (/^## AWACS fallbacks/.test(head)) {
    // AWACS versions of WSO-only story beats, played in their place when the WSO voice is off
    for (const [, repl, speaker, text, note = ''] of rows(sec)) {
      const head = lines.find((l) => l.id === repl);
      if (!head) { problems.push(`fallback for unknown line ${repl}`); continue; }
      lines.push({ id: `${repl}_awacs`, mission: head.mission, speaker: speaker.toUpperCase(), trigger: { fallbackFor: repl }, text, note });
    }
  } else if (/^## WSO tactical pool/.test(head)) {
    for (const [num, key, text, note = ''] of rows(sec)) lines.push({ id: `wso_${num.slice(1)}`, speaker: 'WSO', trigger: { on: 'pool', key: key.replace(/\s*\(.*$/, '').trim() }, text, note });
    // the lock-on pool needs 8+ variants (DIALOGUE_NOTES.md): extra calls in the same voice, screened by a copy reviewer
    LOCK_EXTRA.forEach((text, i) => lines.push({ id: `wso_lock_${i + 1}`, speaker: 'WSO', trigger: { on: 'pool', key: 'lockOn' }, text, note: 'combat, quick' }));
  }
}
// sanity: ids unique, after/with refer to existing rows
const ids = new Set();
for (const l of lines) { if (ids.has(l.id)) problems.push(`duplicate id ${l.id}`); ids.add(l.id); }
for (const l of lines) for (const k of ['after', 'with']) if (l.trigger[k] && !ids.has(l.trigger[k])) problems.push(`${l.id}: ${k} ${l.trigger[k]} not found`);
for (const l of lines) if (!l.music && !['AWACS', 'WSO', 'MAINSPRING'].includes(l.speaker)) problems.push(`${l.id}: unknown speaker ${l.speaker}`);

const voiced = lines.filter((l) => !l.music);
const by = (s) => voiced.filter((l) => l.speaker === s).length;
console.log(`${lines.length} rows: ${voiced.length} voiced (AWACS ${by('AWACS')}, WSO ${by('WSO')}, MAINSPRING ${by('MAINSPRING')}), ${lines.length - voiced.length} music cues; ${voiced.reduce((a, l) => a + l.text.length, 0)} characters`);
if (problems.length) { console.log('PROBLEMS:\n  ' + problems.join('\n  ')); process.exit(1); }
if (CHECK) process.exit(0);

let out = `// tools/dialogue_lines.mjs — GENERATED by tools/dialogue_from_draft.mjs from DIALOGUE_DRAFT.md (the approved script).\n`;
out += `// Do not edit by hand: edit the draft and regenerate. Shape: { id, speaker, trigger, text, note, mission?, music?, gate? }.\n`;
out += `//   trigger.on: start | phase (n) | clear (n) | complete | glassfall | detonation (n) | firstKill | boss (n = 50 / 25)\n`;
out += `//     | deathMainspring | tunnelApproach | tunnelEnter | tunnelExit | pool (key = the AWACS event it may replace);\n`;
out += `//   trigger.after / trigger.with: the id of the line this one queues behind / starts with. trigger.fallbackFor: the WSO\n`;
out += `//   line this AWACS line replaces when the WSO voice is off.\n`;
out += `//   music: a MUSIC cue (no clip): { action: play | cut | resume, track?, fade (s) }. gate 'alone': waits until only the\n`;
out += `//   boss is left alive.\n`;
out += `export const DIALOGUE_LINES = [\n`;
for (const l of lines) out += `  ${JSON.stringify(l)},\n`;
out += `];\n`;
writeFileSync('tools/dialogue_lines.mjs', out);
console.log('wrote tools/dialogue_lines.mjs');
