// GPU + CPU frame profiler.
// GPU timings use EXT_disjoint_timer_query_webgl2 (queries can't nest, so it runs in one of two modes):
//   'pass'   — whole render passes (scene incl. MSAA resolve, bloom, composite), begun/ended by PostFX
//   'object' — individual draws of instrumented objects (terrain, water, sky, jets, fx...), via onBeforeRender/onAfterRender
// CPU timings: main loop sections via cpuBegin/cpuEnd (performance.now()).
// Results are per-frame sums per label, aggregated into rolling windows for mean/p50/p95.
const WINDOW = 600;

class Series {
  constructor() { this.buf = new Float32Array(WINDOW); this.n = 0; this.i = 0; this.ema = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % WINDOW; if (this.n < WINDOW) this.n++; this.ema += (v - this.ema) * 0.1; }
  stats() {
    if (!this.n) return { mean: 0, p50: 0, p95: 0, n: 0 };
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    let s = 0; for (const v of a) s += v;
    return { mean: +(s / a.length).toFixed(3), p50: +a[Math.floor(a.length * 0.5)].toFixed(3), p95: +a[Math.min(a.length - 1, Math.floor(a.length * 0.95))].toFixed(3), n: a.length };
  }
  reset() { this.n = 0; this.i = 0; this.ema = 0; }
}

export class Profiler {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = !!this.ext;
    this.mode = 'off';                 // 'off' | 'pass' | 'object'
    this.frame = 0;
    this._pool = []; this._pending = []; this._active = null;
    this._curFrame = -1; this._cur = new Map();
    this.gpu = { pass: new Map(), object: new Map() };
    this.cpu = new Map(); this._cpuT = new Map(); this._cpuFrame = new Map();
    this.frameMs = new Series();
    this.disjoints = 0;
    this.lastTotal = { pass: 0, object: 0 };   // most recent completed frame's GPU total per mode (ms)
  }
  /** After a WebGL context restore: queries from the old context are invalid; re-acquire the extension. */
  restore() {
    this._pool.length = 0; this._pending.length = 0; this._active = null; this._cur.clear(); this._curFrame = -1;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = !!this.ext;
    if (!this.supported) this.mode = 'off';
  }
  setMode(m) {
    if (m === this.mode) return;
    if (this._active) this._endQuery();
    this.mode = this.supported ? m : 'off';
  }
  // ---- GPU queries ----
  _begin(label) {
    if (this._active) return;
    const gl = this.gl; const q = this._pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._active = { q, label, mode: this.mode };
  }
  _endQuery() {
    if (!this._active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._pending.push({ q: this._active.q, label: this._active.label, mode: this._active.mode, frame: this.frame });
    this._active = null;
  }
  beginPass(label) { if (this.mode === 'pass') this._begin(label); }
  endPass() { if (this.mode === 'pass' && this._active) this._endQuery(); }
  /** Wrap every drawable under `root` so its draws are timed under `label` in 'object' mode. */
  instrument(root, label) {
    const self = this;
    root.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || o.userData.__prof) return;
      o.userData.__prof = label;
      const b = o.onBeforeRender, a = o.onAfterRender;
      o.onBeforeRender = function (...args) { b.apply(this, args); if (self.mode === 'object') self._begin(this.userData.__prof); };
      o.onAfterRender = function (...args) { if (self.mode === 'object' && self._active) self._endQuery(); a.apply(this, args); };
    });
  }
  // ---- CPU sections ----
  cpuBegin(label) { this._cpuT.set(label, performance.now()); }
  cpuEnd(label) {
    const t = this._cpuT.get(label); if (t === undefined) return;
    this._cpuFrame.set(label, (this._cpuFrame.get(label) || 0) + performance.now() - t);
  }
  // ---- frame boundaries ----
  frameEnd(frameMs) {
    for (const [label, ms] of this._cpuFrame) { let s = this.cpu.get(label); if (!s) this.cpu.set(label, s = new Series()); s.push(ms); }
    this._cpuFrame.clear();
    if (frameMs > 0) this.frameMs.push(frameMs);
    this.frame++;
    this._poll();
  }
  _poll() {
    if (!this.supported || !this._pending.length) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this._pending.length) {
      const p = this._pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
      this._pending.shift(); this._pool.push(p.q);
      if (disjoint) { this.disjoints++; continue; }
      if (p.frame !== this._curFrame) { this._flush(); this._curFrame = p.frame; this._curMode = p.mode; }
      this._cur.set(p.label, (this._cur.get(p.label) || 0) + ns / 1e6);
    }
  }
  _flush() {
    if (this._curFrame < 0 || !this._cur.size) return;
    const map = this.gpu[this._curMode]; if (!map) { this._cur.clear(); return; }
    let total = 0;
    for (const [label, ms] of this._cur) { let s = map.get(label); if (!s) map.set(label, s = new Series()); s.push(ms); total += ms; }
    // labels seen before but absent this frame count as 0
    for (const [label, s] of map) if (label !== '__total' && !this._cur.has(label)) s.push(0);
    let t = map.get('__total'); if (!t) map.set('__total', t = new Series()); t.push(total);
    this.lastTotal[this._curMode] = total;
    this._cur.clear();
  }
  reset() {
    for (const m of [this.gpu.pass, this.gpu.object, this.cpu]) for (const s of m.values()) s.reset();
    this.frameMs.reset();
  }
  summary() {
    const out = { gpuPass: {}, gpuObject: {}, cpu: {}, frame: this.frameMs.stats(), disjoints: this.disjoints, timerQueries: this.supported };
    for (const [k, s] of this.gpu.pass) out.gpuPass[k] = s.stats();
    for (const [k, s] of this.gpu.object) out.gpuObject[k] = s.stats();
    for (const [k, s] of this.cpu) out.cpu[k] = s.stats();
    return out;
  }
  /** Short live readout for an overlay: label -> ema ms */
  live() {
    const o = { fps: this.frameMs.ema > 0 ? 1000 / this.frameMs.ema : 0, frame: this.frameMs.ema, gpu: {}, cpu: {} };
    const src = this.mode === 'object' ? this.gpu.object : this.gpu.pass;
    for (const [k, s] of src) o.gpu[k] = s.ema;
    for (const [k, s] of this.cpu) o.cpu[k] = s.ema;
    return o;
  }
  dispose() { const gl = this.gl; for (const q of this._pool) gl.deleteQuery(q); for (const p of this._pending) gl.deleteQuery(p.q); this._pool.length = 0; this._pending.length = 0; }
}
