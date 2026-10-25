// Graphics presets, automatic tier selection, dynamic resolution and the automatic tier step-down.
// The resolution controller targets a GPU frame time (EXT_disjoint_timer_query_webgl2 via the profiler) and falls back
// to the rAF frame interval when timer queries are unavailable (Chrome for Android never exposes them).

// sub: the preset name the subsystems (PostFX, World, AfterburnerFX) receive. 'verylow' is the cheapest playable
// version for budget tablets: render scale 0.45-0.6 at pixel ratio 1, no MSAA, tone map only (no bloom / flare / film
// effects / sharpening / FXAA; the canvas itself is 0.6x, so even the composite skips the full-resolution pass), the cheapest sea (one wave layer, no reflected terrain or foam), no cloud puffs or
// terrain shadow bakes, flat-lit terrain with one detail layer, smaller particles and no wing vapor. Gameplay is identical.
// LOW's drawing buffer is 0.8x too (canvasScale): its scene never renders above 0.8x anyway, so the composite pass runs
// at that size and the browser stretches the result. hudScale caps the HUD canvas's backing store (x CSS px, still
// capped by devicePixelRatio); hudCache turns on the HUD's cached layers (pitch ladder / radar scope blits).
// MEDIUM on a mobile GPU drops MSAA for the composite's FXAA (presetSamples).
export const PRESETS = {
  verylow: { label: 'VERY LOW', samples: 0, scaleMin: 0.45, scaleMax: 0.6, dprCap: 1.0, canvasScale: 0.6, hudScale: 1.0, hudCache: true, sub: 'verylow' },
  low:     { label: 'LOW',      samples: 0, scaleMin: 0.5,  scaleMax: 0.8, dprCap: 1.0, canvasScale: 0.8, hudScale: 1.25, hudCache: true, sub: 'low' },
  medium:  { label: 'MEDIUM',   samples: 2, scaleMin: 0.6,  scaleMax: 0.9, dprCap: 1.25, hudScale: 1.5, sub: 'medium' },
  high:    { label: 'HIGH',     samples: 4, scaleMin: 0.7,  scaleMax: 1.0, dprCap: 1.5,  hudScale: 2, sub: 'high' },
  ultra:   { label: 'ULTRA',    samples: 4, scaleMin: 0.9,  scaleMax: 1.0, dprCap: 2.0,  hudScale: 2, sub: 'ultra' },
};
export const TIERS = ['verylow', 'low', 'medium', 'high', 'ultra'];
export const CHOICES = ['auto', ...TIERS];

const STORE_KEY = 'wingnut.quality';
export function loadChoice() { try { const v = localStorage.getItem(STORE_KEY); return CHOICES.includes(v) ? v : 'auto'; } catch { return 'auto'; } }
export function saveChoice(v) { try { localStorage.setItem(STORE_KEY, v); } catch { /* storage blocked */ } }

/**
 * Initial tier for 'auto' from the WebGL renderer string (WEBGL_debug_renderer_info). Chrome for Android reports the
 * GL_RENDERER string ("Mali-G57 MC2", "Mali-G52", "PowerVR Rogue GE8320", "Adreno (TM) 610"), or with ANGLE
 * "ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)" / "ANGLE (Qualcomm, Adreno (TM) 610, Vulkan 1.1.128 ...)". Firefox
 * sanitizes it into buckets ("Mali-G51, or similar", "Mali-T, or similar", "Adreno (TM) 610, or similar",
 * "PowerVR SGX 540, or similar"), which read the same way: Firefox's "Mali-G51" bucket gathers the budget Bifrost parts.
 *   verylow  software renderers; Mali-T / Mali-4xx, Mali-G31, G51, G52 MC1, G57 MC1 (the MP1 parts report no core count);
 *            PowerVR GE8xxx / SGX; Adreno 3xx, 405 and older 4xx, 504/505; Vivante
 *   low      Mali-G52 / G57 MC2+, other PowerVR (GM9xxx, GX6xxx, BXE...); Adreno 4xx, 5xx, 6xx up to 616
 *   medium   better mobile GPUs (Mali-G68 / G7x / G6xx / G7xx / Immortalis, Adreno 618+ and 7xx/8xx), Apple GPU, Intel
 *            and other integrated GPUs
 *   high     everything else (discrete GPUs, Apple M-series)
 */
export function guessTier(rendererName = '') {
  const n = String(rendererName || '').toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic render/.test(n)) return 'verylow';
  let m;
  if ((m = /mali[- ]?([gt]?)(\d*)/.exec(n))) {
    const fam = m[1], num = m[2] ? Number(m[2]) : 0;
    if (fam === 'g' && !num) return 'low';                               // a bare "Mali-G" bucket
    const mc = /\b(?:mc|mp)\s?(\d+)/.exec(n); const cores = mc ? Number(mc[1]) : 1;
    if (fam === 't' || fam === '') return 'verylow';                      // Midgard Mali-T / Utgard Mali-4xx
    if (num === 31 || num === 51) return 'verylow';
    if (num === 52 || num === 57) return cores <= 1 ? 'verylow' : 'low';
    return 'medium';                                                     // G68, G71-G78, G310+, G610-G720, Immortalis
  }
  if (/powervr|imagination|\bimg\b/.test(n)) {
    if (/\bge\s?\d{4}|sgx/.test(n)) return 'verylow';         // Rogue GE8100-GE8322, SGX
    return 'low';
  }
  if ((m = /adreno[^0-9]*(\d{3})/.exec(n))) {
    const num = Number(m[1]);
    if (num < 400 || num === 404 || num === 405 || num === 504 || num === 505) return 'verylow';
    if (num <= 616) return 'low';
    return 'medium';
  }
  if (/vivante|\bgc\d{3,4}/.test(n)) return 'verylow';
  if (/apple m\d/.test(n)) return 'high';
  if (/intel|iris|uhd|hd graphics|mali|immortalis|adreno|powervr|apple gpu/.test(n)) return 'medium';
  if (/rtx|radeon rx|geforce gtx 1[06-9]|geforce rtx|arc a/.test(n)) return 'high';
  return 'high';
}

/** A tile-based mobile GPU (Mali / Immortalis, Adreno, PowerVR, Apple on an iPhone / iPad). Safari reports every Apple
 *  GPU as "Apple GPU", Macs included, so that one counts only with a touch screen (iPadOS reports a Mac user agent). */
export function isMobileGpu(rendererName = '', touchPoints = 0) {
  const n = String(rendererName || '').toLowerCase();
  if (/mali|immortalis|adreno|powervr|imagination|\bimg\b/.test(n)) return true;
  return /apple gpu/.test(n) && touchPoints > 1;
}

/** MSAA samples for a tier on this GPU: MEDIUM on a mobile GPU uses none (the composite's FXAA instead: a multisampled
 *  HDR target plus its resolve costs mobile GPUs far more bandwidth than the FXAA taps). */
export function presetSamples(tier, rendererName = '', touchPoints = 0) {
  const p = PRESETS[tier] || PRESETS.high;
  return tier === 'medium' && isMobileGpu(rendererName, touchPoints) ? 0 : p.samples;
}

export class DynamicResolution {
  constructor({ targetMs = 12.5 } = {}) {
    this.targetMs = targetMs;
    this.samples = new Float32Array(48); this.n = 0; this.i = 0; this._sort = new Float32Array(48);
    this.window = 48;   // median over the newest `window` samples (the game shortens it when GPU samples arrive sparsely)
    this.reset();
  }
  reset() { this.n = 0; this.i = 0; this.warm = 2.0; this.cool = 0; this.cost = 0; this.useGpu = false; }
  _median() {
    const L = this.samples.length, m = Math.min(this.n, Math.max(1, this.window | 0)); const a = this._sort;
    for (let j = 0; j < m; j++) a[j] = this.samples[(this.i - 1 - j + L) % L];
    const v = a.subarray(0, m); v.sort();
    return v[m >> 1];
  }
  /**
   * @returns {{scale:number}} new scale (quantized to 0.05). Tier changes are StepDown's job (never upward mid-session).
   */
  update(dt, scale, preset, gpuMs, frameMs, fresh = true) {
    const result = { scale };
    // Ignore a warm-up window after start or any quality change (shader compiles and uploads spike the first frames)
    if (this.warm > 0) { this.warm -= dt; return result; }
    const useGpu = gpuMs > 0;
    if (useGpu !== this.useGpu) { this.n = 0; this.i = 0; this.useGpu = useGpu; }
    // GPU totals arrive only every few frames (the profiler samples): count each one once, not once per frame
    if (!useGpu || fresh) { this.samples[this.i] = useGpu ? gpuMs : frameMs; this.i = (this.i + 1) % this.samples.length; if (this.n < this.samples.length) this.n++; }
    if (this.n < 12) return result;
    const cost = this.cost = this._median();
    const target = useGpu ? this.targetMs : 17.5;        // without timer queries, vsynced 16.7 ms frames count as fine
    this.cool -= dt;
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

/**
 * Automatic step-down (Graphics: Auto only). Fires when the frame interval's p75 over the last ~1 s stays above
 * `limitMs` (28 ms: under ~36 fps) for `holdS` seconds while dynamic resolution already sits at the preset's minimum.
 * Load and bake hitches are ignored: nothing is sampled until `graceS` seconds after reset() (called on every mission or
 * round load and after every tier change), single long frames (> 250 ms) are dropped, and the p75 needs a full window.
 * Never steps up; the caller stops at the lowest tier.
 */
export class StepDown {
  constructor({ limitMs = 28, holdS = 4, graceS = 6, window = 48 } = {}) {
    this.limitMs = limitMs; this.holdS = holdS; this.graceS = graceS;
    this.buf = new Float32Array(window); this._sort = new Float32Array(window);
    this.reset();
  }
  reset(graceS = this.graceS) { this.grace = graceS; this.n = 0; this.i = 0; this.overT = 0; this.p75 = 0; }
  /** @param dt s (clamped game step) @param frameMs raw frame interval @param atMin dynamic resolution at its floor
   *  @returns true when one tier should be dropped now (the caller resets this) */
  update(dt, frameMs, atMin) {
    if (this.grace > 0) { this.grace -= dt; return false; }
    if (!(frameMs > 0) || frameMs > 250) return false;
    const B = this.buf; B[this.i] = frameMs; this.i = (this.i + 1) % B.length; if (this.n < B.length) this.n++;
    if (this.n < B.length) return false;
    const a = this._sort; a.set(B); a.sort();
    const p75 = this.p75 = a[Math.floor(a.length * 0.75)];
    if (p75 > this.limitMs && atMin) this.overT += frameMs / 1000; else this.overT = 0;
    return this.overT >= this.holdS;
  }
}
