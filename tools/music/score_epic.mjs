// PROJECT WINGNUT — "Sortie" (working title; original composition, written as code): the main battle theme, meant to
// replace "Ceiling Unlimited" in most missions. Rendered by render_epic.mjs. Audition piece (not wired into the game).
// 144 BPM, 4/4, G minor (Aeolian). The B section lifts to an Eb-Lydian / G-Dorian passage (A natural, C major chord);
// the climax restates the theme in G minor, then lifts it into Bb major and lands on a G major (Picardy) chord.
//
//   bars  1–4   INTRO (plays once): tutti stab, horns call the motif, trumpets answer, strings tremolo swell
//   bars  5–6   LEAD: spiccato ostinato starts, low brass swell Eb -> D, rolls, string run ───────┐ identical copies
//   bars  7–22  BUILD: arrival hit, 16th ostinato + driving celli, low-brass motif, percussion   │ (seeds, dynamics,
//               grows; 15–22 adds violins, horns, snare, riser                                   │ notes): the wrap
//   bars 23–38  THEME A: horns (then horns + trumpets) over sustained low brass and strings,     │ 94->7 hears what
//               galloping celli, anvil/timpani/bass drum downbeats                                │ 6->7 heard
//   bars 39–46  THEME A': trumpets + horns, violin descant, full strings, half-cadence on D       │
//   bars 47–54  B (drop): pizzicato pulse, harp, soft strings; a solo horn remembers the motif   │
//   bars 55–62  B (lift): violins sing a new tune over Eb – F – Gm – C (Dorian), horns pad       │
//   bars 63–70  REBUILD: ostinato returns, low-brass motif climbs C–D–Eb–F, rolls, trumpet run   │
//   bars 71–78  CLIMAX: theme in G minor, tutti with choir                                       │
//   bars 79–86  LIFT: the theme in Bb major (Lydian A natural over Eb in bar 85), gong           │
//   bars 87–92  CODA: Eb – F – G major (Picardy), then the drive in G minor                      │
//   bars 93–94  LEAD (copy 2) ──────────────────────────────────────────────────────────────────────┘
//   loop = [bar 7, bar 95) = [10.000 s, 156.667 s)  (88 bars = 146.7 s)
//
// THE MOTIF (bar 1 of the theme): G – D – C – D – Eb – D – C – Bb, i.e. a rising fifth that is held, a turn back to it,
// then a stepwise fall from the minor sixth: "1 – 5 – 4 – 5 | b6 – 5 – 4 – b3". Its head (1 – 5 – 4 – 5) is the
// identity cell: it is the horn call of the intro, the low-brass figure of the build and rebuild, and the theme's start.
import { hash32 } from './lib/dsp.mjs';
import { P, env } from './score.mjs';

export const BPM = 144;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const TOTAL_BARS = 94;
export const LOOP_START_BAR = 7, LOOP_END_BAR = 95;
export const TITLE = 'Sortie';
export const T = (bar, beat = 0) => ((bar - 1) * 4 + beat) * BEAT;
export const SECTIONS = [['intro', 1, 5], ['lead', 5, 7], ['build1', 7, 15], ['build2', 15, 23], ['themeA1', 23, 31], ['themeA2', 31, 39], ["themeA'", 39, 47],
  ['Bdrop', 47, 55], ['Blift', 55, 63], ['rebuild', 63, 71], ['climax', 71, 79], ['major', 79, 87], ['coda', 87, 93], ['lead2', 93, 95]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (t0, t1, d0, d1, curve = 1) => (t) => d0 + (d1 - d0) * Math.pow(clamp01((t - t0) / (t1 - t0)), curve);
const swell = (t0, t1, d0, peak, d1, at = 0.6) => env([[t0, d0], [t0 + (t1 - t0) * at, peak], [t1, d1]]);
const plus = (f, k) => (t) => (typeof f === 'function' ? f(t) : f) + k;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ------------------------------------------------------------------------------------------------ harmony
const PCN = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const CHORDS = { // root pc, triad pcs, viola ostinato cell [pedal, a, b, c], bass root (octave 1/2)
  Gm: { tri: [7, 10, 2], ost: ['D4', 'G4', 'A4', 'Bb4'], bass: 'G1' }, Eb: { tri: [3, 7, 10], ost: ['Bb3', 'Eb4', 'F4', 'G4'], bass: 'Eb2' },
  Bb: { tri: [10, 2, 5], ost: ['F3', 'Bb3', 'C4', 'D4'], bass: 'Bb1' }, F: { tri: [5, 9, 0], ost: ['C4', 'F4', 'G4', 'A4'], bass: 'F1' },
  Cm: { tri: [0, 3, 7], ost: ['G3', 'C4', 'D4', 'Eb4'], bass: 'C2' }, D: { tri: [2, 6, 9], ost: ['A3', 'D4', 'E4', 'F#4'], bass: 'D2' },
  C: { tri: [0, 4, 7], ost: ['G3', 'C4', 'D4', 'E4'], bass: 'C2' }, G: { tri: [7, 11, 2], ost: ['D4', 'G4', 'A4', 'B4'], bass: 'G1' },
};
const PROG = {};
const setp = (bar0, names) => names.split(' ').forEach((n, i) => { PROG[bar0 + i] = n; });
setp(1, 'Gm Eb Cm D Eb D');                                   // intro + LEAD
setp(7, 'Gm Gm Eb Eb Cm Cm D D Gm Eb Bb F Gm Eb Cm D');        // build
setp(23, 'Gm Eb Bb F Gm Eb Cm D Eb F Gm Eb Cm D Eb D');        // theme A
setp(39, 'Gm Eb Bb F Gm Eb Cm D');                             // A'
setp(47, 'Gm Gm Eb Eb Cm Cm D D Eb F Gm C Eb F Bb D');         // B drop + lift
setp(63, 'Cm Cm D D Eb Eb F F');                               // rebuild
setp(71, 'Gm Eb Bb F Gm Eb Cm D Bb Eb F Cm Bb Eb Eb F');       // climax + major lift (85: Eb Lydian)
setp(87, 'Eb F G G Gm Gm Eb D');                               // coda + LEAD copy 2
const chordOf = (bar) => CHORDS[PROG[bar]];
/** chord tones (triad, by pitch class) stacked upward from `lo` (MIDI or name), n notes */
const voicing = (bar, lo, n) => { const pcs = chordOf(bar).tri, out = []; let m = P(lo); while (out.length < n) { if (pcs.includes(((m % 12) + 12) % 12)) out.push(m); m++; } return out; };
const timpPitch = (bar) => { let m = P(chordOf(bar).bass); while (m < P('D2')) m += 12; while (m > P('C3')) m -= 12; return m; };

// ------------------------------------------------------------------------------------------------ melodies
// theme (16 bars): phrase 1 (bars 1–8) ends on the dominant; phrase 2 (bars 9–16) climbs and ends on the dominant again
export const THEME_1 = 'G4:1 D5:2 C5:.5 D5:.5 | Eb5:1.5 D5:.5 C5:1 Bb4:1 | D5:1 F5:2 Eb5:.5 D5:.5 | C5:3.5 r:.5 | G4:1 D5:2 C5:.5 D5:.5 | Eb5:1.5 F5:.5 G5:1 Eb5:1 | F5:1.5 Eb5:.5 D5:1 C5:1 | D5:3.5 r:.5';
export const THEME_2 = 'G5:1.5 F5:.5 Eb5:1 D5:1 | C5:1.5 D5:.5 Eb5:1 F5:1 | D5:1 G5:2 F5:.5 G5:.5 | Eb5:1.5 D5:.5 C5:1 Bb4:1 | C5:1 G5:2 F5:.5 Eb5:.5 | D5:1.5 E5:.5 F#5:2 | G5:2 F5:1 Eb5:1 | D5:3.5 r:.5';
// the same 8 bars in Bb major (the climax lift)
export const THEME_MAJ = 'Bb4:1 F5:2 Eb5:.5 F5:.5 | G5:1.5 F5:.5 Eb5:1 D5:1 | F5:1 A5:2 G5:.5 F5:.5 | Eb5:3.5 r:.5 | Bb4:1 F5:2 Eb5:.5 F5:.5 | G5:1.5 A5:.5 Bb5:1 G5:1 | A5:1.5 G5:.5 F5:1 Eb5:1 | F5:3.5 r:.5';
// B tune (violins), bars 55–62
export const B_TUNE = 'G5:2 A5:1 Bb5:1 | C6:3 Bb5:1 | D6:2 C6:1 Bb5:1 | A5:4 | G5:2 A5:1 Bb5:1 | C6:2 D6:1 Eb6:1 | F6:2 Eb6:1 D6:1 | D6:3.8';
const octDown = (s, k = 1) => s.replace(/([A-G][#b]?)(\d)/g, (m, n, o) => n + (o - k));

export function buildScore() {
  const tracks = {};
  const track = (name, opts) => { tracks[name] = { name, notes: [], ...opts }; };

  // --- mix / staging (pan: -1 L .. +1 R; send = reverb send; ensemble = doubled players) ---
  track('vln1', { bus: 'str', pan: -0.55, width: 0.6, gainDb: 0, send: 0.3, eq: [['highpass', 170], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 2.5 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.06 });
  track('vln2', { bus: 'str', pan: -0.25, width: 0.6, gainDb: -1.5, send: 0.3, eq: [['highpass', 160], ['peak', 350, { q: 1, gainDb: -2 }], ['peak', 2600, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 1.5 }]], humanize: { time: 0.005, dyn: 0.035, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.06 });
  track('vla', { bus: 'str', pan: 0.2, width: 0.55, gainDb: -2.5, send: 0.27, eq: [['highpass', 110], ['peak', 300, { q: 1, gainDb: -2 }], ['peak', 2500, { q: 1, gainDb: -2.5 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.14 } });
  track('vc', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.25, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.15 } });
  track('vcSus', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.28, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 }, legatoOffset: 0.08, legatoAttack: 0.06 });
  track('cb', { bus: 'str', pan: 0.65, width: 0.35, gainDb: -4, send: 0.22, eq: [['highpass', 32], ['peak', 180, { q: 1, gainDb: -2.5 }]], humanize: { time: 0.004, dyn: 0.03, detune: 2 },
    ensemble: [{}, { detune: 7, delay: 0.011, alt: 1, pan: 0.08, gainDb: -2 }], choke: { release: 0.18 } });
  track('harp', { bus: 'str', pan: -0.65, width: 0.6, gainDb: -10, send: 0.45, eq: [['highpass', 90]], humanize: { time: 0.006, dyn: 0.05, detune: 1 } });
  track('hn', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: 0.5, send: 0.4, eq: [['highpass', 80], ['peak', 420, { q: 1, gainDb: -2.5 }], ['peak', 2400, { q: 0.8, gainDb: 2.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.013, alt: 1, pan: 0.12, gainDb: -1 }, { detune: -7, delay: 0.021, alt: -1, pan: -0.12, gainDb: -1.5 }], legatoOffset: 0.09, legatoAttack: 0.06 });
  track('hnSolo', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: 0, send: 0.48, eq: [['highpass', 80]], humanize: { time: 0.007, dyn: 0.02, detune: 2 }, legatoOffset: 0.09, legatoAttack: 0.07 });
  track('hnChord', { bus: 'brass', pan: -0.35, width: 0.7, gainDb: -5, send: 0.45, eq: [['highpass', 80], ['peak', 420, { q: 1, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 } });
  track('tpt', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: 0, send: 0.38, eq: [['highpass', 140], ['peak', 2800, { q: 0.8, gainDb: 2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: -6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.07, legatoAttack: 0.05 });
  track('tptStab', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: -6, send: 0.38, eq: [['highpass', 150]], humanize: { time: 0.005, dyn: 0.04, detune: 3 } });
  track('tbn', { bus: 'brass', pan: 0.3, width: 0.6, gainDb: 0, send: 0.4, eq: [['highpass', 55], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.08, legatoAttack: 0.05 });
  track('tbnChord', { bus: 'brass', pan: 0.32, width: 0.7, gainDb: -4, send: 0.42, eq: [['highpass', 60], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.007, dyn: 0.03, detune: 3 } });
  track('tuba', { bus: 'brass', pan: 0.45, width: 0.4, gainDb: -1, send: 0.35, eq: [['highpass', 30], ['peak', 160, { q: 1, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 2 } });
  track('fl', { bus: 'winds', pan: -0.1, width: 0.5, gainDb: -8, send: 0.42, eq: [['highpass', 250]], humanize: { time: 0.006, dyn: 0.03, detune: 2 }, legatoOffset: 0.06, legatoAttack: 0.05 });
  track('timp', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: -1.5, send: 0.35, eq: [['highpass', 30], ['lowshelf', 90, { gainDb: 1.5 }]], humanize: { time: 0.004, dyn: 0.035, detune: 0 } });
  track('bd', { bus: 'perc', pan: 0.05, width: 0.7, gainDb: -2.5, send: 0.3, eq: [['highpass', 28], ['lowshelf', 70, { gainDb: 1.5 }]], humanize: { time: 0.003, dyn: 0.03, detune: 0 } });
  track('taiko', { bus: 'perc', pan: 0.0, width: 0.8, gainDb: -1, send: 0.3, eq: [['highpass', 35], ['lowshelf', 80, { gainDb: 1.5 }], ['highshelf', 5000, { gainDb: -3 }]], humanize: { time: 0.005, dyn: 0.04, detune: 0 } });
  track('snare', { bus: 'perc', pan: -0.12, width: 0.7, gainDb: -9, send: 0.34, eq: [['highpass', 120]], humanize: { time: 0.004, dyn: 0.05, detune: 0 } });
  track('drums', { bus: 'perc', pan: -0.1, width: 0.8, gainDb: -5, send: 0.33, eq: [['highpass', 60]], humanize: { time: 0.004, dyn: 0.05, detune: 0 } });
  track('anvil', { bus: 'perc', pan: 0.3, width: 0.6, gainDb: -12, send: 0.36, eq: [['highpass', 600], ['highshelf', 8000, { gainDb: -4 }]], humanize: { time: 0.003, dyn: 0.04, detune: 0 } });
  track('cym', { bus: 'perc', pan: -0.2, width: 0.9, gainDb: -9, send: 0.42, eq: [['highpass', 300]], humanize: { time: 0.002, dyn: 0.02, detune: 0 } });
  track('gong', { bus: 'perc', pan: 0.25, width: 0.9, gainDb: -7, send: 0.45, eq: [['highpass', 40]], humanize: { time: 0, dyn: 0, detune: 0 } });
  const choir = [];

  // --- note entry (seed from track, block, time-in-block, pitch: the two LEAD copies render identically) ---
  let BLOCK = { name: 'main', t0: 0 };
  const add = (tr, art, t, midi, dur, o = {}) => {
    const m = typeof midi === 'number' ? midi : /^\d+$/.test(midi) ? +midi : P(midi);
    const local = Math.round((t - BLOCK.t0) * 1000);
    tracks[tr].notes.push({ art, midi: m, t, dur, dyn: o.dyn ?? 0.7, seed: hash32('ep', tr, BLOCK.name, local, m, o.v || 0),
      legato: !!o.legato, attack: o.attack, release: o.release, offset: o.offset, gainDb: o.gainDb, advance: o.advance, pan: o.pan, vib: o.vib });
  };
  /** melodic line "G4:1 D5:2 ..." from (bar, beat); r = rest; [A3,C4] = chord. Options: dyn (number|fn), legato, gate,
   *  shape (messa di voce on long notes), vib ({depth, rate}) = slow vibrato onset on held notes, phrase (adds a gentle
   *  arch across each 4-bar phrase), accent (first note of each bar a touch stronger) */
  const mel = (tr, art, bar, str, o = {}) => {
    let beat = o.beat || 0, first = true;
    const base = typeof o.dyn === 'function' ? o.dyn : () => (o.dyn ?? 0.7);
    const arch = o.phrase ? (t) => o.phrase * Math.sin(Math.PI * clamp01(((t - T(bar)) % (4 * BAR)) / (4 * BAR))) : () => 0;
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = d.split('+').reduce((a, x) => a + parseFloat(x), 0);
      if (p !== 'r') {
        const t = T(bar, beat) + (o.shift || 0);
        const dur = beats * BEAT * (o.gate ?? 1);
        const pitches = p.startsWith('[') ? p.slice(1, -1).split(',') : [p];
        const acc = o.accent && Math.abs(beat % 4) < 1e-6 ? o.accent : 0;
        let dyn = (tt) => base(tt) + arch(tt) + acc;
        if (o.shape && beats >= 1.5) { const d0 = dyn, k = o.shape === true ? 0.05 : o.shape; dyn = (tt) => d0(tt) + k * Math.sin(Math.PI * clamp01((tt - t) / dur)); }
        const vib = o.vib && beats >= 1.5 ? { delay: Math.min(0.45, dur * 0.3), rise: Math.min(0.8, dur * 0.4), depth: o.vib.depth ?? 10, rate: o.vib.rate ?? 5.2 } : undefined;
        pitches.forEach((pp, k) => add(tr, art, t, pp, dur, { ...o, dyn, vib, v: k, legato: o.legato && !first }));
        first = false;
      } else first = true;
      beat += beats;
    }
    return beat;
  };
  // ------------------------------------------------------------------------------------------------ writers
  /** viola/violin 16th ostinato: P a P b P c P b (x2); accents on the beats, lighter on the "a" of 2 and 4 */
  const ost16 = (tr, art, bars, dynFn, oct = 0, gainDb = 0) => {
    for (const bar of bars) {
      const [p, a, b, c] = chordOf(bar).ost.map((x) => P(x) + 12 * oct), cell = [p, a, p, b, p, c, p, b];
      for (let i = 0; i < 16; i++) {
        const acc = i % 4 === 0 ? 0.1 : i === 6 || i === 14 ? 0.04 : -0.05;
        add(tr, art, T(bar, i * 0.25), cell[i % 8], 0.25 * BEAT, { dyn: (tt) => dynFn(tt) + acc, gainDb });
      }
    }
  };
  /** galloping celli: 8th + two 16ths per beat on the root, octave leap on beat 3 */
  const gallop = (tr, art, bars, dynFn) => {
    for (const bar of bars) {
      let r = P(chordOf(bar).bass); while (r < P('C2')) r += 12;
      for (let b = 0; b < 4; b++) [[0, 0.5], [0.5, 0.25], [0.75, 0.25]].forEach(([o, l], k) => {
        const m = b === 2 && k === 0 ? r + 12 : r;
        add(tr, art, T(bar, b + o), m, l * BEAT, { dyn: (tt) => dynFn(tt) + (k === 0 ? (b % 2 ? 0.04 : 0.1) : -0.06) });
      });
    }
  };
  /** straight driving 8ths: low root, octave above on the off-beats of 2 and 4 */
  const drive8 = (tr, art, bars, dynFn, octave = 0) => {
    for (const bar of bars) {
      let r = P(chordOf(bar).bass) + 12 * octave; if (tr === 'vc') while (r < P('C2')) r += 12;
      for (let i = 0; i < 8; i++) add(tr, art, T(bar, i * 0.5), i === 3 || i === 7 ? r + 12 : r, 0.5 * BEAT, { dyn: (tt) => dynFn(tt) + (i % 2 ? -0.05 : 0.06) });
    }
  };
  /** sustained low brass chord per bar (trombones close position from F2, tuba on the root) */
  const lowBrass = (bars, dynFn, o = {}) => {
    for (const bar of bars) {
      const sw = (t) => dynFn(t) + 0.06 * Math.sin(Math.PI * clamp01((t - T(bar)) / BAR));
      for (const m of voicing(bar, o.lo || 'F2', 3)) add('tbnChord', 'tbnSus', T(bar), m, BAR * 0.97, { dyn: sw });
      let r = P(chordOf(bar).bass); if (r < P('A1')) r += 12;
      add('tuba', 'tubaSus', T(bar), r - (o.tubaLow ? 12 : 0), BAR * 0.97, { dyn: plus(sw, -0.04) });
    }
  };
  const hornPad = (bars, dynFn, lo = 'Bb3') => { for (const bar of bars) for (const m of voicing(bar, lo, 3)) add('hnChord', 'hnSus', T(bar), m, BAR * 0.97, { dyn: swell(T(bar), T(bar + 1), dynFn(T(bar)) - 0.04, dynFn(T(bar)) + 0.04, dynFn(T(bar)) - 0.02) }); };
  const strPad = (bars, dynFn) => {
    for (const bar of bars) {
      const sw = swell(T(bar), T(bar + 1), dynFn(T(bar)) - 0.06, dynFn(T(bar)) + 0.05, dynFn(T(bar)) - 0.03);
      const [a, b, c] = voicing(bar, 'G4', 3), [d, e] = voicing(bar, 'C4', 2);
      add('vln1', 'vlnSus', T(bar), c, BAR * 0.99, { dyn: sw }); add('vln2', 'vlnSus', T(bar), a, BAR * 0.99, { dyn: plus(sw, -0.03) });
      add('vla', 'vlaSus', T(bar), d, BAR * 0.99, { dyn: plus(sw, -0.04) });
      let r = P(chordOf(bar).bass); while (r < P('C2')) r += 12;
      add('vcSus', 'vcSus', T(bar), r, BAR * 0.99, { dyn: plus(sw, -0.04) }); add('cb', 'cbSus', T(bar), r - 12 >= P('E1') ? r - 12 : r, BAR * 0.99, { dyn: plus(sw, -0.08) });
    }
  };
  const SCALE = { Gm: [7, 9, 10, 0, 2, 3, 5], Bb: [10, 0, 2, 3, 5, 7, 9], D: [2, 4, 6, 7, 9, 10, 0] };
  /** harp glissando: every scale note from `from` to `to` (MIDI or names) spread over `beats` starting at (bar, beat) */
  const harpGliss = (bar, beat, from, to, beats, scale, dyn = 0.55) => {
    const a = P(from), b = P(to), dir = b > a ? 1 : -1, notes = [];
    for (let m = a; dir > 0 ? m <= b : m >= b; m += dir) if (scale.includes(((m % 12) + 12) % 12)) notes.push(m);
    notes.forEach((m, k) => add('harp', 'harp', T(bar, beat) + (k / notes.length) * beats * BEAT, m, 0.5, { dyn: dyn + 0.12 * (dir > 0 ? k / notes.length : 1 - k / notes.length) }));
  };
  const harpArp = (bar, dyn) => { const [r, t3, t5] = voicing(bar, 'G2', 3); [r, t3, t5, r + 12, t3 + 12, t5 + 12, r + 24, t5 + 12].forEach((m, k) => add('harp', 'harp', T(bar, k * 0.5), m, 0.5 * BEAT, { dyn: dyn + (k === 0 ? 0.06 : 0) - (k > 5 ? 0.04 : 0) })); };
  /** epic percussion per bar at intensity lvl (0..1); style: 'build' | 'theme' | 'climax' */
  const drums = (bar, lvl, style) => {
    const tp = timpPitch(bar);
    add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: lvl });
    add('taiko', 'taiko', T(bar), 56, BEAT, { dyn: lvl });
    if (style !== 'build' || bar % 2 === 0) add('taiko', 'taiko', T(bar, 2.5), 57, BEAT, { dyn: lvl - 0.14 });
    add('taiko', 'taiko', T(bar, 3), 57, BEAT, { dyn: lvl - 0.1 });
    if (style === 'climax') { add('bd', 'bassDrum', T(bar, 2), 60, BEAT, { dyn: lvl - 0.18 }); add('taiko', 'taiko', T(bar, 1.5), 57, BEAT, { dyn: lvl - 0.16 }); }
    // timpani: 1 . (and) . 3 . (and) .  with the fifth on the "and" of 4
    const t5 = tp + 7 <= P('A3') ? tp + 7 : tp - 5;
    add('timp', 'timp', T(bar), tp, BEAT, { dyn: lvl + 0.02, release: 0.5 });
    add('timp', 'timp', T(bar, 1.5), tp, BEAT, { dyn: lvl - 0.12, release: 0.4 });
    add('timp', 'timp', T(bar, 2), tp, BEAT, { dyn: lvl - 0.06, release: 0.4 });
    if (style !== 'build') add('timp', 'timp', T(bar, 3.5), t5, BEAT, { dyn: lvl - 0.1, release: 0.4 });
    if (style !== 'build') for (const b of [1, 3]) add('snare', 'snare', T(bar, b), 60, BEAT, { dyn: lvl - (style === 'climax' ? 0.08 : 0.16) });
    else for (const b of [1, 3]) add('drums', 'taikoStick', T(bar, b), 58, BEAT, { dyn: lvl - 0.2 });
  };
  const anvil = (bar, dyn) => add('anvil', 'anvil', T(bar), 60, 0.5, { dyn });
  const fill = (bar, dyn) => mel('timp', 'timp', bar, `r:3 ${timpPitch(bar)}:.25 ${timpPitch(bar)}:.25 ${timpPitch(bar) + 5 <= P('A3') ? timpPitch(bar) + 5 : timpPitch(bar) - 7}:.25 ${timpPitch(bar) + 5 <= P('A3') ? timpPitch(bar) + 5 : timpPitch(bar) - 7}:.25`, { dyn });
  const stab = (bar, k = 1, beat = 0) => { // tutti stab on the chord
    for (const m of voicing(bar, 'D3', 3)) add('tbnChord', 'tbnStac', T(bar, beat), m, 0.5, { dyn: 0.85 * k });
    for (const m of voicing(bar, 'D4', 3)) add('hnChord', 'hnStac', T(bar, beat), m, 0.5, { dyn: 0.85 * k, gainDb: 2 });
    for (const m of voicing(bar, 'G4', 3)) add('tptStab', 'tptStac', T(bar, beat), m, 0.5, { dyn: 0.85 * k, gainDb: 2 });
  };
  const choirBar = (bar, dynFn) => { const v = [...voicing(bar, 'G4', 2).reverse(), voicing(bar, 'C4', 1)[0], P(chordOf(bar).bass) + 12];
    ['S', 'A', 'T', 'B'].forEach((part, k) => choir.push({ part, midi: [v[0] + 0, v[1], v[2], v[3] < P('E2') ? v[3] + 12 : v[3]][k], t: T(bar), dur: BAR * 0.98, seed: hash32('epchoir', bar, k), dyn: swell(T(bar), T(bar + 1), dynFn(T(bar)) - 0.06, dynFn(T(bar)) + 0.06, dynFn(T(bar))) })); };

  // ================================================================================================ INTRO (bars 1–4)
  {
    stab(1, 1.05);
    add('bd', 'bassDrum', T(1), 58, 2 * BEAT, { dyn: 0.9 }); add('timp', 'timp', T(1), 'G2', 2 * BEAT, { dyn: 0.95, release: 0.8 });
    add('cym', 'crash', T(1), 60, 3, { dyn: 0.9, release: 2 }); add('anvil', 'anvil', T(1), 60, 0.5, { dyn: 0.8 }); add('gong', 'gong', T(1), 58, 5, { dyn: 0.7, release: 3 });
    // the horn call (motif) and the trumpets' answer, broad and proud
    mel('hn', 'hnSus', 1, 'G4:1 D5:2 C5:.5 D5:.5 | Eb5:1.5 D5:.5 C5:1 Bb4:1', { dyn: env([[T(1), 0.78], [T(2), 0.82], [T(3), 0.72]]), legato: true, shape: 0.05 });
    mel('tpt', 'tptSus', 3, 'C5:1 G5:2 F5:.5 Eb5:.5 | D5:3.6', { dyn: env([[T(3), 0.74], [T(4), 0.8], [T(5), 0.7]]), legato: true, shape: 0.05, vib: { depth: 9 } });
    mel('hn', 'hnSus', 3, 'C4:1 Eb4:2 F4:.5 G4:.5 | F#4:3.6', { dyn: env([[T(3), 0.6], [T(5), 0.62]]), legato: true });
    lowBrass([1, 2, 3, 4], env([[T(1), 0.62], [T(3), 0.58], [T(4), 0.64], [T(5), 0.72]]));
    for (const bar of [1, 2, 3, 4]) { // low strings tremolo + high tremolo swell
      let r = P(chordOf(bar).bass); while (r < P('C2')) r += 12;
      add('vcSus', 'vcTrem', T(bar), r, BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.55, 0.68, 0.6) });
      add('cb', 'cbSus', T(bar), r - 12 >= P('E1') ? r - 12 : r, BAR * 0.99, { dyn: 0.6 });
      const [a, , c] = voicing(bar, 'G4', 3);
      add('vln1', 'vlnTrem', T(bar), c, BAR * 0.99, { dyn: ramp(T(bar), T(bar + 1), 0.45, 0.62) });
      add('vln2', 'vlnTrem', T(bar), a, BAR * 0.99, { dyn: ramp(T(bar), T(bar + 1), 0.42, 0.58) });
      add('vla', 'vlaTrem', T(bar), voicing(bar, 'C4', 1)[0], BAR * 0.99, { dyn: ramp(T(bar), T(bar + 1), 0.42, 0.56) });
    }
    harpGliss(2, 3, 'G2', 'G5', 1, SCALE.Gm, 0.5);
    add('timp', 'timpRoll', T(3), 'C3', 2 * BAR - 0.05, { dyn: ramp(T(3), T(5), 0.3, 0.62), release: 0.05 });
    add('cym', 'swell2', T(5), 60, 1, { dyn: 0.62, release: 1.2 });
  }

  // ================================================================================================ LEAD (bars 5–6 and 93–94)
  const lead = (bar0) => {
    BLOCK = { name: 'LEAD', t0: T(bar0) };
    const b1 = bar0, b2 = bar0 + 1, t0 = T(b1), tEnd = T(b1 + 2);
    const cr = ramp(t0, tEnd, 0.5, 0.86, 1.4);
    ost16('vla', 'vlaSpic', [b1, b2], (t) => cr(t) - 0.12);
    ost16('vln2', 'vlnSpic', [b1, b2], (t) => cr(t) - 0.16, 1, -2);
    drive8('vc', 'vcSpic', [b1, b2], (t) => cr(t) - 0.1);
    drive8('cb', 'cbSpic', [b1, b2], (t) => cr(t) - 0.1);
    // low brass swell Eb -> D (bVI -> V), horns climb
    for (const m of ['Eb2', 'Bb2', 'G3']) add('tbnChord', 'tbnSus', T(b1), m, BAR * 0.96, { dyn: ramp(T(b1), T(b2), 0.5, 0.68) });
    for (const m of ['D2', 'A2', 'F#3']) add('tbnChord', 'tbnSus', T(b2), m, BAR * 0.96, { dyn: ramp(T(b2), tEnd, 0.6, 0.9, 1.5) });
    add('tuba', 'tubaSus', T(b1), 'Eb1', BAR * 0.96, { dyn: ramp(T(b1), T(b2), 0.5, 0.66) }); add('tuba', 'tubaSus', T(b2), 'D1', BAR * 0.96, { dyn: ramp(T(b2), tEnd, 0.6, 0.86) });
    mel('hn', 'hnSus', b1, 'G3:1.5 Bb3:1.5 Eb4:1 | F#3:1.5 A3:1.5 D4:1', { dyn: cr, gate: 0.94 });
    add('vln1', 'vlnSus', T(b1), 'G5', BAR, { dyn: plus(cr, -0.22) });
    mel('vln1', 'vlnSpic', b2, 'r:1 D5:.25 E5:.25 F#5:.25 G5:.25 A5:.25 Bb5:.25 C#6:.25 D6:.25 D5:.25 F#5:.25 A5:.25 D6:.25', { dyn: ramp(T(b2, 1), tEnd, 0.6, 0.9) });
    add('timp', 'timpRoll', T(b1), 'Eb3', BAR - 0.03, { dyn: ramp(t0, T(b2), 0.35, 0.52), release: 0.08 });
    add('timp', 'timpRoll', T(b2), 'D3', 3 * BEAT - 0.03, { dyn: ramp(T(b2), T(b2, 3), 0.5, 0.78), release: 0.06 });
    mel('timp', 'timp', b2, 'r:3 A2:.25 A2:.25 D3:.25 D3:.25', { dyn: 0.9 });
    add('drums', 'snareRoll', T(b1), 60, 2 * BAR - 0.02, { dyn: ramp(t0, tEnd, 0.15, 0.55, 1.5), release: 0.05 });
    add('cym', 'swell2', tEnd, 60, 1.2, { dyn: 0.75, release: 1.5 });
    add('bd', 'bdRoll', tEnd, 60, 0.3, { dyn: 0.5, release: 0.5 });
    BLOCK = { name: 'main', t0: 0 };
  };
  lead(5);

  // ================================================================================================ BUILD (bars 7–22)
  {
    const dB = env([[T(7), 0.6], [T(15), 0.68], [T(21), 0.78], [T(23), 0.86]]);
    // arrival on the loop point (these sit after loopStart)
    stab(7, 0.95); add('cym', 'crash', T(7), 60, 3, { dyn: 0.9, release: 2 }); add('bd', 'bassDrum', T(7), 58, 2 * BEAT, { dyn: 0.85 }); add('timp', 'timp', T(7), 'G2', 2 * BEAT, { dyn: 0.9, release: 0.8 }); anvil(7, 0.7);
    ost16('vla', 'vlaSpic', range(7, 22), (t) => dB(t) - 0.12);
    ost16('vln2', 'vlnSpic', range(15, 22), (t) => dB(t) - 0.16, 1, -2.5);
    drive8('vc', 'vcSpic', range(7, 14), (t) => dB(t) - 0.08);
    gallop('vc', 'vcSpic', range(15, 22), (t) => dB(t) - 0.08);
    drive8('cb', 'cbSpic', range(7, 22), (t) => dB(t) - 0.1);
    // low-brass motif head (1–5–4–5) in long notes on each chord pair, then on every chord
    for (const [bar, root] of [[7, 'G2'], [9, 'Eb2'], [11, 'C3'], [13, 'D3']]) {
      const r = P(root);
      mel('tbn', 'tbnSus', bar, `${r}:2 ${r + 7}:4 ${r + 5}:1 ${r + 7}:1`.replace(/(\d+):/g, (m, x) => `${pn(+x)}:`), { dyn: (t) => dB(t), gate: 0.95, shape: 0.05 });
      mel('tuba', 'tubaSus', bar, `${pn(r - 12)}:7.8`, { dyn: (t) => dB(t) - 0.08 });
    }
    lowBrass(range(15, 22), (t) => dB(t) - 0.08);
    hornPad(range(15, 22), (t) => dB(t) - 0.1);
    for (const [bar, p] of [[7, 'D6'], [9, 'Eb6'], [11, 'Eb6'], [13, 'F#6']]) add('vln1', 'vlnSus', T(bar), p, 2 * BAR * 0.98, { dyn: swell(T(bar), T(bar + 2), 0.42, 0.58, 0.48) });
    for (const bar of range(15, 22)) add('vln1', 'vlnSus', T(bar), voicing(bar, 'C6', 1)[0], BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.5, 0.64, 0.56) });
    for (const bar of range(7, 22)) drums(bar, dB(T(bar)) - (bar < 15 ? 0.12 : 0.06), 'build');
    for (const bar of [10, 14, 18]) fill(bar, 0.72);
    for (const bar of [11, 15, 19]) anvil(bar, 0.55);
    add('cym', 'crash', T(15), 60, 2.5, { dyn: 0.7, release: 2 }); add('cym', 'swellMed', T(15), 60, 0.6, { dyn: 0.55, release: 1.2 });
    // riser into the theme
    add('drums', 'snareRoll', T(21), 60, 2 * BAR - 0.02, { dyn: ramp(T(21), T(23), 0.15, 0.6, 1.5), release: 0.05 });
    add('timp', 'timpRoll', T(22), 'D3', 4 * BEAT - 0.03, { dyn: ramp(T(22), T(23), 0.4, 0.85), release: 0.05 });
    add('cym', 'swellLong', T(23), 60, 1, { dyn: 0.72, release: 1.5 });
    mel('vln1', 'vlnSpic', 22, 'r:2 D5:.25 E5:.25 F#5:.25 G5:.25 A5:.25 Bb5:.25 C6:.25 D6:.25', { dyn: ramp(T(22, 2), T(23), 0.6, 0.9) });
    harpGliss(22, 2.5, 'D3', 'D6', 1.5, SCALE.D, 0.5);
  }

  // ================================================================================================ THEME A (23–38) + A' (39–46)
  {
    const dA = env([[T(23), 0.84], [T(31), 0.86], [T(39), 0.9], [T(45), 0.92], [T(46, 3), 0.8]]);
    arrival(23);
    // melody: horns 23–30, horns + trumpets 31–38 (trumpets a touch under the horns), trumpets lead in A'
    mel('hn', 'hnSus', 23, THEME_1, { dyn: (t) => dA(t) - 0.02, legato: true, shape: 0.05, phrase: 0.05, accent: 0.03 });
    mel('vcSus', 'vcSus', 23, octDown(THEME_1), { dyn: (t) => dA(t) - 0.2, legato: true });
    mel('hn', 'hnSus', 31, THEME_2, { dyn: (t) => dA(t), legato: true, shape: 0.05, phrase: 0.05, accent: 0.03 });
    mel('tpt', 'tptSus', 31, THEME_2, { dyn: (t) => dA(t) - 0.08, legato: true, shape: 0.04, phrase: 0.05, vib: { depth: 8 } });
    mel('tpt', 'tptSus', 39, THEME_1, { dyn: (t) => dA(t) - 0.02, legato: true, shape: 0.04, phrase: 0.05, accent: 0.03, vib: { depth: 9 } });
    mel('hn', 'hnSus', 39, octDown(THEME_1), { dyn: (t) => dA(t) - 0.04, legato: true, shape: 0.04, phrase: 0.04 });
    // violin descant in A' (long notes, vibrato onset)
    mel('vln1', 'vlnSus', 39, 'D6:4 | G6:4 | F6:4 | F6:2 Eb6:2 | D6:4 | Eb6:2 Bb5:2 | C6:4 | D6:3.8', { dyn: (t) => dA(t) - 0.14, legato: true, shape: 0.06, vib: { depth: 12 } });
    // harmony: sustained low brass + strings, horn pads in A2
    lowBrass(range(23, 46), (t) => dA(t) - 0.12);
    hornPad(range(31, 38), (t) => dA(t) - 0.22, 'D4');
    for (const bar of range(23, 38)) add('vln1', 'vlnSus', T(bar), voicing(bar, 'G5', 1)[0], BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), 0.5, 0.62, 0.54) });
    ost16('vla', 'vlaSpic', range(23, 46), (t) => dA(t) - 0.16);
    ost16('vln2', 'vlnSpic', range(31, 46), (t) => dA(t) - 0.2, 1, -3);
    gallop('vc', 'vcSpic', range(23, 46), (t) => dA(t) - 0.12);
    drive8('cb', 'cbSpic', range(23, 46), (t) => dA(t) - 0.12);
    for (const bar of range(23, 45)) drums(bar, dA(T(bar)) - 0.08, bar >= 39 ? 'climax' : 'theme');
    for (const bar of range(23, 45)) if (bar % 2 === 1 || bar >= 39) anvil(bar, 0.6);
    for (const bar of [26, 30, 34, 38, 42]) fill(bar, 0.78);
    for (const bar of [31, 39]) { add('cym', 'crash', T(bar), 60, 2.5, { dyn: 0.75, release: 2 }); add('cym', 'swellShort', T(bar), 60, 0.6, { dyn: 0.55, release: 1.2 }); }
    // bar 46: brass swell on D, everything clears for the drop
    const sw = ramp(T(46), T(47) - 0.15, 0.55, 0.9, 1.6);
    for (const m of ['D3', 'F#3', 'A3']) add('tbnChord', 'tbnSus', T(46), m, BAR - 0.15, { dyn: sw, release: 0.15 });
    for (const m of ['A4', 'D5', 'F#5']) add('hnChord', 'hnSus', T(46), m, BAR - 0.15, { dyn: sw, release: 0.15 });
    add('timp', 'timpRoll', T(46), 'D3', 4 * BEAT - 0.2, { dyn: ramp(T(46), T(47) - 0.2, 0.45, 0.85), release: 0.1 });
    add('cym', 'swell2', T(47) - 0.1, 60, 0.4, { dyn: 0.7, release: 0.3 });
  }

  // ================================================================================================ B (47–62)
  {
    // 47–54 the drop: pizzicato pulse, harp, soft strings, a solo horn remembers the motif
    const dD = env([[T(47), 0.54], [T(51), 0.58], [T(55), 0.62]]);
    add('gong', 'gong', T(47), 58, 5, { dyn: 0.45, release: 3 }); add('timp', 'timp', T(47), 'G2', BEAT, { dyn: 0.6 });
    harpGliss(47, 0, 'G2', 'D6', 1.5, SCALE.Gm, 0.48);
    strPad(range(47, 54), (t) => dD(t) - 0.06);
    for (const bar of range(48, 54)) harpArp(bar, 0.44);
    for (const bar of range(47, 54)) {
      let r = P(chordOf(bar).bass); while (r < P('C2')) r += 12;
      for (const b of [0, 1.5, 2.5]) { add('vc', 'vcPizz', T(bar, b), b === 1.5 ? r + 7 : r, BEAT, { dyn: dD(T(bar)) + (b ? -0.06 : 0.04) }); }
      add('cb', 'cbPizz', T(bar), r - 12 >= P('E1') ? r - 12 : r, BEAT, { dyn: dD(T(bar)) + 0.04 });
      add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.38 });
      if (bar % 2 === 0) add('taiko', 'taiko', T(bar, 3), 57, BEAT, { dyn: 0.4 });
    }
    mel('hnSolo', 'hnSus', 49, 'G4:1 D5:2 C5:.5 D5:.5 | Eb5:1.5 D5:.5 C5:1 Bb4:1 | C5:1 G4:2 A4:.5 Bb4:.5 | A4:3.6', { dyn: env([[T(49), 0.6], [T(51), 0.66], [T(53), 0.56]]), legato: true, shape: 0.06 });
    mel('fl', 'flSus', 51, 'r:2 G5:1 F5:1 | Eb5:2 D5:2 | F#5:4', { dyn: 0.55, legato: true, vib: { depth: 6 } });
    harpGliss(54, 2, 'D3', 'G6', 2, SCALE.Gm, 0.5);
    add('cym', 'swellMed', T(55), 60, 0.6, { dyn: 0.5, release: 1.2 });
    // 55–62 the lift: violins sing over Eb – F – Gm – C (Dorian), horn pads, trombone chorale, celli spiccato returns
    const dL = env([[T(55), 0.62], [T(59), 0.68], [T(62, 2), 0.74], [T(63), 0.66]]);
    mel('vln1', 'vlnSus', 55, B_TUNE, { dyn: (t) => dL(t) + 0.04, legato: true, shape: 0.07, phrase: 0.05, vib: { depth: 14, rate: 5.4 } });
    mel('vln2', 'vlnSus', 55, octDown(B_TUNE), { dyn: (t) => dL(t) - 0.02, legato: true, shape: 0.05, vib: { depth: 10, rate: 5.1 } });
    for (const bar of range(55, 62)) {
      const [a, b] = voicing(bar, 'C4', 2);
      add('vla', 'vlaTrem', T(bar), a, BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), dL(T(bar)) - 0.2, dL(T(bar)) - 0.1, dL(T(bar)) - 0.18) });
      add('vla', 'vlaTrem', T(bar), b, BAR * 0.99, { dyn: swell(T(bar), T(bar + 1), dL(T(bar)) - 0.22, dL(T(bar)) - 0.12, dL(T(bar)) - 0.2) });
      let r = P(chordOf(bar).bass); while (r < P('C2')) r += 12;
      add('cb', 'cbSus', T(bar), r - 12 >= P('E1') ? r - 12 : r, BAR * 0.99, { dyn: dL(T(bar)) - 0.14 });
      if (bar < 59) add('vcSus', 'vcSus', T(bar), r, BAR * 0.99, { dyn: dL(T(bar)) - 0.12 });
      harpArp(bar, 0.42);
      add('timp', 'timp', T(bar), timpPitch(bar), BEAT, { dyn: dL(T(bar)) - 0.14 });
      add('bd', 'bassDrum', T(bar), 60, BEAT, { dyn: 0.45 });
    }
    hornPad(range(55, 62), (t) => dL(t) - 0.12, 'Bb3');
    lowBrass(range(59, 62), (t) => dL(t) - 0.2);
    drive8('vc', 'vcSpic', range(59, 62), (t) => dL(t) - 0.14);
    add('cym', 'swellMed', T(59), 60, 0.6, { dyn: 0.5, release: 1.2 });
  }

  // ================================================================================================ REBUILD (63–70)
  {
    const dR = env([[T(63), 0.6], [T(67), 0.72], [T(70), 0.84], [T(71), 0.92]]);
    ost16('vla', 'vlaSpic', range(63, 70), (t) => dR(t) - 0.12);
    ost16('vln2', 'vlnSpic', range(67, 70), (t) => dR(t) - 0.14, 1, -2);
    gallop('vc', 'vcSpic', range(65, 70), (t) => dR(t) - 0.08);
    drive8('vc', 'vcSpic', [63, 64], (t) => dR(t) - 0.08);
    drive8('cb', 'cbSpic', range(63, 70), (t) => dR(t) - 0.08);
    // the motif head climbs C – D – Eb – F in trombones + horns (octaves) over the tuba
    for (const [bar, root] of [[63, 'C3'], [65, 'D3'], [67, 'Eb3'], [69, 'F3']]) {
      const r = P(root), line = `${pn(r)}:2 ${pn(r + 7)}:4 ${pn(r + 5)}:1 ${pn(r + 7)}:1`;
      mel('tbn', 'tbnSus', bar, line, { dyn: (t) => dR(t), gate: 0.95, shape: 0.05 });
      mel('hn', 'hnSus', bar, octDown(line, -1), { dyn: (t) => dR(t) - 0.06, gate: 0.95, shape: 0.05 });
      mel('tuba', 'tubaSus', bar, `${pn(r - 12)}:7.8`, { dyn: (t) => dR(t) - 0.06 });
    }
    for (const bar of range(63, 70)) add('vln1', 'vlnTrem', T(bar), voicing(bar, 'G5', 1)[0], BAR * 0.99, { dyn: ramp(T(bar), T(bar + 1), dR(T(bar)) - 0.2, dR(T(bar)) - 0.1) });
    for (const bar of range(63, 69)) drums(bar, dR(T(bar)) - 0.1, bar < 67 ? 'build' : 'theme');
    for (const bar of [65, 67, 69]) anvil(bar, 0.55);
    fill(66, 0.75); fill(68, 0.8);
    add('drums', 'snareRoll', T(69), 60, 2 * BAR - 0.02, { dyn: ramp(T(69), T(71), 0.2, 0.7, 1.4), release: 0.05 });
    add('timp', 'timpRoll', T(70), 'F2', 4 * BEAT - 0.03, { dyn: ramp(T(70), T(71), 0.45, 0.9), release: 0.05 });
    // trumpet run (a quick scale "rip" into the downbeat) and the string run
    mel('tptStab', 'tptStac', 70, 'r:3 C5:.2 D5:.2 Eb5:.2 F5:.2 G5:.2', { dyn: ramp(T(70, 3), T(71), 0.66, 0.9), gainDb: 4 });
    mel('vln1', 'vlnSpic', 70, 'r:2 F5:.25 G5:.25 A5:.25 Bb5:.25 C6:.25 D6:.25 Eb6:.25 F6:.25', { dyn: ramp(T(70, 2), T(71), 0.62, 0.92) });
    harpGliss(70, 2, 'F3', 'F6', 2, SCALE.Bb, 0.55);
    add('cym', 'swellLong', T(71), 60, 1, { dyn: 0.85, release: 1.5 }); add('bd', 'bdRoll', T(71), 60, 0.3, { dyn: 0.55, release: 0.5 });
  }

  // ================================================================================================ CLIMAX (71–86) + CODA (87–92)
  {
    const dC = env([[T(71), 0.96], [T(75), 0.94], [T(79), 0.98], [T(83), 0.96], [T(87), 1.0], [T(89), 1.0], [T(91), 0.86], [T(92, 3), 0.74]]);
    arrival(71); add('gong', 'gong', T(71), 58, 5, { dyn: 0.8, release: 3 });
    mel('tpt', 'tptSus', 71, THEME_1, { dyn: (t) => dC(t) - 0.02, legato: true, shape: 0.04, phrase: 0.04, accent: 0.03, vib: { depth: 9 } });
    mel('hn', 'hnSus', 71, THEME_1, { dyn: (t) => dC(t) - 0.02, legato: true, shape: 0.04, phrase: 0.04 });
    mel('vln2', 'vlnSus', 71, THEME_1, { dyn: (t) => dC(t) - 0.14, legato: true });
    mel('tpt', 'tptSus', 79, THEME_MAJ, { dyn: (t) => dC(t), legato: true, shape: 0.04, phrase: 0.04, accent: 0.03, vib: { depth: 9 } });
    mel('hn', 'hnSus', 79, octDown(THEME_MAJ), { dyn: (t) => dC(t) - 0.02, legato: true, shape: 0.04, phrase: 0.04 });
    mel('vln2', 'vlnSus', 79, THEME_MAJ, { dyn: (t) => dC(t) - 0.14, legato: true });
    // descant (violins 1, long notes with vibrato onset)
    mel('vln1', 'vlnSus', 71, 'D6:4 | G6:4 | F6:4 | F6:2 Eb6:2 | D6:4 | Eb6:2 Bb5:2 | C6:4 | D6:3.8 | D6:4 | Eb6:4 | F6:4 | G6:4 | F6:4 | Eb6:2 G6:2 | A6:2 G6:2 | F6:3.8',
      { dyn: (t) => dC(t) - 0.12, legato: true, shape: 0.06, vib: { depth: 12 }, gainDb: 1.5 });
    mel('fl', 'flSus', 79, 'F6:4 | G6:4 | A6:4 | G6:4 | F6:4 | Bb6:4 | A6:4 | A6:3.8', { dyn: 0.7, legato: true });
    // coda: Eb – F – G major, the Picardy arrival
    mel('tpt', 'tptSus', 87, 'G5:3 F5:.5 G5:.5 | A5:3 Bb5:.5 C6:.5 | B5:4 | B5:3.6', { dyn: env([[T(87), 0.92], [T(89), 1.0], [T(90, 3), 0.9]]), legato: true, shape: 0.04, vib: { depth: 10 } });
    mel('hn', 'hnSus', 87, 'Eb5:3 D5:.5 Eb5:.5 | F5:3 G5:.5 A5:.5 | G5:4 | G5:3.6', { dyn: env([[T(87), 0.9], [T(89), 1.0], [T(90, 3), 0.88]]), legato: true });
    mel('vln1', 'vlnSus', 87, 'Bb5:4 | C6:4 | D6:4 | G6:3.8', { dyn: plus(dC, -0.08), legato: true, vib: { depth: 12 }, gainDb: 1.5 });
    for (const bar of [89, 90]) for (const m of ['G2', 'D3', 'B3', 'D4']) add('tbnChord', 'tbnSus', T(bar), m, BAR * 0.97, { dyn: dC(T(bar)) - 0.06 });
    add('gong', 'gong', T(89), 58, 5, { dyn: 0.85, release: 3 }); add('cym', 'crash', T(89), 60, 4, { dyn: 1.0, release: 2.5 }); add('cym', 'swell2', T(89), 60, 1.2, { dyn: 0.8, release: 1.5 });
    add('timp', 'timpRoll', T(89, 0.25), 'G2', 2 * BAR - 0.4, { dyn: env([[T(89), 0.85], [T(90, 2), 0.7], [T(91), 0.5]]), release: 0.3 });
    harpGliss(88, 2, 'G3', 'G6', 2, [7, 9, 11, 0, 2, 4, 6], 0.6);
    // 91–92 the drive in G minor: the motif head ff in low brass, then the LEAD builds again
    for (const [bar, line] of [[91, 'G2:1 D3:2 C3:.5 D3:.5 | Eb3:1.5 D3:.5 C3:1 Bb2:.9']]) {
      mel('tbn', 'tbnSus', bar, line, { dyn: plus(dC, 0.02), gate: 0.92 });
      mel('tuba', 'tubaSus', bar, octDown(line), { dyn: plus(dC, -0.02), gate: 0.92 });
      mel('hn', 'hnSus', bar, octDown(line, -1), { dyn: plus(dC, -0.04), gate: 0.92 });
    }
    // harmony + engine
    const climaxBars = range(71, 88), all = range(71, 92);
    lowBrass(climaxBars, (t) => dC(t) - 0.08, { tubaLow: false });
    hornPad(range(79, 86), (t) => dC(t) - 0.2, 'D4');
    for (const bar of range(71, 90)) choirBar(bar, (t) => dC(t) - 0.12);
    ost16('vla', 'vlaSpic', all, (t) => dC(t) - 0.14);
    ost16('vln2', 'vlnSpic', [...range(87, 92)], (t) => dC(t) - 0.16, 1, -2);
    gallop('vc', 'vcSpic', all, (t) => dC(t) - 0.1);
    drive8('cb', 'cbSpic', all, (t) => dC(t) - 0.1);
    for (const bar of all) if (bar !== 89 && bar !== 90) drums(bar, dC(T(bar)) - 0.06, 'climax');
    for (const bar of [89, 90]) { add('bd', 'bassDrum', T(bar), 58, BEAT, { dyn: 0.9 }); add('taiko', 'taiko', T(bar), 55, BEAT, { dyn: 0.9 }); }
    for (const bar of all) anvil(bar, bar % 2 ? 0.68 : 0.56);
    for (const bar of [74, 78, 82, 86]) fill(bar, 0.85);
    for (const bar of [75, 79, 83, 87]) add('cym', 'crash', T(bar), 60, 2.5, { dyn: bar === 79 ? 0.95 : 0.75, release: 2 });
    add('gong', 'gong', T(79), 58, 5, { dyn: 0.75, release: 3 });
    harpGliss(78, 2, 'F3', 'F6', 2, SCALE.Bb, 0.6);
    add('cym', 'swellMed', T(79), 60, 0.6, { dyn: 0.7, release: 1.2 });
  }
  lead(93);

  // arrival hit used on section downbeats (A, climax)
  function arrival(bar) {
    stab(bar, 1); add('cym', 'crash', T(bar), 60, 3, { dyn: 0.95, release: 2 }); add('bd', 'bassDrum', T(bar), 58, 2 * BEAT, { dyn: 0.9 });
    add('timp', 'timp', T(bar), timpPitch(bar) - (timpPitch(bar) - 12 >= P('D2') ? 12 : 0), 2 * BEAT, { dyn: 0.95, release: 0.8 }); anvil(bar, 0.8);
  }
  return { bpm: BPM, beat: BEAT, bar: BAR, totalBars: TOTAL_BARS, loopStart: T(LOOP_START_BAR), loopEnd: T(LOOP_END_BAR), title: TITLE, tracks, choir, sections: SECTIONS };
}

// MIDI -> pitch name (for building melodic strings from numbers)
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
function pn(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
