// Graphics presets, automatic tier selection and dynamic resolution.
// The controller targets a GPU frame time (EXT_disjoint_timer_query_webgl2 via the profiler) and falls back to the
// rAF frame interval when timer queries are unavailable.

export const PRESETS = {
  low:    { label: 'LOW',    samples: 0, scaleMin: 0.5, scaleMax: 0.8, dprCap: 1.0,  sub: 'low' },
  medium: { label: 'MEDIUM', samples: 2, scaleMin: 0.6, scaleMax: 0.9, dprCap: 1.25, sub: 'medium' },
  high:   { label: 'HIGH',   samples: 4, scaleMin: 0.7, scaleMax: 1.0, dprCap: 1.5,  sub: 'high' },
  ultra:  { label: 'ULTRA',  samples: 4, scaleMin: 0.9, scaleMax: 1.0, dprCap: 2.0,  sub: 'ultra' },
};
export const TIERS = ['low', 'medium', 'high', 'ultra'];
export const CHOICES = ['auto', ...TIERS];

const STORE_KEY = 'wingnut.quality';
export function loadChoice() { try { const v = localStorage.getItem(STORE_KEY); return CHOICES.includes(v) ? v : 'auto'; } catch { return 'auto'; } }
export function saveChoice(v) { try { localStorage.setItem(STORE_KEY, v); } catch { /* storage blocked */ } }

/** Initial tier for 'auto' from the GPU name: integrated GPUs start one tier lower. */
export function guessTier(rendererName = '') {
  const n = rendererName.toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(n)) return 'low';
  if (/intel|iris|uhd|hd graphics|mali|adreno|powervr|apple gpu/.test(n)) return 'medium';
  if (/apple m\d|rtx|radeon rx|geforce gtx 1[06-9]|geforce rtx|arc a/.test(n)) return 'high';
  return 'high';
}

export class DynamicResolution {
  constructor({ targetMs = 12.5 } = {}) {
    this.targetMs = targetMs;
    this.samples = new Float32Array(48); this.n = 0; this.i = 0; this._sort = new Float32Array(48);
    this.reset();
  }
  reset() { this.n = 0; this.i = 0; this.warm = 2.0; this.cool = 0; this.atMinT = 0; this.atMaxT = 0; this.cost = 0; this.useGpu = false; }
  _median() {
    const m = this.n; const a = this._sort;
    for (let j = 0; j < m; j++) a[j] = this.samples[j];
    const v = a.subarray(0, m); v.sort();
    return v[m >> 1];
  }
  /**
   * @returns {{scale:number, tier:-1|0|1}} new scale (quantized to 0.05) and a tier change request for auto mode
   */
  update(dt, scale, preset, gpuMs, frameMs) {
    const result = { scale, tier: 0 };
    // Ignore a warm-up window after start or any quality change (shader compiles and uploads spike the first frames)
    if (this.warm > 0) { this.warm -= dt; return result; }
    const useGpu = gpuMs > 0;
    if (useGpu !== this.useGpu) { this.n = 0; this.i = 0; this.useGpu = useGpu; }
    this.samples[this.i] = useGpu ? gpuMs : frameMs; this.i = (this.i + 1) % this.samples.length; if (this.n < this.samples.length) this.n++;
    if (this.n < 12) return result;
    const cost = this.cost = this._median();
    const target = useGpu ? this.targetMs : 17.5;        // without timer queries, vsynced 16.7 ms frames count as fine
    this.cool -= dt;
    if (scale <= preset.scaleMin + 1e-3 && cost > target * 1.1) this.atMinT += dt; else this.atMinT = 0;
    if (scale >= preset.scaleMax - 1e-3 && cost < target * 0.6) this.atMaxT += dt; else this.atMaxT = 0;
    if (this.atMinT > 3) { result.tier = -1; return result; }
    if (this.atMaxT > 6 && useGpu) { result.tier = 1; return result; }
    if (this.cool > 0) return result;
    let s = scale;
    if (cost > target * 1.05) { s = scale * Math.min(0.95, Math.max(0.8, Math.sqrt(target / cost))); this.cool = 0.75; }
    else if (cost < target * (useGpu ? 0.72 : 0.9)) { s = scale + (cost < target * 0.5 ? 0.1 : 0.05); this.cool = 1.5; }
    s = Math.round(Math.min(preset.scaleMax, Math.max(preset.scaleMin, s)) * 20) / 20;
    if (s !== scale) { this.n = 0; this.i = 0; }      // fresh samples at the new scale
    result.scale = s;
    return result;
  }
}
