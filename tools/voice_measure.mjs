// tools/voice_measure.mjs — speaking rate and pauses of a voice clip, for picking the best of several TTS takes
// (tools/build_dialogue.mjs). Same measures as the voice auditions (assets/voice_audition/climb2/index.txt):
// syllables per second over the speech span (rate), the same without pauses (artic), and the longest pause (ms).
import { spawnSync } from 'node:child_process';

const decode = (f) => { const p = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); return new Float32Array(p.stdout.buffer, p.stdout.byteOffset, p.stdout.length >> 2); };
/** Rough English syllable count (vowel groups per word, silent final e). */
export function syllables(text) { return (text.toLowerCase().match(/[a-z']+/g) || []).reduce((n, w) => n + Math.max(1, (w.replace(/e$/, '').match(/[aeiouy]+/g) || []).length), 0); }
/** { dur, syl, rate, artic, maxPause (ms) }: 10 ms windows, -40 dBFS speech threshold, pauses >= 50 ms. */
export function measure(file, text) {
  const x = decode(file), n = 160, W = Math.floor(x.length / n), thr = 10 ** (-40 / 20);
  const on = new Uint8Array(W);
  for (let w = 0; w < W; w++) { let e = 0; for (let i = w * n; i < (w + 1) * n; i++) e += x[i] * x[i]; on[w] = Math.sqrt(e / n) > thr ? 1 : 0; }
  let a = 0; while (a < W && !on[a]) a++; let b = W - 1; while (b > a && !on[b]) b--;
  const pauses = []; let run = 0;
  for (let w = a; w <= b; w++) { if (!on[w]) run++; else { if (run >= 5) pauses.push(run * 10); run = 0; } }
  const span = Math.max(0.1, (b - a + 1) / 100), pauseTot = pauses.reduce((p, q) => p + q, 0) / 1000, syl = syllables(text);
  return { dur: x.length / 16000, syl, rate: syl / span, artic: syl / Math.max(0.1, span - pauseTot), maxPause: pauses.length ? Math.max(...pauses) : 0 };
}
/** Take score: faster delivery wins, long pauses cost; takes over 9.5 syl/s articulation are treated as garbled. */
export function takeScore(m) { return (m.artic > 9.5 ? -100 : 0) + m.rate - 4 * Math.max(0, m.maxPause / 1000 - 0.25); }
