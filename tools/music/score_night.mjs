// PROJECT WINGNUT — "Night Shift" (working title; original composition, written as code): slow electronic piece for
// night missions. Audition piece; synthesised entirely in render_night.mjs + lib/synth.mjs (no samples).
// 100 BPM, 4/4, C minor (Aeolian; the G7b9 dominant and the Db (Neapolitan) chord supply the tension).
// The whole 64 bars loop (153.6 s); the render folds every tail past bar 64 back onto bar 1 (circular render).
//
//   bars  1–8   DUSK: filtered pad, sub drone, distant rim clicks, the arp fading in under a closed filter
//   bars  9–16  PATROL: sparse kick (1, the "and" of 3), swung 16th hats, subtractive bass line, pump
//   bars 17–24  + half-time clap on 3, the night motif on a soft lead (ping-pong delay)
//   bars 25–32  darker cycle (Ab–Bb–Db–G7b9), open hats, shaker, arp filter opens
//   bars 33–40  BREAKDOWN: no kick; pad swells, slow arp, the motif quoted far away, noise riser + clap roll
//   bars 41–56  PURSUIT: four-on-the-floor (still 100 BPM), rolling bass, motif an octave up with a third below;
//               49–56 resonant "acid" bass and backbeat claps for the peak of the tension
//   bars 57–64  RETURN: layers peel away back to the dusk texture so bar 64 flows into bar 1
//
// NIGHT MOTIF: (pickup) G–Bb–C … Eb–D | C–Bb–G — a rising minor-pentatonic figure that hangs on C and sighs back down
// to G; its answers end on D (over G7: unresolved) so the loop always wants to continue.
import { hash32 } from './lib/dsp.mjs';
import { P } from './score.mjs';

export const BPM = 100;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const STEP = BEAT / 4;
export const TOTAL_BARS = 64;
export const TITLE = 'Night Shift';
export const T = (bar, beat = 0) => ((bar - 1) * 4 + beat) * BEAT;
export const SECTIONS = [['dusk', 1, 9], ['patrol', 9, 17], ['motif', 17, 25], ['develop', 25, 33], ['break', 33, 41], ['pursuit', 41, 49], ['peak', 49, 57], ['return', 57, 65]];
const SWING = 0.56; // 16th swing: odd 16ths land at 56 % of the 8th

const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** piecewise-linear automation over bars: pts = [[bar, value], ...] (bar may be fractional), returns fn(t seconds) */
export function auto(pts) {
  return (t) => {
    const b = t / BAR + 1;
    if (b <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (b <= pts[i][0]) { const [b0, v0] = pts[i - 1], [b1, v1] = pts[i]; return v0 + (v1 - v0) * (b - b0) / (b1 - b0); }
    return pts[pts.length - 1][1];
  };
}

// chord per 2-bar slot: pad voicing, bass root, arp tones, bass colour notes (semitones above root)
const CH = {
  Cm9: { pad: ['C3', 'G3', 'Bb3', 'D4', 'Eb4'], root: 'C2', arp: ['C4', 'Eb4', 'G4', 'Bb4', 'D5'], col: [7, 10, 3] },
  Abmaj9: { pad: ['Eb3', 'G3', 'Bb3', 'C4'], root: 'Ab1', arp: ['Eb4', 'G4', 'C5', 'Bb4', 'Eb5'], col: [7, 11, 4] },
  Fm9: { pad: ['Ab3', 'C4', 'Eb4', 'G4'], root: 'F1', arp: ['Ab4', 'C5', 'Eb5', 'G4', 'C4'], col: [7, 10, 3] },
  G7b9: { pad: ['F3', 'Ab3', 'B3', 'D4'], root: 'G1', arp: ['B3', 'D4', 'F4', 'Ab4', 'D5'], col: [7, 12, 10] },
  G7sus: { pad: ['F3', 'G3', 'C4', 'D4'], root: 'G1', arp: ['C4', 'D4', 'F4', 'G4', 'D5'], col: [7, 12, 10] },
  Abmaj7s11: { pad: ['Eb3', 'G3', 'C4', 'D4'], root: 'Ab1', arp: ['C4', 'D4', 'G4', 'Eb5', 'C5'], col: [7, 11, 4] },
  Bb6: { pad: ['D3', 'F3', 'G3', 'Bb3'], root: 'Bb1', arp: ['D4', 'F4', 'G4', 'Bb4', 'D5'], col: [7, 9, 4] },
  Dbmaj7: { pad: ['F3', 'Ab3', 'C4', 'Db4'], root: 'Db2', arp: ['F4', 'Ab4', 'C5', 'Db5', 'Ab4'], col: [7, 11, 4] },
};
const CYCLE_A = ['Cm9', 'Abmaj9', 'Fm9', 'G7b9'], CYCLE_B = ['Abmaj7s11', 'Bb6', 'Dbmaj7', 'G7b9'], CYCLE_BRK = ['Abmaj9', 'Fm9', 'Dbmaj7', 'G7sus'];
/** chord name for a bar (1..64) */
export function chordAt(bar) {
  const slot = Math.floor(((bar - 1) % 8) / 2);
  if (bar >= 25 && bar <= 32) return CYCLE_B[slot];
  if (bar >= 33 && bar <= 40) return CYCLE_BRK[slot];
  if (bar >= 49 && bar <= 56) return CYCLE_B[slot];
  return CYCLE_A[slot];
}

export function buildScore() {
  const notes = [], drums = [], fx = [];
  const jitter = (key, amt) => { const h = hash32(...key); return ((h % 10007) / 10007 - 0.5) * 2 * amt; };
  const N = (inst, t, midi, dur, vel, o = {}) => notes.push({ inst, t: Math.max(0, t), midi: P(midi), dur, vel: clamp01(vel), seed: hash32('night', inst, Math.round(t * 1000), P(midi)), ...o });
  const D = (inst, t, vel, o = {}) => drums.push({ inst, t: Math.max(0, t), vel: clamp01(vel), seed: hash32('nd', inst, Math.round(t * 10000)), ...o });
  const st = (bar, step) => T(bar) + step * STEP + (step % 2 === 1 ? (SWING - 0.5) * 2 * STEP : 0); // swung 16th grid

  // ------------------------------------------------------------------------------------------------ pad (every 2 bars)
  const padLvl = auto([[1, 0.5], [9, 0.62], [33, 0.66], [37, 0.8], [41, 0.68], [57, 0.62], [65, 0.5]]);
  for (let bar = 1; bar <= 64; bar += 2) {
    const c = CH[chordAt(bar)];
    c.pad.forEach((p, k) => N('pad', T(bar) + k * 0.018 + jitter(['pad', bar, k], 0.01), p, 2 * BAR - 0.1, padLvl(T(bar)) + jitter(['padv', bar, k], 0.04)));
    // breakdown: an extra high voice so the pad blooms
    if (bar >= 33 && bar <= 40) N('pad', T(bar) + 0.1, P(c.pad[c.pad.length - 1]) + 12, 2 * BAR - 0.2, 0.55);
  }
  // ------------------------------------------------------------------------------------------------ sub drone / bass
  for (let bar = 1; bar <= 64; bar += 2) { // sub sine underneath everything except the busiest bass bars (it is in the bass patch there)
    const c = CH[chordAt(bar)];
    const lvl = bar <= 8 || bar >= 61 ? 0.62 : bar >= 33 && bar <= 40 ? 0.7 : 0;
    if (lvl) N('sub', T(bar), c.root, 2 * BAR - 0.05, lvl);
  }
  const BASS_A = [[0, 0, 1.0, 3], [3, 0, 0.55, 2], [6, 12, 0.48, 1], [8, 0, 0.85, 3], [11, 0, 0.5, 2], [14, 'c0', 0.6, 2]];
  const BASS_B = [[0, 0, 0.95, 3], [3, 0, 0.5, 1], [5, 12, 0.45, 1], [8, 0, 0.8, 2], [10, 'c1', 0.55, 2], [12, 'c0', 0.6, 2], [14, 'c2', 0.5, 2]];
  const BASS_ROLL = [[0, 0, 1.0, 2], [2, 0, 0.5, 1], [3, 0, 0.62, 1], [4, 12, 0.5, 1], [6, 0, 0.7, 2], [8, 0, 0.9, 2], [10, 0, 0.5, 1], [11, 'c0', 0.62, 1], [12, 12, 0.55, 1], [13, 0, 0.5, 1], [14, 'c1', 0.66, 2]];
  const bassBar = (bar, pat, inst = 'bass', velMul = 1) => {
    const c = CH[chordAt(bar)], root = P(c.root);
    let prev;
    for (const [step, off, v, len] of pat) {
      const semi = typeof off === 'string' ? c.col[+off[1]] : off;
      const m = root + semi, t = st(bar, step) + jitter(['b', bar, step], 0.004);
      N(inst, t, m, len * STEP * 0.92, v * velMul + jitter(['bv', bar, step], 0.05), { glideFrom: prev !== undefined && step - prev.step <= 1 ? prev.m : undefined });
      prev = { step, m };
    }
  };
  for (let bar = 9; bar <= 32; bar++) bassBar(bar, (bar % 2 ? BASS_A : BASS_B), 'bass', bar < 13 ? 0.85 : 1);
  for (let bar = 33; bar <= 40; bar += 2) { const c = CH[chordAt(bar)]; N('bass', T(bar), c.root, 2 * BAR - 0.15, 0.55, { soft: true }); }
  for (let bar = 41; bar <= 48; bar++) bassBar(bar, bar % 4 === 0 ? BASS_ROLL : (bar % 2 ? BASS_A : BASS_B));
  for (let bar = 49; bar <= 56; bar++) bassBar(bar, bar % 2 ? BASS_ROLL : BASS_B, 'acid');
  for (let bar = 57; bar <= 60; bar++) bassBar(bar, bar % 2 ? BASS_A : BASS_B, 'bass', 1 - (bar - 57) * 0.08);

  // ------------------------------------------------------------------------------------------------ arp (16ths, accents 3-3-3-3-2-2)
  const ACC = new Set([0, 3, 6, 9, 12, 14]);
  const ORDER = [0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 4, 1, 3, 0, 4, 2]; // wandering up/down through the five arp tones
  const arpLvl = auto([[1, 0], [3, 0.12], [5, 0.3], [9, 0.45], [17, 0.5], [25, 0.56], [33, 0.5], [41, 0.6], [49, 0.66], [57, 0.5], [61, 0.3], [64, 0.12], [65, 0]]);
  for (let bar = 1; bar <= 64; bar++) {
    const c = CH[chordAt(bar)];
    const slow = bar >= 33 && bar <= 40; // breakdown: 8ths, longer notes
    for (let s = 0; s < 16; s += slow ? 2 : 1) {
      const lvl = arpLvl(T(bar, s / 4)); if (lvl <= 0.01) continue;
      const k = ORDER[(s + (bar % 2) * 5) % 16];
      const m = P(c.arp[k]) + ((bar >= 41 && bar <= 56 && s >= 8 && k >= 3) ? 12 : 0);
      const v = lvl * (ACC.has(s) ? 1 : 0.68) + jitter(['av', bar, s], 0.06);
      const gate = slow ? 1.6 : 0.55 + 0.25 * ((hash32('ag', bar, s) % 100) / 100);
      N('arp', st(bar, s) + jitter(['at', bar, s], 0.005), m, gate * STEP * (slow ? 2 : 1), v);
    }
  }
  // ------------------------------------------------------------------------------------------------ lead: the night motif
  const PH = [
    'r:.5 G4:.5 Bb4:.5 C5:1.5 Eb5:.75 D5:.25 | C5:1 Bb4:.5 G4:2.5',
    'r:.5 G4:.5 Bb4:.5 C5:1.5 F5:.75 Eb5:.25 | D5:1.5 C5:.5 D5:2',
    'r:.5 Ab4:.5 C5:.5 Eb5:1.5 G5:.75 F5:.25 | Eb5:1 D5:.5 C5:2.5',
    'r:.5 G4:.5 B4:.5 D5:1.5 F5:.75 Eb5:.25 | D5:3.5 r:.5',
  ];
  const PH_B = [ // over Ab–Bb–Db–G7b9 (peak): higher, more insistent
    'r:.5 Eb5:.5 G5:.5 C6:1.5 Bb5:.75 G5:.25 | Ab5:1 G5:.5 Eb5:2.5',
    'r:.5 D5:.5 F5:.5 Bb5:1.5 Ab5:.75 G5:.25 | F5:1.5 D5:.5 F5:2',
    'r:.5 F5:.5 Ab5:.5 C6:1.5 Db6:.75 C6:.25 | Ab5:1 F5:.5 Ab5:2.5',
    'r:.5 G5:.5 B5:.5 D6:1.5 F6:.75 Eb6:.25 | D6:3.5 r:.5',
  ];
  const lead = (bar, str, inst, vel, o = {}) => {
    let beat = 0, prev;
    for (const tok of str.split(/\s+/).filter((x) => x && x !== '|')) {
      const [p, d] = tok.split(':'); const beats = parseFloat(d);
      if (p !== 'r') {
        let m = P(p) + (o.transpose || 0);
        if (o.third) { const pcs = o.third; let k = 0; do { m--; if (pcs.includes(((m % 12) + 12) % 12)) k++; } while (k < 2); } // diatonic third below
        const t = T(bar, beat) + jitter(['l', inst, bar, beat], 0.008) + (o.late || 0);
        const v = vel + (beats >= 1.5 ? 0.05 : 0) + jitter(['lv', inst, bar, beat], 0.04);
        N(inst, t, m, beats * BEAT * 0.94, v, { glideFrom: prev !== undefined && beats < 1 ? prev : undefined });
        prev = m;
      } else prev = undefined;
      beat += beats;
    }
  };
  for (let i = 0; i < 4; i++) lead(17 + 2 * i, PH[i], 'lead', 0.62);
  lead(35, PH[0], 'leadFar', 0.5);
  const MINOR = [0, 2, 3, 5, 7, 8, 10], HARM = [0, 2, 3, 5, 7, 8, 11];
  for (let i = 0; i < 4; i++) { lead(41 + 2 * i, PH[i], 'lead', 0.7, { transpose: 12 }); lead(41 + 2 * i, PH[i], 'lead2', 0.5, { transpose: 12, third: i === 3 ? HARM : MINOR, late: 0.012 }); }
  for (let i = 0; i < 4; i++) lead(49 + 2 * i, PH_B[i], 'lead', 0.74);

  // ------------------------------------------------------------------------------------------------ drums
  const HAT16 = [0.55, 0.18, 0.34, 0.2, 0.62, 0.18, 0.36, 0.24, 0.58, 0.18, 0.34, 0.2, 0.64, 0.2, 0.4, 0.28];
  for (let bar = 1; bar <= 64; bar++) {
    const sec = bar <= 8 ? 'dusk' : bar <= 16 ? 'patrol' : bar <= 24 ? 'motif' : bar <= 32 ? 'develop' : bar <= 40 ? 'break' : bar <= 48 ? 'pursuit' : bar <= 56 ? 'peak' : 'return';
    const j = (k, a) => jitter([k, bar], a);
    // kick
    let kicks = [];
    if (['patrol', 'motif', 'develop'].includes(sec) || (sec === 'return' && bar <= 60)) kicks = [[0, 0.95], [10, 0.78]].concat(bar % 4 === 0 ? [[7, 0.45]] : []);
    if (sec === 'pursuit' || sec === 'peak') kicks = [[0, 1], [4, 0.86], [8, 0.92], [12, 0.86]].concat(bar % 4 === 0 ? [[14, 0.5]] : []);
    for (const [s, v] of kicks) D('kick', st(bar, s) + j('k' + s, 0.0015), v + j('kv' + s, 0.03));
    // hats
    const hatLvl = { dusk: bar >= 5 ? 0.35 : 0, patrol: 0.75, motif: 0.8, develop: 0.85, break: 0, pursuit: 0.9, peak: 1, return: bar <= 60 ? 0.8 - (bar - 57) * 0.1 : 0.35 }[sec];
    if (hatLvl) for (let s = 0; s < 16; s++) {
      if (sec === 'dusk' || (sec === 'return' && bar > 60)) { if (s % 4 !== 2) continue; } // distant offbeat ticks only
      if (sec === 'patrol' && bar < 13 && s % 2 === 1) continue;
      const open = (sec === 'develop' || sec === 'pursuit' || sec === 'peak') && (s === 6 || s === 14) && !(bar % 4 === 0 && s === 14);
      const v = hatLvl * HAT16[s] * (open ? 1.1 : 1) + j('h' + s, 0.05);
      D(open ? 'ohat' : 'hat', st(bar, s) + j('ht' + s, 0.004), v, { pan: 0.18 + j('hp' + s, 0.06) });
    }
    // clap / snare
    if (sec === 'motif' || sec === 'develop' || sec === 'pursuit') D('clap', st(bar, 8) + j('c', 0.003), 0.78 + j('cv', 0.04));
    if (sec === 'peak') { D('clap', st(bar, 4) + j('c4', 0.003), 0.7 + j('cv4', 0.04)); D('clap', st(bar, 12) + j('c12', 0.003), 0.76 + j('cv12', 0.04)); }
    // rim clicks (dusk/break/return colour, and syncopations in the groove)
    if (sec === 'dusk' || sec === 'break' || (sec === 'return' && bar > 60)) { if (bar % 2 === 0) D('rim', st(bar, 6) + j('r', 0.004), 0.32, { pan: -0.35 }); if (bar % 4 === 3) D('rim', st(bar, 15) + j('r2', 0.004), 0.22, { pan: 0.4 }); }
    else if (sec !== 'peak' && bar % 2 === 1) D('rim', st(bar, 13) + j('r3', 0.004), 0.3, { pan: -0.3 });
    // shaker 16ths
    if (sec === 'develop' || sec === 'pursuit' || sec === 'peak') for (let s = 0; s < 16; s++) D('shaker', st(bar, s) + j('s' + s, 0.005), (s % 4 === 2 ? 0.42 : s % 2 ? 0.2 : 0.3) + j('sv' + s, 0.05), { pan: -0.25 });
  }
  // breakdown build: clap roll (bar 40, 16ths crescendo) and noise riser (bars 37–40); swells into 17, 25, 49
  for (let s = 0; s < 16; s++) if (s >= 4) D('clap', st(40, s), 0.18 + 0.04 * s, { tail: 0.08 });
  fx.push({ type: 'riser', t0: T(37), t1: T(41), f0: 250, f1: 8000, gain: 0.18 });
  for (const bar of [17, 25, 49]) fx.push({ type: 'riser', t0: T(bar - 1, 2), t1: T(bar), f0: 1200, f1: 9000, gain: 0.07, reverse: true });
  fx.push({ type: 'riser', t0: T(56, 2), t1: T(57), f0: 9000, f1: 1500, gain: 0.05 }); // downward sweep into the return

  return { bpm: BPM, title: TITLE, loopStart: 0, loopEnd: T(TOTAL_BARS + 1), notes, drums, fx, sections: SECTIONS,
    autos: {
      padCut: auto([[1, 0.35], [9, 0.55], [17, 0.7], [25, 0.8], [33, 0.6], [39, 1.2], [41, 0.9], [49, 1.1], [57, 0.7], [64, 0.4], [65, 0.35]]),
      arpCut: auto([[1, 0.25], [9, 0.45], [17, 0.6], [25, 0.8], [33, 0.5], [40, 1.1], [41, 0.85], [49, 1.15], [57, 0.6], [64, 0.3], [65, 0.25]]),
      bassCut: auto([[9, 0.7], [17, 0.85], [25, 1.0], [41, 1.0], [49, 1.0], [57, 0.8], [61, 0.6]]),
      leadCut: auto([[1, 0.8], [41, 1.0], [49, 1.2], [57, 1.0]]),
    } };
}
