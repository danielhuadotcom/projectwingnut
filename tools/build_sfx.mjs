#!/usr/bin/env node
// PROJECT WINGNUT sound-effect pipeline.
//
//   node tools/build_sfx.mjs              process sources -> assets/sfx/*.ogg, then embed -> js/sfx_data.js
//   node tools/build_sfx.mjs --embed-only only re-embed the committed assets/sfx/*.ogg (no ffmpeg needed)
//   node tools/build_sfx.mjs --fetch      first download any missing raw sources into tools/sfx/downloads/
//   node tools/build_sfx.mjs --only=gun,engine   process just these sounds (embedding always covers all)
//
// Stage 1 (process) needs ffmpeg with libopus and the raw downloads in tools/sfx/downloads/<source-id>/ (untrusted
// data: they are only ever *read* as audio by ffmpeg, nothing in there is executed). Each sound is built from one or
// more source "layers" (segment, pitch, ffmpeg EQ/filters, gain, delay, envelope), mixed in float, trimmed, faded,
// loudness-normalised (BS.1770 K-weighted, peaks kept below -1 dBFS after encoding) and encoded as mono Ogg Opus.
// Loops get an equal-power crossfaded seam plus a periodic pre/post roll, so loopStart/loopEnd sit inside continuous
// audio no matter how a decoder handles Opus pre-skip or resampling.
// Stage 2 (embed) writes js/sfx_data.js:  export const SFX = { name: {data, gain, loop?, loopStart?, loopEnd?} | [variants] }
// assets/sfx/LICENSES.md is regenerated from the SOURCES table below.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DL = join(ROOT, 'tools/sfx/downloads');
const OUT = join(ROOT, 'assets/sfx');
const JS_OUT = join(ROOT, 'js/sfx_data.js');
const SR = 48000;
const PEAK_CEILING_DB = -1.2;   // max sample peak of the *decoded* Opus file (spec: below -1 dBFS)

// ---------------------------------------------------------------------------------------------------------------------
// Sources (every file that contributes to a shipped sound). `file` is relative to tools/sfx/downloads/.
// ---------------------------------------------------------------------------------------------------------------------
const CC0 = { license: 'CC0 1.0 (public domain dedication)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
const SOURCES = {
  edr401: {
    title: 'ED-R 401 MVPA North East » 8-6-16 9-34 bis 10-02 (Eurofighter Typhoon flight noise, field recording)',
    author: 'editoredr401 (freesound.org/people/editoredr401)', ...CC0,
    page: 'https://commons.wikimedia.org/wiki/File:ED-R_401_MVPA_North_East_%C2%BB_8-6-16_9-34_bis_10-02.flac',
    origin: 'https://freesound.org/people/editoredr401/sounds/349898/',
    url: 'https://upload.wikimedia.org/wikipedia/commons/d/d7/ED-R_401_MVPA_North_East_%C2%BB_8-6-16_9-34_bis_10-02.flac',
    file: 'commons_edr401_eurofighter/EDR401_MVPA_North_East_8-6-16.flac',
  },
  draken: {
    title: 'Saab J35D Draken – start engine and taxiing',
    author: 'Work With Sounds / Torsten Nilsson (provided to Wikimedia Commons with Wikimedia Sverige)',
    license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: true,
    page: 'https://commons.wikimedia.org/wiki/File:WWS_SaabJ35DDrakenstartengineandtaxiing.ogg',
    url: 'https://upload.wikimedia.org/wikipedia/commons/4/49/WWS_SaabJ35DDrakenstartengineandtaxiing.ogg',
    file: 'commons_wws_draken_taxi/WWS_SaabJ35DDrakenstartengineandtaxiing.ogg',
  },
  cf18: {
    title: 'Canadian CF 18 maneuvers (Quinte International Air Show, CFB Trenton, 2016)',
    author: 'lonemonk (freesound.org/people/lonemonk)',
    license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/', attribution: true,
    page: 'https://commons.wikimedia.org/wiki/File:Canadian_CF_18_maneuvers.wav',
    origin: 'https://freesound.org/people/lonemonk/sounds/349715/',
    url: 'https://upload.wikimedia.org/wikipedia/commons/1/1c/Canadian_CF_18_maneuvers.wav',
    file: 'commons_lonemonk_cf18/Canadian_CF_18_maneuvers.wav',
  },
  rdBang: {
    title: '25 CC0 bang / firework SFX (files used: shot_01, shot_03, bang_06, fw_06)',
    author: 'rubberduck (opengameart.org/users/rubberduck)', ...CC0,
    page: 'https://opengameart.org/content/25-cc0-bang-firework-sfx',
    url: 'https://opengameart.org/sites/default/files/25-CC0-bang-sfx.zip', zip: true,
    file: 'oga_rubberduck_bang/shot_01.ogg',
  },
  chunky: {
    title: 'Chunky Explosion', author: 'Joth (opengameart.org/users/joth)', ...CC0,
    page: 'https://opengameart.org/content/chunky-explosion',
    url: 'https://opengameart.org/sites/default/files/Chunky%20Explosion.mp3',
    file: 'oga_joth_chunky/Chunky_Explosion.mp3',
  },
  battleSea: {
    title: 'Battle at sea (file used: cannon_fire_1.ogg)', author: 'Thimras (opengameart.org/users/thimras)', ...CC0,
    page: 'https://opengameart.org/content/battle-at-sea',
    url: 'https://opengameart.org/sites/default/files/cannon_fire_1.ogg',
    file: 'oga_thimras_battle_at_sea/cannon_fire_1.ogg',
  },
  kenneyScifi: {
    title: 'Kenney Sci-Fi Sounds 1.0 (file used: thrusterFire_001.ogg)', author: 'Kenney (www.kenney.nl)', ...CC0,
    page: 'https://kenney.nl/assets/sci-fi-sounds',
    url: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip', zip: true,
    file: 'kenney_scifi/Audio/thrusterFire_001.ogg',
  },
  kenneyImpact: {
    title: 'Kenney Impact Sounds 1.0 (files used: impactPlate_heavy_000/002, impactPlate_light_000/002)', author: 'Kenney (www.kenney.nl)', ...CC0,
    page: 'https://kenney.nl/assets/impact-sounds',
    url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', zip: true,
    file: 'kenney_impact/Audio/impactPlate_heavy_000.ogg',
  },
  bmacMetal: {
    title: 'Metal Impact Sounds (file used: thud3.wav)', author: 'Brian MacIntosh / BMacZero (opengameart.org/users/bmaczero)', ...CC0,
    page: 'https://opengameart.org/content/metal-impact-sounds',
    url: 'https://opengameart.org/sites/default/files/thud3.wav',
    file: 'oga_bmaczero_metal/thud3.wav',
  },
  flareIgn: {
    title: 'Flare ignition', author: 'qubodup (opengameart.org/users/qubodup)', ...CC0,
    page: 'https://opengameart.org/content/flare-ignition',
    url: 'https://opengameart.org/sites/default/files/ignition.flac',
    file: 'oga_qubodup_flare/ignition.flac',
  },
  haelYell: {
    title: 'Male Grunt/Yelling sounds (file used: yelling sounds/1yell4.wav)', author: 'HaelDB (opengameart.org/users/haeldb)',
    license: 'CC0 1.0 (dual-licensed OGA-BY 3.0 / CC0 on OpenGameArt; used under CC0)', licenseUrl: CC0.licenseUrl,
    page: 'https://opengameart.org/content/male-gruntyelling-sounds',
    url: 'https://opengameart.org/sites/default/files/yelling%20sounds.zip', zip: true,
    file: 'oga_haeldb_yelling/yelling sounds/1yell4.wav',
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Sound recipes. Layer fields: src (SOURCES key), file (override path), ss/t (segment, s), pitch (resample factor),
// af (ffmpeg filters, applied after resampling to 48 kHz mono), gain (dB), delay (s), env ([[t, dB], ...] linear in dB).
// Variant fields: kbps, maxDur, trim (lead-in threshold dB below peak, or false), fadeIn/fadeOut (s),
// loudness ({ mode: 'momentary'|'integrated', target: LUFS }), post (ffmpeg filters on the mix), loop ({len, xfade, pad}).
// `gain` on a sound is the runtime mixing level written into js/sfx_data.js (AudioFX multiplies by it).
// ---------------------------------------------------------------------------------------------------------------------
const BASS_ROAR = 'equalizer=f=95:t=q:w=0.9:g=4';               // low end of the turbofan roar
const SOUNDS = [
  // --- engine: three seamless loops, all bass-dominated with almost nothing above ~2 kHz (no hiss/static).
  //     Deep Eurofighter turbofan roar (main), Draken turbine body (1-4 kHz whine cut, sits under the roar), CF-18
  //     full-power roar low-passed into a deep afterburner thunder.
  { name: 'engine', gain: 1, variants: [{
    out: 'engine_roar', kbps: 96, loop: { len: 3.0, xfade: 0.6, pad: 0.12, flatten: 0.5 }, loudness: { mode: 'integrated', target: -17 },
    layers: [{ src: 'edr401', ss: 228.4, t: 4.2, af: `highpass=f=22,lowpass=f=1400,lowpass=f=1700,lowpass=f=2000,${BASS_ROAR},lowshelf=f=140:g=3` }],
  }] },
  { name: 'engine_turbine', gain: 1, variants: [{
    out: 'engine_turbine', kbps: 64, loop: { len: 3.0, xfade: 0.6, pad: 0.12, flatten: 0.5 }, loudness: { mode: 'integrated', target: -20 },
    layers: [{ src: 'draken', ss: 109.6, t: 4.2,
      af: 'highpass=f=55,lowshelf=f=160:g=5,equalizer=f=1800:t=o:w=1.6:g=-9,lowpass=f=1700,lowpass=f=1900,lowpass=f=2200' }],
  }] },
  { name: 'afterburner', gain: 1, variants: [{
    out: 'afterburner', kbps: 64, loop: { len: 3.0, xfade: 0.6, pad: 0.12, flatten: 0.5 }, loudness: { mode: 'integrated', target: -17 },
    layers: [{ src: 'cf18', ss: 8.0, t: 4.2,
      af: 'highpass=f=24,lowshelf=f=120:g=8,equalizer=f=60:t=q:w=1:g=3,lowpass=f=1500,lowpass=f=1800,lowpass=f=2100' }],
  }] },

  // --- cannon: one punchy round per gunFire() (25 rds/s overlap into a burst). Two firework "shot" recordings,
  //     pitched down for calibre, low-mid weight added, tails kept short so rapid fire stays tight.
  { name: 'gun', gain: 0.55, variants: [
    { out: 'gun_a', kbps: 64, maxDur: 0.24, fadeOut: 0.12, trim: -36, loudness: { mode: 'momentary', target: -11 },
      layers: [{ src: 'rdBang', file: 'oga_rubberduck_bang/shot_01.ogg', pitch: 0.82, af: 'highpass=f=45,equalizer=f=130:t=q:w=1:g=5,lowpass=f=5500,lowpass=f=7000' }] },
    { out: 'gun_b', kbps: 64, maxDur: 0.24, fadeOut: 0.12, trim: -36, loudness: { mode: 'momentary', target: -11 },
      layers: [{ src: 'rdBang', file: 'oga_rubberduck_bang/shot_03.ogg', pitch: 0.76, af: 'highpass=f=45,equalizer=f=120:t=q:w=1:g=5,lowpass=f=5500,lowpass=f=7000' }] },
  ] },

  // --- missile launch: firework-rocket launch whoosh (pitched down) + Kenney rocket thruster roar + a low ignition thump.
  //     AudioFX sweeps a lowpass over it at runtime (receding motor).
  { name: 'missile', gain: 0.85, variants: [{
    out: 'missile', kbps: 64, maxDur: 1.9, fadeOut: 0.5, trim: -40, loudness: { mode: 'momentary', target: -12 },
    layers: [
      { src: 'rdBang', file: 'oga_rubberduck_bang/fw_06.ogg', pitch: 0.8, af: 'highpass=f=80,lowpass=f=6500,lowpass=f=8000', gain: 0 },
      { src: 'kenneyScifi', ss: 0.5, t: 2.2, af: 'highpass=f=40,lowpass=f=4500,lowpass=f=6000', gain: -4,
        env: [[0, -40], [0.03, 0], [0.35, -2], [1.0, -12], [1.9, -40]] },
      { src: 'battleSea', t: 1.2, af: 'lowpass=f=220,lowpass=f=260', gain: -3, env: [[0, 0], [0.25, -6], [0.8, -40]] },
    ],
  }] },

  // --- explosions by distance class (AudioFX picks by distance and adds its own lowpass/attenuation/delay).
  { name: 'explosion', gain: 1, variants: [
    { out: 'explosion_near', kbps: 64, maxDur: 3.6, fadeOut: 1.4, trim: -40, loudness: { mode: 'momentary', target: -10 },
      layers: [{ src: 'chunky', af: 'highpass=f=28,lowshelf=f=90:g=3,lowpass=f=8000' }] },
    { out: 'explosion_mid', kbps: 56, maxDur: 2.8, fadeOut: 1.0, trim: -40, loudness: { mode: 'momentary', target: -11 },
      layers: [
        { src: 'rdBang', file: 'oga_rubberduck_bang/bang_06.ogg', pitch: 0.72, af: 'highpass=f=40,lowpass=f=5000,lowpass=f=6500' },
        { src: 'battleSea', af: 'lowpass=f=240,lowpass=f=300', gain: -5 },
      ] },
    { out: 'explosion_far', kbps: 48, maxDur: 3.6, fadeOut: 1.4, trim: -40, loudness: { mode: 'momentary', target: -12 },
      layers: [{ src: 'battleSea', af: 'highpass=f=24,lowpass=f=1200,lowpass=f=1500' }],
      post: 'aecho=in_gain=0.9:out_gain=0.75:delays=190|430:decays=0.32|0.2' },
  ] },

  // --- countermeasure flares: three ejection pops over a burning hiss.
  { name: 'flare', gain: 0.7, variants: [{
    out: 'flare', kbps: 56, maxDur: 1.2, fadeOut: 0.35, trim: -40, loudness: { mode: 'momentary', target: -14 },
    layers: [
      { src: 'rdBang', file: 'oga_rubberduck_bang/shot_03.ogg', pitch: 1.3, af: 'highpass=f=150,lowpass=f=4500', gain: 0, env: [[0, 0], [0.09, -30]] },
      { src: 'rdBang', file: 'oga_rubberduck_bang/shot_03.ogg', pitch: 1.42, af: 'highpass=f=150,lowpass=f=4500', gain: -2, delay: 0.115, env: [[0, 0], [0.09, -30]] },
      { src: 'rdBang', file: 'oga_rubberduck_bang/shot_03.ogg', pitch: 1.36, af: 'highpass=f=150,lowpass=f=4500', gain: -4, delay: 0.235, env: [[0, 0], [0.09, -30]] },
      { src: 'flareIgn', ss: 0.25, af: 'highpass=f=700,lowpass=f=4000,lowpass=f=5000', gain: -11, delay: 0.02, env: [[0, -30], [0.06, 0], [0.5, -3], [0.95, -40]] },
    ],
  }] },

  // --- player took a hit: heavy metal-plate impact on a dull thud.
  { name: 'hit', gain: 0.8, variants: [
    { out: 'hit_a', kbps: 56, maxDur: 0.6, fadeOut: 0.25, trim: -40, loudness: { mode: 'momentary', target: -12 },
      layers: [{ src: 'kenneyImpact', file: 'kenney_impact/Audio/impactPlate_heavy_000.ogg', pitch: 0.88, af: 'highpass=f=60' },
        { src: 'bmacMetal', pitch: 0.8, af: 'lowpass=f=1800', gain: -4 }] },
    { out: 'hit_b', kbps: 56, maxDur: 0.6, fadeOut: 0.25, trim: -40, loudness: { mode: 'momentary', target: -12 },
      layers: [{ src: 'kenneyImpact', file: 'kenney_impact/Audio/impactPlate_heavy_002.ogg', pitch: 0.84, af: 'highpass=f=60' },
        { src: 'bmacMetal', pitch: 0.74, af: 'lowpass=f=1600', gain: -4 }] },
  ] },

  // --- our bullets hitting something: short metallic tick.
  { name: 'impact', gain: 0.45, variants: [
    { out: 'impact_a', kbps: 48, maxDur: 0.16, fadeOut: 0.09, trim: -40, loudness: { mode: 'momentary', target: -14 },
      layers: [{ src: 'kenneyImpact', file: 'kenney_impact/Audio/impactPlate_light_000.ogg', pitch: 1.12, af: 'highpass=f=350,lowpass=f=7000' }] },
    { out: 'impact_b', kbps: 48, maxDur: 0.16, fadeOut: 0.09, trim: -40, loudness: { mode: 'momentary', target: -14 },
      layers: [{ src: 'kenneyImpact', file: 'kenney_impact/Audio/impactPlate_light_002.ogg', pitch: 1.2, af: 'highpass=f=350,lowpass=f=7000' }] },
  ] },

  // --- easter egg: Wilhelm-style scream. NOT the original 1951 recording (see LICENSES.md): a CC0 male scream,
  //     band-limited like a 1950s optical soundtrack.
  { name: 'wilhelm', gain: 0.9, variants: [{
    out: 'wilhelm', kbps: 48, maxDur: 0.95, fadeOut: 0.22, trim: -38, loudness: { mode: 'momentary', target: -13 },
    layers: [{ src: 'haelYell', pitch: 1.06, af: 'highpass=f=260,lowpass=f=5200,equalizer=f=1800:t=o:w=1:g=3' }],
  }] },
];

// ---------------------------------------------------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------------------------------------------------
function ffmpeg(args, input) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30 });
}
const toF32 = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const fromF32 = (x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-12));
const RS = 'aresample=48000:resampler=soxr:precision=28';

function decodeLayer(L) {
  const path = join(DL, L.file || SOURCES[L.src].file);
  if (!existsSync(path)) throw new Error(`missing source ${path} (run with --fetch)`);
  const args = [];
  if (L.ss) args.push('-ss', String(L.ss));
  if (L.t) args.push('-t', String(L.t));
  const f = [RS];
  if (L.pitch && L.pitch !== 1) f.push(`asetrate=${Math.round(SR * L.pitch)}`, RS);
  if (L.af) f.push(L.af);
  args.push('-i', path, '-ac', '1', '-af', f.join(','), '-ar', String(SR), '-f', 'f32le', 'pipe:1');
  let x = toF32(ffmpeg(args));
  if (L.env) x = applyEnv(x, L.env);
  if (L.gain) { const g = dbToLin(L.gain); for (let i = 0; i < x.length; i++) x[i] *= g; }
  return x;
}
function applyFilter(x, af) { return toF32(ffmpeg(['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-af', af, '-f', 'f32le', 'pipe:1'], fromF32(x))); }
function applyEnv(x, pts) { // piecewise-linear in dB; holds the last point
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR; let db = pts[pts.length - 1][1];
    for (let k = 0; k + 1 < pts.length; k++) if (t < pts[k + 1][0]) { const [t0, d0] = pts[k], [t1, d1] = pts[k + 1]; db = t <= t0 ? d0 : d0 + (d1 - d0) * (t - t0) / (t1 - t0); break; }
    y[i] = x[i] * dbToLin(db);
  }
  return y;
}
function mix(layers) {
  const parts = layers.map((L) => ({ x: decodeLayer(L), off: Math.round((L.delay || 0) * SR) }));
  const n = Math.max(...parts.map((p) => p.off + p.x.length));
  const y = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.x.length; i++) y[p.off + i] += p.x[i];
  return y;
}
function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; } return p; }
function trimLead(x, relDb, preroll = 0.002) {
  const thr = peakOf(x) * dbToLin(relDb);
  let i = 0; while (i < x.length && Math.abs(x[i]) < thr) i++;
  return x.subarray(Math.max(0, i - Math.round(preroll * SR)));
}
function trimTail(x, relDb, keep = 0.03) { // cut trailing near-silence (below relDb re. peak), keep a short margin
  const thr = peakOf(x) * dbToLin(relDb);
  let i = x.length - 1; while (i > 0 && Math.abs(x[i]) < thr) i--;
  return x.subarray(0, Math.min(x.length, i + 1 + Math.round(keep * SR)));
}
function fade(x, fin, fout) { // raised-cosine in, exponential-ish (cos^2) out
  const y = Float32Array.from(x), ni = Math.min(y.length, Math.round(fin * SR)), no = Math.min(y.length, Math.round(fout * SR));
  for (let i = 0; i < ni; i++) y[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / ni);
  for (let i = 0; i < no; i++) { const g = Math.cos(0.5 * Math.PI * (i + 1) / no); y[y.length - no + i] *= g * g; }
  return y;
}
// ITU-R BS.1770 K-weighting at 48 kHz, then momentary (400 ms) / integrated (ungated mean) loudness of a mono signal.
function kweight(x) {
  const st = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621]];
  let y = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of st) {
    const o = new Float64Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v; }
    y = o;
  }
  return y;
}
function loudness(x, mode) {
  const k = kweight(x);
  if (mode === 'integrated') { let s = 0; for (let i = 0; i < k.length; i++) s += k[i] * k[i]; return -0.691 + 10 * Math.log10(s / k.length + 1e-20); }
  const w = Math.round(0.4 * SR), hop = Math.round(0.1 * SR); let best = -Infinity;
  for (let a = 0; a + w <= Math.max(k.length, w); a += hop) {
    let s = 0; const b = Math.min(k.length, a + w); for (let i = a; i < b; i++) s += k[i] * k[i];
    best = Math.max(best, -0.691 + 10 * Math.log10(s / w + 1e-20));
  }
  return best;
}
function flatten(x, win, maxDb = 6) { // remove slow level drift (centred RMS over `win` s), keep fast texture
  const w = Math.max(1, Math.round(win * SR)), n = x.length, c = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i] * x[i];
  const env = new Float64Array(n); let mean = 0;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - (w >> 1)), b = Math.min(n, i + (w >> 1)); env[i] = Math.sqrt((c[b] - c[a]) / Math.max(1, b - a)) + 1e-9; mean += env[i]; }
  mean /= n; const lo = dbToLin(-maxDb), hi = dbToLin(maxDb), y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i] * Math.min(hi, Math.max(lo, mean / env[i]));
  return y;
}
function makeLoop(x, len, xf) { // seamless loop of `len` s; the tail after `len` is crossfaded onto the head
  const P = Math.round(len * SR), X = Math.round(xf * SR);
  if (x.length < P + X) throw new Error(`loop source too short (${x.length} < ${P + X})`);
  const y = new Float32Array(P);
  for (let i = 0; i < P; i++) {
    if (i < X) { const t = i / X; y[i] = x[i] * Math.sin(0.5 * Math.PI * t) + x[i + P] * Math.cos(0.5 * Math.PI * t); } else y[i] = x[i];
  }
  return y;
}
function encode(x, path, kbps) {
  ffmpeg(['-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on',
    '-compression_level', '10', '-application', 'audio', '-frame_duration', '20', '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'ogg', path], fromF32(x));
}
const decodeFile = (path) => toF32(ffmpeg(['-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1']));

function buildVariant(v) {
  let x = mix(v.layers);
  if (v.post) x = applyFilter(x, v.post);
  let loopInfo = null;
  if (v.loop) {
    if (v.loop.flatten) x = flatten(x, v.loop.flatten);
    const L = makeLoop(x, v.loop.len, v.loop.xfade), pad = Math.round(v.loop.pad * SR);
    let g = dbToLin(v.loudness.target - loudness(L, 'integrated'));
    const build = (gain) => { const P = L.length, y = new Float32Array(P + 2 * pad); for (let i = 0; i < y.length; i++) y[i] = L[((i - pad) % P + P) % P] * gain; return y; };
    x = build(g);
    loopInfo = { loopStart: pad / SR, loopEnd: (pad + L.length) / SR };
  } else {
    if (v.trim !== false) x = trimLead(x, v.trim ?? -40);
    if (v.maxDur) x = x.subarray(0, Math.min(x.length, Math.round(v.maxDur * SR)));
    x = trimTail(x, v.tailDb ?? -54);
    x = fade(x, v.fadeIn ?? 0.003, Math.min(v.fadeOut ?? 0.03, 0.6 * x.length / SR));
    const g = dbToLin(v.loudness.target - loudness(x, v.loudness.mode));
    x = x.map((s) => s * g);
  }
  // never let the pre-encode peak exceed the ceiling, then verify (and if needed correct) the decoded Opus peak
  const pre = linToDb(peakOf(x));
  if (pre > PEAK_CEILING_DB - 0.3) { const k = dbToLin(PEAK_CEILING_DB - 0.3 - pre); x = x.map((s) => s * k); }
  const path = join(OUT, `${v.out}.ogg`);
  for (let pass = 0; pass < 4; pass++) {
    encode(x, path, v.kbps);
    const d = decodeFile(path), pk = linToDb(peakOf(d));
    if (pk <= PEAK_CEILING_DB) {
      const lufs = loudness(loopInfo ? d.subarray(Math.round(loopInfo.loopStart * SR), Math.round(loopInfo.loopEnd * SR)) : d, loopInfo ? 'integrated' : (v.loudness.mode));
      return { ...loopInfo, peakDb: pk, lufs, dur: d.length / SR, bytes: readFileSync(path).length };
    }
    const k = dbToLin(PEAK_CEILING_DB - 0.15 - pk); x = x.map((s) => s * k);
  }
  throw new Error(`${v.out}: could not get decoded peak below ${PEAK_CEILING_DB} dBFS`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetch (optional): download missing sources with curl, unzip archives (rejecting absolute/.. paths).
// ---------------------------------------------------------------------------------------------------------------------
function fetchSources() {
  for (const [id, s] of Object.entries(SOURCES)) {
    const target = join(DL, s.file);
    if (existsSync(target)) continue;
    const dir = join(DL, s.file.split('/')[0]); mkdirSync(dir, { recursive: true });
    const dest = join(dir, s.zip ? 'source.zip' : basename(s.file));
    console.log(`fetch ${id}: ${s.url}`);
    execFileSync('curl', ['-sS', '-f', '-L', '-m', '900', '-A', 'ProjectWingnut-build_sfx', '-o', dest, s.url]);
    if (s.zip) {
      const names = execFileSync('unzip', ['-Z1', dest]).toString().split('\n').filter(Boolean);
      if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new Error(`unsafe paths in ${dest}`);
      execFileSync('unzip', ['-q', '-o', dest, '-d', dir]);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// LICENSES.md + js/sfx_data.js
// ---------------------------------------------------------------------------------------------------------------------
function writeLicenses(stats) {
  const used = (snd) => [...new Set(snd.variants.flatMap((v) => v.layers.map((l) => l.src)))];
  const lines = ['# PROJECT WINGNUT – sound effect sources and licenses', '',
    'Generated by `tools/build_sfx.mjs` (do not edit by hand; edit the SOURCES/SOUNDS tables there).', '',
    'All shipped sounds are embedded in `js/sfx_data.js` as base64 Ogg Opus (mono, 48 kHz). Every source below is',
    'either CC0 / public domain or CC BY (attribution required, redistribution in a game allowed). All shipped files are',
    'modified derivatives (trimmed, mixed, pitch-shifted, EQ\'d, loudness-normalised, looped, re-encoded).', '',
    '## Required attributions (CC BY)', ''];
  for (const s of Object.values(SOURCES).filter((s) => s.attribution)) lines.push(`- "${s.title}" by ${s.author}, ${s.license} (${s.licenseUrl}), ${s.page} – modified.`);
  lines.push('', '## Shipped files', '', '| file | used for | sources | size | duration |', '|---|---|---|---|---|');
  for (const snd of SOUNDS) for (const v of snd.variants) {
    const st = stats[v.out] || {};
    lines.push(`| \`assets/sfx/${v.out}.ogg\` | \`SFX.${snd.name}\` | ${[...new Set(v.layers.map((l) => l.src))].map((k) => `[${k}](#${k.toLowerCase()})`).join(', ')} | ${st.bytes ? (st.bytes / 1024).toFixed(1) + ' KB' : '?'} | ${st.dur ? st.dur.toFixed(2) + ' s' : '?'}${st.loopStart !== undefined ? ` (loop ${st.loopStart.toFixed(3)}–${st.loopEnd.toFixed(3)} s)` : ''} |`);
  }
  lines.push('', '## Sources', '');
  for (const [id, s] of Object.entries(SOURCES)) {
    const usedBy = SOUNDS.filter((snd) => used(snd).includes(id)).map((snd) => `\`${snd.name}\``).join(', ');
    lines.push(`### ${id}`, '', `- **Title:** ${s.title}`, `- **Author:** ${s.author}`, `- **License:** ${s.license} – ${s.licenseUrl}`,
      `- **Source page:** ${s.page}`, ...(s.origin ? [`- **Original upload:** ${s.origin}`] : []), `- **Downloaded from:** ${s.url}`,
      `- **Used in:** ${usedBy}`, '');
  }
  lines.push('## Wilhelm scream', '',
    'The original 1951 Warner Bros. recording ("Distant Drums", Sheb Wooley) is **not** shipped. Copies on Wikimedia Commons',
    'are tagged CC0 – the USC/Sunset Editorial digitisation (archive.org `SSE_Library_VOICES`) and Joseph Sardin\'s',
    '"Cri Wilhelm" (LaSonothèque) – but neither was released by the rights holder of the original recording, and pitch-track /',
    'cross-correlation analysis shows Sardin\'s file is the same 1951 performance (cleaned up), not a re-performance. Per the',
    'licensing brief, `SFX.wilhelm` is instead a clearly CC0 male scream (HaelDB, source `haelYell`) processed into a',
    'Wilhelm-style easter egg (slight pitch-up, 1950s-style band-limiting).', '');
  writeFileSync(join(OUT, 'LICENSES.md'), lines.join('\n'));
}

function embed(stats) {
  const meta = existsSync(join(OUT, 'sfx_meta.json')) ? JSON.parse(readFileSync(join(OUT, 'sfx_meta.json'), 'utf8')) : {};
  Object.assign(meta, stats);
  writeFileSync(join(OUT, 'sfx_meta.json'), JSON.stringify(meta, null, 1) + '\n');
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  let total = 0;
  const entries = SOUNDS.map((snd) => {
    const vs = snd.variants.map((v) => {
      const path = join(OUT, `${v.out}.ogg`);
      if (!existsSync(path)) throw new Error(`missing ${path}: run without --embed-only`);
      const b64 = readFileSync(path).toString('base64'); total += b64.length;
      const m = meta[v.out] || {};
      const fields = [`data: '${b64}'`, `gain: ${snd.gain}`];
      if (v.loop) fields.push('loop: true', `loopStart: ${r6(m.loopStart)}`, `loopEnd: ${r6(m.loopEnd)}`);
      return `{ ${fields.join(', ')} }`;
    });
    return `  ${snd.name}: ${vs.length === 1 && snd.variants[0].loop ? vs[0] : `[\n    ${vs.join(',\n    ')},\n  ]`},`;
  });
  const src = ['// GENERATED by tools/build_sfx.mjs from assets/sfx/*.ogg – do not edit by hand.',
    '// Sources, authors and licenses (incl. required CC BY attributions): assets/sfx/LICENSES.md',
    '// SFX[name] = { data: base64 Ogg Opus (mono 48 kHz), gain: runtime level, loop?, loopStart?/loopEnd? (s) }, or an array of variants.',
    'export const SFX = {', ...entries, '};', ''].join('\n');
  writeFileSync(JS_OUT, src);
  return { base64Bytes: total, jsBytes: Buffer.byteLength(src) };
}

// ---------------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });
if (argv.includes('--fetch')) fetchSources();
const stats = {};
if (!argv.includes('--embed-only')) {
  for (const snd of SOUNDS) {
    if (only.length && !only.includes(snd.name)) continue;
    for (const v of snd.variants) {
      const st = buildVariant(v); stats[v.out] = st;
      console.log(`${v.out.padEnd(16)} ${st.dur.toFixed(3).padStart(6)} s  ${(st.bytes / 1024).toFixed(1).padStart(6)} KB  peak ${st.peakDb.toFixed(2)} dBFS  ${v.loop ? 'LUFS(int)' : 'LUFS(M max)'} ${st.lufs.toFixed(1)}${v.loop ? `  loop ${st.loopStart.toFixed(4)}-${st.loopEnd.toFixed(4)} s` : ''}`);
    }
  }
}
const metaPath = join(OUT, 'sfx_meta.json');
const prev = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
const res = embed(stats);
writeLicenses({ ...prev, ...stats });
const oggBytes = readdirSync(OUT).filter((f) => f.endsWith('.ogg')).reduce((s, f) => s + readFileSync(join(OUT, f)).length, 0);
console.log(`assets/sfx/*.ogg total ${(oggBytes / 1024).toFixed(1)} KB; js/sfx_data.js ${(res.jsBytes / 1024).toFixed(1)} KB (base64 ${(res.base64Bytes / 1024).toFixed(1)} KB)`);
