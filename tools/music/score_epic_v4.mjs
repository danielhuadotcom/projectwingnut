// PROJECT WINGNUT — "Sortie" v4 (original composition, written as code): the main battle theme, rewritten in the modern
// hybrid trailer / film idiom. Orchestra-led (VSCO 2 CE samples), with a synthesised hybrid layer (lib/synth.mjs:
// sub-bass pulse locked to the ostinato, low drone, Shepard riser, reverse swells, sub impacts) and a synthesised
// "ah" pad (lib/choir.mjs) doubled by high strings in place of a choir. Rendered by render_epic.mjs (default).
// D minor. Simple chord loops with slow harmonic rhythm (2 bars per chord): i–VI–III–VII (Dm–Bb–F–C) and i–VI–VII–i,
// long D pedals, and a rising major lift at the climax (Bb – C – D major). No functional voice leading: block power
// voicings (roots, fifths, octaves) that swell, with the movement in the rhythm engine.
// Tempo: 112 BPM for the hit, ramping to 124 over the build, then 124 to the end. The loop is the whole piece; it fades
// out on the last C chord (VII) into the bar-1 Dm braam (circular render; the fade tail folds under the hit).
//
//   bars  1–4   HIT: braam + impact on Dm, held; low drone and D pedal; horns in octaves state the anthem's head
//   bars  5–16  BUILD: 16th spiccato ostinato (accents 3+3+2) from pp, sub pulse locked to it, taiko and toms grow,
//               112 -> 124 BPM; Dm pedal under Dm – Bb/D – C/D – Dm – Bb – C; snare roll + impact
//   bars 17–32  PROGRESSION: i–VI–III–VII loop (Dm Bb F C) x2; pizzicato low strings under the ostinato (17–24), then
//               arco; massive sustained low brass, braams on every loop start; the anthem in horn octaves
//   bars 33–40  BREAKDOWN + SOLO: drone, pedal, solo violin (low register) over Dm – Bb – Gm – C; 37–40 Shepard riser,
//               toms, snare roll, rising braam
//   bars 41–72  CLIMAX: anthem ff with trombones (41–48), higher anthem (49–56), MAJOR LIFT Bb – C – D (57–64),
//               final minor loop with hits on every downbeat (65–72)
//   bars 73–80  FADE: the loop continues, layers drop out, fade to silence on C -> bar-1 Dm braam
//
// THE ANTHEM (horns in octaves, long notes): A – A D | D – C Bb | A – A C | G – – E
//   (5 over Dm, 3 over Bb, 3/5 over F, 5 and 3 over C: a held fifth, a fall, a rise to the 5th, then the open 3rd of C).
import { hash32 } from './lib/dsp.mjs';
import { P, env } from './score.mjs';

export const TITLE = 'Sortie';
export const TOTAL_BARS = 80;
export const OFFSET = 0.5;
const TEMPO = [[0, 112], [4, 112], [16, 124], [80, 124]];
const bpmAt = (bp) => { for (let i = 1; i < TEMPO.length; i++) if (bp <= TEMPO[i][0]) { const [a, x] = TEMPO[i - 1], [b, y] = TEMPO[i]; return x + (y - x) * (bp - a) / (b - a); } return TEMPO[TEMPO.length - 1][1]; };
const RES = 32, CUM = new Float64Array(TOTAL_BARS * 4 * RES + 2);
for (let k = 1; k < CUM.length; k++) CUM[k] = CUM[k - 1] + 60 / bpmAt(((k - 0.5) / RES) / 4) / RES;
export const T = (bar, beat = 0) => { const x = ((bar - 1) * 4 + beat) * RES, i = Math.max(0, Math.min(CUM.length - 2, Math.floor(x))), f = x - i; return OFFSET + CUM[i] + (CUM[i + 1] - CUM[i]) * f; };
const D = (bar, beat, beats) => T(bar, beat + beats) - T(bar, beat);
export const BPM = 124;
export const SECTIONS = [['hit', 1, 5], ['build', 5, 17], ['progression', 17, 33], ['solo', 33, 41], ['climaxA', 41, 49], ['climaxB', 49, 57], ['lift', 57, 65], ['final', 65, 73], ['fade', 73, 81]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (t0, t1, d0, d1, curve = 1) => (t) => d0 + (d1 - d0) * Math.pow(clamp01((t - t0) / (t1 - t0)), curve);
const swell = (t0, t1, d0, peak, d1, at = 0.6) => env([[t0, d0], [t0 + (t1 - t0) * at, peak], [t1, d1]]);
const plus = (f, k) => (t) => (typeof f === 'function' ? f(t) : f) + k;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ------------------------------------------------------------------------------------------------ harmony
const PCN = { C: 0, D: 2, Eb: 3, E: 4, F: 5, G: 7, A: 9, Bb: 10 };
const chord = (sym) => { const m = /^([A-G]b?)(m|sus4)?(?:\/([A-G]b?))?$/.exec(sym); const r = PCN[m[1]], q = m[2] || '';
  return { sym, r, minor: q === 'm', sus: q === 'sus4', third: (r + (q === 'm' ? 3 : q === 'sus4' ? 5 : 4)) % 12, fifth: (r + 7) % 12, bass: m[3] ? PCN[m[3]] : r }; };
const PROG = {};
const setp = (bar0, s) => s.split(' ').forEach((c, i) => { PROG[bar0 + i] = chord(c); });
setp(1, 'Dm Dm Dm Dm');
setp(5, 'Dm Dm Dm Dm Bb/D Bb/D C/D C/D Dm Dm Bb C');
const LOOP = 'Dm Dm Bb Bb F F C C';
setp(17, LOOP); setp(25, LOOP);
setp(33, 'Dm Dm Bb Bb Gm Gm C C'.replace(/Gm/g, 'G'));  // (G minor below)
PROG[37] = { ...chord('G'), minor: true, third: 10 }; PROG[38] = PROG[37];
setp(41, LOOP); setp(49, LOOP);
setp(57, 'Bb Bb C C Dsus4 D Bb C'); // the major lift: VI – VII – I(sus4 -> major) – VI – VII
setp(65, LOOP); setp(73, LOOP);
const ch = (bar) => PROG[bar];
const above = (pc, lo) => { let m = P(lo); while (((m % 12) + 12) % 12 !== pc) m++; return m; };

// ------------------------------------------------------------------------------------------------ the anthem
export const ANTHEM = 'A4:4 | A4:2 D5:2 | D5:4 | C5:2 Bb4:2 | A4:4 | A4:2 C5:2 | G4:4 | E4:3.6';
export const ANTHEM_HI = 'A4:2 D5:2 | F5:4 | F5:4 | E5:2 D5:2 | C5:4 | C5:2 F5:2 | E5:4 | G5:3.6';

export function buildScore() {
  const tracks = {};
  const track = (name, opts) => { tracks[name] = { name, notes: [], ...opts }; };
  // strings: big wide reverb; percussion: dry-ish
  track('vln1', { bus: 'str', pan: -0.55, width: 0.7, gainDb: -1, send: 0.42, eq: [['highpass', 180], ['peak', 350, { q: 1, gainDb: -2 }], ['highshelf', 6000, { gainDb: 1.5 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 }, legatoOffset: 0.09, legatoAttack: 0.1 });
  track('vln2', { bus: 'str', pan: -0.3, width: 0.7, gainDb: -2, send: 0.42, eq: [['highpass', 170], ['peak', 350, { q: 1, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 }, legatoOffset: 0.09, legatoAttack: 0.1 });
  track('ostHi', { bus: 'str', pan: -0.35, width: 0.6, gainDb: -3, send: 0.26, eq: [['highpass', 200], ['peak', 2600, { q: 1, gainDb: -0.5 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.1 } });
  track('ostLo', { bus: 'str', pan: 0.25, width: 0.6, gainDb: -2, send: 0.24, eq: [['highpass', 100], ['peak', 300, { q: 1, gainDb: -2 }], ['peak', 2500, { q: 1, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.1 } });
  track('vc', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.25, eq: [['highpass', 40], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.04, detune: 2 }, choke: { release: 0.12 } });
  track('vcSus', { bus: 'str', pan: 0.45, width: 0.5, gainDb: -1.5, send: 0.36, eq: [['highpass', 40], ['peak', 250, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 2 } });
  track('vla', { bus: 'str', pan: 0.2, width: 0.6, gainDb: -3, send: 0.4, eq: [['highpass', 110], ['peak', 300, { q: 1, gainDb: -2 }]], humanize: { time: 0.006, dyn: 0.03, detune: 3 } });
  track('cb', { bus: 'str', pan: 0.65, width: 0.35, gainDb: -3, send: 0.26, eq: [['highpass', 30], ['peak', 180, { q: 1, gainDb: -2 }]], humanize: { time: 0.004, dyn: 0.03, detune: 2 },
    ensemble: [{}, { detune: 7, delay: 0.011, alt: 1, pan: 0.08, gainDb: -2 }], choke: { release: 0.16 } });
  track('solo', { bus: 'str', pan: -0.12, width: 0.35, gainDb: 1, send: 0.48, eq: [['highpass', 180]], humanize: { time: 0.01, dyn: 0.03, detune: 3 }, legatoOffset: 0.09, legatoAttack: 0.09 });
  track('hn', { bus: 'brass', pan: -0.3, width: 0.7, gainDb: 1, send: 0.5, eq: [['highpass', 80], ['peak', 420, { q: 1, gainDb: -2 }], ['peak', 2200, { q: 0.8, gainDb: 2.5 }]], humanize: { time: 0.008, dyn: 0.03, detune: 4 },
    ensemble: [{}, { detune: 6, delay: 0.013, alt: 1, pan: 0.14, gainDb: -1 }, { detune: -7, delay: 0.021, alt: -1, pan: -0.14, gainDb: -1.5 }, { detune: 4, delay: 0.028, alt: 1, pan: 0.25, gainDb: -2 }], legatoOffset: 0.1, legatoAttack: 0.08 });
  track('tbn', { bus: 'brass', pan: 0.25, width: 0.7, gainDb: 0, send: 0.48, eq: [['highpass', 50], ['peak', 300, { q: 0.9, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 4 },
    ensemble: [{}, { detune: 6, delay: 0.012, alt: 1, pan: 0.12, gainDb: -1.5 }, { detune: -5, delay: 0.02, alt: -1, pan: -0.1, gainDb: -2 }], legatoOffset: 0.09, legatoAttack: 0.07 });
  track('lowBrass', { bus: 'brass', pan: 0.2, width: 0.8, gainDb: -2, send: 0.5, eq: [['highpass', 32], ['peak', 280, { q: 0.9, gainDb: -2.5 }]], humanize: { time: 0.01, dyn: 0.03, detune: 4 } });
  track('braam', { bus: 'brass', pan: 0.1, width: 0.9, gainDb: -1, send: 0.55, eq: [['highpass', 32], ['peak', 300, { q: 0.9, gainDb: -2 }], ['peak', 1200, { q: 1, gainDb: 1.5 }]], humanize: { time: 0.006, dyn: 0.02, detune: 6 } });
  track('tpt', { bus: 'brass', pan: 0.12, width: 0.5, gainDb: -1, send: 0.48, eq: [['highpass', 150], ['peak', 2800, { q: 0.8, gainDb: 1.5 }]], humanize: { time: 0.008, dyn: 0.03, detune: 3 },
    ensemble: [{}, { detune: -6, delay: 0.012, alt: 1, pan: 0.1, gainDb: -1.5 }], legatoOffset: 0.08, legatoAttack: 0.06 });
  track('tuba', { bus: 'brass', pan: 0.4, width: 0.4, gainDb: -1, send: 0.38, eq: [['highpass', 26], ['peak', 160, { q: 1, gainDb: -2 }]], humanize: { time: 0.008, dyn: 0.03, detune: 2 } });
  track('timp', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: -2, send: 0.24, eq: [['highpass', 30], ['lowshelf', 90, { gainDb: 1.5 }]], humanize: { time: 0.004, dyn: 0.035, detune: 0 } });
  track('bd', { bus: 'perc', pan: 0.0, width: 0.7, gainDb: -2, send: 0.18, eq: [['highpass', 26], ['lowshelf', 70, { gainDb: 2 }]], humanize: { time: 0.003, dyn: 0.03, detune: 0 } });
  track('taiko', { bus: 'perc', pan: -0.05, width: 0.8, gainDb: -1, send: 0.18, eq: [['highpass', 32], ['lowshelf', 80, { gainDb: 2 }], ['highshelf', 5000, { gainDb: -3 }]], humanize: { time: 0.005, dyn: 0.045, detune: 0 } });
  track('taiko2', { bus: 'perc', pan: 0.3, width: 0.7, gainDb: -4, send: 0.2, eq: [['highpass', 50], ['highshelf', 5000, { gainDb: -3 }]], humanize: { time: 0.006, dyn: 0.05, detune: 0 } });
  track('toms', { bus: 'perc', pan: -0.3, width: 0.7, gainDb: -4, send: 0.2, eq: [['highpass', 60]], humanize: { time: 0.005, dyn: 0.05, detune: 0 } });
  track('snare', { bus: 'perc', pan: -0.1, width: 0.7, gainDb: -6, send: 0.25, eq: [['highpass', 120]], humanize: { time: 0.004, dyn: 0.04, detune: 0 } });
  track('anvil', { bus: 'perc', pan: 0.3, width: 0.6, gainDb: -13, send: 0.22, eq: [['highpass', 600], ['highshelf', 8000, { gainDb: -4 }]], humanize: { time: 0.003, dyn: 0.04, detune: 0 } });
  track('cym', { bus: 'perc', pan: -0.2, width: 0.9, gainDb: -10, send: 0.45, eq: [['highpass', 300]], humanize: { time: 0.002, dyn: 0.02, detune: 0 } });
  track('gong', { bus: 'perc', pan: 0.2, width: 0.9, gainDb: -7, send: 0.45, eq: [['highpass', 40]], humanize: { time: 0, dyn: 0, detune: 0 } });
  const choir = [], synth = []; // synth: { inst, t, dur, midi, vel } / { inst:'shepard'|'riser'|'impact', ... }

  const add = (tr, art, t, midi, dur, o = {}) => {
    const m = typeof midi === 'number' ? midi : /^\d+$/.test(midi) ? +midi : P(midi);
    tracks[tr].notes.push({ art, midi: m, t, dur, dyn: o.dyn ?? 0.7, seed: hash32('ep4', tr, Math.round(t * 1000), m, o.v || 0),
      legato: !!o.legato, attack: o.attack, release: o.release, gainDb: o.gainDb, pan: o.pan, vib: o.vib });
  };
  const mel = (tr, art, bar, str, o = {}) => {
    let beat = 0, first = true; const base = typeof o.dyn === 'function' ? o.dyn : () => (o.dyn ?? 0.7);
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = parseFloat(d);
      if (p !== 'r') {
        const t = T(bar, beat), dur = D(bar, beat, beats) * (o.gate ?? 1);
        let dyn = base; if (o.shape && beats >= 2) { const k = o.shape; dyn = (tt) => base(tt) + k * Math.sin(Math.PI * clamp01((tt - t) / dur)); }
        const vib = o.vib && beats >= 2 ? { delay: Math.min(0.5, dur * 0.3), rise: Math.min(0.9, dur * 0.4), depth: o.vib, rate: 5.2 } : undefined;
        for (const k of o.octaves || [0]) add(tr, art, t, P(p) + 12 * k, dur, { ...o, dyn, vib, v: k + 5, legato: o.legato && !first });
        first = false;
      } else first = true;
      beat += beats;
    }
  };
  // ------------------------------------------------------------------------------------------------ the engine
  /** relentless 16th spiccato ostinato on the chord (root pedal / fifth / octave / third), accents 3+3+2 per half bar */
  const ostinato = (tr, bars, dynFn, base = 'D4', o = {}) => {
    for (const bar of bars) {
      const c = ch(bar), r = above(c.r, base), f = above(c.fifth, r), t3 = above(c.third, r);
      const cells = [[r, r, f, r, r, f, r, t3], [r, r, f, r, r, f, r + 12, f]];
      for (let i = 0; i < 16; i++) {
        const k = i % 8, acc = k === 0 ? 0.14 : k === 3 || k === 6 ? 0.08 : -0.06;
        add(tr, o.art || (tr === 'ostLo' ? 'vlaSpic' : 'vlnSpic'), T(bar, i * 0.25), cells[i >> 3][k], D(bar, i * 0.25, 0.25), { dyn: (tt) => dynFn(tt) + acc });
      }
    }
  };
  /** celli + basses: driving 8ths on the bass note (octave jump on the 3+3+2 accents), or pizzicato */
  const lowDrive = (bars, dynFn, art = 'spic') => {
    for (const bar of bars) {
      const c = ch(bar), r = above(c.bass, 'D2'), rl = above(c.bass, 'C1') + (above(c.bass, 'C1') < P('E1') ? 12 : 0);
      for (let i = 0; i < 8; i++) {
        const accent = [0, 3, 6].includes(i), m = i === 3 || i === 7 ? r + 12 : r;
        add('vc', art === 'pizz' ? 'vcPizz' : 'vcSpic', T(bar, i * 0.5), m, D(bar, i * 0.5, 0.5), { dyn: (tt) => dynFn(tt) + (accent ? 0.08 : -0.06) });
        if (accent) add('cb', art === 'pizz' ? 'cbPizz' : 'cbSpic', T(bar, i * 0.5), rl, D(bar, i * 0.5, 0.5), { dyn: (tt) => dynFn(tt) + 0.04 });
      }
    }
  };
  /** massive sustained low brass on a chord (power voicing: root, fifth, octave; tuba on the low root), swelling */
  const lowBrass = (bar, bars, k, o = {}) => {
    const c = ch(bar), t0 = T(bar), t1 = T(bar + bars), dur = (t1 - t0) * 0.98;
    const r2 = above(c.r, 'C2'), sw = swell(t0, t1, k - 0.18, k, k - 0.12, o.at ?? 0.65);
    for (const m of [r2, above(c.fifth, r2), r2 + 12]) add('lowBrass', 'tbnSus', t0, m, dur, { dyn: sw });
    if (o.third) add('lowBrass', 'tbnSus', t0, above(c.third, r2 + 12), dur, { dyn: plus(sw, -0.06) });
    add('tuba', 'tubaSus', t0, above(c.r, 'Bb0') < P('C1') ? above(c.r, 'Bb0') + 12 : above(c.r, 'Bb0'), dur, { dyn: plus(sw, -0.02) });
    add('vcSus', 'vcSus', t0, r2, dur, { dyn: plus(sw, -0.1) }); add('cb', 'cbSus', t0, r2 - 12 >= P('C1') ? r2 - 12 : r2, dur, { dyn: plus(sw, -0.12) });
  };
  /** braam: low brass cluster with a short hard attack that swells through the bar (+ staccato bite, sub impact) */
  const braam = (bar, k = 1, beats = 4) => {
    const c = ch(bar), t0 = T(bar), dur = D(bar, 0, beats) * 0.97, r = above(c.r, 'C2');
    const e = env([[t0, 0.92 * k], [t0 + 0.12, 0.62 * k], [t0 + dur * 0.85, 0.98 * k], [t0 + dur, 0.8 * k]]);
    for (const m of [r, above(c.fifth, r), r + 12, above(c.third, r + 12), above(c.fifth, r + 12)]) add('braam', 'tbnSus', t0, m, dur, { dyn: e, attack: 0.004 });
    for (const m of [r + 12, above(c.fifth, r + 12), r + 24]) add('braam', 'hnSus', t0, m, dur, { dyn: plus(e, -0.06), attack: 0.006 });
    add('tuba', 'tubaSus', t0, r - 12 >= P('C1') ? r - 12 : r, dur, { dyn: e });
    for (const m of [r, r + 12, above(c.fifth, r)]) add('braam', 'tbnStac', t0, m, 0.4, { dyn: 0.95 * k });
    synth.push({ inst: 'impact', t: t0, vel: k });
  };
  const impact = (bar, k = 1) => { const t0 = T(bar);
    add('bd', 'bassDrum', t0, 58, D(bar, 0, 2), { dyn: 0.95 * k }); add('taiko', 'taiko', t0, 55, D(bar, 0, 2), { dyn: 0.98 * k }); add('taiko2', 'taiko', t0 + 0.006, 56, D(bar, 0, 2), { dyn: 0.9 * k });
    add('timp', 'timp', t0, above(ch(bar).r, 'D2') > P('A2') ? above(ch(bar).r, 'D2') - 12 : above(ch(bar).r, 'D2'), D(bar, 0, 2), { dyn: 0.95 * k, release: 0.8 });
    add('cym', 'crash', t0, 60, 3, { dyn: 0.9 * k, release: 2 }); add('anvil', 'anvil', t0, 60, 0.5, { dyn: 0.75 * k }); };
  /** layered percussion per bar: lvl 0..1; style 'build' | 'drive' | 'climax' (hits on every downbeat) */
  const perc = (bar, lvl, style) => {
    const d1 = D(bar, 0, 1);
    add('taiko', 'taiko', T(bar), 55, d1, { dyn: lvl + 0.04 });
    if (style !== 'build' || bar % 2 === 0) add('taiko', 'taiko', T(bar, 2.5), 56, d1, { dyn: lvl - 0.1 });
    if (style !== 'build') {
      add('taiko', 'taiko', T(bar, 1.5), 57, d1, { dyn: lvl - 0.12 }); add('taiko', 'taiko', T(bar, 3), 55, d1, { dyn: lvl - 0.04 });
      for (const b of [0.75, 1, 2, 3.5]) add('taiko2', 'taiko', T(bar, b), 57, d1, { dyn: lvl - 0.18 });
      for (let b = 0; b < 4; b += 0.5) add('toms', 'taikoStick', T(bar, b), 58, d1, { dyn: lvl - (b % 1 ? 0.3 : 0.22) });
      add('bd', 'bassDrum', T(bar), 58, d1, { dyn: lvl }); add('bd', 'bassDrum', T(bar, 2), 58, d1, { dyn: lvl - 0.08 });
      add('timp', 'timp', T(bar), above(ch(bar).bass, 'D2') > P('A2') ? above(ch(bar).bass, 'D2') - 12 : above(ch(bar).bass, 'D2'), d1, { dyn: lvl - 0.04, release: 0.5 });
    }
    if (style === 'climax') { add('anvil', 'anvil', T(bar), 60, 0.4, { dyn: lvl - 0.14 }); add('snare', 'snare', T(bar, 1), 60, d1, { dyn: lvl - 0.2 }); add('snare', 'snare', T(bar, 3), 60, d1, { dyn: lvl - 0.16 }); add('cym', 'susHit', T(bar), 60, 1.5, { dyn: lvl - 0.35, release: 1 }); }
    if (bar % 4 === 0 && style !== 'build') mel('toms', 'tenorDrum', bar, 'r:3 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: lvl - 0.04 });
  };
  const subPulse = (bars, vel) => { for (const bar of bars) { const r = above(ch(bar).bass, 'F1'); for (let i = 0; i < 16; i++) if ([0, 3, 6, 8, 11, 14].includes(i)) synth.push({ inst: 'sub', t: T(bar, i * 0.25), dur: D(bar, i * 0.25, i % 8 === 6 ? 0.5 : 0.75) * 0.9, midi: r, vel: (typeof vel === 'function' ? vel(T(bar)) : vel) * (i % 8 === 0 ? 1 : 0.8) }); } };
  const drone = (bar, bars, vel) => synth.push({ inst: 'drone', t: T(bar), dur: D(bar, 0, 4 * bars), midi: above(ch(bar).bass, 'F1'), vel });
  const pad = (bar, bars, lvl) => { // "ah" pad (synth choir) + high, wide strings
    const c = ch(bar), t0 = T(bar), dur = D(bar, 0, 4 * bars) * 0.98, sw = swell(t0, T(bar + bars), lvl - 0.1, lvl + 0.04, lvl - 0.06);
    const s = above(c.fifth, 'G5'), a = above(c.third, 'C5'), tn = above(c.r, 'F4'), b = above(c.r, 'D3');
    [['S', s], ['A', a], ['T', tn], ['B', b]].forEach(([part, midi]) => choir.push({ part, midi, t: t0, dur, seed: hash32('ep4c', bar, part), dyn: sw }));
    add('vln1', 'vlnSus', t0, s + 12 > P('A6') ? s : s + 12 - (s + 12 > P('E6') ? 12 : 0), dur, { dyn: plus(sw, -0.08), vib: { delay: 0.6, rise: 1, depth: 9, rate: 5.2 } });
    add('vln2', 'vlnSus', t0, a + 12 > P('C6') ? a : a + 12, dur, { dyn: plus(sw, -0.1) }); add('vla', 'vlaSus', t0, tn, dur, { dyn: plus(sw, -0.1) });
  };

  // ================================================================================================ HIT (1–4)
  {
    braam(1, 1.0); impact(1, 1.0); add('gong', 'gong', T(1), 58, 6, { dyn: 0.85, release: 3 });
    drone(1, 16, 0.7);
    add('cb', 'cbTrem', T(1, 1), 'D1', D(1, 1, 15) * 0.99, { dyn: env([[T(1, 1), 0.6], [T(3), 0.45], [T(5), 0.55]]) });
    add('vcSus', 'vcTrem', T(1, 1), 'D2', D(1, 1, 15) * 0.99, { dyn: env([[T(1, 1), 0.55], [T(3), 0.42], [T(5), 0.52]]) });
    mel('hn', 'hnSus', 2, 'A3:4 | A3:2 D4:2 | D4:3.6', { dyn: env([[T(2), 0.62], [T(3), 0.7], [T(5), 0.6]]), legato: true, shape: 0.06, octaves: [0, 1] });
    lowBrass(3, 2, 0.6);
    add('timp', 'timpRoll', T(4), 'A2', D(4, 0, 4) - 0.05, { dyn: ramp(T(4), T(5), 0.25, 0.5), release: 0.1 });
    synth.push({ inst: 'reverse', t0: T(4), t1: T(5), gain: 0.06 });
  }
  // ================================================================================================ BUILD (5–16)
  {
    const dB = env([[T(5), 0.3], [T(9), 0.45], [T(13), 0.62], [T(16), 0.8], [T(17), 0.88]]);
    ostinato('ostLo', range(5, 16), (t) => dB(t) - 0.04, 'D3');
    ostinato('ostHi', range(9, 16), (t) => dB(t) - 0.1, 'D4');
    lowDrive(range(9, 16), (t) => dB(t) - 0.08);
    subPulse(range(9, 16), (t) => 0.4 + 0.5 * clamp01((t - T(9)) / (T(17) - T(9))));
    for (const bar of [5, 7, 9, 11, 13, 15]) lowBrass(bar, 2, dB(T(bar)) - 0.02);
    for (const bar of range(5, 16)) perc(bar, dB(T(bar)) - 0.12, bar < 13 ? 'build' : 'drive');
    add('cym', 'swellMed', T(9), 60, 0.6, { dyn: 0.5, release: 1.2 }); synth.push({ inst: 'reverse', t0: T(12), t1: T(13), gain: 0.07 });
    add('snare', 'snareRoll', T(15), 60, D(15, 0, 8) - 0.02, { dyn: ramp(T(15), T(17), 0.15, 0.7, 1.5), release: 0.05 });
    mel('toms', 'tenorDrum', 16, 'r:2 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25 G3:.25', { dyn: 0.75 });
    synth.push({ inst: 'reverse', t0: T(16), t1: T(17), gain: 0.1 });
  }
  // ================================================================================================ PROGRESSION (17–32): i–VI–III–VII x2
  {
    const dP = env([[T(17), 0.82], [T(25), 0.86], [T(32, 3), 0.9]]);
    braam(17, 0.95); impact(17, 0.95); braam(25, 1.0); impact(25, 1.0);
    ostinato('ostLo', range(17, 32), (t) => dP(t) - 0.12, 'D3'); ostinato('ostHi', range(17, 32), (t) => dP(t) - 0.16, 'D4');
    lowDrive(range(17, 24), (t) => dP(t) - 0.08, 'pizz'); lowDrive(range(25, 32), (t) => dP(t) - 0.1);
    for (const bar of [19, 21, 23, 27, 29, 31]) lowBrass(bar, 2, dP(T(bar)) - 0.02);
    lowBrass(17, 2, 0.7, { third: true }); lowBrass(25, 2, 0.74, { third: true });
    mel('hn', 'hnSus', 17, ANTHEM, { dyn: (t) => dP(t) - 0.04, legato: true, shape: 0.06, octaves: [-1, 0] });
    mel('hn', 'hnSus', 25, ANTHEM, { dyn: (t) => dP(t), legato: true, shape: 0.06, octaves: [-1, 0] });
    subPulse(range(17, 32), 0.85);
    for (const bar of range(17, 32)) if (bar !== 17 && bar !== 25) perc(bar, dP(T(bar)) - 0.12, 'drive');
    for (const bar of [21, 29]) add('cym', 'swellShort', T(bar), 60, 0.6, { dyn: 0.5, release: 1.2 });
    synth.push({ inst: 'reverse', t0: T(32), t1: T(33), gain: 0.08 });
  }
  // ================================================================================================ BREAKDOWN + SOLO (33–40)
  {
    drone(33, 8, 0.75);
    for (const bar of [33, 35, 37, 39]) { const c = ch(bar), r = above(c.bass, 'D2'); add('cb', 'cbSus', T(bar), r - 12 >= P('C1') ? r - 12 : r, D(bar, 0, 8) * 0.99, { dyn: 0.48 }); add('vcSus', 'vcSus', T(bar), r, D(bar, 0, 8) * 0.99, { dyn: swell(T(bar), T(bar + 2), 0.4, 0.52, 0.44) });
      add('vla', 'vlaTrem', T(bar), above(c.third, 'F3'), D(bar, 0, 8) * 0.99, { dyn: 0.36 }); }
    mel('solo', 'vlnSolo', 33, 'A4:4 | A4:2 D5:2 | D5:4 | C5:2 Bb4:2 | Bb4:4 | A4:2 G4:2 | G4:4 | E4:3.6', { dyn: env([[T(33), 0.58], [T(35), 0.66], [T(37), 0.7], [T(39), 0.62]]), legato: true, shape: 0.07, vib: 8 });
    for (const bar of range(33, 36)) add('taiko', 'taiko', T(bar), 55, D(bar, 0, 1), { dyn: 0.42 });
    // the rise: Shepard riser, toms, ostinato returning, rising braam, snare roll
    synth.push({ inst: 'shepard', t0: T(37), t1: T(41), gain: 0.16 });
    ostinato('ostLo', range(37, 40), (t) => ramp(T(37), T(41), 0.3, 0.8)(t), 'D3');
    for (const bar of range(37, 40)) for (let b = 0; b < 4; b += bar < 39 ? 1 : 0.5) add('toms', 'tenorDrum', T(bar, b), 60, D(bar, b, 0.5), { dyn: ramp(T(37), T(41), 0.3, 0.8)(T(bar, b)) });
    lowBrass(39, 2, 0.8, { at: 0.95 });
    add('snare', 'snareRoll', T(39), 60, D(39, 0, 8) - 0.02, { dyn: ramp(T(39), T(41), 0.2, 0.8, 1.4), release: 0.05 });
    add('timp', 'timpRoll', T(40), 'C3', D(40, 0, 4) - 0.03, { dyn: ramp(T(40), T(41), 0.5, 0.95), release: 0.05 });
    add('cym', 'swellLong', T(41), 60, 1, { dyn: 0.8, release: 1.5 });
  }
  // ================================================================================================ CLIMAX (41–72)
  {
    const dC = env([[T(41), 0.95], [T(49), 0.96], [T(57), 0.98], [T(65), 1.0], [T(72, 3), 0.98]]);
    for (const bar of [41, 49, 57, 65]) { braam(bar, 1.0); impact(bar, 1.0); add('gong', 'gong', T(bar), 58, 5, { dyn: 0.75, release: 3 }); }
    for (const bar of [45, 53, 61, 69]) braam(bar, 0.88);
    // anthem: horns in octaves + trombones below (41–48); higher anthem (49–56); major lift with trumpets (57–64); final (65–72)
    mel('hn', 'hnSus', 41, ANTHEM, { dyn: (t) => dC(t) - 0.02, legato: true, shape: 0.05, octaves: [-1, 0] });
    mel('tbn', 'tbnSus', 41, ANTHEM, { dyn: (t) => dC(t) - 0.08, legato: true, shape: 0.05, octaves: [-2] });
    mel('hn', 'hnSus', 49, ANTHEM_HI, { dyn: (t) => dC(t), legato: true, shape: 0.05, octaves: [-1, 0] });
    mel('tbn', 'tbnSus', 49, ANTHEM_HI, { dyn: (t) => dC(t) - 0.08, legato: true, shape: 0.05, octaves: [-2] });
    mel('hn', 'hnSus', 57, 'D5:4 | F5:4 | E5:4 | G5:4 | A5:4 | F#5:4 | F5:2 D5:2 | E5:2 G5:2', { dyn: (t) => dC(t), legato: true, shape: 0.05, octaves: [-1, 0] });
    mel('tpt', 'tptSus', 57, 'D5:4 | F5:4 | E5:4 | G5:4 | A5:4 | A5:4 | F5:2 D5:2 | E5:2 G5:2', { dyn: (t) => dC(t) - 0.06, legato: true, shape: 0.04, vib: 7 });
    mel('tbn', 'tbnSus', 57, 'D4:4 | F4:4 | E4:4 | G4:4 | A4:4 | F#4:4 | F4:2 D4:2 | E4:2 G4:2', { dyn: (t) => dC(t) - 0.08, legato: true, octaves: [-1] });
    mel('hn', 'hnSus', 65, ANTHEM_HI, { dyn: (t) => dC(t), legato: true, shape: 0.05, octaves: [-1, 0] });
    mel('tpt', 'tptSus', 65, ANTHEM_HI, { dyn: (t) => dC(t) - 0.1, legato: true, shape: 0.04, vib: 7 });
    mel('tbn', 'tbnSus', 65, ANTHEM_HI, { dyn: (t) => dC(t) - 0.08, legato: true, octaves: [-2] });
    // engine + harmony
    ostinato('ostLo', range(41, 72), (t) => dC(t) - 0.14, 'D3'); ostinato('ostHi', range(41, 72), (t) => dC(t) - 0.18, 'D4');
    lowDrive(range(41, 72), (t) => dC(t) - 0.1);
    for (let bar = 41; bar <= 72; bar += 2) if (![41, 45, 49, 53, 57, 61, 65, 69].includes(bar)) lowBrass(bar, 2, dC(T(bar)) - 0.04, { third: bar >= 57 && bar < 65 });
    for (let bar = 41; bar <= 72; bar += 2) pad(bar, 2, dC(T(bar)) - 0.14);
    subPulse(range(41, 72), 0.95);
    for (const bar of range(41, 72)) { if (![41, 49, 57, 65].includes(bar)) perc(bar, dC(T(bar)) - 0.08, 'climax'); if (bar >= 65) add('bd', 'bassDrum', T(bar, 1), 58, D(bar, 0, 1), { dyn: 0.6 }); }
    for (const bar of [48, 56, 64]) { add('snare', 'snareRoll', T(bar), 60, D(bar, 0, 4) - 0.02, { dyn: ramp(T(bar), T(bar + 1), 0.2, 0.7, 1.4), release: 0.05 }); synth.push({ inst: 'reverse', t0: T(bar), t1: T(bar + 1), gain: 0.09 }); }
    synth.push({ inst: 'shepard', t0: T(53), t1: T(57), gain: 0.1 });
  }
  // ================================================================================================ FADE (73–80): layers drop out, fade to silence (renderer fade)
  {
    const dF = env([[T(73), 0.92], [T(77), 0.8], [T(81), 0.7]]);
    braam(73, 0.85); add('cym', 'crash', T(73), 60, 3, { dyn: 0.7, release: 2 }); add('bd', 'bassDrum', T(73), 58, D(73, 0, 2), { dyn: 0.8 });
    mel('hn', 'hnSus', 73, ANTHEM, { dyn: (t) => dF(t) - 0.06, legato: true, shape: 0.05, octaves: [-1, 0] });
    ostinato('ostLo', range(73, 80), (t) => dF(t) - 0.14, 'D3'); ostinato('ostHi', range(73, 78), (t) => dF(t) - 0.2, 'D4');
    lowDrive(range(73, 78), (t) => dF(t) - 0.12);
    for (const bar of [75, 77, 79]) lowBrass(bar, 2, dF(T(bar)) - 0.04);
    for (const bar of [73, 75, 77]) pad(bar, 2, dF(T(bar)) - 0.2);
    subPulse(range(73, 78), 0.8); drone(77, 4, 0.6);
    for (const bar of range(74, 79)) perc(bar, dF(T(bar)) - 0.14, bar <= 76 ? 'drive' : 'build');
  }
  return { bpm: BPM, title: TITLE, totalBars: TOTAL_BARS, loopStart: T(1), loopEnd: T(TOTAL_BARS + 1), seam: 'circular', fade: [T(75), T(TOTAL_BARS + 1)],
    tracks, choir, synth, sections: SECTIONS, tempo: TEMPO };
}
