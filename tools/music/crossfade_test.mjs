// QA render: a 10 s cut from "Ceiling Unlimited" into "Mainspring", to hear whether the boss leitmotif can interrupt the
// main theme in game. The theme is joined mid-climax (bar 40 of score.mjs) and fades out over 0.6 s ending on its bar-42
// downbeat; Mainspring's appearance (bar 1: low brass cluster, gong, bell, then the glockenspiel motif) lands on that
// downbeat. Both masters are already at the same integrated loudness (render.mjs / render_mainspring.mjs).
// usage: node tools/music/crossfade_test.mjs   (needs out/wingnut_theme.wav and out/mainspring.wav)
// Output: assets/music_audition/crossfade_test.mp3 (+ out/crossfade_test.wav)
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './lib/wav.mjs';
import { segmentLoudness } from './lib/dsp.mjs';
import { encodeMp3, ffLoudness } from './lib/master.mjs';
import { T as themeT } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out'), AUD = join(HERE, '..', '..', 'assets', 'music_audition');
const theme = readWav(join(OUT, 'wingnut_theme.wav')), boss = readWav(join(OUT, 'mainspring.wav'));
const SR = theme.sampleRate;
if (boss.sampleRate !== SR) throw new Error('sample-rate mismatch');
const LEN = 10, CUT = themeT(42) - themeT(40), FADE = 0.6, FROM = themeT(40); // cut 3.75 s into the clip
const n = Math.round(LEN * SR), cutI = Math.round(CUT * SR), fadeI = Math.round(FADE * SR), from = Math.round(FROM * SR);
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) {
  // theme: equal-power fade over the FADE seconds that end on the cut
  const x = (i - (cutI - fadeI)) / fadeI, gt = x <= 0 ? 1 : x >= 1 ? 0 : Math.cos(x * Math.PI / 2);
  if (gt > 0) { L[i] += theme.channels[0][from + i] * gt; R[i] += theme.channels[1][from + i] * gt; }
  const j = i - cutI;
  if (j >= 0 && j < boss.frames) { L[i] += boss.channels[0][j]; R[i] += boss.channels[1][j]; }
}
for (let i = 0; i < 480; i++) { const g = i / 480; L[i] *= g; R[i] *= g; }
const tailI = Math.round(0.8 * SR); for (let i = 0; i < tailI; i++) { const g = Math.pow(i / tailI, 1.5); L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
const [before, after] = segmentLoudness([L, R], SR, [[CUT - 3, CUT - FADE], [CUT, CUT + 3]]);
console.log(`theme from ${FROM.toFixed(3)} s, cut at ${CUT.toFixed(3)} s (theme bar 42 downbeat), ${FADE} s equal-power fade; peak ${(20 * Math.log10(pk)).toFixed(2)} dBFS`);
console.log(`loudness (ungated K-weighted): last 3 s of theme before the fade ${before.toFixed(1)}, first 3 s of Mainspring ${after.toFixed(1)}`);
const wav = join(OUT, 'crossfade_test.wav'), mp3 = join(AUD, 'crossfade_test.mp3');
writeWav(wav, [L, R], SR, { float: true });
encodeMp3(wav, mp3, 'Ceiling Unlimited -> Mainspring (crossfade test)', 192);
console.log(`wrote ${mp3}`, ffLoudness(mp3));
