// PROJECT WINGNUT — "Mainspring" (original composition, written as code): leitmotif of Mainspring, Chime Squadron's ace
// and the recurring final boss. Audition piece; rendered by render_mainspring.mjs (not wired into the game).
// 90 BPM, 4/4, E minor (Phrygian/tritone colour: F natural and A#/Bb are the "wrong" notes she keeps insisting on).
//
//   bars  1–2   APPEARANCE (plays once): low brass cluster E–F–B fp, gong, bell; the glockenspiel states the motif alone
//   bars  3–4   LEAD: the clock starts (tick-tock), ratchet winds the spring, low tremolo swell ─┐ identical copies
//   bars  5–16  A "Clockwork": ticking, low string tremolo on E, glock motif, low brass motif   │ (seeds, dynamics,
//               in augmentation, muted-horn echo, string clusters creeping in                  │ notes) so the wrap
//   bars 17–28  B "The Hunt": spiccato gear ostinato (accents every 3 eighths across the bar),  │ 52→5 hears what 4→5
//               brass motif in E, then G, answer phrase over C–Bb–B, clusters to a B7b9 swell   │ heard, reverb
//   bars 29–40  C "Gaslight": subito p, the clock stops; the same motif reharmonised in C major   │ included.
//               (harp, glock, flute) sounds sweet until the A# turns it; the clock restarts (37) │
//               and everything winds up                                                        │
//   bars 41–50  D "Wound Tight": brass motif ff, glock motif in diminution as a 6-against-4 gear, │
//               ticking doubles; 49–50 the spring runs down                                    │
//   bars 51–52  LEAD (copy 2) ──────────────────────────────────────────────────────────────────┘
//   loop = [bar 5, bar 53) = [10.667 s, 138.667 s)  (48 bars = 128 s)
//
// THE MOTIF (6 notes): E–D#–E–B–C–A#, rhythm short-short-long-long-long-held (8th 8th | q q q | dotted half).
// The E–D#–E oscillation is a balance wheel ticking; B–C leans on the minor sixth; A# (tritone) refuses to resolve.
// Answer: E–D#–E–G–F#–F (ends on the flat second). Used at three speeds like gears: original (glock), x2 augmentation
// (low brass), x1/4 diminution as a running 16th ostinato (glock, climax).
import { hash32 } from './lib/dsp.mjs';
import { P, env } from './score.mjs';

export const BPM = 90;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const TOTAL_BARS = 52;
export const LOOP_START_BAR = 5, LOOP_END_BAR = 53;
export const TITLE = 'Mainspring';
export const T = (bar, beat = 0) => ((bar - 1) * 4 + beat) * BEAT;
export const SECTIONS = [['appear', 1, 3], ['lead', 3, 5], ['A1', 5, 11], ['A2', 11, 17], ['B1', 17, 23], ['B2', 23, 29], ['C1', 29, 35], ['C2', 35, 41], ['D1', 41, 47], ['D2', 47, 51], ['lead2', 51, 53]];

// motif as [semitones from tonic, beats]
export const MOTIF = [[0, 0.5], [-1, 0.5], [0, 1], [-5, 1], [-4, 1], [-6, 3]];
export const ANSWER = [[0, 0.5], [-1, 0.5], [0, 1], [3, 1], [2, 1], [1, 3]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (t0, t1, d0, d1, curve = 1) => (t) => d0 + (d1 - d0) * Math.pow(clamp01((t - t0) / (t1 - t0)), curve);
const swell = (t0, t1, d0, peak, d1, at = 0.6) => env([[t0, d0], [t0 + (t1 - t0) * at, peak], [t1, d1]]);
const plus = (f, k) => (t) => (typeof f === 'function' ? f(t) : f) + k;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export function buildScore() {
  const tracks = {};
  const track = (name, opts) => { tracks[name] = { name, notes: [], ...opts }; };

  // --- mix / staging (pan: -1 L .. +1 R; send = reverb send; ensemble = doubled players) ---
  track('vln1', { bus: 'str', pan: -0.55, width: 0.6, gainDb: -2, send: 0.34, eq: [['highpass', 180], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 1 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 } });
  track('vln2', { bus: 'str', pan: -0.25, width: 0.6, gainDb: -3, send: 0.34, eq: [['highpass', 170], ['peak', 350, { q: 1, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 } });
  track('vla', { bus: 'str', pan: 0.2, width: 0.55, gainDb: -3, send: 0.3, eq: [['highpass', 110], ['peak', 300, { q: 1, gainDb: -2.5 }]], humanize: { time: 0.005, dyn: 0.04, detune: 3 } });
  track('vc', { bus: 'str', pan: 0.42, width: 0.5, gainDb: -2, send: 0.26, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.005, dyn: 0.04, detune: 2 }, choke: { release: 0.16 } });
  track('vcSus', { bus: 'str', pan: 0.42, width: 0.5, gainDb: -2, send: 0.3, eq: [['highpass', 45], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 } });
  track('cb', { bus: 'str', pan: 0.62, width: 0.35, gainDb: -3, send: 0.24, eq: [['highpass', 30], ['peak', 180, { q: 1, gainDb: -2.5 }]], humanize: { time: 0.005, dyn: 0.03, detune: 2 },
    ensemble: [{}, { detune: 7, delay: 0.011, alt: 1, pan: 0.08, gainDb: -2 }], choke: { release: 0.2 } });
  track('harp', { bus: 'str', pan: -0.62, width: 0.6, gainDb: -11.5, send: 0.5, eq: [['highpass', 90]], humanize: { time: 0.008, dyn: 0.05, detune: 1 } });
  track('hn', { bus: 'brass', pan: -0.3, width: 0.6, gainDb: -2, send: 0.42, eq: [['highpass', 70], ['peak', 420, { q: 1, gainDb: -2 }], ['peak', 2400, { q: 0.8, gainDb: 1 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.013, alt: 1, pan: 0.12, gainDb: -1 }, { detune: -7, delay: 0.021, alt: -1, pan: -0.12, gainDb: -1.5 }], legatoOffset: 0.09, legatoAttack: 0.07 });
  track('hnMute', { bus: 'brass', pan: -0.42, width: 0.5, gainDb: -3, send: 0.5, eq: [['highpass', 120], ['peak', 1800, { q: 1, gainDb: 1.5 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 }, legatoOffset: 0.08, legatoAttack: 0.06 });
  track('tbn', { bus: 'brass', pan: 0.28, width: 0.6, gainDb: 0, send: 0.4, eq: [['highpass', 50], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: 6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }, { detune: -5, delay: 0.019, alt: -1, pan: -0.08, gainDb: -2 }], legatoOffset: 0.08, legatoAttack: 0.06 });
  track('tbnChord', { bus: 'brass', pan: 0.32, width: 0.7, gainDb: -3, send: 0.42, eq: [['highpass', 50], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.01, dyn: 0.03, detune: 4 } });
  track('tuba', { bus: 'brass', pan: 0.45, width: 0.4, gainDb: -1, send: 0.34, eq: [['highpass', 28], ['peak', 160, { q: 1, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 2 } });
  track('bsn', { bus: 'winds', pan: 0.12, width: 0.4, gainDb: -4, send: 0.4, eq: [['highpass', 50], ['peak', 400, { q: 1, gainDb: -1.5 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 }, legatoOffset: 0.07, legatoAttack: 0.05 });
  track('fl', { bus: 'winds', pan: -0.12, width: 0.5, gainDb: -8, send: 0.5, eq: [['highpass', 250]], humanize: { time: 0.008, dyn: 0.03, detune: 3 }, legatoOffset: 0.06, legatoAttack: 0.05 });
  track('glock', { bus: 'clock', pan: -0.18, width: 0.5, gainDb: -4, send: 0.42, eq: [['highpass', 400], ['peak', 3500, { q: 1.2, gainDb: -2 }], ['highshelf', 9000, { gainDb: -3 }]], humanize: { time: 0.003, dyn: 0.04, detune: 0 } });
  track('glockGear', { bus: 'clock', pan: 0.22, width: 0.5, gainDb: -9, send: 0.38, eq: [['highpass', 400], ['peak', 3500, { q: 1.2, gainDb: -2 }], ['highshelf', 9000, { gainDb: -4 }]], humanize: { time: 0.002, dyn: 0.05, detune: 0 } });
  track('bell', { bus: 'clock', pan: 0.25, width: 0.7, gainDb: -8, send: 0.55, eq: [['highpass', 150], ['peak', 2500, { q: 1, gainDb: -2 }]], humanize: { time: 0, dyn: 0.02, detune: 0 } });
  track('tick', { bus: 'clock', pan: 0.08, width: 0.3, gainDb: -10, send: 0.16, eq: [['highpass', 300], ['peak', 1400, { q: 1.4, gainDb: 1.5 }], ['highshelf', 8000, { gainDb: -2 }]], humanize: { time: 0.0015, dyn: 0.035, detune: 0 } });
  track('ratchet', { bus: 'clock', pan: 0.32, width: 0.6, gainDb: -12, send: 0.3, eq: [['highpass', 400], ['highshelf', 9000, { gainDb: -4 }]], humanize: { time: 0.004, dyn: 0.04, detune: 0 } });
  track('brake', { bus: 'perc', pan: 0.38, width: 0.6, gainDb: -14, send: 0.36, eq: [['highpass', 250], ['highshelf', 7000, { gainDb: -3 }]], humanize: { time: 0.004, dyn: 0.04, detune: 0 } });
  track('timp', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: -2.5, send: 0.36, eq: [['highpass', 30], ['lowshelf', 90, { gainDb: 1.5 }]], humanize: { time: 0.004, dyn: 0.03, detune: 0 } });
  track('bd', { bus: 'perc', pan: 0.05, width: 0.7, gainDb: -4.5, send: 0.34, eq: [['highpass', 26], ['lowshelf', 70, { gainDb: 1.5 }]], humanize: { time: 0.003, dyn: 0.02, detune: 0 } });
  track('gong', { bus: 'perc', pan: 0.25, width: 0.9, gainDb: -7, send: 0.5, eq: [['highpass', 40]], humanize: { time: 0, dyn: 0, detune: 0 } });
  track('cym', { bus: 'perc', pan: -0.2, width: 0.9, gainDb: -12, send: 0.5, eq: [['highpass', 300], ['highshelf', 8000, { gainDb: -3 }]], humanize: { time: 0.002, dyn: 0.02, detune: 0 } });

  // --- note entry ---
  // seed is derived from (track, block, time-within-block, pitch) so the two LEAD copies render bit-identically
  let BLOCK = { name: 'main', t0: 0 };
  const add = (tr, art, t, midi, dur, o = {}) => {
    const m = /^\d+$/.test(String(midi)) ? +midi : P(midi);
    const local = Math.round((t - BLOCK.t0) * 1000);
    tracks[tr].notes.push({ art, midi: m, t, dur, dyn: o.dyn ?? 0.6, seed: hash32('ms', tr, BLOCK.name, local, m, o.v || 0),
      legato: !!o.legato, attack: o.attack, release: o.release, offset: o.offset, gainDb: o.gainDb, advance: o.advance, pan: o.pan, detune: o.detune });
  };
  /** melodic line from "E4:1 F4:.5 ..." starting at (bar, beat); r = rest; [A3,C4] = chord (as in score.mjs) */
  const mel = (tr, art, bar, str, o = {}) => {
    let beat = o.beat || 0, first = true;
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = d.split('+').reduce((a, x) => a + parseFloat(x), 0);
      if (p !== 'r') {
        const t = T(bar, beat) + (o.shift || 0);
        const dur = beats * BEAT * (o.gate ?? 1);
        const pitches = p.startsWith('[') ? p.slice(1, -1).split(',') : [p];
        let dyn = o.dyn;
        if (o.shape && beats >= 1.5) { // messa di voce on long notes
          const base = typeof dyn === 'function' ? dyn : () => (dyn ?? 0.6), t0n = t, dn = dur, k = o.shape === true ? 0.05 : o.shape;
          dyn = (tt) => base(tt) + k * Math.sin(Math.PI * clamp01((tt - t0n) / dn));
        }
        pitches.forEach((pp, k) => add(tr, art, t, pp, dur, { ...o, dyn, v: k, legato: o.legato && !first }));
        first = false;
      } else first = true;
      beat += beats;
    }
    return beat;
  };
  /** the motif (or answer) from tonic `root` (MIDI or name) at (bar, beat), time-scaled by `aug`; returns beats used.
   *  Phrasing: the oscillation is played lighter and detached, the long notes swell (shape), the last note decays. */
  const motif = (tr, art, bar, beat, root, o = {}) => {
    const shape = o.form === 'answer' ? ANSWER : MOTIF, aug = o.aug ?? 1, r0 = P(root);
    let b = beat;
    shape.forEach(([semi, beats], i) => {
      const len = beats * aug, t = T(bar, b), dur = len * BEAT * (o.gate ?? (i < 2 ? 0.8 : 0.96));
      const base = typeof o.dyn === 'function' ? o.dyn : () => (o.dyn ?? 0.6);
      const acc = i === 0 ? 0.05 : i === 1 ? -0.05 : i === shape.length - 1 ? 0.02 : 0;
      let dyn = (tt) => base(tt) + acc;
      if (o.shape && len >= 1.5) { const k = o.shape === true ? 0.06 : o.shape; const d0 = dyn; dyn = (tt) => d0(tt) + k * Math.sin(Math.PI * clamp01((tt - t) / dur)); }
      if (i === shape.length - 1 && o.fade) { const d0 = dyn; dyn = (tt) => d0(tt) - o.fade * clamp01((tt - t) / dur); }
      for (const oct of o.octaves || [0]) add(tr, art, t, r0 + semi + 12 * oct, dur, { ...o, dyn, v: oct + 10, legato: o.legato && i > 0 });
      b += len;
    });
    return b - beat;
  };
  // the clock: tick (higher) / tock (lower, very slightly late: a real escapement's "beat error"), per quarter or eighth
  const ticks = (bar0, bar1, dyn, o = {}) => {
    const step = o.step ?? 1;
    for (let bar = bar0; bar <= bar1; bar++) for (let b = 0; b < 4; b += step) {
      const k = Math.round(b / step), tock = k % 2 === 1;
      if (o.skip && o.skip(bar, b)) continue;
      const t = T(bar, b) + (tock ? 0.011 : 0);
      const d = (typeof dyn === 'function' ? dyn(t) : dyn) + (b === 0 ? 0.05 : 0) + (tock ? -0.04 : 0);
      add('tick', 'woodTick', t, tock ? 56 : 62, 0.2, { dyn: d });
    }
  };
  // spiccato "gear" ostinato in 8ths: root / root / b2 / root ... accents every 3 eighths counted from bar0 (3 against 4)
  const gear = (bars, roots, dynFn, o = {}) => {
    let g = 0;
    for (const bar of bars) {
      const R = P(roots[bar]);
      const cell = [R, R, R + 1, R, R + 12, R + 1, R, R - 1];
      for (let i = 0; i < 8; i++, g++) {
        const acc = g % 3 === 0, t = T(bar, i * 0.5);
        add('vc', 'vcSpic', t, cell[i], 0.5 * BEAT, { dyn: (tt) => dynFn(tt) + (acc ? 0.1 : -0.05) });
        if (acc && o.cb !== false) add('cb', 'cbSpic', t, R - 12, 0.5 * BEAT, { dyn: (tt) => dynFn(tt) - 0.02 });
      }
    }
  };
  const swellNote = (tr, art, bar, bars, pitch, d0, pk, d1, o = {}) => add(tr, art, T(bar), pitch, bars * BAR * (o.gate ?? 0.99), { dyn: swell(T(bar), T(bar + bars), d0, pk, d1, o.at ?? 0.55), ...o });

  // ================================================================================================ APPEARANCE (bars 1–2)
  {
    const t0 = T(1), tE = T(3);
    // fp cluster: E–F–B in low brass, held with a menacing re-swell
    const fp = env([[t0, 0.95], [t0 + 0.45, 0.48], [T(2, 1), 0.62], [T(2, 3.5), 0.34]]);
    for (const p of ['E2', 'F2', 'B2']) add('tbnChord', 'tbnSus', t0, p, 2 * BAR - 0.3, { dyn: fp });
    add('tuba', 'tubaSus', t0, 'E1', 2 * BAR - 0.3, { dyn: plus(fp, -0.02) });
    for (const p of ['B3', 'E4', 'F4']) add('hn', 'hnSus', t0, p, 1.6 * BAR, { dyn: env([[t0, 0.8], [t0 + 0.4, 0.38], [T(2, 1), 0.46], [T(2, 3), 0.28]]), gainDb: -3 });
    for (const p of ['E2', 'B2', 'F3']) add('tbnChord', 'tbnStac', t0, p, 0.5, { dyn: 0.8 }); // the bite of the attack
    add('cb', 'cbTrem', t0, 'E1', 2 * BAR, { dyn: env([[t0, 0.85], [t0 + 0.5, 0.4], [tE, 0.3]]) });
    add('vcSus', 'vcTrem', t0, 'E2', 2 * BAR, { dyn: env([[t0, 0.8], [t0 + 0.5, 0.38], [tE, 0.3]]) });
    add('vcSus', 'vcTrem', t0, 'F2', 2 * BAR, { dyn: env([[t0, 0.75], [t0 + 0.5, 0.34], [tE, 0.26]]) });
    add('vln1', 'vlnTrem', t0, 'F5', 2 * BAR, { dyn: env([[t0, 0.7], [t0 + 0.4, 0.3], [T(2, 2), 0.36], [tE, 0.24]]) });
    add('vln2', 'vlnTrem', t0, 'E5', 2 * BAR, { dyn: env([[t0, 0.68], [t0 + 0.4, 0.28], [T(2, 2), 0.34], [tE, 0.22]]) });
    add('vla', 'vlaTrem', t0, 'D#4', 2 * BAR, { dyn: env([[t0, 0.66], [t0 + 0.4, 0.26], [tE, 0.22]]) });
    add('gong', 'gong', t0 + 0.012, 58, 5, { dyn: 0.74, release: 3 });
    add('bd', 'bassDrum', t0, 58, 2 * BEAT, { dyn: 0.74 });
    add('timp', 'timp', t0, 'E2', 2 * BEAT, { dyn: 0.8, release: 0.9 });
    add('timp', 'timpRoll', T(1, 0.5), 'E2', 2 * BAR - 0.6, { dyn: env([[T(1, 0.5), 0.4], [T(1, 2), 0.22], [T(2, 3), 0.3], [tE, 0.18]]), release: 0.6 });
    add('bell', 'tubBell', t0, 'E4', 4, { dyn: 0.75 });
    add('bell', 'tubBell', t0 + 0.004, 'E5', 4, { dyn: 0.5, gainDb: -4 });
    // the motif, alone and cold
    motif('glock', 'glock', 1, 1.5, 'E6', { dyn: 0.7 });
    motif('harp', 'harp', 1, 1.5, 'E4', { dyn: 0.46 });
  }

  // ================================================================================================ LEAD (bars 3–4 and 51–52)
  const lead = (bar0) => {
    BLOCK = { name: 'LEAD', t0: T(bar0) };
    const b1 = bar0, b2 = bar0 + 1, t0 = T(b1), tEnd = T(b1 + 2);
    const cr = ramp(t0, tEnd, 0.3, 0.52, 1.3);
    ticks(b1, b2, 0.42);
    // the spring is wound: four ratchet cranks, the last ones stronger
    [[b1, 0, 0.42], [b1, 2, 0.48], [b2, 0, 0.55], [b2, 2, 0.64]].forEach(([bar, beat, d]) => add('ratchet', 'ratchet', T(bar, beat) + 0.02, 60, 1.0, { dyn: d }));
    add('cb', 'cbTrem', t0, 'E1', 2 * BAR * 0.99, { dyn: cr });
    add('vcSus', 'vcTrem', t0, 'B2', 2 * BAR * 0.99, { dyn: plus(cr, -0.06) });
    add('timp', 'timpRoll', t0, 'E2', 2 * BAR - 0.05, { dyn: ramp(t0, tEnd, 0.16, 0.42, 1.5), release: 0.08 });
    mel('bsn', 'bsnSus', b1, 'E2:3 F2:1 | E2:2 D#2:1.9', { dyn: ramp(t0, tEnd, 0.38, 0.5), legato: true });
    add('vla', 'vlaTrem', T(b2), 'D#4', BAR * 0.99, { dyn: ramp(T(b2), tEnd, 0.2, 0.4) });
    add('vla', 'vlaTrem', T(b2), 'E4', BAR * 0.99, { dyn: ramp(T(b2), tEnd, 0.2, 0.42) });
    add('cym', 'swellShort', tEnd, 60, 0.8, { dyn: 0.5, release: 1.2 });
    BLOCK = { name: 'main', t0: 0 };
  };
  lead(3);

  // ================================================================================================ A "Clockwork" (bars 5–16)
  {
    const dA = env([[T(5), 0.42], [T(9), 0.45], [T(13), 0.5], [T(16, 2), 0.54], [T(17), 0.6]]);
    ticks(5, 16, (t) => dA(t) - 0.02);
    // arrival: low toll on the loop point
    add('bell', 'tubBell', T(5), 'E4', 4, { dyn: 0.62 });
    add('cb', 'cbPizz', T(5), 'E1', BEAT, { dyn: 0.7 });
    add('bd', 'bassDrum', T(5), 58, BEAT, { dyn: 0.52 });
    for (const bar of [9, 13]) { add('bd', 'bassDrum', T(bar), 58, BEAT, { dyn: 0.42 }); add('cb', 'cbPizz', T(bar), 'E1', BEAT, { dyn: 0.58 }); }
    // low string pedal: tremolo E with slow breathing swells; the cello's upper note drifts B -> C -> A# (the motif's tail)
    for (const bar of [5, 7, 9, 11, 13, 15]) swellNote('cb', 'cbTrem', bar, 2, 'E1', dA(T(bar)) - 0.12, dA(T(bar)) - 0.02, dA(T(bar)) - 0.1);
    for (const [bar, p] of [[5, 'B2'], [7, 'B2'], [9, 'C3'], [11, 'C3'], [13, 'A#2'], [15, 'B2']]) {
      swellNote('vcSus', 'vcTrem', bar, 2, 'E2', dA(T(bar)) - 0.14, dA(T(bar)) - 0.05, dA(T(bar)) - 0.12);
      swellNote('vcSus', 'vcTrem', bar, 2, p, dA(T(bar)) - 0.16, dA(T(bar)) - 0.06, dA(T(bar)) - 0.14);
    }
    // glock: motif / answer / motif (+harp a 2 octaves below, celesta-like blend)
    motif('glock', 'glock', 5, 0, 'E6', { dyn: 0.56 });
    motif('glock', 'glock', 9, 0, 'E6', { dyn: 0.54, form: 'answer' });
    motif('glock', 'glock', 13, 0, 'E6', { dyn: 0.58 });
    motif('harp', 'harp', 13, 0, 'E4', { dyn: 0.42 });
    // low brass: the motif in augmentation, p, in octaves (trombones + tuba), bars 7–10
    motif('tbn', 'tbnSus', 7, 0, 'E3', { aug: 2, dyn: env([[T(7), 0.46], [T(9), 0.54], [T(10, 2), 0.5], [T(11), 0.36]]), shape: 0.06, legato: false, gate: 0.94 });
    motif('tuba', 'tubaSus', 7, 0, 'E2', { aug: 2, dyn: env([[T(7), 0.44], [T(9), 0.5], [T(11), 0.34]]), shape: 0.05, gate: 0.94 });
    // muted horn echoes the tail (stopped, nasal): B C | A#
    mel('hnMute', 'hnMute', 11, 'r:1 B4:1 C5:1 A#4:3', { dyn: env([[T(11), 0.5], [T(12), 0.55], [T(12, 3), 0.4]]), legato: true, shape: 0.05 });
    // creeping string clusters: violas D#–E (bars 9–16), violins E–F high (bars 13–16)
    for (const bar of [9, 11, 13, 15]) { swellNote('vla', 'vlaTrem', bar, 2, 'D#4', 0.22, 0.36, 0.24); swellNote('vla', 'vlaTrem', bar, 2, 'E4', 0.22, 0.38, 0.26, { at: 0.45 }); }
    for (const bar of [13, 15]) { swellNote('vln1', 'vlnTrem', bar, 2, 'F5', 0.2, 0.36, 0.24, { at: 0.5 }); swellNote('vln2', 'vlnTrem', bar, 2, 'E5', 0.2, 0.34, 0.24, { at: 0.6 }); }
    // bassoon counter-line, bars 13–16 (the motif's B–C–A# turned into a slow lament)
    mel('bsn', 'bsnSus', 13, 'B2:3 C3:1 | B2:4 | A#2:3 B2:1 | C3:2 B2:1.9', { dyn: env([[T(13), 0.42], [T(15), 0.5], [T(17), 0.46]]), legato: true, shape: 0.05 });
    // timpani breathing at phrase ends; the build into B
    for (const bar of [8, 12]) add('timp', 'timpRoll', T(bar, 1), 'E2', 3 * BEAT - 0.05, { dyn: swell(T(bar, 1), T(bar + 1), 0.14, 0.3, 0.16), release: 0.3 });
    add('timp', 'timpRoll', T(16), 'B1', 4 * BEAT - 0.05, { dyn: ramp(T(16), T(17), 0.2, 0.55, 1.4), release: 0.06 });
    add('gong', 'gongScrape', T(15, 2), 60, 6, { dyn: 0.55, release: 2 });
    add('cym', 'swellMed', T(17), 60, 0.8, { dyn: 0.55, release: 1.2 });
  }

  // ================================================================================================ B "The Hunt" (bars 17–28)
  {
    const roots = {}; for (const b of range(17, 20)) roots[b] = 'E2'; for (const b of range(21, 24)) roots[b] = 'G2';
    Object.assign(roots, { 25: 'C2', 26: 'C2', 27: 'A#1', 28: 'B1' });
    const dB = env([[T(17), 0.62], [T(21), 0.66], [T(25), 0.68], [T(28), 0.76], [T(28, 3.5), 0.84]]);
    ticks(17, 28, (t) => dB(t) - 0.14);
    for (const bar of range(17, 28)) add('tick', 'claves', T(bar), 60, 0.2, { dyn: dB(T(bar)) - 0.22 });
    gear(range(17, 28), roots, (t) => dB(t) - 0.1);
    // low brass motif: in E (17–20), in G (21–24); horns join an octave up for G
    motif('tbn', 'tbnSus', 17, 0, 'E3', { aug: 2, dyn: (t) => dB(t), shape: 0.05, gate: 0.94 });
    motif('tuba', 'tubaSus', 17, 0, 'E2', { aug: 2, dyn: (t) => dB(t) - 0.04, gate: 0.94 });
    motif('tbn', 'tbnSus', 21, 0, 'G3', { aug: 2, dyn: (t) => dB(t) + 0.02, shape: 0.05, gate: 0.94 });
    motif('tuba', 'tubaSus', 21, 0, 'G2', { aug: 2, dyn: (t) => dB(t) - 0.02, gate: 0.94 });
    motif('hn', 'hnSus', 21, 0, 'G4', { aug: 2, dyn: (t) => dB(t) - 0.08, shape: 0.05, gate: 0.94 });
    // answer phrase over C – Bb – B, horns + trombones (octaves), tuba on the bass line
    motif('hn', 'hnSus', 25, 0, 'E4', { aug: 2, form: 'answer', dyn: (t) => dB(t) - 0.02, shape: 0.05, gate: 0.95 });
    motif('tbn', 'tbnSus', 25, 0, 'E3', { aug: 2, form: 'answer', dyn: (t) => dB(t) - 0.04, shape: 0.05, gate: 0.95 });
    mel('tuba', 'tubaSus', 25, 'C2:8 | A#1:4 | B1:3.9', { dyn: (t) => dB(t) - 0.06 });
    mel('cb', 'cbSus', 25, 'C2:8 | A#1:4 | B1:3.9', { dyn: (t) => dB(t) - 0.14 });
    // B7b9 cluster swell in bar 28 (B D# F# A C) into the subito piano
    const sw = ramp(T(28), T(29) - 0.12, 0.5, 0.86, 1.6);
    for (const p of ['B2', 'D#3', 'A3']) add('tbnChord', 'tbnSus', T(28), p, BAR - 0.12, { dyn: sw, release: 0.12 });
    for (const p of ['F#4', 'C5']) add('hn', 'hnSus', T(28, 2), p, 2 * BEAT - 0.12, { dyn: ramp(T(28, 2), T(29) - 0.12, 0.55, 0.85), release: 0.12 });
    // strings: high violins hold, then a chromatic cluster tremolo crescendo
    swellNote('vln1', 'vlnSus', 17, 4, 'B5', 0.36, 0.5, 0.42);
    swellNote('vln2', 'vlnSus', 17, 4, 'C6', 0.3, 0.44, 0.36, { at: 0.7 });
    swellNote('vln1', 'vlnSus', 21, 4, 'D6', 0.4, 0.54, 0.46);
    swellNote('vln2', 'vlnSus', 21, 4, 'D#6', 0.34, 0.48, 0.4, { at: 0.7 });
    for (const [tr, p] of [['vln1', 'F#5'], ['vln2', 'F5'], ['vla', 'E5']]) add(tr, tr === 'vla' ? 'vlaTrem' : 'vlnTrem', T(25), p, 4 * BAR - 0.12, { dyn: ramp(T(25), T(29) - 0.12, 0.3, 0.8, 1.5), release: 0.12 });
    add('vla', 'vlaTrem', T(17), 'B3', 8 * BAR * 0.99, { dyn: env([[T(17), 0.34], [T(21), 0.4], [T(25), 0.36]]) });
    // glock gear: 3-eighth cell against the bar (25–28)
    { let g = 0; for (const bar of range(25, 28)) for (let i = 0; i < 8; i++, g++) add('glockGear', 'glock', T(bar, i * 0.5), ['E6', 'B5', 'C6'][g % 3], 0.5 * BEAT, { dyn: 0.4 + (g % 3 === 0 ? 0.08 : 0) + 0.006 * g }); }
    // percussion: timpani + bass drum on the downbeats, brake-drum clank at phrase ends, roll into C
    for (const bar of range(17, 27)) {
      const r = P(roots[bar]); const tp = r < P('D2') ? r + 12 : r;
      add('timp', 'timp', T(bar), tp, BEAT, { dyn: dB(T(bar)) - 0.04, release: 0.6 });
      add('bd', 'bassDrum', T(bar), 58, BEAT, { dyn: dB(T(bar)) - 0.14 });
      if (bar % 4 === 3) add('timp', 'timp', T(bar, 3.5), tp, BEAT, { dyn: dB(T(bar)) - 0.12 });
    }
    for (const bar of [20, 24]) { add('brake', 'brake', T(bar, 3), 60, 0.5, { dyn: 0.5 }); add('brake', 'brake', T(bar, 3.5), 60, 0.5, { dyn: 0.42 }); }
    add('timp', 'timpRoll', T(28), 'B1', 4 * BEAT - 0.14, { dyn: ramp(T(28), T(29) - 0.14, 0.4, 0.82, 1.4), release: 0.1 });
    add('cym', 'swell2', T(29) - 0.08, 60, 0.4, { dyn: 0.7, release: 0.25 });
  }

  // ================================================================================================ C "Gaslight" (bars 29–40)
  {
    // 29–36: the clock stops. The same motif over C major: E–D#–E–B–C resolves sweetly ... and A# sours it (C7).
    const chords = { 29: ['C3', 'G3', 'E4', 'B4'], 30: ['C3', 'G3', 'E4', 'A#4'], 31: ['A2', 'E3', 'C4', 'B4'], 32: ['F2', 'C3', 'G#3', 'D4'],
      33: ['C3', 'G3', 'E4', 'B4'], 34: ['F#2', 'C3', 'E3', 'A3'], 35: ['G#2', 'D#3', 'C4', 'G4'], 36: ['B1', 'A2', 'D#3', 'C4'] };
    const dC = env([[T(29), 0.4], [T(33), 0.44], [T(35), 0.46], [T(37), 0.42]]);
    for (const bar of range(29, 36)) {
      const [b, a, c, d] = chords[bar], sw = swell(T(bar), T(bar + 1), dC(T(bar)) - 0.08, dC(T(bar)) + 0.04, dC(T(bar)) - 0.06);
      add('cb', 'cbSusNV', T(bar), P(b) - 12 >= P('E1') ? P(b) - 12 : P(b), BAR * 0.99, { dyn: plus(sw, -0.16) }); // light bass: this is the false calm
      add('vcSus', 'vcSus', T(bar), b, BAR * 0.99, { dyn: plus(sw, -0.1) });
      add('vla', 'vlaSus', T(bar), a, BAR * 0.99, { dyn: plus(sw, -0.06) });
      add('vln2', 'vlnSus', T(bar), c, BAR * 0.99, { dyn: plus(sw, -0.08) });
      add('vln1', 'vlnSus', T(bar), d, BAR * 0.99, { dyn: plus(sw, -0.12) });
      // harp: gentle rising-falling arpeggio (music box)
      const arp = [P(b) + 12, P(a) + 12, P(c), P(d), P(c) + 12, P(d), P(c), P(a) + 12];
      arp.forEach((m, k) => add('harp', 'harp', T(bar, k * 0.5) + (k % 2 ? 0.012 : 0), m, 0.5 * BEAT, { dyn: 0.4 + (k === 0 ? 0.06 : 0) - (k > 4 ? 0.03 : 0) }));
    }
    motif('glock', 'glock', 29, 0, 'E6', { dyn: 0.5 });
    motif('glock', 'glock', 31, 0, 'E6', { dyn: 0.48, form: 'answer' });
    motif('fl', 'flSus', 33, 0, 'E5', { dyn: 0.52, shape: 0.06, legato: true });
    motif('glock', 'glock', 33, 0, 'E6', { dyn: 0.42 });
    motif('fl', 'flSus', 35, 0, 'E5', { dyn: 0.5, form: 'answer', shape: 0.06, legato: true, fade: 0.1 });
    mel('hnMute', 'hnMute', 35, 'r:2 B4:1 C5:1 | A#4:3.6', { dyn: env([[T(35, 2), 0.36], [T(36), 0.44], [T(37), 0.3]]), legato: true });
    // 37–40: one tick ... then the clock again, the low pedal, brass fragments climbing, the spring wound for the climax
    const dW = env([[T(37), 0.36], [T(39), 0.52], [T(40), 0.66], [T(41), 0.86]]);
    add('tick', 'woodTick', T(37), 62, 0.2, { dyn: 0.55 });
    ticks(37, 40, (t) => dW(t) - 0.04, { skip: (bar, b) => bar === 37 && b < 2 });
    add('cb', 'cbTrem', T(37), 'E1', 4 * BAR - 0.1, { dyn: dW, release: 0.1 });
    add('vcSus', 'vcTrem', T(37), 'E2', 4 * BAR - 0.1, { dyn: plus(dW, -0.04), release: 0.1 });
    for (const [bar, root] of [[37, 'E2'], [38, 'F2'], [39, 'F#2'], [40, 'G2']]) {
      const r = P(root);
      mel('tbn', 'tbnSus', bar, `${r + 12}:.5 ${r + 11}:.5 ${r + 12}:2.4`, { dyn: dW(T(bar)) + 0.02, gate: 0.95 });
      add('tuba', 'tubaSus', T(bar), r, 3.4 * BEAT, { dyn: dW(T(bar)) - 0.02 });
      add('timp', 'timp', T(bar), r < P('D2') ? r + 12 : r, BEAT, { dyn: dW(T(bar)), release: 0.6 });
    }
    for (const [tr, art, p] of [['vln1', 'vlnTrem', 'G5'], ['vln2', 'vlnTrem', 'F#5'], ['vla', 'vlaTrem', 'F4']]) add(tr, art, T(37), p, 4 * BAR - 0.1, { dyn: ramp(T(37), T(41) - 0.1, 0.22, 0.78, 1.6), release: 0.1 });
    [[39, 0, 0.45], [39, 2, 0.5], [40, 0, 0.58], [40, 1, 0.62], [40, 2, 0.68], [40, 3, 0.75]].forEach(([bar, beat, d]) => add('ratchet', 'ratchet', T(bar, beat) + 0.02, 60, 0.9, { dyn: d }));
    add('gong', 'gongScrape', T(38), 60, 8, { dyn: 0.7, release: 1.5 });
    add('timp', 'timpRoll', T(40, 1), 'E2', 3 * BEAT - 0.08, { dyn: ramp(T(40, 1), T(41), 0.4, 0.9, 1.5), release: 0.06 });
    add('cym', 'swell2', T(41), 60, 1.2, { dyn: 0.8, release: 1.6 });
  }

  // ================================================================================================ D "Wound Tight" (bars 41–50)
  {
    const dD = env([[T(41), 0.87], [T(43), 0.83], [T(45), 0.86], [T(47), 0.9], [T(49), 0.78], [T(50), 0.5], [T(51), 0.3]]);
    // tutti downbeat
    add('gong', 'gong', T(41), 58, 5, { dyn: 0.9, release: 3 });
    add('bd', 'bassDrum', T(41), 58, 2 * BEAT, { dyn: 0.85 });
    add('timp', 'timp', T(41), 'E2', 2 * BEAT, { dyn: 0.9, release: 0.8 });
    add('cym', 'susHit', T(41), 60, 3, { dyn: 0.6, release: 2 });
    for (const bar of [41, 43, 45, 47]) { add('bell', 'tubBell', T(bar), 'E4', 4, { dyn: 0.8 }); add('bell', 'tubBell', T(bar) + 0.005, 'B4', 4, { dyn: 0.55, gainDb: -4 }); }
    // brass: the motif in augmentation, ff, three octaves (horns E4, trombones E3, tuba E2) ...
    motif('hn', 'hnSus', 41, 0, 'E4', { aug: 2, dyn: dD, shape: 0.04, gate: 0.95 });
    motif('tbn', 'tbnSus', 41, 0, 'E3', { aug: 2, dyn: dD, shape: 0.04, gate: 0.95 });
    motif('tuba', 'tubaSus', 41, 0, 'E2', { aug: 2, dyn: plus(dD, -0.03), gate: 0.95 });
    // ... then the answer harmonised in clusters over C – A – Bb – B
    motif('hn', 'hnSus', 45, 0, 'E4', { aug: 2, form: 'answer', dyn: dD, shape: 0.04, gate: 0.95 });
    motif('tbn', 'tbnSus', 45, 0, 'E3', { aug: 2, form: 'answer', dyn: dD, shape: 0.04, gate: 0.95 });
    mel('tuba', 'tubaSus', 45, 'C2:4 | A1:4 | A#1:4 | B1:3.8', { dyn: plus(dD, -0.04) });
    const clus = { 45: ['G2', 'C3'], 46: ['A2', 'C#3'], 47: ['A#2', 'D3'], 48: ['B2', 'D#3'] };
    for (const bar of range(45, 48)) for (const p of clus[bar]) add('tbnChord', 'tbnSus', T(bar), p, BAR * 0.96, { dyn: swell(T(bar), T(bar + 1), dD(T(bar)) - 0.2, dD(T(bar)) - 0.08, dD(T(bar)) - 0.16) });
    // strings: high tremolo clusters, gear ostinato below
    for (const [bar, a, b] of [[41, 'E6', 'F6'], [43, 'D#6', 'E6'], [45, 'G6', 'F#6'], [47, 'F6', 'E6']]) {
      add('vln1', 'vlnTrem', T(bar), a, 2 * BAR * 0.99, { dyn: swell(T(bar), T(bar + 2), dD(T(bar)) - 0.14, dD(T(bar)) - 0.04, dD(T(bar)) - 0.12) });
      add('vln2', 'vlnTrem', T(bar), b, 2 * BAR * 0.99, { dyn: swell(T(bar), T(bar + 2), dD(T(bar)) - 0.16, dD(T(bar)) - 0.06, dD(T(bar)) - 0.14, 0.7) });
    }
    add('vla', 'vlaTrem', T(41), 'B3', 8 * BAR * 0.99, { dyn: plus(dD, -0.16) });
    const roots = {}; for (const b of range(41, 44)) roots[b] = 'E2'; Object.assign(roots, { 45: 'C2', 46: 'A1', 47: 'A#1', 48: 'B1' });
    gear(range(41, 48), roots, (t) => dD(t) - 0.08);
    add('cb', 'cbSus', T(41), 'E1', 4 * BAR * 0.99, { dyn: plus(dD, -0.14) });
    // glock: the motif in diminution (16ths), a gear turning 6 against 4
    { let g = 0; for (let s = 0; s < 6 * 16; s++, g++) { const [semi] = MOTIF[g % 6]; add('glockGear', 'glock', T(41, s * 0.25), P('E6') + semi, 0.25 * BEAT, { dyn: 0.5 + (g % 6 === 0 ? 0.1 : 0) - (g % 6 === 1 ? 0.04 : 0) }); } }
    motif('glock', 'glock', 47, 0, 'E6', { dyn: 0.72 });
    // the clock, now in eighths
    ticks(41, 48, (t) => dD(t) - 0.3, { step: 0.5 });
    // percussion: timpani on 1 and 3, brake drum on a dotted-half gear (45–48), timpani fills
    for (const bar of range(41, 48)) {
      const r = P(roots[bar]), tp = r < P('D2') ? r + 12 : r;
      add('timp', 'timp', T(bar), tp, BEAT, { dyn: dD(T(bar)) - 0.06, release: 0.6 });
      add('timp', 'timp', T(bar, 2), tp, BEAT, { dyn: dD(T(bar)) - 0.18, release: 0.6 });
      add('bd', 'bassDrum', T(bar), 58, BEAT, { dyn: dD(T(bar)) - 0.2 });
    }
    for (const bar of [44, 48]) mel('timp', 'timp', bar, 'r:3 B1:.25 B1:.25 E2:.25 E2:.25', { dyn: 0.82 });
    for (let b = 0; b < 16; b += 3) add('brake', 'brake', T(45, b), 60, 0.5, { dyn: 0.55 + 0.02 * b });
    // 49–50: the spring runs down — glock slows (8ths -> quarters -> half), brass cluster dies away, ticks thin out
    mel('glock', 'glock', 49, 'E6:.5 D#6:.5 E6:.5 B5:.5 C6:.5 A#5:.5 E6:.5 D#6:.5 | E6:1 B5:1 C6:1.5 A#5:.5', { dyn: env([[T(49), 0.62], [T(50), 0.5], [T(51), 0.36]]) });
    const die = env([[T(49), 0.72], [T(50), 0.46], [T(50, 3.6), 0.2]]);
    for (const p of ['E2', 'F2', 'B2']) add('tbnChord', 'tbnSus', T(49), p, 2 * BAR - 0.4, { dyn: die });
    add('tuba', 'tubaSus', T(49), 'E1', 2 * BAR - 0.4, { dyn: plus(die, -0.02) });
    add('cb', 'cbTrem', T(49), 'E1', 2 * BAR - 0.3, { dyn: plus(die, -0.06) });
    add('vcSus', 'vcTrem', T(49), 'E2', 2 * BAR - 0.3, { dyn: plus(die, -0.06) });
    add('vln1', 'vlnTrem', T(49), 'F5', 2 * BAR - 0.3, { dyn: plus(die, -0.16) });
    add('vln2', 'vlnTrem', T(49), 'E5', 2 * BAR - 0.3, { dyn: plus(die, -0.18) });
    add('timp', 'timpRoll', T(49), 'E2', 2 * BAR - 0.3, { dyn: plus(die, -0.24), release: 0.3 });
    ticks(49, 49, 0.5);
    ticks(50, 50, 0.4, { step: 2 });
  }
  lead(51);

  return { bpm: BPM, beat: BEAT, bar: BAR, totalBars: TOTAL_BARS, loopStart: T(LOOP_START_BAR), loopEnd: T(LOOP_END_BAR), title: TITLE, tracks, choir: [], sections: SECTIONS };
}
