// GPU + CPU frame profiler.
// GPU timings use EXT_disjoint_timer_query_webgl2 (queries can't nest, so it runs in one of two modes):
//   'pass'   — whole render passes (scene incl. MSAA resolve, bloom, composite), begun/ended by PostFX
//   'object' — individual draws of instrumented objects (terrain, water, sky, jets, fx...), via onBeforeRender/onAfterRender
// Every timer query costs the page: each begin/end pair measured ~1 ms of main-thread time (ANGLE flushes around it;
// three pairs a frame = 3 ms of "render" on Iris Xe/ANGLE), so 'pass' mode has a plan (setPassPlan):
//   'all'    — every pass every sampled frame (benchmarks: per-pass numbers, the old behaviour)
//   'rr'     — one pass per frame, round-robin (perf overlay: the per-pass breakdown at a flat ~1 pair a frame)
//   'single' — one query spanning the whole frame on every passEvery-th frame (normal play: dynamic resolution's input;
//              the game uses every 4th frame while the controller gathers samples, every 14th once it has settled)
// gpuSeq counts completed GPU frames, so a consumer can tell a fresh total from a repeated one.
// CPU timings: main loop sections via cpuBegin/cpuEnd (performance.now()), recorded only while `cpuOn` is set (the game
// sets it while the perf overlay is visible or in benchmark mode: nothing else reads them).
// Results are per-frame sums per label, aggregated into rolling windows for mean/p50/p95.
// The per-frame path allocates nothing: labels map to small integer slots (typed arrays hold the times), pending GPU
// queries live in a ring of parallel arrays, and Series objects are created once per label on first sight.
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

/** label -> slot registry with per-slot accumulators (grows rarely, on a new label). */
class Slots {
  constructor(cap = 32) { this.index = new Map(); this.names = []; this.n = 0; this.acc = new Float64Array(cap); this.hit = new Uint8Array(cap); this.start = new Float64Array(cap).fill(NaN); }
  slot(label) {
    let s = this.index.get(label);
    if (s === undefined) {
      s = this.n++; this.index.set(label, s); this.names[s] = label;
      if (s >= this.acc.length) {   // grow (only when a new label appears)
        const cap = this.acc.length * 2, acc = new Float64Array(cap), hit = new Uint8Array(cap), start = new Float64Array(cap).fill(NaN);
        acc.set(this.acc); hit.set(this.hit); start.set(this.start); this.acc = acc; this.hit = hit; this.start = start;
      }
    }
    return s;
  }
}

export class Profiler {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = !!this.ext;
    this.mode = 'off';                 // 'off' | 'pass' | 'object'
    this.cpuOn = true;                 // record CPU sections (the game turns this off while nobody reads them)
    this.frame = 0;
    this._pool = [];                   // idle WebGLQuery objects
    // the query in flight (no per-query object)
    this._actQ = null; this._actLabel = ''; this._actMode = 'off';
    // pending queries: ring of parallel arrays (query, label, mode, frame)
    this._rq = []; this._rl = []; this._rm = []; this._rf = []; this._rh = 0; this._rn = 0; this._rcap = 0;
    this._ringGrow(64);
    this._curFrame = -1; this._curMode = 'pass';
    this._g = new Slots();             // GPU labels of the frame being collected
    this._gSeries = { pass: [], object: [] }; this._gSeen = { pass: [], object: [] }; this._gTotal = { pass: null, object: null };
    this.gpu = { pass: new Map(), object: new Map() };   // label -> Series (live() / summary())
    this._c = new Slots();             // CPU sections
    this._cSeries = [];
    this.cpu = new Map();              // label -> Series (live() / summary())
    this.frameMs = new Series();
    this.disjoints = 0;
    this.lastTotal = { pass: 0, object: 0 };   // most recent completed frame's GPU total per mode (ms)
    this.gpuSeq = 0;                   // completed GPU frames so far (lastTotal changed)
    this.passPlan = 'all'; this.passEvery = 1;   // see setPassPlan
    this._passIdx = 0; this._passN = 1; this._rr = 0; this._singleOpen = false; this._planFrame = 0;
    this._last = new Float64Array(32); // 'rr': latest value per pass slot (the total sums them)
  }
  /** 'all' | 'rr' | 'single' (see the header); every: time only every N-th frame. */
  setPassPlan(plan, every = 1) {
    if (plan === this.passPlan && every === this.passEvery) return;
    if (this._actQ !== null) this._endQuery();
    this._singleOpen = false;
    this.passPlan = plan; this.passEvery = Math.max(1, every | 0);
    const G = this._g; for (let s = 0; s < G.n; s++) { G.acc[s] = 0; G.hit[s] = 0; }
    this._last.fill(0); this._curFrame = -1;
    this._planFrame = this.frame;      // results still in flight from the previous plan are dropped (_poll)
  }
  _ringGrow(cap) {
    const q = new Array(cap).fill(null), l = new Array(cap).fill(''), m = new Array(cap).fill(''), f = new Array(cap).fill(0);
    for (let k = 0; k < this._rn; k++) { const j = (this._rh + k) % this._rcap; q[k] = this._rq[j]; l[k] = this._rl[j]; m[k] = this._rm[j]; f[k] = this._rf[j]; }
    this._rq = q; this._rl = l; this._rm = m; this._rf = f; this._rh = 0; this._rcap = cap;
  }
  /** After a WebGL context restore: queries from the old context are invalid; re-acquire the extension. */
  restore() {
    this._pool.length = 0; this._actQ = null;
    for (let k = 0; k < this._rcap; k++) this._rq[k] = null;
    this._rh = 0; this._rn = 0;
    const G = this._g; for (let s = 0; s < G.n; s++) { G.acc[s] = 0; G.hit[s] = 0; }
    this._curFrame = -1;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = !!this.ext;
    if (!this.supported) this.mode = 'off';
  }
  setMode(m) {
    if (m === this.mode) return;
    if (this._actQ !== null) this._endQuery();
    this._singleOpen = false;
    this.mode = this.supported ? m : 'off';
  }
  // ---- GPU queries ----
  _begin(label) {
    // context lost: no result ever becomes available, so every query begun now would stay pending until restore()
    if (this._actQ !== null || this.gl.isContextLost()) return;
    const gl = this.gl; const q = this._pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._actQ = q; this._actLabel = label; this._actMode = this.mode;
  }
  _endQuery() {
    if (this._actQ === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    if (this._rn === this._rcap) this._ringGrow(this._rcap * 2);
    const j = (this._rh + this._rn) % this._rcap;
    this._rq[j] = this._actQ; this._rl[j] = this._actLabel; this._rm[j] = this._actMode; this._rf[j] = this.frame; this._rn++;
    this._actQ = null;
  }
  beginPass(label) {
    if (this.mode !== 'pass') return;
    const i = this._passIdx++;
    if (this.frame % this.passEvery !== 0) return;
    const plan = this.passPlan;
    if (plan === 'all') this._begin(label);
    else if (plan === 'rr') { if (i === this._rr) this._begin(label); }
    else if (i === 0) { this._begin('frame'); this._singleOpen = this._actQ !== null; }   // 'single': open across passes
  }
  endPass() {
    if (this.mode !== 'pass' || this._actQ === null) return;
    if (this._singleOpen) { if (this._passIdx < this._passN) return; this._singleOpen = false; }   // the frame's last pass
    this._endQuery();
  }
  /** Wrap every drawable under `root` so its draws are timed under `label` in 'object' mode. */
  instrument(root, label) {
    const self = this;
    root.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || o.userData.__prof) return;
      o.userData.__prof = label;
      const b = o.onBeforeRender, a = o.onAfterRender;
      // fixed parameters (three r170 passes renderer, scene, camera, geometry, material, group): no per-draw arrays
      o.onBeforeRender = function (r, s, c, g, m, gr) { b.call(this, r, s, c, g, m, gr); if (self.mode === 'object') self._begin(this.userData.__prof); };
      o.onAfterRender = function (r, s, c, g, m, gr) { if (self.mode === 'object' && self._actQ !== null) self._endQuery(); a.call(this, r, s, c, g, m, gr); };
    });
  }
  // ---- CPU sections ----
  cpuBegin(label) { if (this.cpuOn) { const C = this._c; C.start[C.slot(label)] = performance.now(); } }
  cpuEnd(label) {
    if (!this.cpuOn) return;
    const C = this._c, s = C.slot(label), t = C.start[s];
    if (t !== t) return;               // never begun
    C.acc[s] += performance.now() - t; C.hit[s] = 1;
  }
  // ---- frame boundaries ----
  frameEnd(frameMs) {
    const C = this._c;
    for (let s = 0; s < C.n; s++) {
      if (!C.hit[s]) continue;
      if (this.cpuOn) {
        let S = this._cSeries[s];
        if (S === undefined) { S = this._cSeries[s] = new Series(); this.cpu.set(C.names[s], S); }
        S.push(C.acc[s]);
      }
      C.acc[s] = 0; C.hit[s] = 0;
    }
    if (frameMs > 0) this.frameMs.push(frameMs);
    if (this._singleOpen) { this._singleOpen = false; if (this._actQ !== null) this._endQuery(); }
    if (this._passIdx > 0) {           // passes seen this frame: the round-robin moves on
      this._passN = this._passIdx;
      if (this.passPlan === 'rr' && this.frame % this.passEvery === 0) this._rr = (this._rr + 1) % this._passN;
      this._passIdx = 0;
    }
    this.frame++;
    this._poll();
  }
  _poll() {
    if (!this.supported || this._rn === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this._rn > 0) {
      const h = this._rh, q = this._rq[h];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      const label = this._rl[h], mode = this._rm[h], frame = this._rf[h];
      this._rq[h] = null; this._rh = (h + 1) % this._rcap; this._rn--;
      this._pool.push(q);
      if (disjoint) { this.disjoints++; continue; }
      if (frame < this._planFrame) continue;
      if (frame !== this._curFrame) { this._flush(); this._curFrame = frame; this._curMode = mode; }
      const G = this._g, s = G.slot(label);
      G.acc[s] += ns / 1e6; G.hit[s] = 1;
    }
  }
  _flush() {
    const G = this._g;
    if (this._curFrame < 0) return;
    let any = false; for (let s = 0; s < G.n; s++) if (G.hit[s]) { any = true; break; }
    if (!any) return;
    const mode = this._curMode, map = this.gpu[mode];
    if (map) {
      const ser = this._gSeries[mode], seen = this._gSeen[mode];
      let total = 0;
      const rr = mode === 'pass' && this.passPlan === 'rr';
      if (rr && this._last.length < G.n) { const L = new Float64Array(G.n * 2); L.set(this._last); this._last = L; }
      for (let s = 0; s < G.n; s++) {
        if (!G.hit[s]) continue;
        let S = ser[s];
        if (S === undefined) { S = ser[s] = new Series(); map.set(G.names[s], S); seen.push(s); }
        S.push(G.acc[s]); total += G.acc[s];
        if (rr) this._last[s] = G.acc[s];
      }
      if (rr) { total = 0; for (let k = 0; k < seen.length; k++) total += this._last[seen[k]]; }   // latest of every pass
      // labels seen before but absent this frame count as 0 (not in 'rr', where each frame times one pass only)
      else for (let k = 0; k < seen.length; k++) { const s = seen[k]; if (!G.hit[s]) ser[s].push(0); }
      let T = this._gTotal[mode];
      if (T === null) { T = this._gTotal[mode] = new Series(); map.set('__total', T); }
      T.push(total);
      this.lastTotal[mode] = total;
      this.gpuSeq++;
    }
    for (let s = 0; s < G.n; s++) { G.acc[s] = 0; G.hit[s] = 0; }
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
  dispose() {
    const gl = this.gl;
    for (const q of this._pool) gl.deleteQuery(q);
    for (let k = 0; k < this._rn; k++) { const q = this._rq[(this._rh + k) % this._rcap]; if (q) gl.deleteQuery(q); }
    if (this._actQ) gl.deleteQuery(this._actQ);
    this._pool.length = 0; this._rn = 0; this._actQ = null;
  }
}
