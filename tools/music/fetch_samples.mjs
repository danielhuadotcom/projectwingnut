// Downloads the subset of VSCO 2 Community Edition (CC0, Versilian Studios) samples used by the score.
// usage: node tools/music/fetch_samples.mjs            (prints plan)
//        node tools/music/fetch_samples.mjs --download (downloads missing files with curl, 8 in parallel)
// Downloads are treated as data only: WAV files are parsed by our own reader, nothing in them is executed.
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, 'downloads', 'vsco2ce');
const TREE = join(DEST, '_tree.json'); // GitHub git tree listing of sgossner/VSCO-2-CE@master
const RAW = 'https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/';

// [folder, optional filename regex]
const WANT = [
  ['Strings/Violin Section/susVib'], ['Strings/Violin Section/Spic'], ['Strings/Violin Section/Trem'], ['Strings/Violin Section/Pizz'],
  ['Strings/Viola Section/susvib'], ['Strings/Viola Section/spic'], ['Strings/Viola Section/trem'],
  ['Strings/Cello Section/susvib'], ['Strings/Cello Section/spic'], ['Strings/Cello Section/trem'], ['Strings/Cello Section/pizzT'],
  ['Strings/Solo Contrabass/SusVib'], ['Strings/Solo Contrabass/SusNV'], ['Strings/Solo Contrabass/Spic'], ['Strings/Solo Contrabass/Pizz'],
  ['Strings/Harp'],
  ['Brass/F Horn/sus'], ['Brass/F Horn/stac'], ['Brass/Trumpet/sus'], ['Brass/Trumpet/stac'],
  ['Brass/Tenor Trombone/sus'], ['Brass/Tenor Trombone/stac'], ['Brass/Tuba/sus'], ['Brass/Tuba/stac'],
  ['Percussion/Timpani'], ['Percussion/Timpani/Rolls'],
  ['Percussion', /^(BDrumNewhit|susCymb1-|cymbal-crash1_|gongHit_|Snare2-roll|Snare2-Hit|Triangle3-Hit_|Tamb1-Roll)/],
  ['VSCO 1 Percussion/drums/bass'], ['VSCO 1 Percussion/varMetal/Cymbals/susp'],
  ['VSCO 1 Percussion/drums/other/ethnic/giant'], ['VSCO 1 Percussion/drums/other/ethnic/giant/hand'],
  ['VSCO 1 Percussion/drums/other/ethnic/giant/mallet'], ['VSCO 1 Percussion/drums/other/ethnic/giant/sticks'],
  ['VSCO 1 Percussion/drums/tenor/tenor_lower'],
  ['Woodwinds/Flute/susvib'], ['Woodwinds/Flute/stac'], ['Woodwinds/Piccolo/Sus'], ['Woodwinds/Oboe/Vib'],
  // audition pieces (score_mainspring.mjs): clockwork percussion, muted horn, bassoon, contrabass tremolo
  ['Strings/Solo Contrabass/Trem'], ['Brass/F Horn/mute'], ['Woodwinds/Bassoon/sus'],
  ['Percussion/Glock'],
  ['Percussion', /^(TB_hit_|Claves1_Hit_|Ratchet1-Crank_|Anvil_Hit1_|BrakeDrum1_Hammer_|gongscrape_)/],
  ['VSCO 1 Percussion/varWood', /^wood_click/],
];

const tree = JSON.parse(readFileSync(TREE, 'utf8')).tree.filter((x) => x.type === 'blob' && /\.wav$/i.test(x.path));
const files = [];
for (const [folder, re] of WANT) {
  for (const x of tree) {
    const i = x.path.lastIndexOf('/');
    if (x.path.slice(0, i) !== folder) continue;
    if (re && !re.test(x.path.slice(i + 1))) continue;
    files.push(x);
  }
}
const total = files.reduce((s, x) => s + x.size, 0);
const missing = files.filter((x) => { const p = join(DEST, x.path); return !existsSync(p) || statSync(p).size !== x.size; });
console.log(`${files.length} files, ${(total / 1e6).toFixed(0)} MB total; missing ${missing.length} (${(missing.reduce((s, x) => s + x.size, 0) / 1e6).toFixed(0)} MB)`);
if (!process.argv.includes('--download')) process.exit(0);

let next = 0, done = 0, failed = 0;
function worker() {
  return new Promise((resolve) => {
    const step = () => {
      if (next >= missing.length) return resolve();
      const x = missing[next++];
      const out = join(DEST, x.path);
      mkdirSync(dirname(out), { recursive: true });
      const url = RAW + x.path.split('/').map(encodeURIComponent).join('/');
      const p = spawn('curl', ['-sS', '-f', '-L', '--retry', '4', '--retry-delay', '2', '-o', out, url], { stdio: ['ignore', 'ignore', 'inherit'] });
      p.on('close', (code) => {
        done++; if (code !== 0 || !existsSync(out) || statSync(out).size !== x.size) { failed++; console.log(`FAILED ${x.path}`); }
        if (done % 50 === 0) console.log(`${done}/${missing.length}`);
        step();
      });
    };
    step();
  });
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`downloaded ${done - failed}, failed ${failed}`);
