// Analyse every downloaded VSCO sample once: onset, attack ("speak") time, loudness, usable length and, for pitched
// samples, the real fundamental (restricted-range YIN) so the sampler can correct tuning to the cent.
// Output: tools/music/out/analysis.json  (keyed by path relative to downloads/vsco2ce)
import { readdirSync, statSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './lib/wav.mjs';
import { parseSfz } from './lib/sfz.mjs';
import { analyzeSample } from './lib/analysis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'downloads', 'vsco2ce');
const SFZ = join(HERE, 'downloads', 'vsco2ce-sfz');
const OUT = join(HERE, 'out', 'analysis.json');
const VERSION = 4;

const keyOf = new Map();
for (const f of readdirSync(SFZ)) {
  if (!f.endsWith('.sfz') || /Timpani|Perc/.test(f)) continue;
  for (const r of parseSfz(join(SFZ, f))) keyOf.set(r.sample, r.key + r.tune / 100);
}
function walk(d, acc = []) {
  for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, acc); else if (/\.wav$/i.test(n)) acc.push(p); }
  return acc;
}
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const res = {}; let n = 0;
for (const p of walk(ROOT)) {
  const rel = relative(ROOT, p).split('\\').join('/');
  const bytes = statSync(p).size;
  if (prev[rel] && prev[rel].bytes === bytes && prev[rel].v === VERSION) { res[rel] = prev[rel]; continue; }
  let w; try { w = readWav(p); } catch (e) { console.log('skip', rel, e.message); continue; }
  const isShort = /spic|stac|pizz/i.test(rel) && !/sus/i.test(rel);
  res[rel] = { v: VERSION, bytes, ...analyzeSample(w.channels, w.sampleRate, keyOf.get(rel), isShort) };
  n++;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(res));
console.log(`analysis: ${Object.keys(res).length} samples (${n} new) -> ${OUT}`);
