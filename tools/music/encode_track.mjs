#!/usr/bin/env node
// tools/music/encode_track.mjs — encode a rendered master into a shipped soundtrack track, the same formats as
// "Ceiling Unlimited" (tools/music/render.mjs): Ogg Opus 96 kbps (primary) and MP3 128 kbps (fallback for browsers that
// cannot decode Opus), plus a .json with title, bpm and loop points for tools/music/build.mjs.
//   assets/music/<name>.opus | .mp3 | .json
// Called by render_mainspring.mjs and render_night.mjs after their render; also runs standalone on an existing render:
//   node tools/music/encode_track.mjs <name> [<render>]   (reads tools/music/out/<render>.wav and .json; render = name)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '..', 'assets', 'music');

/** wavPath: float master; meta: { title, bpm, loopStart, loopEnd, duration, sampleRate, lufs? }. Returns the shipped meta. */
export function encodeTrack(name, wavPath, meta) {
  const ff = (a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
  const opus = join(ASSETS, `${name}.opus`), mp3 = join(ASSETS, `${name}.mp3`);
  ff(['-i', wavPath, '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', '96k', '-vbr', 'constrained', '-compression_level', '10', '-application', 'audio', '-frame_duration', '20', '-metadata', `title=${meta.title}`, opus]);
  ff(['-i', wavPath, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', String(meta.sampleRate || 48000), '-metadata', `title=${meta.title}`, mp3]);
  const out = { title: meta.title, bpm: meta.bpm, loopStart: meta.loopStart, loopEnd: meta.loopEnd, duration: meta.duration, sampleRate: meta.sampleRate,
    lufs: meta.lufs, sections: meta.sections, files: { opus: { bytes: statSync(opus).size, kbps: 96 }, mp3: { bytes: statSync(mp3).size, kbps: 128 } } };
  writeFileSync(join(ASSETS, `${name}.json`), JSON.stringify(out, null, 2));
  console.log(`encoded ${name}: opus ${(out.files.opus.bytes / 1024).toFixed(0)} KB, mp3 ${(out.files.mp3.bytes / 1024).toFixed(0)} KB -> assets/music/${name}.*`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const name = process.argv[2], render = process.argv[3] || name;
  if (!name) { console.error('usage: node tools/music/encode_track.mjs <name> [<render>]'); process.exit(1); }
  const meta = JSON.parse(readFileSync(join(HERE, 'out', `${render}.json`), 'utf8'));
  encodeTrack(name, join(HERE, 'out', `${render}.wav`), meta);
}
