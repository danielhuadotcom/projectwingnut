// Synthesised "aah" choir pad (used softly under the climax). Each sung note is an ensemble of detuned voices
// (PolyBLEP sawtooth glottal source with independent vibrato, slow pitch drift and breath noise); every part
// (S/A/T/B) is shaped by a parallel formant filter bank for the vowel "ah" (classic Csound formant tables).
import { biquadCoefs, rng, dbToGain } from './dsp.mjs';

const FORMANTS = { // [freq Hz, gain dB, bandwidth Hz]
  S: [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130], [4950, -50, 140]],
  A: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
  T: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
  B: [[600, 0, 60], [1040, -7, 70], [2250, -9, 110], [2450, -9, 120], [2750, -20, 130]],
};

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/** notes: [{ part:'S'|'A'|'T'|'B', midi, t, dur, dyn:number|fn, seed }] -> [L, R] */
export function renderChoir(notes, sr, frames, { voices = 6, attack = 0.35, release = 0.7 } = {}) {
  const parts = {};
  for (const p of ['S', 'A', 'T', 'B']) parts[p] = [new Float32Array(frames), new Float32Array(frames)];
  for (const n of notes) {
    const [PL, PR] = parts[n.part];
    const r = rng(n.seed ?? Math.round(n.t * 1000 + n.midi * 7));
    const dynFn = typeof n.dyn === 'function' ? n.dyn : () => (n.dyn ?? 0.6);
    const f0 = 440 * Math.pow(2, (n.midi - 69) / 12);
    for (let v = 0; v < voices; v++) {
      const det = (r() * 2 - 1) * 9, vibRate = 4.8 + r() * 1.1, vibDepth = 12 + r() * 14, vibPh = r() * 6.283;
      const drRate = 0.15 + r() * 0.3, drPh = r() * 6.283, drDepth = 4 + r() * 5;
      const delay = r() * 0.07, pan = (r() * 2 - 1) * 0.65;
      const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
      const t0 = n.t + delay - 0.08, t1 = n.t + n.dur, tEnd = t1 + release;
      const i0 = Math.max(0, Math.floor(t0 * sr)), i1 = Math.min(frames, Math.ceil(tEnd * sr));
      let ph = r(), noiseState = 0;
      for (let i = i0; i < i1; i++) {
        const t = i / sr, tt = t - t0;
        const cents = det + vibDepth * Math.sin(6.2832 * vibRate * tt + vibPh) * Math.min(1, tt / 0.6) + drDepth * Math.sin(6.2832 * drRate * tt + drPh);
        const f = f0 * Math.pow(2, cents / 1200), dt = f / sr;
        ph += dt; if (ph >= 1) ph -= 1;
        const saw = 2 * ph - 1 - polyblep(ph, dt);
        noiseState = 0.97 * noiseState + 0.03 * (r() * 2 - 1);
        let env = tt < attack ? 0.5 - 0.5 * Math.cos(Math.PI * tt / attack) : 1;
        if (t > t1) env *= Math.pow(Math.max(0, 1 - (t - t1) / release), 2);
        const d = dynFn(t);
        const g = env * dbToGain(24 * (d - 1)) / Math.sqrt(voices);
        const s = g * (saw + 0.35 * noiseState * 8);
        PL[i] += s * gl; PR[i] += s * gr;
      }
    }
  }
  // formant filter banks per part
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  for (const p of Object.keys(parts)) {
    const [PL, PR] = parts[p];
    for (const [f, gdb, bw] of FORMANTS[p]) {
      const c = biquadCoefs('bandpass', f, sr, { q: f / bw });
      const g = dbToGain(gdb);
      for (const [src, dst] of [[PL, outL], [PR, outR]]) {
        let z1 = 0, z2 = 0;
        for (let i = 0; i < frames; i++) { const x = src[i]; const y = c.b0 * x + z1; z1 = c.b1 * x - c.a1 * y + z2; z2 = c.b2 * x - c.a2 * y; dst[i] += y * g * 2.2; }
      }
    }
  }
  return [outL, outR];
}
