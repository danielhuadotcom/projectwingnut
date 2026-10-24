// Extra VSCO 2 CE (CC0) articulations for the audition pieces (score_mainspring.mjs): instruments that have no SFZ
// mapping in the library (glockenspiel, tubular bells, muted horn, bassoon) are mapped from their file names, with the
// octave conventions checked against the recordings (FFT of each sample: glockenspiel and bassoon files are named one
// octave below sounding pitch; the muted-horn file names are unreliable, so its keys are the measured pitches).
// Unpitched clockwork percussion (wood clicks, claves, ratchet, brake drum, gong scrape) is built as one-shots.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Articulation } from './sampler.mjs';

const PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const sci = (name, oct) => 12 * (+oct + 1) + PC[name];
const MUTED_HORN = { 'A#1': 58, C3: 60, 'D#2': 63, 'D#3': 63, F2: 65, 'G#3': 68, 'A#3': 70, D4: 74, F4: 77 };
const PITCHED = [
  // [folder, file regex (note name, octave), key from match]
  ['Percussion/Glock', /^glock_medium_([A-G]#?)(-?\d)\.wav$/, (m) => sci(m[1], m[2]) + 12],
  ['Woodwinds/Bassoon/sus', /^PSBassoon_([A-G]#?)(-?\d)_v\d_1\.wav$/, (m) => sci(m[1], m[2]) + 12],
  ['Brass/F Horn/mute', /^MOHorn_mute_([A-G]#?)(-?\d)_v\d_1\.wav$/, (m) => MUTED_HORN[m[1] + m[2]]],
  ['Percussion', /^TB_hit_([A-G]#?)(-?\d)_v\d_rr1\.wav$/, (m) => sci(m[1], m[2])],
  ['Strings/Solo Violin/Arco Vib', /^LLVln_ArcoVib_([A-G]#?)(-?\d)_[pf]\.wav$/, (m) => sci(m[1], m[2])],
];

/** Expected MIDI key of a sample (path relative to downloads/vsco2ce) when the library has no SFZ for it; for
 *  analyze.mjs, so tuning gets measured. Tubular bells are left out: their strike tone is virtual (inharmonic partials). */
export function namedKey(rel) {
  for (const [folder, re, key] of PITCHED) {
    if (folder === 'Percussion' || !rel.startsWith(folder + '/')) continue;
    const m = re.exec(rel.slice(folder.length + 1));
    if (m) return key(m);
  }
  return undefined;
}

/** Key-split regions from [{sample, key}]: each key spans halfway to its neighbours; recordings of the same key become
 *  dynamic layers ordered by their analysed loudness. */
function pitchedRegions(bank, files) {
  const keys = [...new Set(files.map((f) => f.key))].sort((a, b) => a - b);
  const regs = [];
  keys.forEach((k, i) => {
    const lokey = i === 0 ? 0 : Math.floor((keys[i - 1] + k) / 2) + 1, hikey = i === keys.length - 1 ? 127 : Math.floor((k + keys[i + 1]) / 2);
    const same = files.filter((f) => f.key === k).sort((a, b) => (bank.analysis[a.sample]?.bodyDb ?? 0) - (bank.analysis[b.sample]?.bodyDb ?? 0));
    same.forEach((f, li) => {
      const lo = Math.round((li / same.length) * 127), hi = Math.round(((li + 1) / same.length) * 127) - (li + 1 < same.length ? 1 : 0);
      regs.push({ sample: f.sample, lokey, hikey, key: k, lovel: lo, hivel: hi, volume: 0, tune: 0, seqLength: 1, seqPosition: 1, offset: 0 });
    });
  });
  return regs;
}

export function extendOrchestra(A, bank, sfzDir) {
  const list = (folder, re) => readdirSync(join(bank.root, folder)).filter((f) => re.test(f)).sort();
  const pitched = (name, idx, opts) => {
    const [folder, re, key] = PITCHED[idx];
    const files = list(folder, re).map((f) => ({ sample: `${folder}/${f}`, key: key(re.exec(f)) })).filter((f) => Number.isFinite(f.key));
    A[name] = new Articulation(bank, name, pitchedRegions(bank, files), opts);
  };
  pitched('glock', 0, { kind: 'short', dynRangeDb: 24, advanceMax: 0.002, ring: 2.6, release: 1.4 });
  A.glock.singleLayerDarken = 2.2; // one recording per bar: soften the top end at low dynamics
  pitched('bsnSus', 1, { kind: 'sus', advanceMax: 0.06 });
  pitched('hnMute', 2, { kind: 'sus', advanceMax: 0.05 });
  pitched('tubBell', 3, { kind: 'short', dynRangeDb: 20, advanceMax: 0.002, ring: 4.5, release: 2.5 });
  A.tubBell.singleLayerDarken = 1.6;
  pitched('vlnSolo', 4, { kind: 'sus', advanceMax: 0.09, advanceK: 0.45 });
  A.cbTrem = Articulation.fromSfz(bank, 'cbTrem', join(sfzDir, 'ContrabassTrem.sfz'), { kind: 'sus', advanceMax: 0.07 });

  const oneShot = (name, files, opts = {}) => { // files: [[path, layer, rr, rrCount]]
    const layers = [...new Set(files.map((f) => f[1]))].sort((a, b) => a - b);
    const regs = files.map(([p, layer, rr, rrCount]) => {
      const li = layers.indexOf(layer), n = layers.length;
      const lo = Math.round((li / n) * 127), hi = Math.round(((li + 1) / n) * 127) - (li + 1 < n ? 1 : 0);
      return { sample: p, lokey: 0, hikey: 127, key: 60, lovel: lo, hivel: hi, volume: 0, tune: 0, seqLength: rrCount || 1, seqPosition: rr || 1, offset: 0 };
    });
    A[name] = new Articulation(bank, name, regs, { kind: 'short', dynRangeDb: 24, advanceMax: 0.002, ...opts });
  };
  const W = 'VSCO 1 Percussion/varWood/wood_click';
  oneShot('woodTick', [[W + '_pp_1.wav', 0, 1, 3], [W + '_pp_2.wav', 0, 2, 3], [W + '_pp_3.wav', 0, 3, 3], [W + '_mp.wav', 1], [W + '3.wav', 2],
    [W + '_f.wav', 3, 1, 2], [W + '_f2.wav', 3, 2, 2], [W + '_ff_2.wav', 4, 1, 2], [W + '3_loud.wav', 4, 2, 2]], { ring: 0.3, release: 0.15, dynRangeDb: 20 });
  oneShot('claves', [1, 2, 3].flatMap((v) => [1, 2].map((r) => [`Percussion/Claves1_Hit_v${v}_rr${r}_Sum.wav`, v, r, 2])), { ring: 0.35, release: 0.2 });
  oneShot('ratchet', [1, 2].map((r) => [`Percussion/Ratchet1-Crank_v1_rr${r}_Sum.wav`, 0, r, 2]), { ring: 1.2, release: 0.3 });
  oneShot('brake', [1, 2, 3].map((v) => [`Percussion/BrakeDrum1_Hammer_v${v}_Sum.wav`, v]), { ring: 1.0, release: 0.5 });
  oneShot('anvil', [1, 2, 3].map((v) => [`Percussion/Anvil_Hit1_v${v}_Sum.wav`, v]), { ring: 1.2, release: 0.6 });
  oneShot('gongScrape', [['Percussion/gongscrape_pp.wav', 0], ['Percussion/gongscrape_mf.wav', 1]], { ring: 5, release: 2, dynRangeDb: 18 });
  return A;
}
