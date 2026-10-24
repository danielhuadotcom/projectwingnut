// PROJECT WINGNUT — "Sortie" v2 (original composition, written as code): the main battle theme, rebuilt on the
// designer's arc (modelled on the proportions of a reference battle theme; measurements only, see NOTES.txt):
//   HIT -> URGENCY (pulsing strings, crescendo + accelerando) -> THEME PROGRESSION (plucked strings descend, orchestral
//   swells per chord) -> brief STRING SOLO -> LEITMOTIF in big swells -> RELEASE (decrescendo, ritardando) -> loop to HIT.
// Eb major. Heroic film vocabulary: borrowed bVI / bVII (Cb, Db) in I–bVI–bVII–I lifts, IV–V–vi deceptive turns into
// swells, the bIII (Gb) chromatic mediant, tonic and dominant pedals, sus4 -> 3 resolutions, added 9ths in the high
// strings. Wide voicing: tuba / basses / celli on roots, horns on 3rds and 5ths, violins on 9ths and suspensions.
// Tempo map (real accelerando): 108 BPM for the hit, ramping to 130 over the urgency section, 130 to the release, which
// slows to 110 into the loop. The loop is the whole piece: bar 1's tutti chord re-hits on every pass; the render folds
// the release's tails under it (circular render, as render_night.mjs).
//
//   bars  1–6   HIT: tutti Eb(add9) whole note, then horns proclaim the motif over an Eb pedal: Eb – Cb – Db – Eb
//   bars  7–18  URGENCY: soft on-beat string chords, quarters -> 8ths -> 16ths, pp -> f, 108 -> 130 BPM;
//               Eb pedal (Eb – Eb sus2 – Cm – Cm – Cb – Db) then Bb pedal (Eb/Bb – Ab/Bb – Cm/Bb – Gb/Bb – Bbsus4 – Bb)
//   bars 19–34  THEME PROGRESSION: pizzicato + arco strings walk down Eb – Bb/D – Cm – Cm/Bb – Ab – Eb/G – Fm7 – Bbsus4,
//               then the theme's progression with brass/string swells on every chord
//   bars 35–40  STRING SOLO: solo violin over harp and soft low strings (Cm – Ab – Eb/G – Ab – Fm – Bbsus4)
//   bars 41–84  LEITMOTIF in four swell waves (theme + Cb–Db–Eb lift / deceptive turns + G-major mediant / tutti theme
//               with choir / Ab – Bbsus4 – Cm – Gb – Ab – Bbsus4 – Eb arrival)
//   bars 85–90  RELEASE: Ab – Abm6 – Eb/G – Fm7 – Bbsus4 – Bb, decrescendo + ritardando -> bar 1
//
// THE MOTIF (2 bars): Eb – Bb – Eb' | D – Bb – F'   (up a 5th, up a 4th = an octave in two leaps; then down and a leap
// of a 6th onto the 9th). The full theme continues in falling and rising arpeggio leaps; its lift (Cb – Db – Eb) ends on
// a high Bb over the tonic.
import { hash32 } from './lib/dsp.mjs';
import { P, env } from './score.mjs';

export const TITLE = 'Sortie';
export const TOTAL_BARS = 90;
export const OFFSET = 0.5; // s of silence before bar 1 (pre-attacks of the hit), folded onto the loop end by the render
// ------------------------------------------------------------------------------------------------ tempo map
const TEMPO = [[0, 108], [6, 108], [18, 130], [84, 130], [90, 110]]; // [bar position (bars from bar 1), BPM], linear
const bpmAt = (bp) => { for (let i = 1; i < TEMPO.length; i++) if (bp <= TEMPO[i][0]) { const [a, x] = TEMPO[i - 1], [b, y] = TEMPO[i]; return x + (y - x) * (bp - a) / (b - a); } return TEMPO[TEMPO.length - 1][1]; };
const RES = 32, CUM = new Float64Array(TOTAL_BARS * 4 * RES + 2); // seconds at every 1/32 beat
for (let k = 1; k < CUM.length; k++) { const bp = ((k - 0.5) / RES) / 4; CUM[k] = CUM[k - 1] + 60 / bpmAt(bp) / RES; }
/** absolute time (s) of (bar, beat) under the tempo map (bars from 1) */
export const T = (bar, beat = 0) => { const x = ((bar - 1) * 4 + beat) * RES, i = Math.max(0, Math.min(CUM.length - 2, Math.floor(x))), f = x - i; return OFFSET + CUM[i] + (CUM[i + 1] - CUM[i]) * f; };
/** duration (s) of `beats` beats starting at (bar, beat) */
const D = (bar, beat, beats) => T(bar, beat + beats) - T(bar, beat);
export const BPM = 130;
export const SECTIONS = [['hit', 1, 7], ['urgency', 7, 19], ['progression', 19, 35], ['solo', 35, 41], ['wave1', 41, 53], ['wave2', 53, 63], ['wave3', 63, 75], ['wave4', 75, 85], ['release', 85, 91]];

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
setp(7, 'Eb Ebsus2 Cm Cm Cb Db Eb/Bb Ab/Bb Cm/Bb Gb/Bb Bbsus4 Bb');
setp(19, 'Eb Bb/D Cm Cm/Bb Ab Eb/G Fm7 Bbsus4 Eb Bb/D Cm Ab Eb/G Ab Bbsus4 Bb');
setp(35, 'Cm Ab Eb/G Ab Fm Bbsus4');
setp(41, 'Eb Bb/D Cm Ab Eb/G Ab Bbsus4 Bb Cb Db Eb Eb');
setp(53, 'Ab Bb Cm Cm Ab Bb G G Cm Bbsus4');
setp(63, 'Eb Bb/D Cm Ab Eb/G Ab Bbsus4 Bb Cb Db Eb Eb');
setp(75, 'Ab Bbsus4 Cm Gb Ab Bbsus4 Bb Bb Eb Eb');
setp(85, 'Ab Abm6 Eb/G Fm7 Bbsus4 Bb7');
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
export const THEME = 'Eb4:1.5 Bb4:.5 Eb5:2 | D5:1 Bb4:1 F5:2 | G5:1.5 Eb5:.5 C5:2 | Bb4:1 Ab4:1 Eb5:2 | G4:1.5 Eb5:.5 D5:1 Bb4:1 | C5:1.5 Ab4:.5 Eb5:2 | Eb5:2 D5:2 | F5:3.6';
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

  // ================================================================================================ URGENCY (7–18): pulse, crescendo, accelerando
  {
    const dU = env([[T(7), 0.34], [T(11), 0.46], [T(15), 0.62], [T(18), 0.78], [T(19), 0.86]]);
    for (const bar of range(7, 18)) pulse(bar, bar < 11 ? 1 : bar < 15 ? 2 : 4, (t) => dU(t) - 0.04);
    // pedals: low strings + tuba on Eb (7–12), Bb (13–18), swelling
    add('cb', 'cbSus', T(7), 'Eb1', D(7, 0, 24) * 0.99, { dyn: plus(dU, -0.1) }); add('cb', 'cbSus', T(13), 'Bb1', D(13, 0, 24) * 0.98, { dyn: plus(dU, -0.08) });
    add('tuba', 'tubaSus', T(13), 'Bb1', D(13, 0, 24) * 0.98, { dyn: plus(dU, -0.12) });
    // horns: 3rd/5th pads from bar 11; the motif head creeps in (13, 15, 17)
    for (const bar of range(11, 18)) for (const m of voice(bar).hn) add('hnChord', 'hnSus', T(bar), m, D(bar, 0, 4) * 0.97, { dyn: swell(T(bar), T(bar + 1), dU(T(bar)) - 0.16, dU(T(bar)) - 0.08, dU(T(bar)) - 0.14) });
    mel('hn', 'hnSus', 13, 'Eb4:1.5 Bb4:.5 Eb5:2 | C5:1 Ab4:1 Eb5:1.8', { dyn: (t) => dU(t) + 0.02, legato: true });
    mel('hn', 'hnSus', 15, 'Eb4:1.5 C5:.5 G5:2 | Gb5:1 Db5:1 Bb4:1.8', { dyn: (t) => dU(t) + 0.04, legato: true });
    mel('tpt', 'tptSus', 17, 'Bb4:1.5 Eb5:.5 F5:2 | F5:2 F5:1 Bb5:1', { dyn: (t) => dU(t), legato: true, vib: { depth: 8 } });
    for (const bar of range(13, 18)) for (const m of voice(bar).tbn) add('tbnChord', 'tbnSus', T(bar), m, D(bar, 0, 4) * 0.97, { dyn: dU(T(bar)) - 0.14 });
    // high violins hold the 9ths / suspensions above the pulse from bar 11
    for (const bar of range(11, 18)) add('vln1', 'vlnSus', T(bar), voice(bar).vln1, D(bar, 0, 4) * 0.99, { dyn: dU(T(bar)) - 0.14, vib: { delay: 0.4, rise: 0.8, depth: 10, rate: 5.3 } });
    // percussion grows: timpani on beats, then taiko, rolls into the progression
    for (const bar of range(7, 18)) {
      add('timp', 'timp', T(bar), timpOf(bar), D(bar, 0, 1), { dyn: dU(T(bar)) - 0.08 });
      if (bar >= 11) add('timp', 'timp', T(bar, 2), timpOf(bar), D(bar, 0, 1), { dyn: dU(T(bar)) - 0.14 });
      if (bar >= 13) { add('taiko', 'taiko', T(bar), 56, D(bar, 0, 1), { dyn: dU(T(bar)) - 0.1 }); add('bd', 'bassDrum', T(bar), 60, D(bar, 0, 1), { dyn: dU(T(bar)) - 0.14 }); }
      if (bar >= 15) for (const b of [1, 3]) add('drums', 'taikoStick', T(bar, b), 58, D(bar, 0, 1), { dyn: dU(T(bar)) - 0.24 });
    }
    add('drums', 'snareRoll', T(17), 60, D(17, 0, 8) - 0.02, { dyn: ramp(T(17), T(19), 0.15, 0.62, 1.5), release: 0.05 });
    add('timp', 'timpRoll', T(18), 'F2', D(18, 0, 4) - 0.03, { dyn: ramp(T(18), T(19), 0.45, 0.88), release: 0.05 });
    add('cym', 'swellLong', T(19), 60, 1, { dyn: 0.75, release: 1.5 });
    harpGliss(18, 2, 'Bb2', 'Bb5', 2, [10, 0, 2, 3, 5, 7, 8], 0.55);
  }

  // ================================================================================================ THEME PROGRESSION (19–34)
  {
    // 19–26: plucked + bowed strings walk down Eb – Bb/D – Cm – Cm/Bb – Ab – Eb/G – Fm7 – Bbsus4; a swell on each chord
    const dP = env([[T(19), 0.74], [T(23), 0.7], [T(27), 0.8], [T(31), 0.84], [T(34, 3), 0.8]]);
    add('cym', 'crash', T(19), 60, 2.5, { dyn: 0.75, release: 2 }); add('bd', 'bassDrum', T(19), 58, D(19, 0, 2), { dyn: 0.8 }); add('anvil', 'anvil', T(19), 60, 0.5, { dyn: 0.6 });
    for (const bar of range(19, 26)) {
      const v = voice(bar), d = dP(T(bar));
      // pizzicato: basses + celli on the beats (root, octave, fifth), violins pizz arpeggio on the off-beats
      [[0, v.bassLo], [1, v.bass], [2, v.bassLo], [3, v.bass + 7 - (v.bass + 7 > P('G3') ? 12 : 0)]].forEach(([b, m]) => { add('vc', 'vcPizz', T(bar, b), m, D(bar, b, 1), { dyn: d - (b ? 0.06 : 0) }); if (b % 2 === 0) add('cb', 'cbPizz', T(bar, b), m, D(bar, b, 1), { dyn: d - 0.04 }); });
      [v.vla + 12, v.vln2, v.vln1 - 12, v.vln2].forEach((m, k) => add('vln2', 'vlnPizz', T(bar, k + 0.5), m, D(bar, k + 0.5, 0.5), { dyn: d - 0.12 }));
      swellChord(bar, d - 0.06, { strings: true, at: 0.55 });
    }
    // 27–34: the theme's progression, swells per chord, string ostinato grows, motif hinted in horns
    for (const bar of range(27, 34)) swellChord(bar, dP(T(bar)), { at: 0.6 });
    ost16('vla', 'vlaSpic', range(27, 34), (t) => dP(t) - 0.2);
    gallop(range(31, 34), (t) => dP(t) - 0.14);
    mel('hn', 'hnSus', 27, oct(THEME, 0).split('|').slice(0, 4).join('|'), { dyn: (t) => dP(t) - 0.06, legato: true, shape: 0.05 });
    for (const bar of range(27, 33)) drums(bar, dP(T(bar)) - 0.16, bar >= 31);
    add('timp', 'timpRoll', T(34), 'F2', D(34, 0, 4) - 0.2, { dyn: ramp(T(34), T(35) - 0.2, 0.5, 0.8), release: 0.4 });
    add('cym', 'swell2', T(35) - 0.05, 60, 0.4, { dyn: 0.55, release: 1.2 });
  }

  // ================================================================================================ STRING SOLO (35–40)
  {
    mel('solo', 'vlnSolo', 35, SOLO, { dyn: env([[T(35), 0.6], [T(37), 0.68], [T(38), 0.72], [T(40), 0.62], [T(41), 0.55]]), legato: true, shape: 0.07, phrase: 0.04, vib: { depth: 8, rate: 5.6 } });
    for (const bar of range(35, 40)) {
      const v = voice(bar);
      harpArp(bar, 0.42);
      add('vcSus', 'vcSus', T(bar), v.bass, D(bar, 0, 4) * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.4, 0.5, 0.42) });
      add('cb', 'cbSus', T(bar), v.bassLo, D(bar, 0, 4) * 0.99, { dyn: 0.4 });
      add('vla', 'vlaSus', T(bar), v.vla, D(bar, 0, 4) * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.32, 0.42, 0.34) });
      for (const m of v.hn) add('hnChord', 'hnSus', T(bar), m, D(bar, 0, 4) * 0.97, { dyn: 0.36 });
    }
    // bar 40: the build back (Bbsus4 -> Bb): timpani roll, swell, harp sweep
    add('timp', 'timpRoll', T(40), 'F2', D(40, 0, 4) - 0.03, { dyn: ramp(T(40), T(41), 0.3, 0.86, 1.6), release: 0.05 });
    add('drums', 'snareRoll', T(40), 60, D(40, 0, 4) - 0.02, { dyn: ramp(T(40), T(41), 0.12, 0.55, 1.6), release: 0.05 });
    for (const m of voice(40).tbn) add('tbnChord', 'tbnSus', T(40, 1), m, D(40, 1, 3) - 0.03, { dyn: ramp(T(40, 1), T(41), 0.4, 0.86, 1.5) });
    harpGliss(40, 2, 'Bb2', 'Bb6', 2, [10, 0, 2, 3, 5, 7, 8], 0.55);
    add('cym', 'swellLong', T(41), 60, 1, { dyn: 0.8, release: 1.5 }); add('bd', 'bdRoll', T(41), 60, 0.3, { dyn: 0.55, release: 0.5 });
  }

  // ================================================================================================ LEITMOTIF (41–84), four swell waves
  {
    const dL = env([[T(41), 0.92], [T(49), 0.94], [T(52, 2), 0.98], [T(53), 0.8], [T(57), 0.82], [T(61), 0.9], [T(63), 0.98], [T(71), 1.0], [T(75), 0.9], [T(79), 0.94], [T(83), 1.0], [T(84, 3), 0.88]]);
    // wave 1 (41–52): the theme + its Cb – Db – Eb lift
    add('cym', 'crash', T(41), 60, 3, { dyn: 0.95, release: 2 }); add('bd', 'bassDrum', T(41), 58, D(41, 0, 2), { dyn: 0.9 }); add('anvil', 'anvil', T(41), 60, 0.5, { dyn: 0.75 }); add('timp', 'timp', T(41), 'Eb2', D(41, 0, 2), { dyn: 0.95, release: 0.8 });
    mel('hn', 'hnSus', 41, THEME, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, phrase: 0.05, accent: 0.03 });
    mel('tpt', 'tptSus', 45, THEME.split('|').slice(4).join('|'), { dyn: (t) => dL(t) - 0.08, legato: true, shape: 0.04, vib: { depth: 8 } });
    mel('tpt', 'tptSus', 49, LIFT, { dyn: (t) => dL(t), legato: true, shape: 0.05, phrase: 0.04, vib: { depth: 9 } });
    mel('hn', 'hnSus', 49, oct(LIFT, -1), { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.04 });
    // wave 2 (53–62): deceptive turns Ab – Bb – Cm, the G-major mediant, Cm – Bbsus4; violins carry the motif
    mel('vln1', 'vlnSus', 53, 'Eb5:1.5 Ab5:.5 C6:2 | D6:1 Bb5:1 F6:2 | Eb6:1.5 G5:.5 C6:2 | C6:4 | Eb5:1.5 Ab5:.5 C6:2 | D6:1 F6:1 Bb6:2 | B5:1.5 G5:.5 D6:2 | D6:4 | C6:1.5 G5:.5 Eb6:2 | Eb6:2 D6:1.8',
      { dyn: (t) => dL(t) - 0.06, legato: true, shape: 0.06, phrase: 0.05, vib: { depth: 13 }, gainDb: 1.5 });
    mel('hn', 'hnSus', 53, 'C4:1.5 Eb4:.5 Ab4:2 | Bb4:2 D5:2 | Eb5:2 C5:2 | G4:4 | C4:1.5 Eb4:.5 Ab4:2 | Bb4:2 F4:2 | G4:2 B4:2 | D5:4 | C5:2 G4:2 | Ab4:2 F4:1.8', { dyn: (t) => dL(t) - 0.12, legato: true, shape: 0.05 });
    // wave 3 (63–74): tutti theme, trumpets lead, choir, violin descant on 9ths
    add('gong', 'gong', T(63), 58, 5, { dyn: 0.75, release: 3 }); add('cym', 'crash', T(63), 60, 3, { dyn: 1.0, release: 2 }); add('anvil', 'anvil', T(63), 60, 0.5, { dyn: 0.8 });
    mel('tpt', 'tptSus', 63, THEME, { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.04, phrase: 0.04, accent: 0.03, vib: { depth: 9 } });
    mel('hn', 'hnSus', 63, THEME, { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.04, phrase: 0.04 });
    mel('tpt', 'tptSus', 71, LIFT, { dyn: (t) => dL(t), legato: true, shape: 0.05, vib: { depth: 10 } });
    mel('hn', 'hnSus', 71, oct(LIFT, -1), { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.04 });
    mel('fl', 'flSus', 71, 'Eb6:4 | F6:4 | G6:4 | Bb6:3.6', { dyn: 0.7, legato: true });
    // wave 4 (75–84): Ab – Bbsus4 – Cm – Gb – Ab – Bbsus4 – Bb – Bb – Eb arrival; motif in augmentation
    mel('tpt', 'tptSus', 75, 'Eb5:2 Bb5:2 | Bb5:2 Ab5:2 | G5:2 Eb5:2 | Gb5:2 Db5:2 | C5:2 Eb5:2 | Eb5:4 | D5:2 F5:2 | Bb5:4 | Bb5:4 | G5:3.6', { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, vib: { depth: 9 } });
    mel('hn', 'hnSus', 75, 'Eb4:1.5 Bb4:.5 Eb5:2 | Eb5:2 D5:2 | Eb4:1.5 C5:.5 G5:2 | Db5:1.5 Bb4:.5 Gb5:2 | C5:1.5 Ab4:.5 Eb5:2 | Eb5:4 | D5:1 Bb4:1 F5:2 | F5:4 | Eb5:4 | Eb5:3.6', { dyn: (t) => dL(t) - 0.04, legato: true, shape: 0.05, accent: 0.03 });
    add('gong', 'gong', T(83), 58, 5, { dyn: 0.85, release: 3 }); add('cym', 'crash', T(83), 60, 4, { dyn: 1.0, release: 2.5 });
    // harmony and engine for all waves
    for (const bar of range(41, 84)) swellChord(bar, dL(T(bar)) - 0.06, { at: ch(bar).q === 'sus4' ? 0.5 : 0.62 });
    for (const bar of [...range(63, 74), 83, 84]) choirBar(bar, (t) => dL(t) - 0.12);
    ost16('vla', 'vlaSpic', range(41, 84), (t) => dL(t) - 0.2);
    ost16('vln2', 'vlnSpic', [...range(45, 52), ...range(63, 82)], (t) => dL(t) - 0.24, 1);
    gallop(range(41, 84), (t) => dL(t) - 0.12);
    for (const bar of range(41, 84)) drums(bar, dL(T(bar)) - (bar >= 53 && bar <= 60 ? 0.2 : 0.1), !(bar >= 53 && bar <= 58));
    for (const bar of range(41, 84)) if (bar % 2 === 1) add('anvil', 'anvil', T(bar), 60, 0.5, { dyn: 0.55 });
    for (const bar of [44, 48, 52, 62, 66, 70, 74, 78, 82]) mel('timp', 'timp', bar, `r:3 ${timpOf(bar)}:.25 ${timpOf(bar)}:.25 ${timpOf(bar + 1)}:.25 ${timpOf(bar + 1)}:.25`, { dyn: 0.82 });
    for (const bar of [45, 53, 59, 67, 75, 79]) add('cym', 'crash', T(bar), 60, 2.5, { dyn: 0.7, release: 2 });
    for (const [bar, from, to, pcs] of [[52, 'Eb3', 'Eb6', EBMAJ], [62, 'Bb2', 'Bb5', [10, 0, 2, 3, 5, 7, 8]], [74, 'Ab2', 'Ab5', EBMAJ], [82, 'Bb2', 'Bb6', [10, 0, 2, 3, 5, 7, 8]]]) harpGliss(bar, 2, from, to, 2, pcs, 0.58);
    for (const bar of [52, 62, 82]) add('drums', 'snareRoll', T(bar), 60, D(bar, 0, 4) - 0.02, { dyn: ramp(T(bar), T(bar + 1), 0.15, 0.6, 1.5), release: 0.05 });
    for (const bar of [53, 63, 83]) add('cym', 'swellMed', T(bar), 60, 0.6, { dyn: 0.6, release: 1.2 });
  }

  // ================================================================================================ RELEASE (85–90): decrescendo + ritardando
  {
    const dR = env([[T(85), 0.74], [T(87), 0.58], [T(89), 0.44], [T(90, 3), 0.3]]);
    for (const bar of range(85, 90)) swellChord(bar, dR(T(bar)), { at: 0.45 });
    mel('hn', 'hnSus', 85, 'Eb5:2 C5:2 | Cb5:2 Ab4:2 | G4:1.5 Bb4:.5 Eb5:2 | Ab4:4 | Eb4:4 | D4:3.6', { dyn: (t) => dR(t) + 0.04, legato: true, shape: 0.05 });
    mel('vln1', 'vlnSus', 85, 'Bb5:4 | Cb6:4 | Bb5:4 | Ab5:4 | Ab5:4 | Ab5:3.6', { dyn: (t) => dR(t) - 0.08, legato: true, vib: { depth: 10 } });
    gallop(range(85, 86), (t) => dR(t) - 0.16);
    for (const bar of range(85, 88)) { add('timp', 'timp', T(bar), timpOf(bar), D(bar, 0, 1), { dyn: dR(T(bar)) - 0.1 }); add('bd', 'bassDrum', T(bar), 60, D(bar, 0, 1), { dyn: dR(T(bar)) - 0.16 }); }
    add('timp', 'timpRoll', T(89), 'Bb2', D(89, 0, 8) - 0.3, { dyn: env([[T(89), 0.3], [T(90), 0.22], [T(90, 3.5), 0.28]]), release: 0.2 });
  }

  return { bpm: BPM, title: TITLE, totalBars: TOTAL_BARS, loopStart: T(1), loopEnd: T(TOTAL_BARS + 1), seam: 'circular', tracks, choir, sections: SECTIONS, tempo: TEMPO };
}
