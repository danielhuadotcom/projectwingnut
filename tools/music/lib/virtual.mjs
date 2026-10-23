// "Virtual" samples: formant-preserving re-pitches of real samples, cached as float WAVs in out/virtual/, used to
// fill holes in a library's key coverage. Regions are re-split so no note is shifted by more than ~2 semitones.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readWav, writeWav } from './wav.mjs';
import { formantShift } from './formant.mjs';
import { analyzeSample } from './analysis.mjs';

/**
 * regions: parsed SFZ regions. plan: [{ from: keycenter of source regions, to: new keycenter, lo, hi }]
 * trims: { [keycenter]: [lo, hi] } new ranges for existing regions.
 */
export function withVirtualRegions(bank, outDir, regions, plan, trims = {}, isShort = false) {
  const out = regions.map((r) => (trims[r.key] ? { ...r, lokey: trims[r.key][0], hikey: trims[r.key][1] } : r));
  for (const p of plan) {
    for (const r of regions.filter((x) => x.key === p.from)) {
      const semis = p.to - p.from;
      const rel = `virtual/${r.sample.replace(/\.wav$/i, '')}@${semis > 0 ? '+' : ''}${semis}.wav`;
      const abs = join(outDir, rel);
      if (!existsSync(abs)) {
        const w = readWav(join(bank.root, r.sample));
        const ch = w.channels.length > 1 ? w.channels : [w.channels[0], w.channels[0]];
        const f0 = 440 * Math.pow(2, (p.to - 69) / 12);
        const shifted = formantShift(ch, w.sampleRate, semis, f0);
        mkdirSync(dirname(abs), { recursive: true });
        writeWav(abs, shifted, w.sampleRate, { float: true });
        console.log(`  virtual sample ${rel}`);
      }
      if (!bank.analysis[rel]) {
        const w = readWav(abs);
        bank.analysis[rel] = { v: 'virtual', ...analyzeSample(w.channels, w.sampleRate, p.to, isShort) };
      }
      out.push({ ...r, sample: rel, key: p.to, lokey: p.lo, hikey: p.hi });
    }
  }
  return out;
}
