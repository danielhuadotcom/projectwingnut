// tools/voice_chain.mjs — the radio-voice processing chain shared by tools/build_awacs.mjs and tools/build_dialogue.mjs.
//   TTS master (MP3 44.1 kHz mono 128 kbps, the service default)
//   -> trim leading/trailing silence (sustained 10 ms RMS > -46 dBFS = speech; keep 50 ms pre-roll / 100 ms tail)
//   -> optional tight gaps (maxGap s: every pause inside the line longer than that is shortened to it)
//   -> pitch-preserving time-stretch (speaking rate x tempo; the TTS API has no rate parameter)
//   -> loudness-normalise to lufs (EBU R128 integrated), -1 dBFS peak limiter, 5 ms / 30 ms fades
//   -> MP3 mono CBR (48 kbps @ 24 kHz is transparent behind the 300-3200 Hz radio chain)
import { spawnSync } from 'node:child_process';

const THRESH_DB = -46, PRE_ROLL = 0.05, TAIL = 0.10, WIN = 0.01; // trim: 10 ms RMS windows, sustained-signal edges

function ffmpeg(argv, what) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...argv], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (p.status !== 0) throw new Error(`ffmpeg ${what} failed: ${(p.stderr || '').slice(-400)}`);
  return p.stderr; // ffmpeg logs (incl. the ebur128 summary) go to stderr
}
export const duration = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());

/** The chain with its settings: { trim(raw, out) -> { I, gain }, duration }. */
export function voiceChain({ kbps = 48, rate = 24000, lufs = -18, tempo = 1.07, maxGap = 0 } = {}) {
  /**
   * Speech span [start, end] in seconds: first/last 10 ms RMS window above THRESH_DB that belongs to sustained signal
   * (3 of 4 consecutive windows above threshold), so isolated clicks / mouth noise in the silence are ignored.
   */
  function speechSpan(raw) {
    const p = spawnSync('ffmpeg', ['-v', 'error', '-i', raw, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
    if (p.status !== 0) throw new Error(`ffmpeg decode of ${raw} failed`);
    const x = new Float32Array(p.stdout.buffer, p.stdout.byteOffset, p.stdout.length >> 2);
    const n = Math.max(1, Math.round(rate * WIN)), W = Math.floor(x.length / n), thr = Math.pow(10, THRESH_DB / 20);
    const on = new Uint8Array(W);
    for (let w = 0; w < W; w++) { let e = 0; for (let i = w * n; i < (w + 1) * n; i++) e += x[i] * x[i]; on[w] = Math.sqrt(e / n) > thr ? 1 : 0; }
    const sustained = (w) => on[w] && (on[w] + (on[w + 1] || 0) + (on[w + 2] || 0) + (on[w + 3] || 0) >= 3 || on[w] + (on[w - 1] || 0) + (on[w - 2] || 0) + (on[w - 3] || 0) >= 3);
    let a = 0; while (a < W && !sustained(a)) a++;
    let b = W - 1; while (b > a && !sustained(b)) b--;
    const dur = x.length / rate;
    if (a >= W) return [0, dur];
    return [Math.max(0, a * WIN - PRE_ROLL), Math.min(dur, (b + 1) * WIN + TAIL)];
  }
  function trim(raw, out) {
    const [t0, t1] = speechSpan(raw);
    const gaps = maxGap > 0 ? `,silenceremove=stop_periods=-1:stop_duration=${maxGap}:stop_threshold=${THRESH_DB + 6}dB:stop_silence=${maxGap}:detection=rms:window=0.01` : '';
    const pre = `atrim=start=${t0.toFixed(3)}:end=${t1.toFixed(3)},asetpts=PTS-STARTPTS${gaps},atempo=${tempo}`;
    const log = ffmpeg(['-i', raw, '-af', `${pre},ebur128=peak=true`, '-f', 'null', '-'], `analysis of ${raw}`);
    const m = [...log.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)].pop();
    const I = m ? Number(m[1]) : NaN;
    const gain = Number.isFinite(I) && I > -60 ? Math.max(-12, Math.min(15, lufs - I)) : 0;
    const af = [pre, `volume=${gain.toFixed(2)}dB`, 'alimiter=limit=0.891:attack=3:release=60:level=0:latency=1',
      'afade=t=in:st=0:d=0.005', 'areverse', 'afade=t=in:st=0:d=0.03', 'areverse'].join(',');
    ffmpeg(['-y', '-i', raw, '-af', af, '-ac', '1', '-ar', String(rate), '-c:a', 'libmp3lame', '-b:a', `${kbps}k`,
      '-map_metadata', '-1', '-id3v2_version', '0', out], `encode of ${raw}`);
    return { I, gain };
  }
  return { trim, duration };
}
