// The virtual orchestra: articulation set built from VSCO 2 CE (CC0) + a track renderer that turns score notes into
// sampler voices (dynamic-layer crossfades, ensemble doubling, legato transitions, chokes, humanisation).
import { join } from 'node:path';
import { Articulation, layerWeights, renderVoice } from './sampler.mjs';
import { parseSfz } from './sfz.mjs';
import { withVirtualRegions } from './virtual.mjs';
import { dbToGain, rng, hash32 } from './dsp.mjs';

export function createOrchestra(bank, sfzDir) {
  const A = {};
  const sfz = (name, file, opts) => { A[name] = Articulation.fromSfz(bank, name, join(sfzDir, file + '.sfz'), opts); };
  // strings
  sfz('vlnSus', 'ViolinEnsSusVib', { kind: 'sus', advanceMax: 0.11, advanceK: 0.45 });
  sfz('vlnSpic', 'ViolinEnsSpic', { kind: 'short' });
  sfz('vlnTrem', 'ViolinEnsTrem', { kind: 'sus', advanceMax: 0.08 });
  sfz('vlnPizz', 'ViolinEnsPizz', { kind: 'short' });
  sfz('vlaSus', 'ViolaEnsSusVib', { kind: 'sus', advanceMax: 0.1, advanceK: 0.45 });
  sfz('vlaSpic', 'ViolaEnsSpic', { kind: 'short' });
  sfz('vlaTrem', 'ViolaEnsTrem', { kind: 'sus', advanceMax: 0.08 });
  sfz('vcSus', 'CelloEnsSusVib', { kind: 'sus', advanceMax: 0.09 });
  sfz('vcSpic', 'CelloEnsSpic', { kind: 'short' });
  sfz('vcTrem', 'CelloEnsTrem', { kind: 'sus', advanceMax: 0.07 });
  sfz('vcPizz', 'CelloEnsPizz', { kind: 'short' });
  sfz('cbSus', 'ContrabassSusVB', { kind: 'sus', advanceMax: 0.08 });
  sfz('cbSusNV', 'ContrabassSusNV', { kind: 'sus', advanceMax: 0.08 });
  sfz('cbSpic', 'ContrabassSpic', { kind: 'short' });
  sfz('cbPizz', 'ContrabassPizz', { kind: 'short' });
  sfz('harp', 'Harp', { kind: 'short', dynRangeDb: 18, ring: 2.2, release: 1.2 });
  // brass
  // French horn: VSCO 2 CE has no samples between C4 and D5 (MIDI 60..74) — fill with formant-preserving re-pitches
  const hornPlan = [{ from: 60, to: 63, lo: 62, hi: 64 }, { from: 60, to: 66, lo: 65, hi: 67 }, { from: 74, to: 69, lo: 68, hi: 70 }, { from: 74, to: 71, lo: 71, hi: 72 }];
  const hornTrim = { 60: [59, 61], 74: [73, 75], 77: [76, 80] };
  A.hnSus = new Articulation(bank, 'hnSus', withVirtualRegions(bank, bank.outDir, parseSfz(join(sfzDir, 'FHornSus.sfz')), hornPlan, hornTrim), { kind: 'sus', advanceMax: 0.06 });
  A.hnSus.singleLayerDarken = 4.5; // the upper horn notes only exist as forte recordings: darken them at lower dynamics
  A.hnStac = new Articulation(bank, 'hnStac', withVirtualRegions(bank, bank.outDir, parseSfz(join(sfzDir, 'FHornStac.sfz')), hornPlan, hornTrim, true), { kind: 'short' });
  sfz('tptSus', 'TrumpetSus', { kind: 'sus', advanceMax: 0.04 });
  sfz('tptStac', 'TrumpetStac', { kind: 'short' });
  sfz('tbnSus', 'TromboneSus', { kind: 'sus', advanceMax: 0.05 });
  sfz('tbnStac', 'TromboneStac', { kind: 'short' });
  sfz('tubaSus', 'TubaSus', { kind: 'sus', advanceMax: 0.06 });
  sfz('tubaStac', 'TubaStac', { kind: 'short' });
  // winds
  sfz('flSus', 'FluteSusVib', { kind: 'sus', advanceMax: 0.05 });
  sfz('flStac', 'FluteStac', { kind: 'short' });
  sfz('picSus', 'PiccoloSus', { kind: 'sus', advanceMax: 0.05 });
  sfz('obSus', 'OboeSusVib', { kind: 'sus', advanceMax: 0.05 });
  // percussion
  sfz('timp', 'Timpani', { kind: 'short', dynRangeDb: 26, advanceMax: 0.004, ring: 1.1, release: 0.7 });
  sfz('timpRoll', 'TimpaniRolls', { kind: 'sus', dynRangeDb: 26, advanceMax: 0 });
  const oneShot = (name, files, opts = {}) => { // files: [[path, layer, rr]]
    const layers = [...new Set(files.map((f) => f[1]))].sort((a, b) => a - b);
    const regs = files.map(([p, layer, rr, rrCount]) => {
      const li = layers.indexOf(layer), n = layers.length;
      const lo = Math.round((li / n) * 127), hi = Math.round(((li + 1) / n) * 127) - (li + 1 < n ? 1 : 0);
      return { sample: p, lokey: 0, hikey: 127, key: 60, lovel: lo, hivel: hi, volume: 0, tune: 0, seqLength: rrCount || 1, seqPosition: rr || 1, offset: 0 };
    });
    A[name] = new Articulation(bank, name, regs, { kind: 'short', dynRangeDb: 26, advanceMax: 0.003, ...opts });
    if (opts.alignPeak) A[name].alignPeak = true;
  };
  oneShot('bassDrum', [1, 2, 3, 4, 5, 6, 7].flatMap((v) => [1, 2].map((r) => [`Percussion/BDrumNewhit_v${v}_rr${r}_Sum.wav`, v, r, 2])), { ring: 1.4, release: 0.8 });
  oneShot('crash', ['pp', 'mp', 'mf', 'ff'].flatMap((d, i) => [1, 2].map((r) => [`Percussion/cymbal-crash1_${d}_rr${r}.wav`, i, r, 2])));
  oneShot('susHit', ['pp', 'mp', 'f', 'fff'].flatMap((d, i) => [1, 2].map((r) => [`Percussion/susCymb1-hit_${d}_rr${r}.wav`, i, r, 2])));
  oneShot('gong', [['Percussion/gongHit_p.wav', 0], ['Percussion/gongHit_mf.wav', 1], ['Percussion/gongHit_f.wav', 2], ['Percussion/gongHit_fff.wav', 3]]);
  oneShot('swellLong', [['Percussion/susCymb1-cresc-Long_v1.wav', 0]], { alignPeak: true });
  oneShot('swellMed', [['Percussion/susCymb1-cresc-Median_v1.wav', 0]], { alignPeak: true });
  oneShot('swellShort', [['Percussion/susCymb1-cresc-Short_v1.wav', 0]], { alignPeak: true });
  oneShot('swell2', [['VSCO 1 Percussion/varMetal/Cymbals/susp/susp_hit_softmall_roll2_cresc.wav', 0]], { alignPeak: true });
  oneShot('bdRoll', [['VSCO 1 Percussion/drums/bass/bdrum_roll1.wav', 0]], { alignPeak: true });
  oneShot('snareRoll', [1, 3, 5].map((v, i) => [`Percussion/Snare2-rollNS_v${v}_rr1_Sum.wav`, i]), { kind: 'sus', dynRangeDb: 24 });
  oneShot('snare', [1, 3, 5, 6].flatMap((v, i) => [1, 2].map((r) => [`Percussion/Snare2-HitNS_v${v}_rr${r}_Sum.wav`, i, r, 2])));
  const G = 'VSCO 1 Percussion/drums/other/ethnic/giant/';
  oneShot('taiko', [[G + 'mallet/EthnicLargeMallet_hit_pp_1.wav', 0], [G + 'mallet/EthnicLargeMallet_hit_mf_1.wav', 1], [G + 'mallet/EthnicLargeMallet_hit_f_1.wav', 2],
    [G + 'mallet/EthnicLargeMallet_hit_ff_1.wav', 3, 1, 2], [G + 'mallet/EthnicLargeMallet_hit_ff_2.wav', 3, 2, 2]], { ring: 1.0, release: 0.5 });
  oneShot('taikoStick', [['ppp_1', 0], ['pp_1', 1], ['p_1', 2], ['mp_1', 3], ['mf_1', 4, 1, 2], ['mf_2', 4, 2, 2], ['f_1', 5, 1, 2], ['f_2', 5, 2, 2], ['fff_1', 6]]
    .map(([n, l, r, c]) => [G + `sticks/EthnicLargeSticks_hit_${n}.wav`, l, r, c]));
  const TD = 'VSCO 1 Percussion/drums/tenor/tenor_lower/tenor_';
  oneShot('tenorDrum', [['pp', 0, 4], ['mf', 1, 4], ['ff', 2, 3], ['fff', 3, 4]].flatMap(([d, l, n]) => Array.from({ length: n }, (_, i) => [TD + `${d}_${i + 1}.wav`, l, i + 1, n])), { ring: 0.5, release: 0.4 });
  oneShot('triangle', [1, 2].flatMap((v, i) => [1, 2].map((r) => [`Percussion/Triangle3-Hit_v${v}_rr${r}_Sum.wav`, i, r, 2])));
  return A;
}

// time of the loudest 50 ms window of a sample (for swells that must peak on a downbeat)
const peakCache = new Map();
function peakTime(sample) {
  if (peakCache.has(sample.rel)) return peakCache.get(sample.rel);
  const hop = Math.round(sample.sr * 0.05), x = sample.L, y = sample.R; let best = 0, bi = 0;
  for (let s = 0; s + hop <= sample.frames; s += hop) { let e = 0; for (let i = s; i < s + hop; i++) e += x[i] * x[i] + y[i] * y[i]; if (e > best) { best = e; bi = s; } }
  const onset = sample.info.onset || 0;
  const t = (bi + hop / 2 - onset) / sample.sr; peakCache.set(sample.rel, t); return t;
}

const asFn = (d) => (typeof d === 'function' ? d : () => d);

/**
 * Render a track into a fresh stereo buffer.
 * track = { name, notes:[...], pan, width, gainDb, ensemble:[{detune, delay, pan, gainDb, rr, alt}], choke:{release}|null,
 *           humanize:{time, dyn, detune}, legatoOffset, legatoAttack }
 * note  = { art, midi, t, dur, dyn (0..1 | fn(t)), seed, legato, attack, release, offset, advance, gainDb, detune, pan }
 */
export function renderTrack(orch, bank, track, outSr, frames) {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const notes = track.notes.slice().sort((a, b) => a.t - b.t);
  const hum = track.humanize || { time: 0.006, dyn: 0.03, detune: 3 };
  const ens = track.ensemble || [{}];
  // pre-pass: chokes & legato hand-offs
  const tOff = notes.map((n) => n.t + Math.max(n.dur, orch[n.art] ? orch[n.art].ring : 0));
  const rel = notes.map((n) => n.release ?? (orch[n.art] ? orch[n.art].release : undefined));
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.legato) {
      for (let j = i - 1; j >= 0; j--) {
        if (notes[j].art !== n.art && !(orch[notes[j].art].kind === 'sus' && orch[n.art].kind === 'sus')) continue;
        if (tOff[j] >= n.t - 0.06) { tOff[j] = Math.min(tOff[j], n.t + 0.035); rel[j] = Math.min(rel[j] ?? 0.12, 0.13); }
        break;
      }
    }
    if (track.choke && i + 1 < notes.length) {
      // choke the previous short note when the next note in the line starts
      const nx = notes[i + 1];
      if (orch[n.art].kind === 'short' && nx.t > n.t) { if (tOff[i] > nx.t + 0.02) { tOff[i] = nx.t + 0.02; rel[i] = track.choke.release ?? 0.12; } }
    }
  }
  let voices = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const art = orch[n.art]; if (!art) throw new Error(`unknown articulation ${n.art} in ${track.name}`);
    const seed = n.seed ?? hash32(track.name, i, n.midi, Math.round(n.t * 1000));
    const rnd = rng(seed);
    const dynFn = asFn(n.dyn ?? 0.7);
    const dj = (rnd() * 2 - 1) * (hum.dyn || 0);
    const timeJ = (rnd() * 2 - 1) * (hum.time || 0);
    const usedSamples = new Set(); // recordings already used by this note's players (doubling must use other takes)
    for (let e = 0; e < ens.length; e++) {
      const E = ens[e];
      const er = rng(seed + 7919 * (e + 1));
      const rr = Math.floor(er() * 1000) + (E.rr || 0);
      const layers = art.layersFor(n.midi, rr);
      // Doubled players must not share a recording with the leader (identical waveforms, slightly detuned and delayed,
      // comb-filter). Prefer a *different dynamic layer* of the same key (a different take); if the key only has one
      // layer, borrow the nearest region with another key centre (a different note recorded separately).
      let lay = layers, forceLayer = -1;
      if (E.alt) {
        let found = false;
        if (layers.length > 1) {
          const d0 = Math.max(0, Math.min(1, asFn(n.dyn ?? 0.7)(n.t + 0.1)));
          const lead = layerWeights(layers, d0).reduce((bi, w, i, a) => (w > a[bi] ? i : bi), 0);
          const order = E.alt > 0 ? [lead - 1, lead + 1, lead - 2, lead + 2] : [lead + 1, lead - 1, lead + 2, lead - 2];
          for (const li of order) if (li >= 0 && li < layers.length && !usedSamples.has(layers[li].region.sample)) { forceLayer = li; found = true; break; }
        }
        if (!found) {
          for (const dk of E.alt > 0 ? [3, -3, 5, -5] : [-3, 3, -5, 5]) {
            const alt = art.layersFor(n.midi + dk, rr + 1);
            if (alt.length && !alt.some((l) => usedSamples.has(l.region.sample)) && Math.abs(alt[0].region.key - n.midi) <= 5) { lay = alt; found = true; break; }
          }
        }
        if (!found) continue; // no unused recording left for this doubling: leave the player out
      }
      const isShort = art.kind === 'short';
      // which layers are ever used across the note's dynamic curve?
      const tEnd = tOff[i] + (rel[i] ?? (isShort ? 0.3 : 0.25));
      const samplesT = [n.t, n.t + 0.25 * n.dur, n.t + 0.5 * n.dur, n.t + 0.75 * n.dur, n.t + n.dur];
      const used = new Set();
      if (forceLayer >= 0) used.add(forceLayer);
      else for (const t of samplesT) layerWeights(lay, Math.max(0, Math.min(1, dynFn(t) + dj))).forEach((w, li) => { if (w > 0.001) used.add(li); });
      const delay = (E.delay || 0) + timeJ + (e > 0 ? (er() * 2 - 1) * 0.008 : 0);
      const detune = (n.detune || 0) + (E.detune || 0) + (er() * 2 - 1) * (hum.detune || 0);
      const gainLin = dbToGain((track.gainDb || 0) + (n.gainDb || 0) + (E.gainDb || 0));
      for (const li of used) usedSamples.add(lay[li].region.sample);
      for (const li of used) {
        const region = lay[li].region;
        const sample = bank.get(region.sample);
        const info = sample.info;
        let advance = n.advance ?? Math.min(art.advanceMax, art.advanceK * (info.t50 || 0));
        let offset = n.offset || 0, attack = n.attack || 0;
        if (n.legato && !isShort) { offset = Math.max(offset, track.legatoOffset ?? 0.1); attack = Math.max(attack, track.legatoAttack ?? 0.06); advance = 0.03; }
        let tOn = n.t + delay - advance;
        if (art.alignPeak) tOn = n.t + delay - peakTime(sample);
        const gainFn = (t) => {
          const d = Math.max(0, Math.min(1, dynFn(t) + dj));
          const w = forceLayer >= 0 ? 1 : layerWeights(lay, d)[li];
          return w * dbToGain(art.dynRangeDb * (d - 1)) * gainLin;
        };
        // single-layer regions (one recording for all dynamics): follow the dynamic with a brightness filter
        const darken = lay.length === 1 && art.singleLayerDarken ? art.singleLayerDarken : 0;
        const lpFn = darken ? (t) => 18000 * Math.pow(2, -darken * (1 - Math.max(0, Math.min(1, dynFn(t) + dj)))) : null;
        renderVoice([L, R], outSr, {
          lpFn,
          region, sample, midi: n.midi, tOn, tOff: tOff[i] + delay, release: rel[i] ?? (isShort ? 0.3 : 0.25),
          gainFn, offset, attack, detune, loop: !isShort,
          pan: (track.pan || 0) + (E.pan || 0) + (n.pan || 0), width: n.width ?? E.width ?? track.width ?? 1,
          hardEnd: isShort && !art.alignPeak ? undefined : tEnd + 0.01,
          vib: n.vib && !isShort ? { ...n.vib, t0: n.t + delay, phase: er() * 6.283 } : undefined,
        });
        voices++;
      }
    }
  }
  return { L, R, voices };
}
