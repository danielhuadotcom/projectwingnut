// PROJECT WINGNUT — "Ceiling Unlimited" (original composition, written as code).
// 128 BPM, 4/4. D major home key; climax lifts a minor third to F major (prepared by Bb–C, i.e. IV–V of F);
// the bridge sinks to D minor and the signature cadence Bb–C (bVI–bVII of D) carries us back to D major.
//
//   bars  1–2   intro: solo horn states the motif over a D pedal (not part of the loop)
//   bars  3–4   LEAD: rising motif in brass, swell, timpani roll  ─┐ identical copies (seeds, dynamics, notes) so the
//   bars  5–20  A: spiccato ostinato + low-brass motif (1-2-5)      │ loop wrap 64→5 hears exactly what 4→5 heard,
//   bars 21–36  B: soaring horn theme over sustained strings,       │ including reverb pre-roll.
//               rising sequence G–A–Bb–C                            │
//   bars 37–52  climax in F: horns+trumpets theme, brass chorale,   │
//               string descant, choir, timpani, cymbals, gong       │
//   bars 53–62  bridge in D minor: horn solo, violins, rebuild      │
//   bars 63–64  LEAD (copy 2)  ─────────────────────────────────────┘
//   loop = [bar 5, bar 65) = [7.5 s, 120 s)
//
// The core motif is three notes, scale degrees 1-2-5 (e.g. D-E-A), answered by 4-3-1; it is used in tresillo
// rhythm (3+3+2 eighths) in the low brass, broadened into the horn theme, and sequenced upward at every build.
import { hash32 } from './lib/dsp.mjs';

export const BPM = 128;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const TOTAL_BARS = 64;
export const LOOP_START_BAR = 5, LOOP_END_BAR = 65;
export const TITLE = 'Ceiling Unlimited';
export const T = (bar, beat = 0) => ((bar - 1) * 4 + beat) * BEAT;

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function P(name) {
  if (typeof name === 'number') return name;
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error('bad pitch ' + name);
  return 12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

// ------------------------------------------------------------------------------------------------ dynamics helpers
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** piecewise-linear dynamics over absolute time: pts = [[t, d], ...] */
export function env(pts) {
  return (t) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [t0, d0] = pts[i - 1], [t1, d1] = pts[i]; return d0 + (d1 - d0) * (t - t0) / (t1 - t0); }
    return pts[pts.length - 1][1];
  };
}
const ramp = (t0, t1, d0, d1, curve = 1) => (t) => d0 + (d1 - d0) * Math.pow(clamp01((t - t0) / (t1 - t0)), curve);
/** swell: d0 -> peak (at fraction `at`) -> d1 over [t0, t1] */
const swell = (t0, t1, d0, peak, d1, at = 0.6) => env([[t0, d0], [t0 + (t1 - t0) * at, peak], [t1, d1]]);
const plus = (f, k) => (t) => f(t) + k;

// ------------------------------------------------------------------------------------------------ score container
export function buildScore() {
  const tracks = {};
  const track = (name, opts) => { tracks[name] = { name, notes: [], ...opts }; };

  // --- mix / staging (pan: -1 L .. +1 R; send = reverb send; ensemble = doubled players) ---
  track('vln1', { bus: 'str', pan: -0.55, width: 0.6, gainDb: 0, send: 0.30, eq: [['highpass', 160], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 3 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 } });
  track('vln2', { bus: 'str', pan: -0.25, width: 0.6, gainDb: -1, send: 0.30, eq: [['highpass', 150], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 2.5 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 } });
  track('vla', { bus: 'str', pan: 0.2, width: 0.55, gainDb: -2, send: 0.27, eq: [['highpass', 110], ['peak', 300, { q: 1, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.16 } });
  track('vc', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1, send: 0.25, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -1.5 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.18 } });
  track('vcSus', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1, send: 0.27, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -1.5 }]] });
  track('cb', { bus: 'str', pan: 0.65, width: 0.35, gainDb: -4, send: 0.22, eq: [['highpass', 32], ['peak', 180, { q: 1, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.03, detune: 2 },
    ensemble: [{}, { detune: 7, delay: 0.011, alt: 1, pan: 0.08, gainDb: -2 }], choke: { release: 0.2 } });
  track('hn', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: -1, send: 0.42, eq: [['highpass', 70], ['peak', 420, { q: 1, gainDb: -2 }], ['peak', 2400, { q: 0.8, gainDb: 2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.013, alt: 1, pan: 0.12, gainDb: -1 }, { detune: -7, delay: 0.021, alt: -1, pan: -0.12, gainDb: -1.5 }], legatoOffset: 0.09, legatoAttack: 0.06 });
  track('hnSolo', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: 1, send: 0.48, eq: [['highpass', 70]], humanize: { time: 0.006, dyn: 0.02, detune: 2 }, legatoOffset: 0.09, legatoAttack: 0.07 });
  track('hnChord', { bus: 'brass', pan: -0.35, width: 0.7, gainDb: -4, send: 0.45, eq: [['highpass', 70]], humanize: { time: 0.008, dyn: 0.03, detune: 3 } });
  track('tpt', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: 0.5, send: 0.4, eq: [['highpass', 120], ['peak', 2800, { q: 0.8, gainDb: 1.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: -6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.07, legatoAttack: 0.05 });
  track('tptStab', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: -6, send: 0.38, eq: [['highpass', 150]], humanize: { time: 0.005, dyn: 0.04, detune: 3 } });
  track('tbn', { bus: 'brass', pan: 0.3, width: 0.6, gainDb: 0.5, send: 0.4, eq: [['highpass', 55], ['peak', 300, { q: 0.9, gainDb: -1.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.08, legatoAttack: 0.05 });
  track('tbnChord', { bus: 'brass', pan: 0.32, width: 0.7, gainDb: -3, send: 0.42, eq: [['highpass', 60], ['peak', 300, { q: 0.9, gainDb: -1.5 }]], humanize: { time: 0.007, dyn: 0.03, detune: 3 } });
  track('tuba', { bus: 'brass', pan: 0.45, width: 0.4, gainDb: 0, send: 0.35, eq: [['highpass', 30], ['peak', 160, { q: 1, gainDb: -1.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 2 } });
  track('timp', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: 1, send: 0.35, eq: [['highpass', 30], ['lowshelf', 90, { gainDb: 2 }]], humanize: { time: 0.003, dyn: 0.03, detune: 0 } });
  track('bd', { bus: 'perc', pan: 0.05, width: 0.7, gainDb: 2, send: 0.3, eq: [['highpass', 28], ['lowshelf', 70, { gainDb: 2 }]], humanize: { time: 0.003, dyn: 0.02, detune: 0 } });
  track('taiko', { bus: 'perc', pan: 0.0, width: 0.8, gainDb: 2, send: 0.3, eq: [['highpass', 35], ['lowshelf', 80, { gainDb: 2 }], ['highshelf', 5000, { gainDb: -3 }]], humanize: { time: 0.004, dyn: 0.03, detune: 0 } });
  track('drums', { bus: 'perc', pan: -0.1, width: 0.8, gainDb: -4, send: 0.33, eq: [['highpass', 60]], humanize: { time: 0.004, dyn: 0.04, detune: 0 } });
  track('cym', { bus: 'perc', pan: -0.2, width: 0.9, gainDb: -8, send: 0.42, eq: [['highpass', 300]], humanize: { time: 0.002, dyn: 0.02, detune: 0 } });
  track('gong', { bus: 'perc', pan: 0.25, width: 0.9, gainDb: -6, send: 0.45, eq: [['highpass', 40]], humanize: { time: 0, dyn: 0, detune: 0 } });
  track('harp', { bus: 'str', pan: -0.65, width: 0.6, gainDb: -13, send: 0.45, eq: [['highpass', 80]], humanize: { time: 0.006, dyn: 0.05, detune: 1 } });
  track('fl', { bus: 'winds', pan: -0.1, width: 0.5, gainDb: -8, send: 0.42, eq: [['highpass', 250]], humanize: { time: 0.005, dyn: 0.03, detune: 2 } });
  const choir = []; // synthesized separately

  // --- note entry ---
  // seed is derived from (track, block, time-within-block, pitch) so the two LEAD copies render bit-identically
  let BLOCK = { name: 'main', t0: 0 };
  const add = (tr, art, t, midi, dur, o = {}) => {
    const m = P(midi);
    const local = Math.round((t - BLOCK.t0) * 1000);
    tracks[tr].notes.push({ art, midi: m, t, dur, dyn: o.dyn ?? 0.7, seed: hash32(tr, BLOCK.name, local, m, o.v || 0),
      legato: !!o.legato, attack: o.attack, release: o.release, offset: o.offset, gainDb: o.gainDb, advance: o.advance, pan: o.pan });
  };
  /** melodic line from "D4:1 E4:.5 A4:2.5 | ..." starting at (bar, beat); r = rest; [A3,C4] = chord */
  const mel = (tr, art, bar, str, o = {}) => {
    let beat = 0, first = true;
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = d.split('+').reduce((a, x) => a + parseFloat(x), 0); // durations like 1.5 or 2+2
      if (p !== 'r') {
        const t = T(bar, beat) + (o.shift || 0);
        const dur = beats * BEAT * (o.gate ?? 1);
        const pitches = p.startsWith('[') ? p.slice(1, -1).split(',') : [p];
        let dyn = o.dyn;
        if (o.shape && beats >= 1.5) { // messa di voce on long notes: a little swell through the middle of the note
          const base = typeof dyn === 'function' ? dyn : () => (dyn ?? 0.7), t0n = t, dn = dur, k = o.shape === true ? 0.05 : o.shape;
          dyn = (tt) => base(tt) + k * Math.sin(Math.PI * Math.max(0, Math.min(1, (tt - t0n) / dn)));
        }
        pitches.forEach((pp, k) => add(tr, art, t, pp, dur, { ...o, dyn, v: k, legato: o.legato && !first }));
        first = false;
      } else first = true;
      beat += beats;
    }
    return beat;
  };
  const tresillo = [0, 1.5, 3];

  // ------------------------------------------------------------------------------------------------ harmony table
  // per bar: ostinato cell [pedal, a, b, c] (viola octave), cello root (octave 3), bass root (sounding), timpani note
  const H = {};
  const set = (bars, chord, ost, vc, cb, timp, timp5) => { for (const b of [].concat(bars)) H[b] = { chord, ost: ost.map(P), vc: P(vc), cb: P(cb), timp: P(timp), timp5: P(timp5) }; };
  const OST = {
    D: ['A3', 'D4', 'E4', 'F#4'], Dm: ['A3', 'D4', 'E4', 'F4'], C: ['G3', 'C4', 'D4', 'E4'], G: ['G3', 'B3', 'C4', 'D4'], A: ['A3', 'C#4', 'D4', 'E4'],
    Bm: ['F#3', 'B3', 'C#4', 'D4'], Em: ['G3', 'B3', 'D4', 'E4'], 'F#m': ['F#3', 'A3', 'B3', 'C#4'], Bb: ['F3', 'Bb3', 'C4', 'D4'], Gm: ['G3', 'Bb3', 'C4', 'D4'],
    F: ['F3', 'A3', 'Bb3', 'C4'], Am: ['A3', 'C4', 'D4', 'E4'], Db: ['Ab3', 'Db4', 'Eb4', 'F4'], Eb: ['G3', 'Bb3', 'C4', 'Eb4'],
  };
  set([1, 2], 'Dm', OST.Dm, 'D3', 'D2', 'D3', 'A2'); set(3, 'Bb', OST.Bb, 'Bb2', 'Bb1', 'Bb2', 'F2'); set(4, 'C', OST.C, 'C3', 'C2', 'C3', 'G2');
  set([5, 6, 13, 14], 'D', OST.D, 'D3', 'D2', 'D3', 'A2'); set([7, 8, 15, 16], 'C', OST.C, 'C3', 'C2', 'C3', 'G2');
  set([9, 10, 19], 'G', OST.G, 'G2', 'G1', 'G2', 'D3'); set([11, 12, 20], 'A', OST.A, 'A2', 'A1', 'A2', 'E3'); set([17, 18], 'Bm', OST.Bm, 'B2', 'B1', 'B2', 'F#2');
  set([21, 28], 'D', OST.D, 'D3', 'D2', 'D3', 'A2'); set(22, 'Bm', OST.Bm, 'B2', 'B1', 'B2', 'F#2'); set([23, 26, 29], 'G', OST.G, 'G2', 'G1', 'G2', 'D3');
  set([24, 27, 31], 'A', OST.A, 'A2', 'A1', 'A2', 'E3'); set(25, 'D', OST.D, 'F#2', 'F#1', 'D3', 'A2'); set(30, 'Em', OST.Em, 'E3', 'E2', 'E3', 'B2');
  set(32, 'F#m', OST['F#m'], 'F#2', 'F#1', 'F#2', 'C#3'); set(33, 'Bb', OST.Bb, 'Bb2', 'Bb1', 'Bb2', 'F2'); set(34, 'Gm', OST.Gm, 'G2', 'G1', 'G2', 'D3');
  set([35, 36], 'C', OST.C, 'C3', 'C2', 'C3', 'G2');
  set([37, 44, 51, 52], 'F', OST.F, 'F2', 'F1', 'F2', 'C3'); set(38, 'Dm', OST.Dm, 'D3', 'D2', 'D3', 'A2'); set([39, 42, 45], 'Bb', OST.Bb, 'Bb2', 'Bb1', 'Bb2', 'F2');
  set([40, 43, 47], 'C', OST.C, 'C3', 'C2', 'C3', 'G2'); set(41, 'F', OST.F, 'A2', 'A1', 'F2', 'C3'); set(46, 'Gm', OST.Gm, 'G2', 'G1', 'G2', 'D3');
  set(48, 'Am', OST.Am, 'A2', 'A1', 'A2', 'E3'); set(49, 'Db', OST.Db, 'Db3', 'Db2', 'Db3', 'Ab2'); set(50, 'Eb', OST.Eb, 'Eb3', 'Eb2', 'Eb3', 'Bb2');
  set([53, 57, 61], 'Dm', OST.Dm, 'D3', 'D2', 'D3', 'A2'); set([54, 58], 'Bb', OST.Bb, 'Bb2', 'Bb1', 'Bb2', 'F2'); set(55, 'F', OST.F, 'F2', 'F1', 'F2', 'C3');
  set(56, 'C', OST.C, 'C3', 'C2', 'C3', 'G2'); set([59, 62], 'Gm', OST.Gm, 'G2', 'G1', 'G2', 'D3'); set(60, 'A', OST.A, 'A2', 'A1', 'A2', 'E3');
  set(63, 'Bb', OST.Bb, 'Bb2', 'Bb1', 'Bb2', 'F2'); set(64, 'C', OST.C, 'C3', 'C2', 'C3', 'G2');

  // ostinato writers -------------------------------------------------------------------------------
  /** 16th bariolage P a P b P c P b (x2 per bar); accents on the tresillo 16ths 0,3,6 / 8,11,14 */
  const ost16 = (tr, art, bars, dynFn, oct = 0, gainDb = 0) => {
    for (const bar of bars) {
      const [p, a, b, c] = H[bar].ost.map((x) => x + 12 * oct);
      const cell = [p, a, p, b, p, c, p, b];
      for (let i = 0; i < 16; i++) {
        const t = T(bar, i * 0.25), acc = [0, 3, 6, 8, 11, 14].includes(i);
        add(tr, art, t, cell[i % 8], 0.25 * BEAT, { dyn: (tt) => dynFn(tt) + (acc ? 0.1 : -0.04), gainDb });
      }
    }
  };
  /** cello 8ths: low root on tresillo positions, octave above otherwise */
  const ost8 = (tr, art, bars, dynFn) => {
    for (const bar of bars) {
      const hi = H[bar].vc, lo = hi - 12 >= 36 ? hi - 12 : hi;
      for (let i = 0; i < 8; i++) { const acc = [0, 3, 6].includes(i); add(tr, art, T(bar, i * 0.5), acc ? lo : hi, 0.5 * BEAT, { dyn: (tt) => dynFn(tt) + (acc ? 0.08 : -0.03) }); }
    }
  };
  const bassTres = (tr, art, bars, dynFn, octave = 0) => { for (const bar of bars) for (const b of tresillo) add(tr, art, T(bar, b), H[bar].cb + 12 * octave, 1.2 * BEAT, { dyn: dynFn }); };
  const timpTres = (bars, dynFn, pattern = 'tres') => {
    for (const bar of bars) {
      const h = H[bar];
      if (pattern === 'tres') { add('timp', 'timp', T(bar, 0), h.timp, 1.5 * BEAT, { dyn: plus(dynFn, 0.06), release: 0.5 }); add('timp', 'timp', T(bar, 1.5), h.timp, 1.5 * BEAT, { dyn: dynFn, release: 0.5 }); add('timp', 'timp', T(bar, 3), h.timp5, 1.5 * BEAT, { dyn: plus(dynFn, -0.04), release: 0.6 }); }
      else if (pattern === 'down') add('timp', 'timp', T(bar, 0), h.timp, 3 * BEAT, { dyn: dynFn, release: 0.6 });
    }
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // harp: rising-falling triad arpeggio in 8ths from the bar's chord (root in octave 3)
  const TRIAD = { D: [2, 6, 9], Dm: [2, 5, 9], Bm: [11, 2, 6], G: [7, 11, 2], A: [9, 1, 4], Bb: [10, 2, 5], F: [5, 9, 0], C: [0, 4, 7], Gm: [7, 10, 2], Em: [4, 7, 11] };
  const harpArp = (bar, dyn) => {
    const [r, t3, t5] = TRIAD[H[bar].chord]; const root = 48 + r; // C3..B3
    const up = (pc, from) => { let m = from + 1; while (((m % 12) + 12) % 12 !== pc) m++; return m; };
    const n1 = root, n2 = up(t5, n1), n3 = up(r, n2), n4 = up(t3, n3), n5 = up(t5, n4), n6 = up(r, n5);
    [n1, n2, n3, n4, n5, n6, n5, n4].forEach((m, k) => add('harp', 'harp', T(bar, k * 0.5), m, 0.5 * BEAT, { dyn: dyn + (k === 0 ? 0.08 : 0) }));
  };

  // ================================================================================================ INTRO (bars 1–2)
  {
    const d0 = T(1), d1 = T(3);
    add('cb', 'cbSus', T(1), 'D2', 2 * BAR, { dyn: swell(d0, d1, 0.25, 0.52, 0.4) });
    add('vcSus', 'vcTrem', T(1), 'D3', 2 * BAR, { dyn: swell(d0, d1, 0.25, 0.5, 0.4) });
    add('vcSus', 'vcTrem', T(1), 'A3', 2 * BAR, { dyn: swell(d0, d1, 0.22, 0.45, 0.35) });
    add('vln1', 'vlnSus', T(1), 'A5', 2 * BAR, { dyn: swell(d0, d1, 0.2, 0.46, 0.35), attack: 0.6 });
    add('vln2', 'vlnSus', T(1, 2), 'D5', 1.5 * BAR, { dyn: swell(T(1, 2), d1, 0.2, 0.42, 0.32), attack: 0.6 });
    mel('hnSolo', 'hnSus', 1, 'D4:1 E4:.5 A4:2.5 | Bb4:1.5 A4:.5 F4:1.8', { dyn: env([[d0, 0.52], [T(1, 3), 0.6], [T(2, 3), 0.52], [d1, 0.4]]), legato: true, shape: 0.06 });
    mel('harp', 'harp', 1, 'D3:.5 A3:.5 D4:.5 E4:.5 A4:.5 D5:.5 E5:.5 A5:.5 | Bb2:.5 F3:.5 Bb3:.5 D4:.5 F4:.5 Bb4:.5 D5:.5 F5:.5', { dyn: 0.45 });
    add('timp', 'timpRoll', T(1), 'D3', 2 * BAR - 0.05, { dyn: swell(d0, d1, 0.12, 0.3, 0.18), release: 0.4 });
  }

  // ================================================================================================ LEAD (bars 3–4 and 63–64)
  const lead = (bar0) => {
    BLOCK = { name: 'LEAD', t0: T(bar0) };
    const b1 = bar0, b2 = bar0 + 1, t0 = T(b1), tEnd = T(b1 + 2);
    const cr = ramp(t0, tEnd, 0.52, 0.8, 1.4);
    // brass: rising motif Bb-C-F | C-D-G in horns (+trombones 8vb), tuba pedal
    mel('hn', 'hnSus', b1, 'Bb3:1.5 C4:1.5 F4:1 | C4:1.5 D4:1.5 G4:1', { dyn: cr, gate: 0.92 });
    mel('tbn', 'tbnSus', b1, 'Bb2:1.5 C3:1.5 F3:1 | C3:1.5 D3:1.5 G3:1', { dyn: plus(cr, -0.03), gate: 0.9 });
    add('tuba', 'tubaSus', T(b1), 'Bb1', BAR * 0.97, { dyn: plus(cr, -0.05) });
    add('tuba', 'tubaSus', T(b2), 'C2', BAR * 0.97, { dyn: plus(cr, -0.05) });
    // strings: ostinato crescendo, sustained violins and the run into the downbeat
    ost16('vla', 'vlaSpic', [b1, b2], (t) => cr(t) - 0.12);
    ost16('vln2', 'vlnSpic', [b1, b2], (t) => cr(t) - 0.18, 1);
    ost8('vc', 'vcSpic', [b1, b2], (t) => cr(t) - 0.1);
    bassTres('cb', 'cbSpic', [b1, b2], (t) => cr(t) - 0.08);
    add('vln1', 'vlnSus', T(b1), 'F5', BAR, { dyn: plus(cr, -0.12) });
    add('vln1', 'vlnSus', T(b2), 'G5', 2 * BEAT, { dyn: plus(cr, -0.1) });
    mel('vln1', 'vlnSpic', b2, 'r:2 D5:.25 E5:.25 F#5:.25 G5:.25 A5:.25 B5:.25 C#6:.25 D6:.25', { dyn: ramp(T(b2, 2), T(b2, 4), 0.58, 0.86) });
    // percussion: timpani roll Bb -> C with a fill, swell, bass-drum roll, snare roll
    add('timp', 'timpRoll', T(b1), 'Bb2', BAR - 0.03, { dyn: ramp(t0, T(b2), 0.3, 0.48), release: 0.08 });
    add('timp', 'timpRoll', T(b2), 'C3', 3 * BEAT - 0.03, { dyn: ramp(T(b2), T(b2, 3), 0.48, 0.74), release: 0.06 });
    mel('timp', 'timp', b2, 'r:3 G2:.25 G2:.25 C3:.25 C3:.25', { dyn: 0.9 });
    add('cym', 'swell2', T(b1 + 2), 60, 1.2, { dyn: 0.74, release: 1.6 });
    add('bd', 'bdRoll', T(b1 + 2), 60, 0.3, { dyn: 0.5, release: 0.5 });
    add('drums', 'snareRoll', T(b2), 60, BAR - 0.02, { dyn: ramp(T(b2), tEnd, 0.18, 0.5), release: 0.05 });
    BLOCK = { name: 'main', t0: 0 };
  };
  lead(3);

  // ================================================================================================ A (bars 5–20)
  {
    const A1 = range(5, 12), A2 = range(13, 20), all = range(5, 20);
    const dA = env([[T(5), 0.8], [T(12, 4), 0.8], [T(13), 0.82], [T(20), 0.83], [T(21), 0.86]]);
    // low-brass motif in tresillo: 1-2-5 / 4-3-1
    const motif = [
      [5, 'D3 E3 A3'], [6, 'G3 F#3 D3'], [7, 'C3 D3 G3'], [8, 'F3 E3 C3'], [9, 'G2 A2 D3'], [10, 'C3 B2 G2'], [11, 'A2 B2 E3'], [12, 'D3 C#3 A2'],
      [13, 'D3 E3 A3'], [14, 'G3 F#3 D3'], [15, 'C3 D3 G3'], [16, 'F3 E3 C3'], [17, 'B2 C#3 F#3'], [18, 'E3 D3 B2'], [19, 'G2 A2 D3'],
    ];
    for (const [bar, notes] of motif) {
      const ps = notes.split(' ');
      ps.forEach((p, i) => {
        const t = T(bar, tresillo[i]), dur = (i < 2 ? 1.5 : 1) * BEAT * 0.86;
        add('tbn', 'tbnSus', t, p, dur, { dyn: (tt) => dA(tt) + (i === 0 ? 0.05 : 0) });
        add('tuba', 'tubaSus', t, P(p) - 12, dur, { dyn: (tt) => dA(tt) - 0.06 });
        if (i === 0) add('tbnChord', 'tbnStac', t, p, 0.4, { dyn: dA(t) + 0.05 }); // marcato bite
        if (bar >= 13) add('hn', 'hnSus', t, P(p) + 12, dur, { dyn: (tt) => dA(tt) - 0.02 });
      });
    }
    // bar 20: dominant swell (A major) into B
    const sw20 = ramp(T(20), T(21), 0.55, 0.84, 1.5);
    for (const p of ['A2', 'E3', 'A3']) add('tbnChord', 'tbnSus', T(20), p, BAR * 0.98, { dyn: sw20 });
    add('tuba', 'tubaSus', T(20), 'A1', BAR * 0.98, { dyn: sw20 });
    for (const p of ['E4', 'A4', 'C#5']) add('hnChord', 'hnSus', T(20), p, BAR * 0.98, { dyn: sw20 });
    // horn chord pads in A1
    for (const [bar, ch] of [[5, ['D4', 'F#4', 'A4']], [7, ['C4', 'E4', 'G4']], [9, ['B3', 'D4', 'G4']], [11, ['C#4', 'E4', 'A4']]])
      for (const p of ch) add('hnChord', 'hnSus', T(bar), p, 2 * BAR * 0.97, { dyn: swell(T(bar), T(bar + 2), 0.48, 0.62, 0.52, 0.5), gainDb: -3 });
    // strings
    ost16('vla', 'vlaSpic', all, (t) => dA(t) - 0.1);
    ost16('vln2', 'vlnSpic', A2, (t) => dA(t) - 0.14, 1, -2.5);
    ost8('vc', 'vcSpic', all, (t) => dA(t) - 0.08);
    bassTres('cb', 'cbSpic', all, (t) => dA(t) - 0.06);
    const v1 = [[5, 'D6', 2], [7, 'C6', 2], [9, 'B5', 2], [11, 'C#6', 2], [13, 'D6', 2], [15, 'E6', 2], [17, 'D6', 2], [19, 'B5', 1], [20, 'C#6', 1]];
    for (const [bar, p, n] of v1) add('vln1', 'vlnSus', T(bar), p, n * BAR * 0.98, { dyn: bar < 13 ? swell(T(bar), T(bar + n), 0.5, 0.66, 0.55) : swell(T(bar), T(bar + n), 0.6, 0.76, 0.66) });
    // trumpet stabs in A2 (tresillo)
    const stab = { 13: ['A4', 'D5'], 14: ['A4', 'D5'], 15: ['G4', 'C5'], 16: ['G4', 'C5'], 17: ['F#4', 'B4'], 18: ['F#4', 'B4'], 19: ['G4', 'B4'] };
    for (const bar of range(13, 19)) for (const b of tresillo) for (const p of stab[bar]) add('tptStab', 'tptStac', T(bar, b), p, 0.5 * BEAT, { dyn: b === 0 ? 0.82 : 0.72 });
    // percussion
    timpTres(range(5, 19), (t) => dA(t) - 0.05);
    for (const bar of all) {
      add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: bar < 13 ? 0.6 : 0.7 });
      add('taiko', 'taiko', T(bar, 0), 56, BEAT, { dyn: bar < 13 ? 0.62 : 0.74 });
      if (bar >= 13) { add('taiko', 'taiko', T(bar, 1.5), 57, BEAT, { dyn: 0.62 }); add('taiko', 'taiko', T(bar, 3), 57, BEAT, { dyn: 0.58 }); }
      else add('taiko', 'taiko', T(bar, 3), 57, BEAT, { dyn: 0.5 });
      if (bar >= 13) for (const b of [1, 3]) add('drums', 'taikoStick', T(bar, b), 58, BEAT, { dyn: 0.5 });
    }
    // tenor-drum pickups every 4 bars
    for (const bar of [8, 12, 16]) mel('drums', 'tenorDrum', bar, 'r:3 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: bar === 16 ? 0.7 : 0.6 });
    add('cym', 'crash', T(5), 60, 3, { dyn: 0.95, release: 2 });
    // tutti arrival accents on the A downbeats (bar 5 is also the loop point: these sit after loopStart)
    for (const [bar, k] of [[5, 1], [13, 0.9]]) {
      add('timp', 'timp', T(bar), 'D2', 2 * BEAT, { dyn: 0.95 * k + 0.05, release: 0.8 });
      add('bd', 'bassDrum', T(bar), 58, 2 * BEAT, { dyn: 0.9 * k });
      for (const p of ['A3', 'D4', 'F#4']) add('tbnChord', 'tbnStac', T(bar), p, 0.5, { dyn: 0.85 * k });
      for (const p of ['A4', 'D5', 'F#5']) add('hnChord', 'hnStac', T(bar), p, 0.5, { dyn: 0.85 * k, gainDb: 2 });
    }
    add('cym', 'swellShort', T(13), 60, 0.8, { dyn: 0.7, release: 1.5 });
    add('cym', 'crash', T(13), 60, 2.5, { dyn: 0.7, release: 2 });
    add('timp', 'timpRoll', T(20), 'A2', 4 * BEAT - 0.03, { dyn: ramp(T(20), T(21), 0.3, 0.7), release: 0.05 });
    add('cym', 'swell2', T(21), 60, 1.2, { dyn: 0.66, release: 1.6 });
    // arrival of B: soft tutti downbeat
    add('cym', 'crash', T(21), 60, 2.5, { dyn: 0.55, release: 2 }); add('timp', 'timp', T(21), 'D2', 2 * BEAT, { dyn: 0.75, release: 0.8 }); add('bd', 'bassDrum', T(21), 58, 2 * BEAT, { dyn: 0.7 });
  }

  // ================================================================================================ B (bars 21–36)
  {
    const theme = 'D4:1 E4:.5 A4:2.5 | B4:1.5 A4:.5 F#4:2 | G4:1 A4:.5 D5:2.5 | C#5:1.5 B4:.5 A4:2 | D4:1 E4:.5 A4:2.5 | B4:1.5 C#5:.5 D5:2 | E5:2 D5:1 C#5:1 | D5:3.8';
    const seq = 'G4:1 A4:.5 D5:2.5 | C5:1.5 B4:.5 G4:2 | A4:1 B4:.5 E5:2.5 | D5:1.5 C#5:.5 A4:2 | Bb4:1 C5:.5 F5:2.5 | Eb5:1.5 D5:.5 Bb4:2 | C5:1 D5:.5 G5:2.5 | F5:1.5 E5:.5 C5:1.5';
    const dTheme = env([[T(21), 0.66], [T(24), 0.7], [T(25), 0.68], [T(27), 0.76], [T(29), 0.72], [T(33), 0.8], [T(35), 0.84], [T(36, 3), 0.8]]);
    mel('hn', 'hnSus', 21, theme, { dyn: dTheme, legato: true, shape: true });
    mel('hn', 'hnSus', 29, seq, { dyn: dTheme, legato: true, shape: true });
    mel('tpt', 'tptSus', 33, 'Bb4:1 C5:.5 F5:2.5 | Eb5:1.5 D5:.5 Bb4:2 | C5:1 D5:.5 G5:2.5 | F5:1.5 E5:.5 C5:1.5', { dyn: (t) => dTheme(t) - 0.05, legato: true });
    // celli double the theme an octave below (classic horns+celli colour), B1 only
    mel('vcSus', 'vcSus', 21, theme.replace(/([A-G][#b]?)(\d)/g, (m, n, o) => n + (o - 1)), { dyn: (t) => dTheme(t) - 0.12, legato: true });
    // sustained strings with swells
    const v1 = ['F#5', 'F#5', 'G5', 'E5', 'F#5', 'G5', 'A5', 'A5', 'B5', 'B5', 'C#6', 'C#6', 'D6', 'D6', 'E6', 'E6'];
    const v2 = ['D5', 'D5', 'D5', 'C#5', 'D5', 'D5', 'E5', 'F#5'];
    for (let i = 0; i < 16; i++) {
      const bar = 21 + i, b0 = T(bar), b1 = T(bar + 1);
      const lvl = i < 8 ? 0.56 + 0.03 * (i % 4) : 0.62 + 0.033 * (i - 8);
      add('vln1', 'vlnSus', b0, v1[i], BAR * 0.99, { dyn: swell(b0, b1, lvl - 0.06, lvl + 0.08, lvl - 0.02) });
      if (i < 8) add('vln2', 'vlnSus', b0, v2[i], BAR * 0.99, { dyn: swell(b0, b1, lvl - 0.1, lvl + 0.04, lvl - 0.06) });
    }
    ost16('vla', 'vlaSpic', range(21, 36), env([[T(21), 0.5], [T(29), 0.55], [T(36, 4), 0.74]]));
    ost16('vln2', 'vlnSpic', range(29, 36), env([[T(29), 0.45], [T(36, 4), 0.74]]), 1, -2);
    // basses: sustained in B1, driving in B2
    for (let i = 0; i < 8; i++) add('cb', 'cbSus', T(21 + i), H[21 + i].cb, BAR * 0.99, { dyn: swell(T(21 + i), T(22 + i), 0.5, 0.6, 0.52) });
    ost8('vc', 'vcSpic', range(29, 36), env([[T(29), 0.55], [T(36, 4), 0.85]]));
    bassTres('cb', 'cbSpic', range(29, 36), env([[T(29), 0.58], [T(36, 4), 0.85]]));
    // harp arpeggios in B1
    for (let i = 0; i < 8; i++) harpArp(21 + i, 0.44);
    // B1: soft low-brass pad + cello pulse keep the momentum under the theme
    const pad = { 21: ['D3', 'A3'], 22: ['D3', 'F#3'], 23: ['D3', 'G3'], 24: ['C#3', 'E3'], 25: ['D3', 'A3'], 26: ['D3', 'G3'], 27: ['C#3', 'E3'], 28: ['D3', 'F#3'] };
    for (const bar of range(21, 28)) {
      for (const p of pad[bar]) add('tbnChord', 'tbnSus', T(bar), p, BAR * 0.97, { dyn: swell(T(bar), T(bar + 1), 0.38, 0.48, 0.42) });
      add('tuba', 'tubaSus', T(bar), H[bar].cb, BAR * 0.97, { dyn: swell(T(bar), T(bar + 1), 0.4, 0.5, 0.44) });
    }
    ost8('vc', 'vcSpic', range(25, 28), env([[T(25), 0.45], [T(29), 0.55]]));
    // brass support in B2
    const chords = { 33: ['D3', 'F3', 'Bb3'], 34: ['D3', 'G3', 'Bb3'], 35: ['E3', 'G3', 'C4'], 36: ['E3', 'G3', 'Bb3'] };
    for (const bar of [33, 34, 35, 36]) {
      for (const p of chords[bar]) add('tbnChord', 'tbnSus', T(bar), p, BAR * 0.97, { dyn: env([[T(bar), 0.55 + (bar - 33) * 0.06], [T(bar + 1), 0.6 + (bar - 33) * 0.06]]) });
      add('tuba', 'tubaSus', T(bar), H[bar].cb, BAR * 0.97, { dyn: 0.55 + (bar - 33) * 0.08 });
    }
    // percussion
    for (const bar of range(21, 28)) { add('timp', 'timp', T(bar), H[bar].timp, BEAT, { dyn: 0.5 }); add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: bar % 4 === 1 ? 0.55 : 0.42 }); }
    for (const bar of range(29, 32)) { add('timp', 'timp', T(bar), H[bar].timp, BEAT, { dyn: 0.6 }); add('timp', 'timp', T(bar, 3), H[bar].timp5, BEAT, { dyn: 0.5 }); add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.55 }); add('taiko', 'taiko', T(bar), 57, BEAT, { dyn: 0.55 }); }
    timpTres(range(33, 35), env([[T(33), 0.68], [T(36), 0.8]]));
    for (const bar of range(33, 36)) { add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.68 }); add('taiko', 'taiko', T(bar), 57, BEAT, { dyn: 0.66 }); add('taiko', 'taiko', T(bar, 1.5), 57, BEAT, { dyn: 0.56 }); }
    add('cym', 'swellMed', T(29), 60, 0.6, { dyn: 0.55, release: 1.2 });
    add('timp', 'timpRoll', T(36), 'C3', 3.5 * BEAT, { dyn: ramp(T(36), T(36, 3.5), 0.35, 0.76), release: 0.05 });
    mel('timp', 'timp', 36, 'r:3.5 G2:.25 C3:.25', { dyn: 0.88 });
    add('drums', 'snareRoll', T(36), 60, BAR - 0.02, { dyn: ramp(T(36), T(37), 0.18, 0.5), release: 0.05 });
    add('cym', 'swell2', T(37), 60, 1, { dyn: 0.78, release: 1.5 });
    add('bd', 'bdRoll', T(37), 60, 0.3, { dyn: 0.5, release: 0.5 });
    mel('vln1', 'vlnSpic', 36, 'r:2 C5:.25 D5:.25 E5:.25 F5:.25 G5:.25 A5:.25 Bb5:.25 C6:.25', { dyn: ramp(T(36, 2), T(37), 0.6, 0.9) });
  }

  // ================================================================================================ CLIMAX (bars 37–52) in F
  {
    const c1 = 'F4:1 G4:.5 C5:2.5 | D5:1.5 C5:.5 A4:2 | Bb4:1 C5:.5 F5:2.5 | E5:1.5 D5:.5 C5:2 | F4:1 G4:.5 C5:2.5 | D5:1.5 E5:.5 F5:2 | G5:2 F5:1 E5:1 | F5:3.8';
    const c2 = 'Bb4:1 C5:.5 F5:2.5 | Eb5:1.5 D5:.5 Bb4:2 | C5:1 D5:.5 G5:2.5 | F5:1.5 E5:.5 C5:2 | Db5:1 Eb5:.5 Ab5:2.5 | Eb5:1 F5:.5 Bb5:2.5 | F5:1 G5:.5 C6:2.5 | C6:1.5 Bb5:.5 A5:2';
    const dC = env([[T(37), 0.96], [T(39), 0.92], [T(44), 0.9], [T(45), 0.9], [T(49), 0.94], [T(51), 1.0], [T(52), 0.95], [T(53), 0.6]]);
    mel('tpt', 'tptSus', 37, c1, { dyn: dC, legato: true, shape: 0.04 });
    mel('tpt', 'tptSus', 45, c2, { dyn: dC, legato: true, shape: 0.04 });
    mel('hn', 'hnSus', 37, c1, { dyn: dC, legato: true, shape: 0.04 });
    mel('hn', 'hnSus', 45, 'Bb4:1 C5:.5 F5:2.5 | Eb5:1.5 D5:.5 Bb4:2 | C5:1 D5:.5 G5:2.5 | F5:1.5 E5:.5 C5:2', { dyn: dC, legato: true });
    mel('hn', 'hnSus', 49, 'Db4:1 Eb4:.5 Ab4:2.5 | Eb4:1 F4:.5 Bb4:2.5 | F4:1 G4:.5 C5:2.5 | C5:1.5 Bb4:.5 A4:2', { dyn: dC, legato: true });
    mel('vln2', 'vlnSus', 37, c1, { dyn: (t) => dC(t) - 0.1, legato: true });
    mel('vln2', 'vlnSus', 45, c2, { dyn: (t) => dC(t) - 0.1, legato: true });
    // descant
    const desc = ['C6', 'A5', 'Bb5', 'C6', 'C6', 'D6', 'E6', 'C6', 'D6', 'D6', 'E6', 'E6', 'Db6', 'Eb6'];
    desc.forEach((p, i) => { const bar = 37 + i; add('vln1', 'vlnSus', T(bar), p, BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.74, 0.94, 0.8), gainDb: 2 }); });
    add('vln1', 'vlnSus', T(51), 'F6', 2 * BAR * 0.98, { dyn: env([[T(51), 0.8], [T(51, 2), 0.95], [T(52), 0.9], [T(53), 0.5]]), gainDb: 2 }); // held top F over the resolution
    [...desc.slice(8), 'F6'].forEach((p, i) => { const bar = 45 + i; add('fl', 'flSus', T(bar), P(p), BAR * 0.99, { dyn: 0.75 }); });
    // brass chorale (trombones in tresillo) + tuba
    const chor = { 37: ['F3', 'A3', 'C4'], 38: ['F3', 'A3', 'D4'], 39: ['F3', 'Bb3', 'D4'], 40: ['E3', 'G3', 'C4'], 41: ['F3', 'A3', 'C4'], 42: ['F3', 'Bb3', 'D4'], 43: ['E3', 'G3', 'C4'], 44: ['F3', 'A3', 'C4'],
      45: ['F3', 'Bb3', 'D4'], 46: ['G3', 'Bb3', 'D4'], 47: ['E3', 'G3', 'C4'], 48: ['E3', 'A3', 'C4'], 49: ['F3', 'Ab3', 'Db4'], 50: ['G3', 'Bb3', 'Eb4'], 51: ['F3', 'A3', 'C4'] };
    for (const bar of range(37, 51)) {
      tresillo.forEach((b, k) => {
        const dur = (k < 2 ? 1.5 : 1) * BEAT * 0.88;
        for (const p of chor[bar]) add('tbnChord', 'tbnSus', T(bar, b), p, dur, { dyn: dC(T(bar, b)) - (k ? 0.06 : 0) });
        add('tuba', 'tubaSus', T(bar, b), H[bar].cb, dur, { dyn: dC(T(bar, b)) - 0.04 });
      });
    }
    for (const p of ['F3', 'A3', 'C4']) add('tbnChord', 'tbnSus', T(52), p, BAR * 0.95, { dyn: ramp(T(52), T(53), 0.9, 0.45) });
    add('tuba', 'tubaSus', T(52), 'F1', BAR * 0.95, { dyn: ramp(T(52), T(53), 0.88, 0.45) });
    // strings drive
    ost16('vla', 'vlaSpic', range(37, 51), (t) => dC(t) - 0.08);
    ost8('vc', 'vcSpic', range(37, 51), (t) => dC(t) - 0.06);
    bassTres('cb', 'cbSpic', range(37, 51), (t) => dC(t) - 0.05);
    add('vcSus', 'vcSus', T(52), 'F2', BAR, { dyn: ramp(T(52), T(53), 0.85, 0.45) });
    add('cb', 'cbSus', T(52), 'F1', BAR, { dyn: ramp(T(52), T(53), 0.85, 0.45) });
    add('vla', 'vlaSus', T(52), 'C4', BAR, { dyn: ramp(T(52), T(53), 0.8, 0.45) });
    // choir pads
    const ch = { 37: ['C5', 'A4', 'F4', 'F3'], 38: ['D5', 'A4', 'F4', 'D3'], 39: ['D5', 'Bb4', 'F4', 'Bb2'], 40: ['E5', 'C5', 'G4', 'C3'], 41: ['C5', 'A4', 'F4', 'A2'], 42: ['D5', 'Bb4', 'F4', 'Bb2'],
      43: ['E5', 'C5', 'G4', 'C3'], 44: ['F5', 'C5', 'A4', 'F3'], 45: ['F5', 'D5', 'Bb4', 'Bb2'], 46: ['D5', 'Bb4', 'G4', 'G2'], 47: ['E5', 'C5', 'G4', 'C3'], 48: ['E5', 'C5', 'A4', 'A2'],
      49: ['F5', 'Db5', 'Ab4', 'Db3'], 50: ['G5', 'Eb5', 'Bb4', 'Eb3'], 51: ['A5', 'F5', 'C5', 'F3'], 52: ['A5', 'F5', 'C5', 'F3'] };
    for (const bar of range(37, 52)) ['S', 'A', 'T', 'B'].forEach((part, k) => choir.push({ part, midi: P(ch[bar][k]), t: T(bar), dur: BAR * 0.98, seed: hash32('choir', bar, k),
      dyn: bar < 52 ? swell(T(bar), T(bar + 1), 0.7, 0.86, 0.76) : ramp(T(52), T(53), 0.85, 0.4) }));
    // percussion
    timpTres(range(37, 50), dC);
    for (const bar of range(37, 51)) {
      add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.85 }); add('bd', 'bassDrum', T(bar, 2), 60, BEAT, { dyn: 0.62 });
      add('taiko', 'taiko', T(bar), 55, BEAT, { dyn: 0.86 }); add('taiko', 'taiko', T(bar, 1.5), 57, BEAT, { dyn: 0.72 }); add('taiko', 'taiko', T(bar, 3), 57, BEAT, { dyn: 0.68 });
      for (const b of [1, 3]) add('drums', 'taikoStick', T(bar, b), 58, BEAT, { dyn: 0.6 });
    }
    for (const bar of [40, 44, 48]) mel('drums', 'tenorDrum', bar, 'r:2 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: 0.68 });
    add('cym', 'crash', T(37), 60, 3, { dyn: 1.0, release: 2 });
    add('bd', 'bassDrum', T(37), 58, 2 * BEAT, { dyn: 0.95 });
    for (const p of ['F2', 'C3', 'F3', 'A3']) add('tbnChord', 'tbnStac', T(37), p, 0.5, { dyn: 0.95 });
    for (const p of ['F4', 'A4', 'C5']) add('hnChord', 'hnStac', T(37), p, 0.5, { dyn: 0.95, gainDb: 2 });
    for (const p of ['C5', 'F5', 'A5']) add('tptStab', 'tptStac', T(37), p, 0.5, { dyn: 0.95, gainDb: 3 });
    add('timp', 'timp', T(37), 'F3', 2 * BEAT, { dyn: 0.9, release: 0.8 });
    add('cym', 'swellMed', T(45), 60, 0.6, { dyn: 0.75, release: 1.2 });
    add('cym', 'crash', T(45), 60, 3, { dyn: 0.85, release: 2 });
    add('cym', 'crash', T(49), 60, 3, { dyn: 0.85, release: 2 });
    add('timp', 'timpRoll', T(50), 'Bb2', 4 * BEAT - 0.03, { dyn: ramp(T(50), T(51), 0.5, 0.95), release: 0.05 });
    add('cym', 'swell2', T(51), 60, 1.5, { dyn: 0.9, release: 2 });
    add('cym', 'crash', T(51), 60, 4, { dyn: 1.0, release: 2.5 });
    add('gong', 'gong', T(51), 58, 5, { dyn: 0.9, release: 3 });
    add('timp', 'timp', T(51), 'F2', BEAT, { dyn: 1.0 });
    add('timp', 'timpRoll', T(51, 0.25), 'F2', 7.5 * BEAT, { dyn: ramp(T(51), T(53), 0.85, 0.3), release: 0.6 });
  }

  // ================================================================================================ BRIDGE (bars 53–62) in D minor
  {
    // 53–56: horn solo over soft strings and harp
    mel('hnSolo', 'hnSus', 53, 'D4:1 E4:.5 A4:2.5 | Bb4:1.5 A4:.5 F4:2 | F4:1 G4:.5 C5:2.5 | F4:1.5 E4:.5 C4:1.9', { dyn: env([[T(53), 0.64], [T(55), 0.7], [T(57), 0.6]]), legato: true, shape: 0.06 });
    const pads = { 53: ['A4', 'F4', 'D3', 'D2'], 54: ['Bb4', 'F4', 'Bb2', 'Bb1'], 55: ['A4', 'F4', 'F3', 'F1'], 56: ['G4', 'E4', 'C3', 'C2'] };
    for (const bar of [53, 54, 55, 56]) {
      const [a, b, c, d] = pads[bar], sw = swell(T(bar), T(bar + 1), 0.44, 0.56, 0.47);
      add('vln2', 'vlnSus', T(bar), a, BAR * 0.99, { dyn: sw }); add('vla', 'vlaSus', T(bar), b, BAR * 0.99, { dyn: sw });
      add('vcSus', 'vcSus', T(bar), c, BAR * 0.99, { dyn: sw }); add('cb', 'cbSus', T(bar), d, BAR * 0.99, { dyn: plus(sw, -0.04) });
      harpArp(bar, 0.42);
    }
    [['F5', 53], ['F5', 54], ['A5', 55], ['G5', 56]].forEach(([p, bar]) => add('vln1', 'vlnSus', T(bar), p, BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.3, 0.4, 0.33) }));
    add('timp', 'timpRoll', T(56), 'A2', 4 * BEAT - 0.05, { dyn: ramp(T(56), T(57), 0.15, 0.4), release: 0.1 });
    // 57–60: violins take the motif, ostinato returns
    const dB = env([[T(57), 0.54], [T(61), 0.62], [T(63), 0.66]]);
    mel('vln1', 'vlnSus', 57, 'D5:1 E5:.5 A5:2.5 | Bb5:1.5 A5:.5 F5:2 | G5:1 A5:.5 D6:2.5 | C#6:1.5 Bb5:.5 A5:2', { dyn: plus(dB, 0.06), legato: true, shape: 0.06 });
    mel('vln2', 'vlnSus', 57, 'D4:1 E4:.5 A4:2.5 | Bb4:1.5 A4:.5 F4:2 | G4:1 A4:.5 D5:2.5 | C#5:1.5 Bb4:.5 A4:2', { dyn: plus(dB, 0.04), legato: true });
    ost16('vla', 'vlaSpic', range(57, 62), (t) => dB(t) - 0.08);
    ost8('vc', 'vcSpic', range(57, 62), (t) => dB(t) - 0.08);
    for (const bar of range(57, 60)) add('cb', 'cbSus', T(bar), H[bar].cb, BAR * 0.99, { dyn: plus(dB, -0.06) });
    const hc = { 57: ['D4', 'F4', 'A4'], 58: ['D4', 'F4', 'Bb4'], 59: ['D4', 'G4', 'Bb4'], 60: ['C#4', 'E4', 'A4'] };
    for (const bar of range(57, 60)) for (const p of hc[bar]) add('hnChord', 'hnSus', T(bar), p, BAR * 0.97, { dyn: swell(T(bar), T(bar + 1), 0.42, 0.55, 0.47) });
    for (const bar of range(57, 60)) { add('timp', 'timp', T(bar), H[bar].timp, BEAT, { dyn: 0.45 + (bar - 57) * 0.05 }); add('taiko', 'taiko', T(bar), 55, BEAT, { dyn: 0.45 + (bar - 57) * 0.05 }); }
    // 61–62: low-brass motif returns (D-E-A, G-A-D), everything builds
    for (const [bar, notes] of [[61, 'D3 E3 A3'], [62, 'G2 A2 D3']]) notes.split(' ').forEach((p, i) => {
      const t = T(bar, tresillo[i]), dur = (i < 2 ? 1.5 : 1) * BEAT * 0.86;
      add('tbn', 'tbnSus', t, p, dur, { dyn: dB(t) + 0.02 }); add('tuba', 'tubaSus', t, P(p) - 12, dur, { dyn: dB(t) - 0.06 });
      add('hn', 'hnSus', t, P(p) + 12, dur, { dyn: dB(t) - 0.04 });
    });
    ost16('vln2', 'vlnSpic', [61, 62], (t) => dB(t) - 0.12, 1);
    add('vln1', 'vlnTrem', T(61), 'A5', BAR, { dyn: ramp(T(61), T(62), 0.5, 0.62) }); add('vln1', 'vlnTrem', T(62), 'Bb5', BAR * 0.98, { dyn: ramp(T(62), T(63), 0.6, 0.7) });
    bassTres('cb', 'cbSpic', [61, 62], (t) => dB(t) - 0.04);
    timpTres([61, 62], (t) => dB(t) - 0.04);
    for (const bar of [61, 62]) { add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.6 }); add('taiko', 'taiko', T(bar), 55, BEAT, { dyn: 0.62 }); add('taiko', 'taiko', T(bar, 1.5), 57, BEAT, { dyn: 0.52 }); }
    mel('drums', 'tenorDrum', 62, 'r:3 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: 0.55 });
  }
  lead(63);

  return { bpm: BPM, beat: BEAT, bar: BAR, totalBars: TOTAL_BARS, loopStart: T(LOOP_START_BAR), loopEnd: T(LOOP_END_BAR), title: TITLE, tracks, choir };
}
