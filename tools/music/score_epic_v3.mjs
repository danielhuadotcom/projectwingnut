// PROJECT WINGNUT — "Sortie" v3 (original composition, written as code): the main battle theme. Same opening as v2
// (bars 1–6 are note-for-note v2, the part the designer called excellent); from bar 7 the body is darker, heavier and
// more modern-military: low strings / low brass / taiko weight, driving ostinatos, borrowed minor (iv, bVI, bVII, bIII)
// and pedal points around Eb major, and real voice leading (lib-free, below: nearest-tone voice leading with prepared
// suspensions resolving down, register changes per phrase, rhythmic string figures under the harmony).
// Tempo map: 108 BPM for the hit, ramping to 130 over the urgency section, then 130 to the end (no ritardando: the
// piece fades out on its last swell; the loop restarts on the bar-1 hit, the fade's tail folded under it).
//
//   bars  1–6   HIT (as v2): tutti Eb(add9), horns proclaim the motif over an Eb pedal: Eb – Cb – Db – Eb
//   bars  7–18  URGENCY: low-string pulse + moving inner voices over an Eb pedal (Eb – Ebsus4 – Cb – Abm – Eb – Gb – Db –
//               Ebsus4), then Cb – Db – Bbsus4 – Bb; 108 -> 130 BPM, pp -> f, taiko enters
//   bars 19–26  PLUCKS in C minor (relative minor): pizzicato walk Cm – Cm/Bb – Ab – Gsus4 – G – Fm – Ab – G
//   bars 27–34  back to Eb via Ab (pivot): Ab – Bbsus4 – Bb – Cb – Db – Abm – Bbsus4 – Bb, swells with suspensions
//   bars 35–40  STRING SOLO (as v2, darker accompaniment)
//   bars 41–84  LEITMOTIF waves: theme over Eb – Bb/D – Cb – Abm – Eb/G – Gb – Db – Bbsus4 (+ Cb – Db – Eb lift);
//               a low unison wave (Abm – Cb – Bbsus4 – Bb – Gb – Db – Cm – Abm6 – Bbsus4); tutti theme; Cb – Db – Abm – Gb
//               driving wave
//   bars 85–90  FADE: the last Cb – Db swells fade to nothing over the thinning ostinato (no closing chord) -> bar 1 hit
//
// THE MOTIF (unchanged): Eb – Bb – Eb' | D – Bb – F'. The theme now continues into the borrowed chords (Gb – Eb – Cb over
// Cb, Cb – Ab – Eb over Abm, Bb – Gb – Db over Gb ...), still in arpeggio leaps.
import { hash32 } from './lib/dsp.mjs';
import { P, env } from './score.mjs';

export const TITLE = 'Sortie';
export const TOTAL_BARS = 90;
export const OFFSET = 0.5; // s of silence before bar 1 (pre-attacks of the hit), folded onto the loop end by the render
// ------------------------------------------------------------------------------------------------ tempo map
const TEMPO = [[0, 108], [6, 108], [18, 130], [90, 130]]; // [bar position (bars from bar 1), BPM], linear
const bpmAt = (bp) => { for (let i = 1; i < TEMPO.length; i++) if (bp <= TEMPO[i][0]) { const [a, x] = TEMPO[i - 1], [b, y] = TEMPO[i]; return x + (y - x) * (bp - a) / (b - a); } return TEMPO[TEMPO.length - 1][1]; };
const RES = 32, CUM = new Float64Array(TOTAL_BARS * 4 * RES + 2); // seconds at every 1/32 beat
for (let k = 1; k < CUM.length; k++) { const bp = ((k - 0.5) / RES) / 4; CUM[k] = CUM[k - 1] + 60 / bpmAt(bp) / RES; }
/** absolute time (s) of (bar, beat) under the tempo map (bars from 1) */
export const T = (bar, beat = 0) => { const x = ((bar - 1) * 4 + beat) * RES, i = Math.max(0, Math.min(CUM.length - 2, Math.floor(x))), f = x - i; return OFFSET + CUM[i] + (CUM[i + 1] - CUM[i]) * f; };
/** duration (s) of `beats` beats starting at (bar, beat) */
const D = (bar, beat, beats) => T(bar, beat + beats) - T(bar, beat);
export const BPM = 130;
export const SECTIONS = [['hit', 1, 7], ['urgency', 7, 19], ['plucks', 19, 27], ['return', 27, 35], ['solo', 35, 41], ['wave1', 41, 53], ['wave2', 53, 63], ['wave3', 63, 75], ['wave4', 75, 85], ['fade', 85, 91]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (t0, t1, d0, d1, curve = 1) => (t) => d0 + (d1 - d0) * Math.pow(clamp01((t - t0) / (t1 - t0)), curve);
const swell = (t0, t1, d0, peak, d1, at = 0.6) => env([[t0, d0], [t0 + (t1 - t0) * at, peak], [t1, d1]]);
const plus = (f, k) => (t) => (typeof f === 'function' ? f(t) : f) + k;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ------------------------------------------------------------------------------------------------ harmony
// chord symbols: root[quality][/bass]; quality: '' major, m, sus4, sus2, m7, 7, m6
const PCN = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, Cb: 11, B: 11 };
function parseChord(sym) {
  const m = /^([A-G]b?)(m7|m6|m|sus4|sus2|7)?(?:\/([A-G]b?))?$/.exec(sym); if (!m) throw new Error('chord ' + sym);
  const r = PCN[m[1]], q = m[2] || '';
  const iv = { '': [0, 4, 7], m: [0, 3, 7], sus4: [0, 5, 7], sus2: [0, 2, 7], m7: [0, 3, 7, 10], 7: [0, 4, 7, 10], m6: [0, 3, 7, 9] }[q];
  return { sym, r, q, pcs: iv.map((x) => (r + x) % 12), third: (r + iv[1]) % 12, fifth: (r + 7) % 12, sev: iv[3] !== undefined ? (r + iv[3]) % 12 : null, bass: m[3] ? PCN[m[3]] : r };
}
const PROG = {};
const setp = (bar0, s) => s.split(' ').forEach((c, i) => { PROG[bar0 + i] = parseChord(c); });
setp(1, 'Eb Cb Db Eb Eb Eb');
setp(7, 'Eb Ebsus4 Cb/Eb Abm/Eb Eb Gb/Eb Db/Eb Ebsus4 Cb Db Bbsus4 Bb');
setp(19, 'Cm Cm/Bb Ab Gsus4 G Fm Ab G Ab Bbsus4 Bb Cb Db Abm Bbsus4 Bb');
setp(35, 'Cm Ab Eb/G Ab Fm Bbsus4');
setp(41, 'Eb Bb/D Cb Abm Eb/G Gb Db Bbsus4 Cb Db Eb Eb');
setp(53, 'Abm Cb Bbsus4 Bb Gb Db Cm Cm Abm6 Bbsus4');
setp(63, 'Eb Bb/D Cb Abm Eb/G Gb Db Bbsus4 Cb Db Eb Eb');
setp(75, 'Cb Db Abm Gb Cb Db Bbsus4 Bb Cb Db');
setp(85, 'Cb Db Cb Db Bbsus4 Bbsus4');
const ch = (bar) => PROG[bar];
const above = (pc, lo) => { let m = P(lo); while (((m % 12) + 12) % 12 !== pc) m++; return m; };
/** the wide voicing of a bar: roots low, horns on 3rd/5th, violins on the 9th and suspension */
function voice(bar) {
  const c = ch(bar);
  const bassLo = above(c.bass, 'E1'), bass = bassLo + 12;
  const tbn = [above(c.r, 'F2'), 0]; tbn[1] = above(c.fifth, tbn[0] + 1 > P('F2') ? 'C3' : 'C3');
  const hn = [above(c.third, 'G3'), 0]; hn[1] = above(c.fifth, hn[0] + 1);
  if (c.sev !== null) hn.push(above(c.sev, hn[1] + 1));
  const ninth = c.q === 'sus2' || c.q === 'sus4' ? c.third : (c.r + 2) % 12; // sus chords: violins hold the suspension
  const vln1 = above(ninth, 'Bb5'), vln2 = above(c.q.startsWith('sus') ? c.fifth : c.third, 'F5'), vla = above(c.fifth, 'G4');
  return { bassLo, bass, tbn, hn, vln1, vln2, vla, root: c.r };
}

// ------------------------------------------------------------------------------------------------ melodies
export const THEME = 'Eb4:1.5 Bb4:.5 Eb5:2 | D5:1 Bb4:1 F5:2 | Gb5:1.5 Eb5:.5 Cb5:2 | Cb5:1 Ab4:1 Eb5:2 | G4:1.5 Eb5:.5 D5:1 Bb4:1 | Bb4:1.5 Gb4:.5 Db5:2 | Ab4:1.5 Db5:.5 F5:2 | Eb5:2 D5:1.6';
export const LIFT = 'Eb5:1.5 Cb5:.5 Gb5:2 | F5:1 Db5:1 Ab5:2 | G5:1.5 Eb5:.5 Bb5:2 | Bb5:3.6';
const SOLO = 'G5:1.5 C6:.5 Eb6:2 | C6:1 Bb5:1 Ab5:2 | G5:1.5 Bb5:.5 Eb6:2 | F6:2 Eb6:1 C6:1 | Ab5:1.5 C6:.5 F6:2 | Eb6:2 D6:1.8';
const oct = (s, k) => s.replace(/([A-G]b?)(\d)/g, (m, n, o) => n + (+o + k));

export function buildScore() {
  const tracks = {};
  const track = (name, opts) => { tracks[name] = { name, notes: [], ...opts }; };
  track('vln1', { bus: 'str', pan: -0.55, width: 0.6, gainDb: 0, send: 0.32, eq: [['highpass', 170], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 2.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.07 });
  track('vln2', { bus: 'str', pan: -0.25, width: 0.6, gainDb: -1.5, send: 0.32, eq: [['highpass', 160], ['peak', 350, { q: 1, gainDb: -2 }], ['peak', 2600, { q: 1, gainDb: -1.5 }]], humanize: { time: 0.006, dyn: 0.035, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.07 });
  track('vla', { bus: 'str', pan: 0.2, width: 0.55, gainDb: -2.5, send: 0.3, eq: [['highpass', 110], ['peak', 300, { q: 1, gainDb: -2 }], ['peak', 2500, { q: 1, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.04, detune: 2 }, choke: { release: 0.14 } });
  track('vc', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.27, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.04, detune: 2 }, choke: { release: 0.15 } });
  track('vcSus', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.3, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.06 });
  track('cb', { bus: 'str', pan: 0.65, width: 0.35, gainDb: -4, send: 0.24, eq: [['highpass', 32], ['peak', 180, { q: 1, gainDb: -2.5 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 },
    ensemble: [{}, { detune: 7, delay: 0.011, alt: 1, pan: 0.08, gainDb: -2 }], choke: { release: 0.18 } });
  track('solo', { bus: 'str', pan: -0.15, width: 0.35, gainDb: 1, send: 0.42, eq: [['highpass', 200], ['peak', 3000, { q: 1, gainDb: 1 }]], humanize: { time: 0.01, dyn: 0.03, detune: 3 }, legatoOffset: 0.09, legatoAttack: 0.08 });
  track('harp', { bus: 'str', pan: -0.65, width: 0.6, gainDb: -10, send: 0.45, eq: [['highpass', 90]], humanize: { time: 0.008, dyn: 0.05, detune: 1 } });
  track('hn', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: 0.5, send: 0.42, eq: [['highpass', 80], ['peak', 420, { q: 1, gainDb: -2.5 }], ['peak', 2400, { q: 0.8, gainDb: 2.5 }]], humanize: { time: 0.007, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.013, alt: 1, pan: 0.12, gainDb: -1 }, { detune: -7, delay: 0.021, alt: -1, pan: -0.12, gainDb: -1.5 }], legatoOffset: 0.09, legatoAttack: 0.06 });
  track('hnChord', { bus: 'brass', pan: -0.35, width: 0.7, gainDb: -4, send: 0.45, eq: [['highpass', 80], ['peak', 420, { q: 1, gainDb: -2 }]], humanize: { time: 0.009, dyn: 0.03, detune: 3 } });
  track('tpt', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: 0, send: 0.4, eq: [['highpass', 140], ['peak', 2800, { q: 0.8, gainDb: 2 }]], humanize: { time: 0.007, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: -6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.07, legatoAttack: 0.05 });
  track('brassStab', { bus: 'brass', pan: 0.1, width: 0.7, gainDb: -4, send: 0.4, eq: [['highpass', 70]], humanize: { time: 0.005, dyn: 0.04, detune: 3 } });
  track('tbnChord', { bus: 'brass', pan: 0.32, width: 0.7, gainDb: -3, send: 0.42, eq: [['highpass', 55], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 } });
  track('tuba', { bus: 'brass', pan: 0.45, width: 0.4, gainDb: -1, send: 0.35, eq: [['highpass', 28], ['peak', 160, { q: 1, gainDb: -2 }]], humanize: { time: 0.007, dyn: 0.03, detune: 2 } });
  track('fl', { bus: 'winds', pan: -0.1, width: 0.5, gainDb: -8, send: 0.45, eq: [['highpass', 250]], humanize: { time: 0.007, dyn: 0.03, detune: 2 }, legatoOffset: 0.06, legatoAttack: 0.05 });
  track('timp', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: -1.5, send: 0.36, eq: [['highpass', 30], ['lowshelf', 90, { gainDb: 1.5 }]], humanize: { time: 0.004, dyn: 0.035, detune: 0 } });
  track('bd', { bus: 'perc', pan: 0.05, width: 0.7, gainDb: -3, send: 0.32, eq: [['highpass', 28], ['lowshelf', 70, { gainDb: 1.5 }]], humanize: { time: 0.003, dyn: 0.03, detune: 0 } });
  track('taiko', { bus: 'perc', pan: 0.0, width: 0.8, gainDb: -2, send: 0.3, eq: [['highpass', 35], ['lowshelf', 80, { gainDb: 1.5 }], ['highshelf', 5000, { gainDb: -3 }]], humanize: { time: 0.005, dyn: 0.04, detune: 0 } });
  track('drums', { bus: 'perc', pan: -0.1, width: 0.8, gainDb: -5, send: 0.33, eq: [['highpass', 60]], humanize: { time: 0.004, dyn: 0.05, detune: 0 } });
  track('anvil', { bus: 'perc', pan: 0.3, width: 0.6, gainDb: -13, send: 0.36, eq: [['highpass', 600], ['highshelf', 8000, { gainDb: -4 }]], humanize: { time: 0.003, dyn: 0.04, detune: 0 } });
  track('cym', { bus: 'perc', pan: -0.2, width: 0.9, gainDb: -9, send: 0.45, eq: [['highpass', 300]], humanize: { time: 0.002, dyn: 0.02, detune: 0 } });
  track('lowOst', { bus: 'brass', pan: 0.35, width: 0.6, gainDb: -3, send: 0.32, eq: [['highpass', 40], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.04, detune: 3 } });
  track('figure', { bus: 'str', pan: 0.05, width: 0.7, gainDb: -3, send: 0.26, eq: [['highpass', 120], ['peak', 300, { q: 1, gainDb: -2 }], ['peak', 2600, { q: 1, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.045, detune: 2 }, choke: { release: 0.12 } });
  track('gong', { bus: 'perc', pan: 0.25, width: 0.9, gainDb: -7, send: 0.48, eq: [['highpass', 40]], humanize: { time: 0, dyn: 0, detune: 0 } });
  const choir = [];

  const add = (tr, art, t, midi, dur, o = {}) => {
    const m = typeof midi === 'number' ? midi : /^\d+$/.test(midi) ? +midi : P(midi);
    tracks[tr].notes.push({ art, midi: m, t, dur, dyn: o.dyn ?? 0.7, seed: hash32('ep2', tr, Math.round(t * 1000), m, o.v || 0),
      legato: !!o.legato, attack: o.attack, release: o.release, offset: o.offset, gainDb: o.gainDb, advance: o.advance, pan: o.pan, vib: o.vib });
  };
  /** melodic line on the tempo map; options as in score_epic.mjs (dyn, legato, gate, shape, vib, phrase, accent) */
  const mel = (tr, art, bar, str, o = {}) => {
    let beat = o.beat || 0, first = true;
    const base = typeof o.dyn === 'function' ? o.dyn : () => (o.dyn ?? 0.7);
    const t0 = T(bar), tP = T(bar + 4) - t0;
    const arch = o.phrase ? (t) => o.phrase * Math.sin(Math.PI * clamp01(((t - t0) % tP) / tP)) : () => 0;
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = parseFloat(d);
      if (p !== 'r') {
        const t = T(bar, beat), dur = D(bar, beat, beats) * (o.gate ?? 1);
        const acc = o.accent && Math.abs(beat % 4) < 1e-6 ? o.accent : 0;
        let dyn = (tt) => base(tt) + arch(tt) + acc;
        if (o.shape && beats >= 1.5) { const d0 = dyn, k = o.shape; dyn = (tt) => d0(tt) + k * Math.sin(Math.PI * clamp01((tt - t) / dur)); }
        const vib = o.vib && beats >= 1.5 ? { delay: Math.min(0.45, dur * 0.3), rise: Math.min(0.8, dur * 0.4), depth: o.vib.depth ?? 10, rate: o.vib.rate ?? 5.2 } : undefined;
        add(tr, art, t, p, dur, { ...o, dyn, vib, legato: o.legato && !first });
        first = false;
      } else first = true;
      beat += beats;
    }
  };
  // ------------------------------------------------------------------------------------------------ writers
  /** orchestral swell on a bar's chord (wide voicing): low brass + celli/basses on roots, horns on 3rd/5th, violins on
   *  the 9th/suspension. k = intensity 0..1, len = bars, at = peak position; sus4 chords resolve to the 3rd at 60 %. */
  const swellChord = (bar, k, o = {}) => {
    const v = voice(bar), c = ch(bar), len = o.len || 1, t0 = T(bar), t1 = T(bar + len), dur = (t1 - t0) * 0.98;
    const sw = (d0, pk, d1) => swell(t0, t1, d0, pk, d1, o.at ?? 0.62);
    const lo = sw(k - 0.2, k, k - 0.14), mid = sw(k - 0.24, k - 0.04, k - 0.2), hi = sw(k - 0.3, k - 0.08, k - 0.26);
    if (o.brass !== false) {
      add('tuba', 'tubaSus', t0, v.bassLo, dur, { dyn: plus(lo, -0.04) });
      for (const m of v.tbn) add('tbnChord', 'tbnSus', t0, m, dur, { dyn: lo });
      v.hn.forEach((m, i) => {
        if (c.q === 'sus4' && i === 0) { const tR = t0 + (t1 - t0) * 0.6; add('hnChord', 'hnSus', t0, m, tR - t0, { dyn: mid }); add('hnChord', 'hnSus', tR, m - 1, t1 - tR, { dyn: mid, legato: true }); }
        else add('hnChord', 'hnSus', t0, m, dur, { dyn: mid });
      });
    }
    if (o.strings !== false) {
      add('cb', 'cbSus', t0, v.bassLo, dur, { dyn: plus(lo, -0.08) });
      add('vcSus', 'vcSus', t0, v.bass, dur, { dyn: plus(lo, -0.04) });
      add('vla', 'vlaSus', t0, v.vla, dur, { dyn: plus(mid, -0.04) });
      add('vln2', 'vlnSus', t0, v.vln2, dur, { dyn: hi, vib: { delay: 0.4, rise: 0.8, depth: 9, rate: 5.3 } });
      if (c.q === 'sus4') { const tR = t0 + (t1 - t0) * 0.6; add('vln1', 'vlnSus', t0, v.vln1, tR - t0, { dyn: hi }); add('vln1', 'vlnSus', tR, v.vln1 - 1, t1 - tR, { dyn: hi, legato: true }); }
      else add('vln1', 'vlnSus', t0, v.vln1, dur, { dyn: hi, vib: { delay: 0.4, rise: 0.8, depth: 11, rate: 5.4 } });
    }
  };
  /** on-beat string chords: `per` notes per beat (1 = quarters, 2 = 8ths, 4 = 16ths), short arco */
  const pulse = (bar, per, dynFn) => {
    const v = voice(bar);
    for (let b = 0; b < 4; b += 1 / per) {
      const t = T(bar, b), len = D(bar, b, 1 / per) * 0.9, acc = Math.abs(b % 1) < 1e-6 ? 0.06 : -0.04;
      const d = (tt) => dynFn(tt) + acc;
      add('vln1', 'vlnSpic', t, v.vln1 - 12, len, { dyn: d }); add('vln2', 'vlnSpic', t, v.vln2 - 12, len, { dyn: plus(d, -0.02) });
      add('vla', 'vlaSpic', t, v.vla, len, { dyn: plus(d, -0.02) }); add('vc', 'vcSpic', t, v.bass, len, { dyn: d });
      if (Math.abs(b % 1) < 1e-6) add('cb', 'cbSpic', t, v.bassLo, len, { dyn: plus(d, -0.04) });
    }
  };
  /** 16th string ostinato on the chord: 5th-below pedal / root / 9th / 3rd */
  const ost16 = (tr, art, bars, dynFn, octave = 0) => {
    for (const bar of bars) {
      const c = ch(bar), r = above(c.r, 'Eb4') + 12 * octave, p = above(c.fifth, 'Bb3') + 12 * octave, n9 = above((c.r + 2) % 12, r), t3 = above(c.third, n9);
      const cell = [p, r, p, n9, p, t3, p, n9];
      for (let i = 0; i < 16; i++) add(tr, art, T(bar, i * 0.25), cell[i % 8], D(bar, i * 0.25, 0.25), { dyn: (tt) => dynFn(tt) + (i % 4 === 0 ? 0.1 : i % 2 ? -0.06 : 0) });
    }
  };
  const gallop = (bars, dynFn) => { for (const bar of bars) { const r = voice(bar).bass; for (let b = 0; b < 4; b++) [[0, 0.5], [0.5, 0.25], [0.75, 0.25]].forEach(([o, l], k) => add('vc', 'vcSpic', T(bar, b + o), b === 2 && k === 0 ? r + 12 : r, D(bar, b + o, l), { dyn: (tt) => dynFn(tt) + (k ? -0.06 : 0.08) })); add('cb', 'cbSpic', T(bar), voice(bar).bassLo, D(bar, 0, 1), { dyn: dynFn }); add('cb', 'cbSpic', T(bar, 2), voice(bar).bassLo, D(bar, 2, 1), { dyn: plus(dynFn, -0.05) }); } };
  const timpOf = (bar) => { let m = above(ch(bar).bass, 'D2'); if (m > P('A2')) m -= 12; return m < P('D2') ? m + 12 : m; };
  const drums = (bar, lvl, full = true) => {
    const tp = timpOf(bar);
    add('bd', 'bassDrum', T(bar), 60, D(bar, 0, 1), { dyn: lvl }); add('taiko', 'taiko', T(bar), 56, D(bar, 0, 1), { dyn: lvl });
    add('timp', 'timp', T(bar), tp, D(bar, 0, 1), { dyn: lvl, release: 0.5 }); add('timp', 'timp', T(bar, 2.5), tp, D(bar, 0, 1), { dyn: lvl - 0.12, release: 0.4 });
    add('taiko', 'taiko', T(bar, 2), 57, D(bar, 0, 1), { dyn: lvl - 0.1 });
    if (full) { add('taiko', 'taiko', T(bar, 1.5), 57, D(bar, 0, 1), { dyn: lvl - 0.16 }); add('timp', 'timp', T(bar, 3.5), tp + 5 <= P('A3') ? tp + 5 : tp - 7, D(bar, 0, 1), { dyn: lvl - 0.1, release: 0.4 });
      for (const b of [1, 3]) add('drums', 'taikoStick', T(bar, b), 58, D(bar, 0, 1), { dyn: lvl - 0.18 }); }
  };
  const harpGliss = (bar, beat, from, to, beats, pcs, dyn = 0.55) => {
    const a = P(from), b = P(to), dir = b > a ? 1 : -1, notes = [];
    for (let m = a; dir > 0 ? m <= b : m >= b; m += dir) if (pcs.includes(((m % 12) + 12) % 12)) notes.push(m);
    const t0 = T(bar, beat), span = D(bar, beat, beats);
    notes.forEach((m, k) => add('harp', 'harp', t0 + (k / notes.length) * span, m, 0.5, { dyn: dyn + 0.12 * k / notes.length }));
  };
  const EBMAJ = [3, 5, 7, 8, 10, 0, 2];
  const harpArp = (bar, dyn) => { const c = ch(bar), r = above(c.bass, 'Eb2'), t = above(c.third, r + 7), f = above(c.fifth, t), n9 = above((c.r + 2) % 12, f);
    [r, f, t + 12, n9, f + 12, t + 12, n9 + 12, f + 12].forEach((m, k) => add('harp', 'harp', T(bar, k * 0.5), m, D(bar, k * 0.5, 0.5), { dyn: dyn + (k ? 0 : 0.06) })); };
  const choirBar = (bar, dynFn) => { const v = voice(bar), c = ch(bar);
    const parts = [['S', above((c.r + 2) % 12, 'D5')], ['A', above(c.third, 'Bb4')], ['T', above(c.fifth, 'Eb4')], ['B', v.bass < P('Eb2') ? v.bass + 12 : v.bass]];
    for (const [part, midi] of parts) choir.push({ part, midi, t: T(bar), dur: D(bar, 0, 4) * 0.98, seed: hash32('ep2c', bar, part), dyn: swell(T(bar), T(bar + 1), dynFn(T(bar)) - 0.06, dynFn(T(bar)) + 0.06, dynFn(T(bar))) }); };
  const hit = (bar, k) => { // the tutti chord, held a whole note (fz, settles, swells slightly)
    const t0 = T(bar), dur = D(bar, 0, 4) * 0.98, fz = env([[t0, 0.95 * k], [t0 + 0.35, 0.74 * k], [t0 + dur * 0.7, 0.8 * k], [t0 + dur, 0.62 * k]]);
    const v = voice(bar);
    add('tuba', 'tubaSus', t0, v.bassLo, dur, { dyn: fz }); for (const m of [...v.tbn, v.tbn[0] + 12]) add('tbnChord', 'tbnSus', t0, m, dur, { dyn: fz });
    for (const m of [...v.hn, v.hn[0] + 12]) add('hnChord', 'hnSus', t0, m, dur, { dyn: fz, gainDb: 2 });
    for (const m of [P('Bb4'), P('Eb5'), P('G5')]) add('tpt', 'tptSus', t0, m, dur, { dyn: plus(fz, -0.04) });
    for (const m of [...v.tbn, ...v.hn]) add('brassStab', 'tbnStac', t0, m, 0.5, { dyn: 0.9 * k });
    add('cb', 'cbSus', t0, v.bassLo, dur, { dyn: fz }); add('vcSus', 'vcSus', t0, v.bass, dur, { dyn: fz });
    add('vla', 'vlaSus', t0, v.vla, dur, { dyn: fz }); add('vln2', 'vlnSus', t0, v.vln2, dur, { dyn: fz }); add('vln1', 'vlnSus', t0, v.vln1, dur, { dyn: fz }); add('vln1', 'vlnSus', t0, v.vln1 - 7, dur, { dyn: plus(fz, -0.06) });
    add('timp', 'timp', t0, P('Eb2'), D(bar, 0, 2), { dyn: 0.95 * k, release: 0.8 }); add('timp', 'timpRoll', t0 + 0.12, P('Eb2'), dur - 0.12, { dyn: env([[t0, 0.6 * k], [t0 + dur, 0.4 * k]]), release: 0.3 });
    add('bd', 'bassDrum', t0, 58, D(bar, 0, 2), { dyn: 0.9 * k }); add('cym', 'crash', t0, 60, 3, { dyn: 0.95 * k, release: 2 });
    add('gong', 'gong', t0, 58, 5, { dyn: 0.8 * k, release: 3 }); add('anvil', 'anvil', t0, 60, 0.5, { dyn: 0.75 * k });
  };

  // ================================================================================================ HIT (1–6)
  {
    hit(1, 1.0);
    // horns proclaim the motif over an Eb pedal while the harmony lifts Eb – Cb – Db – Eb (I – bVI – bVII – I)
    mel('hn', 'hnSus', 2, 'Eb4:1.5 Bb4:.5 Eb5:2 | D#5:1 B4:1 F#5:2 | F5:1 Db5:1 Ab5:2 | G5:1.5 Eb5:.5 Bb4:2 | Eb5:3.6',
      { dyn: env([[T(2), 0.78], [T(4), 0.84], [T(5), 0.8], [T(6), 0.66], [T(7), 0.5]]), legato: true, shape: 0.05 });
    for (const bar of [2, 3, 4, 5]) swellChord(bar, bar === 5 ? 0.76 : 0.82, { at: 0.55 });
    add('tuba', 'tubaSus', T(2), 'Eb1', D(2, 0, 16) * 0.98, { dyn: 0.6 }); // tonic pedal
    swellChord(6, 0.58, { at: 0.3 });
    harpGliss(5, 2, 'Eb3', 'Eb6', 2, EBMAJ, 0.48);
    for (const bar of [2, 3, 4]) { add('timp', 'timpRoll', T(bar), timpOf(bar), D(bar, 0, 4) - 0.05, { dyn: swell(T(bar), T(bar + 1), 0.3, 0.55, 0.36), release: 0.2 }); add('bd', 'bassDrum', T(bar), 60, D(bar, 0, 1), { dyn: 0.6 }); }
    add('cym', 'swellMed', T(4), 60, 0.6, { dyn: 0.55, release: 1.2 });
  }

  // ------------------------------------------------------------------------------------------------ v3 writers
  const pcOf = (m) => ((m % 12) + 12) % 12;
  const SCALE_ALL = [3, 5, 7, 8, 10, 0, 2, 6, 11, 1]; // Eb major + borrowed minor (Gb, Cb, Db)
  /**
   * Voice leading for 4 upper voices over `bars` (one chord per bar). Each voice moves to the nearest chord tone (no
   * crossing, tones the chord still needs are preferred); at every 4-bar phrase the voicing is re-seeded under a new top
   * note (register changes, alternating close and open spacing). A voice whose previous note is not in the new chord
   * and lies a step above its new note is held as a suspension and resolves down on beat 2 or 3; a voice on the 4th of
   * a sus4 chord resolves to the 3rd within the bar unless the next bar does it; inner voices that leap a 3rd get a
   * passing note on beat 3. Returns notes per voice: [{ bar, beat, beats, midi }].
   */
  const leadVoices = (bars, o = {}) => {
    const R = o.ranges || [[P('Bb3'), P('Ab5')], [P('F3'), P('Eb5')], [P('C3'), P('Bb4')], [P('G2'), P('F4')]];
    const anchors = (o.anchors || ['G4', 'Eb5', 'Bb4', 'Db5']).map(P);
    const out = [[], [], [], []]; let cur = null;
    bars.forEach((bar, k) => {
      const c = ch(bar), tones = c.pcs, want = [c.third, c.fifth, c.r, ...(c.sev !== null ? [c.sev] : [])];
      const topTones = [...tones, (c.r + 2) % 12];
      let next = [];
      if (!cur || k % 4 === 0) { // re-seed under the phrase anchor
        const open = (k / 4) % 2 === 1;
        let m = anchors[(k / 4 | 0) % anchors.length]; while (!topTones.includes(pcOf(m)) || m > R[0][1]) m--; next[0] = m;
        const used = new Set([pcOf(m)]);
        for (let v = 1; v < 4; v++) {
          let x = next[v - 1] - (open ? 5 : 2), skip = open ? 1 : 0;
          for (; x >= R[v][0]; x--) { if (!tones.includes(pcOf(x))) continue; if (used.has(pcOf(x)) && want.some((p) => !used.has(p))) continue; if (skip-- > 0) continue; break; }
          next[v] = Math.max(x, R[v][0]); used.add(pcOf(next[v]));
        }
      } else {
        const used = new Set();
        for (let v = 0; v < 4; v++) {
          const p = cur[v], lim = v ? next[v - 1] - 2 : R[0][1]; let best = null, bs = 1e9;
          for (let x = Math.max(R[v][0], p - 7); x <= Math.min(R[v][1], p + 7, lim); x++) {
            const pc = pcOf(x); if (!(v === 0 ? topTones : tones).includes(pc)) continue;
            const s = Math.abs(x - p) + (used.has(pc) ? 2.5 : 0) - (want.includes(pc) && !used.has(pc) ? 1 : 0);
            if (s < bs) { bs = s; best = x; }
          }
          next[v] = best ?? Math.min(lim, p); used.add(pcOf(next[v]));
        }
      }
      for (let v = 0; v < 4; v++) {
        const m = next[v], p = cur ? cur[v] : null;
        const isSus = p !== null && k % 4 !== 0 && (p - m === 1 || p - m === 2) && !tones.includes(pcOf(p));
        let segs = isSus ? [[0, v % 2 ? 2 : 1, p], [v % 2 ? 2 : 1, v % 2 ? 2 : 3, m]] : [[0, 4, m]];
        // sus4 chord: the voice on the 4th resolves to the 3rd within the bar unless the next bar is the same root
        if (c.q === 'sus4' && pcOf(m) === c.third && !(PROG[bar + 1] && PROG[bar + 1].r === c.r)) segs = [[0, 2.5, m], [2.5, 1.5, m - 1]];
        // passing note in inner voices leaping a third to the next bar
        const nb = bars[k + 1];
        if (!isSus && (v === 1 || v === 2) && nb && segs.length === 1) {
          const nt = PROG[nb].pcs; let target = null, bd = 9;
          for (let x = m - 5; x <= m + 5; x++) if (nt.includes(pcOf(x)) && Math.abs(x - m) < bd && x !== m) { bd = Math.abs(x - m); target = x; }
          if (target !== null && Math.abs(target - m) >= 3 && Math.abs(target - m) <= 4) {
            const dir = Math.sign(target - m); let pass = m + dir; while (!SCALE_ALL.includes(pcOf(pass)) && pass !== target) pass += dir;
            if (pass !== target) segs = [[0, 3, m], [3, 1, pass]];
          }
        }
        for (const [beat, beats, midi] of segs) out[v].push({ bar, beat, beats, midi });
      }
      cur = next;
    });
    return out;
  };
  /** play voice notes on a track as legato sustains with a per-bar swell (dynFn gives the bar's level) */
  const playVoice = (notes, tr, art, dynFn, o = {}) => {
    let prevEnd = -1;
    for (const n of notes) {
      const t = T(n.bar, n.beat), dur = D(n.bar, n.beat, n.beats) * 0.99, t0 = T(n.bar), t1 = T(n.bar + 1), lv = dynFn(t0) + (o.k || 0);
      const dyn = swell(t0, t1, lv - 0.08, lv + 0.04, lv - 0.05, o.at ?? 0.6);
      add(tr, art, t, n.midi + 12 * (o.oct || 0), dur, { dyn, legato: o.legato !== false && Math.abs(t - prevEnd) < 0.05, vib: o.vib && n.beats >= 2 ? { delay: 0.4, rise: 0.7, depth: o.vib, rate: 5.3 } : undefined, gainDb: o.gainDb });
      prevEnd = t + dur / 0.99;
    }
  };
  /** rhythmic string figure under the harmony: 8ths alternating two inner voices (lower first), accents 3+3+2 */
  const figure = (vA, vB, bars, dynFn, o = {}) => {
    const at = (notes, bar, beat) => { let m = null; for (const n of notes) if (n.bar === bar && n.beat <= beat + 1e-6) m = n.midi; return m; };
    for (const bar of bars) for (let i = 0; i < 8; i++) {
      const b = i * 0.5, lo = at(vB, bar, b), hi = at(vA, bar, b); if (lo === null || hi === null) continue;
      const m = (i % 2 ? hi : lo) + 12 * (o.oct || 0), acc = [0, 3, 6].includes(i) ? 0.1 : -0.04;
      add('figure', o.art || 'vlaSpic', T(bar, b), m, D(bar, b, 0.5), { dyn: (tt) => dynFn(tt) + acc });
    }
  };
  /** low register: basses/celli/tuba on the chord bass; style 'sus' | 'drive' (8ths) | 'gallop' | 'pulse' (per = notes/beat) */
  const low = (bars, dynFn, style, per = 2) => {
    for (const bar of bars) {
      const v = voice(bar), b0 = v.bassLo, b1 = v.bass, t0 = T(bar), d4 = D(bar, 0, 4) * 0.99;
      if (style === 'sus') { add('cb', 'cbSus', t0, b0, d4, { dyn: plus(dynFn, -0.06) }); add('vcSus', 'vcSus', t0, b1, d4, { dyn: dynFn }); continue; }
      if (style === 'trem') { add('cb', 'cbTrem', t0, b0, d4, { dyn: plus(dynFn, -0.04) }); add('vcSus', 'vcTrem', t0, b1, d4, { dyn: dynFn }); continue; }
      const step = style === 'pulse' ? 1 / per : 0.5;
      for (let b = 0; b < 4; b += step) {
        const k = Math.round(b / step), acc = Math.abs(b % 1) < 1e-6 ? 0.08 : -0.05;
        let m = b1; if (style === 'gallop' && (k % 4 === 3)) m = b1 + 12; if (style === 'drive' && (k === 3 || k === 7)) m = b1 + 12;
        add('vc', 'vcSpic', T(bar, b), m, D(bar, b, step), { dyn: (tt) => dynFn(tt) + acc });
        if (Math.abs(b % 1) < 1e-6 || style === 'drive') add('cb', 'cbSpic', T(bar, b), b0, D(bar, b, step), { dyn: (tt) => dynFn(tt) + acc - 0.04 });
      }
      if (style === 'gallop') for (const b of [0.75, 2.75]) add('vc', 'vcSpic', T(bar, b), b1, D(bar, b, 0.25), { dyn: plus(dynFn, -0.08) });
    }
  };
  /** low brass ostinato: staccato trombones (bass + 8va) and tuba on 3+3+2, a 16th pickup into the next bar */
  const lowBrassOst = (bars, dynFn) => {
    for (const bar of bars) {
      const v = voice(bar), r = v.bass < P('E2') ? v.bass + 12 : v.bass;
      for (const [b, a] of [[0, 0.1], [1.5, 0], [3, 0.04]]) { add('lowOst', 'tbnStac', T(bar, b), r, 0.4, { dyn: (tt) => dynFn(tt) + a }); add('lowOst', 'tbnStac', T(bar, b), r + 7, 0.4, { dyn: (tt) => dynFn(tt) + a - 0.08 }); add('lowOst', 'tubaStac', T(bar, b), v.bassLo, 0.4, { dyn: (tt) => dynFn(tt) + a - 0.02 }); }
      add('lowOst', 'tbnStac', T(bar, 3.75), r, 0.2, { dyn: plus(dynFn, -0.08) });
    }
  };
  /** heavy percussion: taiko ensemble, bass drum on 1 and 3, anvil, timpani; heavy adds 16th doubles and stick 8ths */
  const heavy = (bar, lvl, o = {}) => {
    const tp = timpOf(bar), d1 = D(bar, 0, 1);
    add('taiko', 'taiko', T(bar), 55, d1, { dyn: lvl + 0.04 }); add('taiko', 'taiko', T(bar, 2.5), 56, d1, { dyn: lvl - 0.08 });
    add('bd', 'bassDrum', T(bar), 58, d1, { dyn: lvl }); add('timp', 'timp', T(bar), tp, d1, { dyn: lvl, release: 0.5 });
    if (o.level !== 'light') {
      add('taiko', 'taiko', T(bar, 1.5), 57, d1, { dyn: lvl - 0.12 }); add('taiko', 'taiko', T(bar, 3), 55, d1, { dyn: lvl - 0.02 }); add('taiko', 'taiko', T(bar, 3.75), 57, d1, { dyn: lvl - 0.16 });
      add('bd', 'bassDrum', T(bar, 2), 58, d1, { dyn: lvl - 0.1 }); add('timp', 'timp', T(bar, 2.5), tp, d1, { dyn: lvl - 0.1, release: 0.4 });
      add('anvil', 'anvil', T(bar), 60, 0.4, { dyn: lvl - 0.2 });
    }
    if (o.level === 'full') { for (let b = 0.5; b < 4; b += 1) add('drums', 'taikoStick', T(bar, b), 58, d1, { dyn: lvl - 0.26 }); add('anvil', 'anvil', T(bar, 2), 60, 0.4, { dyn: lvl - 0.3 }); }
    if (o.fill) mel('drums', 'tenorDrum', bar, 'r:3 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: lvl - 0.1 });
  };

  // ================================================================================================ URGENCY (7–18)
  {
    const dU = env([[T(7), 0.34], [T(11), 0.46], [T(15), 0.62], [T(18), 0.78], [T(19), 0.86]]);
    // the pulse lives low: violas, celli and basses on the beat, quarters -> 8ths -> 16ths
    for (const bar of range(7, 18)) {
      const per = bar < 11 ? 1 : bar < 15 ? 2 : 4;
      low([bar], (t) => dU(t) - 0.02, 'pulse', per);
      const v = voice(bar);
      for (let b = 0; b < 4; b += 1 / per) add('figure', 'vlaSpic', T(bar, b), v.vla - 12 >= P('C3') ? v.vla - 12 : v.vla, D(bar, b, 1 / per), { dyn: (tt) => dU(tt) - 0.08 + (Math.abs(b % 1) < 1e-6 ? 0.06 : -0.04) });
    }
    add('cb', 'cbSus', T(7), 'Eb1', D(7, 0, 32) * 0.99, { dyn: plus(dU, -0.12) }); // tonic pedal under bars 7–14
    add('tuba', 'tubaSus', T(7), 'Eb1', D(7, 0, 32) * 0.98, { dyn: plus(dU, -0.16) });
    // moving inner voices above the pulse (dark register), violins join on top from bar 13, horns double the middle
    const V = leadVoices(range(7, 18), { ranges: [[P('G3'), P('Eb5')], [P('Eb3'), P('Bb4')], [P('Bb2'), P('F4')], [P('G2'), P('Db4')]], anchors: ['Bb4', 'Eb5', 'Db5'] });
    playVoice(V[1].filter((n) => n.bar >= 9), 'vln2', 'vlnSus', (t) => dU(t) - 0.12);
    playVoice(V[2], 'vla', 'vlaSus', (t) => dU(t) - 0.1);
    playVoice(V[3], 'vcSus', 'vcSus', (t) => dU(t) - 0.12);
    playVoice(V[0].filter((n) => n.bar >= 13), 'vln1', 'vlnSus', (t) => dU(t) - 0.12, { vib: 9 });
    playVoice(V[2].filter((n) => n.bar >= 11), 'hnChord', 'hnSus', (t) => dU(t) - 0.12, { legato: false });
    playVoice(V[3].filter((n) => n.bar >= 13), 'tbnChord', 'tbnSus', (t) => dU(t) - 0.14, { legato: false });
    for (const bar of range(15, 18)) add('tuba', 'tubaSus', T(bar), voice(bar).bassLo, D(bar, 0, 4) * 0.97, { dyn: dU(T(bar)) - 0.1 });
    // the motif head creeps in (horns), then the trumpets
    mel('hn', 'hnSus', 13, 'Db4:1.5 Ab4:.5 Db5:2 | Ab4:1 Eb4:1 Bb4:1.8', { dyn: (t) => dU(t) + 0.02, legato: true });
    mel('hn', 'hnSus', 15, 'Eb4:1.5 Gb4:.5 Cb5:2 | Db5:1 Ab4:1 F5:1.8', { dyn: (t) => dU(t) + 0.04, legato: true });
    mel('tpt', 'tptSus', 17, 'Bb4:1.5 Eb5:.5 F5:2 | D5:2 F5:1 Bb5:1', { dyn: (t) => dU(t), legato: true, vib: { depth: 7 } });
    for (const bar of range(7, 18)) {
      add('timp', 'timp', T(bar), timpOf(bar), D(bar, 0, 1), { dyn: dU(T(bar)) - 0.06 });
      if (bar >= 11) heavy(bar, dU(T(bar)) - 0.1, { level: bar >= 15 ? 'heavy' : 'light', fill: bar === 14 || bar === 18 });
    }
    lowBrassOst(range(15, 18), (t) => dU(t) - 0.14);
    add('drums', 'snareRoll', T(17), 60, D(17, 0, 8) - 0.02, { dyn: ramp(T(17), T(19), 0.15, 0.6, 1.5), release: 0.05 });
    add('timp', 'timpRoll', T(18), 'F2', D(18, 0, 4) - 0.03, { dyn: ramp(T(18), T(19), 0.45, 0.88), release: 0.05 });
    add('cym', 'swellLong', T(19), 60, 1, { dyn: 0.7, release: 1.5 });
  }

  // ================================================================================================ PLUCKS in C minor (19–26)
  {
    const dP = env([[T(19), 0.72], [T(23), 0.68], [T(26), 0.76], [T(27), 0.8]]);
    add('bd', 'bassDrum', T(19), 58, D(19, 0, 2), { dyn: 0.8 }); add('anvil', 'anvil', T(19), 60, 0.5, { dyn: 0.6 }); add('gong', 'gong', T(19), 58, 4, { dyn: 0.45, release: 2.5 });
    for (const bar of range(19, 26)) {
      const v = voice(bar), d = dP(T(bar));
      [[0, v.bassLo], [1, v.bass], [2, v.bassLo], [3, v.bass + 7 - (v.bass + 7 > P('G3') ? 12 : 0)]].forEach(([b, m]) => { add('vc', 'vcPizz', T(bar, b), m, D(bar, b, 1), { dyn: d - (b ? 0.06 : 0) }); if (b % 2 === 0) add('cb', 'cbPizz', T(bar, b), m, D(bar, b, 1), { dyn: d - 0.02 }); });
      [v.vla - 12, v.vla, v.vln2 - 12, v.vla].forEach((m, k) => add('vln2', 'vlnPizz', T(bar, k + 0.5), m, D(bar, k + 0.5, 0.5), { dyn: d - 0.1 }));
      heavy(bar, d - 0.18, { level: 'light' });
    }
    const V = leadVoices(range(19, 26), { ranges: [[P('Eb4'), P('C5')], [P('Bb3'), P('G4')], [P('F3'), P('Eb4')], [P('C3'), P('Bb3')]], anchors: ['G4', 'C5'] });
    playVoice(V[1], 'vla', 'vlaSus', (t) => dP(t) - 0.16, { at: 0.55 });
    playVoice(V[2], 'vcSus', 'vcSus', (t) => dP(t) - 0.16, { at: 0.55 });
    playVoice(V[0], 'hnChord', 'hnSus', (t) => dP(t) - 0.16, { at: 0.55, legato: false });
    playVoice(V[3], 'tbnChord', 'tbnSus', (t) => dP(t) - 0.16, { at: 0.55, legato: false });
    for (const bar of range(19, 26)) add('tuba', 'tubaSus', T(bar), voice(bar).bassLo, D(bar, 0, 4) * 0.97, { dyn: swell(T(bar), T(bar + 1), dP(T(bar)) - 0.24, dP(T(bar)) - 0.12, dP(T(bar)) - 0.22) });
    add('timp', 'timpRoll', T(26), 'G2', D(26, 0, 4) - 0.03, { dyn: ramp(T(26), T(27), 0.35, 0.7), release: 0.05 });
  }

  // ================================================================================================ RETURN to Eb (27–34)
  {
    const dR = env([[T(27), 0.76], [T(31), 0.82], [T(34), 0.86], [T(35), 0.62]]);
    const V = leadVoices(range(27, 34), { anchors: ['Eb5', 'Gb5'] });
    playVoice(V[0], 'vln1', 'vlnSus', (t) => dR(t) - 0.14, { vib: 10 }); playVoice(V[1], 'vln2', 'vlnSus', (t) => dR(t) - 0.14);
    playVoice(V[2], 'hnChord', 'hnSus', (t) => dR(t) - 0.12, { legato: false }); playVoice(V[3], 'hnChord', 'hnSus', (t) => dR(t) - 0.14, { legato: false });
    figure(V[1], V[2], range(27, 34), (t) => dR(t) - 0.18, { oct: -1 });
    low(range(27, 30), (t) => dR(t) - 0.1, 'drive'); low(range(31, 34), (t) => dR(t) - 0.1, 'gallop');
    for (const bar of range(27, 34)) { add('tuba', 'tubaSus', T(bar), voice(bar).bassLo, D(bar, 0, 4) * 0.97, { dyn: dR(T(bar)) - 0.14 }); for (const m of voice(bar).tbn) add('tbnChord', 'tbnSus', T(bar), m, D(bar, 0, 4) * 0.97, { dyn: swell(T(bar), T(bar + 1), dR(T(bar)) - 0.24, dR(T(bar)) - 0.1, dR(T(bar)) - 0.2) }); }
    mel('hn', 'hnSus', 27, 'Eb4:1.5 Ab4:.5 C5:2 | Eb5:2 Bb4:2 | D5:1 Bb4:1 F5:2 | Gb5:1.5 Eb5:.5 Cb5:2 | F5:1 Db5:1 Ab4:2 | Cb5:1.5 Ab4:.5 Eb4:2 | Eb5:2 Bb4:2 | D5:3.6', { dyn: (t) => dR(t) - 0.02, legato: true, shape: 0.05, phrase: 0.04 });
    lowBrassOst(range(29, 34), (t) => dR(t) - 0.16);
    for (const bar of range(27, 34)) heavy(bar, dR(T(bar)) - 0.12, { level: bar < 31 ? 'heavy' : 'full', fill: bar === 30 || bar === 34 });
    add('cym', 'crash', T(27), 60, 2.5, { dyn: 0.7, release: 2 }); add('anvil', 'anvil', T(27), 60, 0.5, { dyn: 0.7 });
    add('cym', 'swell2', T(35) - 0.05, 60, 0.4, { dyn: 0.5, release: 1.2 });
  }

  // ================================================================================================ STRING SOLO (35–40), dark accompaniment
  {
    mel('solo', 'vlnSolo', 35, SOLO, { dyn: env([[T(35), 0.6], [T(37), 0.68], [T(38), 0.72], [T(40), 0.62], [T(41), 0.55]]), legato: true, shape: 0.07, phrase: 0.04, vib: { depth: 8, rate: 5.6 } });
    const V = leadVoices(range(35, 40), { ranges: [[P('Bb3'), P('Eb5')], [P('F3'), P('Bb4')], [P('C3'), P('F4')], [P('G2'), P('Db4')]], anchors: ['G4', 'C5'] });
    playVoice(V[1], 'vla', 'vlaTrem', () => 0.42); playVoice(V[2], 'vcSus', 'vcTrem', () => 0.42); playVoice(V[3], 'hnChord', 'hnSus', () => 0.36, { legato: false });
    for (const bar of range(35, 40)) { add('cb', 'cbSus', T(bar), voice(bar).bassLo, D(bar, 0, 4) * 0.99, { dyn: 0.42 }); add('taiko', 'taiko', T(bar), 55, D(bar, 0, 1), { dyn: 0.4 }); if (bar % 2 === 0) add('timp', 'timp', T(bar, 2.5), timpOf(bar), D(bar, 0, 1), { dyn: 0.38 }); }
    add('timp', 'timpRoll', T(40), 'F2', D(40, 0, 4) - 0.03, { dyn: ramp(T(40), T(41), 0.3, 0.86, 1.6), release: 0.05 });
    add('drums', 'snareRoll', T(40), 60, D(40, 0, 4) - 0.02, { dyn: ramp(T(40), T(41), 0.12, 0.55, 1.6), release: 0.05 });
    for (const m of voice(40).tbn) add('tbnChord', 'tbnSus', T(40, 1), m, D(40, 1, 3) - 0.03, { dyn: ramp(T(40, 1), T(41), 0.4, 0.86, 1.5) });
    mel('drums', 'tenorDrum', 40, 'r:2 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: 0.62 });
    add('cym', 'swellLong', T(41), 60, 1, { dyn: 0.75, release: 1.5 }); add('bd', 'bdRoll', T(41), 60, 0.3, { dyn: 0.55, release: 0.5 });
  }

  // ================================================================================================ LEITMOTIF waves (41–84)
  {
    const dL = env([[T(41), 0.92], [T(49), 0.94], [T(52, 2), 0.97], [T(53), 0.8], [T(57), 0.82], [T(61), 0.9], [T(63), 0.98], [T(71), 1.0], [T(75), 0.92], [T(79), 0.96], [T(84, 3), 0.94]]);
    add('cym', 'crash', T(41), 60, 3, { dyn: 0.9, release: 2 }); add('bd', 'bassDrum', T(41), 58, D(41, 0, 2), { dyn: 0.9 }); add('anvil', 'anvil', T(41), 60, 0.5, { dyn: 0.8 }); add('timp', 'timp', T(41), 'Eb2', D(41, 0, 2), { dyn: 0.95, release: 0.8 });
    // wave 1: theme (horns, trumpets from the 2nd half) + lift
    mel('hn', 'hnSus', 41, THEME, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, phrase: 0.05, accent: 0.03 });
    mel('tpt', 'tptSus', 45, THEME.split('|').slice(4).join('|'), { dyn: (t) => dL(t) - 0.1, legato: true, shape: 0.04, vib: { depth: 7 } });
    mel('tpt', 'tptSus', 49, LIFT, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, phrase: 0.04, vib: { depth: 8 } });
    mel('hn', 'hnSus', 49, oct(LIFT, -1), { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.04 });
    // wave 2: low unison — horns, celli and trombones carry the motif through the borrowed chords
    const W2 = 'Eb4:1.5 Cb4:.5 Ab4:2 | Gb4:1 Eb4:1 B4:2 | Bb4:2 Eb4:2 | D4:4 | Db4:1.5 Bb3:.5 Gb4:2 | F4:1 Ab4:1 Db5:2 | C5:1.5 G4:.5 Eb4:2 | G4:4 | F4:1.5 B3:.5 Ab4:2 | Eb4:2 D4:1.8';
    mel('hn', 'hnSus', 53, W2, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, phrase: 0.05, accent: 0.03 });
    mel('vcSus', 'vcSus', 53, oct(W2, -1), { dyn: (t) => dL(t) - 0.08, legato: true, shape: 0.05 });
    mel('tbnChord', 'tbnSus', 53, oct(W2, -1), { dyn: (t) => dL(t) - 0.14, legato: false, gate: 0.97 });
    // wave 3: tutti theme, trumpets lead
    add('gong', 'gong', T(63), 58, 5, { dyn: 0.8, release: 3 }); add('cym', 'crash', T(63), 60, 3, { dyn: 0.95, release: 2 });
    mel('tpt', 'tptSus', 63, THEME, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.04, phrase: 0.04, accent: 0.03, vib: { depth: 8 } });
    mel('hn', 'hnSus', 63, THEME, { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.04, phrase: 0.04 });
    mel('tpt', 'tptSus', 71, LIFT, { dyn: (t) => dL(t), legato: true, shape: 0.05, vib: { depth: 9 } });
    mel('hn', 'hnSus', 71, oct(LIFT, -1), { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.04 });
    // wave 4: driving — Cb – Db – Abm – Gb – Cb – Db – Bbsus4 – Bb – Cb – Db, the motif broadened
    mel('tpt', 'tptSus', 75, 'Eb5:2 Gb5:2 | F5:2 Ab5:2 | Eb5:2 Cb5:2 | Db5:2 Bb4:2 | Eb5:2 Gb5:2 | F5:2 Ab5:2 | Eb5:4 | D5:4 | Eb5:4 | F5:3.6', { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, vib: { depth: 8 } });
    mel('hn', 'hnSus', 75, 'Cb4:1.5 Gb4:.5 Eb5:2 | Db4:1.5 Ab4:.5 F5:2 | Ab3:1.5 Eb4:.5 Cb5:2 | Gb3:1.5 Db4:.5 Bb4:2 | Cb4:1.5 Gb4:.5 Eb5:2 | Db4:1.5 Ab4:.5 F5:2 | Eb4:4 | D4:4 | Eb4:4 | F4:3.6', { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.05, accent: 0.03 });
    // harmony: voice-led strings (top kept below Bb5: weight, not sweetness), horns on the middle voices
    const V = leadVoices(range(41, 84), { anchors: ['Bb4', 'Gb5', 'Eb5', 'Db5', 'G4', 'Bb4', 'Eb5', 'Gb5', 'Bb4', 'Eb5', 'Db5'] });
    playVoice(V[0], 'vln1', 'vlnSus', (t) => dL(t) - 0.16, { vib: 10 });
    playVoice(V[1].filter((n) => n.bar < 53 || n.bar > 62), 'vln2', 'vlnSus', (t) => dL(t) - 0.18);
    playVoice(V[2], 'hnChord', 'hnSus', (t) => dL(t) - 0.16, { legato: false }); playVoice(V[3], 'hnChord', 'hnSus', (t) => dL(t) - 0.18, { legato: false });
    figure(V[1], V[2], range(41, 84), (t) => dL(t) - 0.2, { oct: -1 });
    for (const bar of range(41, 84)) { const v = voice(bar); add('tuba', 'tubaSus', T(bar), v.bassLo, D(bar, 0, 4) * 0.97, { dyn: dL(T(bar)) - 0.12 });
      if (bar < 53 || bar > 62) for (const m of v.tbn) add('tbnChord', 'tbnSus', T(bar), m, D(bar, 0, 4) * 0.97, { dyn: swell(T(bar), T(bar + 1), dL(T(bar)) - 0.24, dL(T(bar)) - 0.12, dL(T(bar)) - 0.2) }); }
    low(range(41, 52), (t) => dL(t) - 0.12, 'gallop'); low(range(53, 62), (t) => dL(t) - 0.12, 'drive'); low(range(63, 84), (t) => dL(t) - 0.1, 'gallop');
    lowBrassOst([...range(41, 52), ...range(63, 84)], (t) => dL(t) - 0.16);
    for (const bar of range(41, 84)) heavy(bar, dL(T(bar)) - 0.1, { level: bar >= 53 && bar <= 58 ? 'heavy' : 'full', fill: bar % 4 === 0 });
    for (const bar of [45, 49, 53, 59, 67, 75, 79]) add('cym', 'crash', T(bar), 60, 2.5, { dyn: 0.66, release: 2 });
    for (const bar of [52, 62, 82]) add('drums', 'snareRoll', T(bar), 60, D(bar, 0, 4) - 0.02, { dyn: ramp(T(bar), T(bar + 1), 0.15, 0.58, 1.5), release: 0.05 });
    for (const bar of [53, 63, 83]) add('cym', 'swellMed', T(bar), 60, 0.6, { dyn: 0.55, release: 1.2 });
  }

  // ================================================================================================ FADE (85–90): the last swells die away, no closing chord
  {
    const dF = env([[T(85), 0.88], [T(86), 0.84], [T(87), 0.78], [T(88), 0.72], [T(89), 0.66], [T(90), 0.6], [T(91), 0.55]]); // the level falls through the renderer's fade (score.fade)
    const V = leadVoices(range(85, 90), { anchors: ['Gb5', 'Eb5'] });
    playVoice(V[0], 'vln1', 'vlnSus', (t) => dF(t) - 0.14, { vib: 9 }); playVoice(V[1], 'vln2', 'vlnSus', (t) => dF(t) - 0.14);
    playVoice(V[2], 'hnChord', 'hnSus', (t) => dF(t) - 0.12, { legato: false }); playVoice(V[3], 'hnChord', 'hnSus', (t) => dF(t) - 0.14, { legato: false });
    mel('hn', 'hnSus', 85, 'Eb5:2 Gb5:2 | F5:2 Ab5:2 | Gb5:4 | F5:4', { dyn: (t) => dF(t) - 0.02, legato: true, shape: 0.04 });
    figure(V[1], V[2], range(85, 87), (t) => dF(t) - 0.2, { oct: -1 });
    low(range(85, 88), (t) => dF(t) - 0.1, 'drive'); low([89, 90], (t) => dF(t) - 0.04, 'trem');
    for (const bar of range(85, 90)) { add('tuba', 'tubaSus', T(bar), voice(bar).bassLo, D(bar, 0, 4) * 0.97, { dyn: dF(T(bar)) - 0.12 }); if (bar <= 88) heavy(bar, dF(T(bar)) - 0.12, { level: bar <= 86 ? 'heavy' : 'light' }); }
    add('timp', 'timpRoll', T(89), 'Bb2', D(89, 0, 8) - 0.3, { dyn: env([[T(89), 0.5], [T(90), 0.46], [T(91), 0.42]]), release: 0.4 });
  }

  // the fade: a gain ramp to silence applied by the renderer to the dry mix and the reverb send (tails fold under bar 1)
  return { bpm: BPM, title: TITLE, totalBars: TOTAL_BARS, loopStart: T(1), loopEnd: T(TOTAL_BARS + 1), seam: 'circular', fade: [T(87), T(TOTAL_BARS + 1)],
    tracks, choir, sections: SECTIONS, tempo: TEMPO };
}
