// js/hud.js — PROJECT WINGNUT · fighter-style 2D canvas HUD overlay.
// Pure Canvas2D: deliberately NO Three.js import (the HUD only receives screen-space data — see SPEC.md "js/hud.js").
//
// Visual language: phosphor green primary, amber cautions, red warnings/hostiles, white for the lock cue.
// Every line/glyph is drawn in two passes (thick dark under, thin bright over) and text is stroked dark then filled,
// which keeps the HUD legible over bright sky/snow without shadowBlur (far too expensive per frame). Target and
// squadmate markers are the exception: one thin line, no dark halo, sized to clear the model so nothing covers it.
// Geometry scales from s = clamp(min(w,h)/900, 0.6, 2.2); text uses ts = max(0.78, s) so phones stay readable.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const FONT = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

const COL = {
  green: '#9CEBFF',            // PW-style cyan (kept under the old key names)
  greenSoft: 'rgba(156,235,255,0.62)',
  greenFaint: 'rgba(156,235,255,0.25)',
  pale: '#EAFBFF',             // bright readouts, cardinal letters, big messages
  amber: '#FFB547',
  orange: '#FF7A1F',
  red: '#FF4D4D',
  white: '#FFFFFF',
  dark: 'rgba(0,0,0,0.6)',     // outline pass
  panel: 'rgba(0,10,18,0.42)',  // translucent box fills
  seg: 'rgba(0,0,0,0.45)',     // empty gauge segments
  ally: '#7CFF6A',             // friendlies: squadmates on screen and on the radar, allied ground/naval on the radar
  allySoft: 'rgba(124,255,106,0.72)',
  wso: '#C3A6FF',              // radio speaker labels: the WSO (violet), Mainspring (crimson); AWACS keeps amber
  mainspring: '#FF5C6C',
};
/** Radio subtitle speaker label -> colour (frame.radio.speaker). */
const RADIO_COL = { 'AWACS CLAUDE': COL.amber, 'WSO SPANNER': COL.wso, MAINSPRING: COL.mainspring };

const NO_DASH = [];
const EMPTY = [];
const DEF_PLAYER = { speed: 0, altitude: 0, radarAlt: 0, heading: 0, pitch: 0, roll: 0, gLoad: 1, throttle: 0,
  afterburner: false, health: 100, ammo: 0, missiles: 0, maxMissiles: 0, stall: false };
const DEF_RADAR = { range: 8000, blips: EMPTY };
const DEF_WARN = {};
const DEF_INPUT = { gamepadConnected: false, gamepadName: null, gamepadBlocked: false, usingGamepad: false };
const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
const ALLY_MAX = 8;                        // squadmate markers drawn per frame
const ALLY_NEAR = 1500, ALLY_FAR = 8000;   // m: squadmate markers shrink and fade between these distances
const ARC_A = 0.95, ARC_C = Math.cos(ARC_A), ARC_S = Math.sin(ARC_A);   // half-angle of the "( )" bracket arcs
const TOUCH_KEYS = ['lt', 'lb', 'rb', 'rt', 'flr', 'pause'];           // touch buttons (frame.touchRects) labels avoid
// Hostile markers frame the drawn model: half-size = max(the fixed size, r * MK_GROW + MK_PAD * s) for a projected model
// radius of r px (frame contact / target .r), capped at MK_MAX * min(w, h)
const MK_GROW = 1.1, MK_PAD = 3, MK_MAX = 0.4;
// Hostiles farther than MK_FAR_M (m), other than the selected target, get no brackets: only a small dim caret just above
// the model (MK_FAR_A alpha), pointing down at it, never over it, no label
const MK_FAR_M = 4500, MK_FAR_A = 0.55;
const MAX_CONTACTS = 128;                  // safety bound on frame.contacts and radar blips (js/main.js fills at most 96)
// Incoming-missile edge glow (_drawThreats): one soft red arc per enemy missile guiding on us, on a rounded rect
// hugging the screen edge (THR_CORNER * min(w, h) corner radius) at the missile's direction in the camera frame.
// Nearer impact (time to impact THR_FAR..THR_NEAR s) = brighter (THR_A0..THR_A1 alpha), narrower (THR_SPAN0..1 deg
// of edge seen from the centre; the gradient ellipse is 1.5x that, as its tails fade) and deeper (THR_D0..1 * min(w, h));
// under THR_PULSE s it pulses. Arcs add ('lighter'); the summed alpha of arcs that overlap is capped at THR_CAP.
// Drawn first, under every HUD element, so tapes, reticle and text always sit on top. Budget mode blits a sprite.
const THR_MAX = 8, THR_FAR = 8, THR_NEAR = 1, THR_A0 = 0.25, THR_A1 = 0.55, THR_SPAN0 = 40, THR_SPAN1 = 25;
const THR_D0 = 0.06, THR_D1 = 0.10, THR_PULSE = 1.5, THR_CAP = 0.75, THR_CORNER = 0.16;
const CARDINAL = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
const WARN_DEFS = [
  { key: 'missileIncoming', text: 'MISSILE', color: COL.red },
  { key: 'pullUp', text: 'PULL UP', color: COL.red },
  { key: 'stall', text: 'STALL', color: COL.amber },
  { key: 'overG', text: 'OVER-G', color: COL.amber },
];

// ---- allocation-free number formatting (lazy string tables) -------------------------------------------------
const INT_STR = [];
function fInt(v) {
  v = Math.round(v) || 0;
  if (v >= 0 && v < 200000) return INT_STR[v] || (INT_STR[v] = String(v));
  return String(v);
}
const PAD3 = [];
function fPad3(v) {           // heading 0..359 as "007"
  v = ((Math.round(v) % 360) + 360) % 360;
  return PAD3[v] || (PAD3[v] = (v < 10 ? '00' : v < 100 ? '0' : '') + v);
}
const DEC1 = [];
function fDec1(v) {           // one decimal, e.g. 4.2
  const neg = v < 0;
  const k = Math.round(Math.abs(v) * 10) || 0;
  let str;
  if (k < 100000) str = DEC1[k] || (DEC1[k] = ((k / 10) | 0) + '.' + (k % 10));
  else str = (k / 10).toFixed(1);
  return neg ? '-' + str : str;
}
const WAVE_STR = [], ROUND_STR = [], ENEMY_STR = [], KILL_STR = [], PCT_STR = [];
function fPrefixed(table, prefix, n) {
  n = Math.max(0, Math.round(n) || 0);
  if (n < 10000) return table[n] || (table[n] = prefix + n);
  return prefix + n;
}
/** The incoming-missile glow, edge (0) to inner rim (1): a deep crimson core reads on bright skies (day, the red
 *  Glassfall), the brighter red ring inside it on dark ones (night). */
function threatStops(g) {
  g.addColorStop(0, 'rgba(60,0,8,1)'); g.addColorStop(0.35, 'rgba(175,0,20,0.9)');
  g.addColorStop(0.68, 'rgba(255,36,42,0.45)'); g.addColorStop(1, 'rgba(255,34,40,0)');
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function norm360(d) { d = (d || 0) % 360; return d < 0 ? d + 360 : d; }
/** True if the point (px, py), grown by r, overlaps the rect x0..x1, y0..y1. */
function near(x0, y0, x1, y1, px, py, r) { return px + r > x0 && px - r < x1 && py + r > y0 && py - r < y1; }

export class HUD {
  constructor(container) {
    this.container = container || document.body;
    const canvas = document.createElement('canvas');
    canvas.className = 'wingnut-hud';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block;';
    this.canvas = canvas;
    this.container.appendChild(canvas);
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.w = 0; this.h = 0; this.dpr = 1; this.s = 1;
    // Budget devices (js/main.js sets these on the LOW / VERY LOW tiers, or when the HUD section runs slow):
    //   res        backing-store scale (1 = device pixels; 0.6-0.75 lets CSS upscale a smaller canvas: fewer pixels to
    //              clear, stroke and composite, which is what a software Canvas2D (Firefox for Android) pays for)
    //   spriteText every label is a cached pre-rendered sprite (outline + fill drawn once per string/font/colour/align),
    //              so a steady frame blits images instead of rasterising glyph outlines (strokeText is never cached)
    //   prof       null, or an object that receives per-group times in ms (EMA) for the perf overlay
    //   maxScale   cap on the device-pixel ratio used for the backing store (per graphics tier: 1 on VERY LOW ... 2)
    this.res = 1; this.k = 1; this.spriteText = false; this.cacheLayers = false; this.prof = null; this.maxScale = 2;
    this._sprites = new Map(); this._fontPx = new Map();
    this.alpha = 1;            // base alpha (0.35 when dimmed for paused/dead/victory)
    this.time = 0;
    this.L = {};               // layout cache (positions, fonts, dashes), rebuilt on resize only
    // small string caches so steady-state frames allocate (almost) nothing
    this._gKey = NaN; this._gStr = '';
    this._raKey = NaN; this._raStr = '';
    this._distKey = NaN; this._distStr = '';
    this._clKey = NaN; this._clStr = '';
    this._mslKey = NaN; this._mslStr = '';
    this._gunKey = NaN; this._gunStr = '';
    this._rngKey = NaN; this._rngStr = '';
    this._allyRects = new Float32Array(4 * ALLY_MAX);   // squadmate label boxes placed this frame (x0, y0, x1, y1)
    // selected target, laid out before anything draws (_prepTarget): box half-size, info block position and whether it
    // sits over the box (since _tClearT, the last time the spot under it covered the gun cross), squadmate keep-out
    this._tHalf = 0; this._tX = 0; this._tY = 0; this._tAbove = false; this._tClearT = -1;
    this._kx0 = 0; this._kx1 = -1; this._ky0 = 0; this._ky1 = -1;
    this._inBlocked = null; this._inConn = null; this._inName = null; this._inUsing = null; this._inLocked = null; this._inMaxW = -1;
    this._inLines = []; this._inColor = COL.green; this._inGlyph = false;
    this._thrA = new Float32Array(THR_MAX); this._thrSpan = new Float32Array(THR_MAX);   // per-arc alpha, half-span (rad)
    this._ep = { x: 0, y: 0, nx: 0, ny: 0, t: 0 };                                          // _edgePoint result
    this._thrSprite = null;                                                                // budget mode: the glow as an image
    this._ro = null;
    try {
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.container);
      }
    } catch (e) { this._ro = null; }
    this.resize();
  }

  /** Read the container size and (re)allocate the backing store (DPR capped at maxScale, at most 2). */
  resize() {
    const el = this.container;
    let w = el.clientWidth, h = el.clientHeight;
    if (!(w > 0) || !(h > 0)) { w = window.innerWidth; h = window.innerHeight; }
    this._setSize(w, h);
  }

  _setSize(w, h, force = false) {
    const dpr = Math.min(this.maxScale, window.devicePixelRatio || 1);
    if (!force && w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr; this.k = dpr * this.res;
    if (!(w > 0 && h > 0)) return;
    this.canvas.width = Math.max(1, Math.round(w * this.k));
    this.canvas.height = Math.max(1, Math.round(h * this.k));
    this._sprites.clear(); this._radarBg = null; this._ladderStrip = null;
    this._layout();
  }
  /** Backing-store scale (0.5..1), sprite text, cached layers and the DPR cap (1..2; see the constructor). Cheap when
   *  nothing changes. */
  setBudget(res = 1, spriteText = false, cacheLayers = false, maxScale = 2) {
    res = clamp(Number(res) || 1, 0.5, 1);
    maxScale = clamp(Number(maxScale) || 2, 1, 2);
    const cache = !!cacheLayers;
    if (cache !== this.cacheLayers) { this._radarBg = null; this._ladderStrip = null; }   // rebuilt on demand
    this.spriteText = !!spriteText; this.cacheLayers = cache;
    if (res !== this.res || maxScale !== this.maxScale) { this.res = res; this.maxScale = maxScale; this._setSize(this.w, this.h, true); }
  }

  dispose() {
    try { if (this._ro) this._ro.disconnect(); } catch (e) { /* ignore */ }
    this._ro = null;
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.ctx = null;
  }

  // ---- layout -------------------------------------------------------------------------------------------------
  _layout() {
    const w = this.w, h = this.h, m = Math.min(w, h);
    const s = clamp(m / 900, 0.6, 2.2);
    const ts = Math.max(0.78, s);
    const L = this.L;
    this.s = s;
    L.w = w; L.h = h; L.m = m; L.s = s; L.ts = ts; L.cx = w / 2; L.cy = h / 2;
    L.compact = w < 600 || h < 480;
    L.lw = clamp(1.75 * s, 1.5, 3.4);
    L.lwThin = Math.max(1, L.lw * 0.65);
    L.outline = s < 1.3 ? 1 : 1.3;              // dark halo width (px per side) under lines
    L.textOutline = clamp(2 * ts, 2, 3.6);      // strokeText width under glyphs
    const F = (px, wt) => (wt ? wt + ' ' : '') + Math.max(9, Math.round(px)) + 'px ' + FONT;
    L.fTiny = F(9.5 * ts); L.fSmall = F(11 * ts); L.fMed = F(13 * ts);
    L.fBig = F(20 * ts, 500); L.fHdg = F(15 * ts, 600); L.fLock = F(14 * ts, 700); L.fPill = F(11 * ts, 700);
    L.fWarn = F(26 * ts, 700); L.fMsg = F(15 * ts, 500); L.fMsgBig = F(23 * ts, 700);
    // central attitude region
    L.clipR = 0.30 * m; L.rungHalf = 0.14 * m; L.rungGap = 0.045 * m; L.horizonHalf = 0.26 * m;
    L.ppd = 12 * s; L.tick = 6 * s; L.bankR = L.clipR + 12 * s;
    // side tapes
    L.spdBoxW = Math.round(66 * ts); L.altBoxW = Math.round(78 * ts); L.boxH = Math.round(24 * ts);
    L.sideOff = Math.min(0.42 * m, w / 2 - (Math.max(L.spdBoxW, L.altBoxW) + 16 * s));
    L.tapeHalf = 0.13 * m;
    // heading tape (top)
    L.hdgHalf = Math.min(0.26 * w, 0.31 * m);
    L.hdgBoxTop = Math.round(6 * s); L.hdgBoxH = Math.round(20 * ts); L.hdgBoxW = Math.round(52 * ts);
    L.hdgBase = L.hdgBoxTop + L.hdgBoxH + Math.round(16 * s) + 2;
    L.hdgBottom = L.hdgBase + Math.round(6 * s) + Math.round(12 * ts);
    L.pillY = L.hdgBottom + Math.round(6 * s); L.pillH = Math.round(18 * ts);
    L.msgY = L.pillY + L.pillH + Math.round(12 * s);
    // boss bar (top center, under the heading tape); pills and messages shift down by bossH while it shows
    L.bossNameH = Math.round(13 * ts); L.bossBarH = Math.round(7 * s); L.bossW = Math.round(Math.min(2 * L.hdgHalf, 460 * s, L.compact ? w - 2 * 120 : w));   // compact: clear the touch shoulder buttons
    L.bossH = L.bossNameH + Math.round(3 * s) + L.bossBarH + Math.round(8 * s);
    // bottom-left stack
    L.healthY = Math.round(h - 24 * s - 22 * ts); L.healthH = Math.round(10 * s);
    L.healthW = Math.round(Math.min(170 * s, w * 0.34));
    L.thrBot = Math.round(L.healthY - 10 * s - 10 * ts); L.thrH = Math.round(100 * s);
    // bottom-right radar
    L.radarR = Math.max(30 * s, (L.compact ? 0.085 : 0.11) * m);
    L.radarX = Math.round(w - L.radarR - 16 * s); L.radarY = Math.round(h - L.radarR - 22 * s);
    L.radarLeft = L.radarX - L.radarR;
    // dashes
    L.dashLadder = [8 * s, 6 * s]; L.dashBox = [5 * s, 4 * s]; L.dashRing = [3 * s, 5 * s]; L.dashVV = [4 * s, 4 * s];
    L.warnY = Math.round(L.cy + L.clipR + 16 * s);
    // measured widths (fonts only change here)
    const ctx = this.ctx;
    ctx.font = L.fWarn;
    L.warnW = L.warnW || [];
    for (let i = 0; i < WARN_DEFS.length; i++) L.warnW[i] = Math.round(ctx.measureText(WARN_DEFS[i].text).width + 36 * s);
    ctx.font = L.fPill;
    L.pillW1 = Math.round(ctx.measureText('PADLOCK').width + 22 * s);
    L.pillW2 = Math.round(ctx.measureText('REAR VIEW').width + 22 * s);
    ctx.font = L.fSmall;
    L.chSmall = ctx.measureText('0000000000').width / 10;   // monospace advance: squadmate and target labels are laid out by length
    try {
      const g = ctx.createRadialGradient(L.cx, L.cy, m * 0.55, L.cx, L.cy, Math.max(w, h) * 0.78);
      g.addColorStop(0, 'rgba(255,30,20,0)'); g.addColorStop(0.55, 'rgba(255,30,20,0.35)'); g.addColorStop(1, 'rgba(255,30,20,0.85)');
      L.dmgGrad = g;
    } catch (e) { L.dmgGrad = null; }
    // incoming-missile glow: a unit radial gradient, stretched per arc by the transform (_drawThreats)
    try {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      threatStops(g);
      L.thrGrad = g;
    } catch (e) { L.thrGrad = null; }
    L.thrCorner = THR_CORNER * m;
    this._inMaxW = -1;   // invalidate the wrapped input-status cache
  }

  // ---- primitives ---------------------------------------------------------------------------------------------
  /** Two-pass stroke of the current path: dark halo under, bright line over. */
  _stroke(color, lw) {
    const ctx = this.ctx;
    ctx.lineWidth = lw + 2 * this.L.outline; ctx.strokeStyle = COL.dark; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  }
  /** One-pass stroke, no dark halo: target and squadmate markers, kept thin so the model they frame stays clear. */
  _line(color, lw) {
    const ctx = this.ctx;
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  }
  /** Fill the current path with a dark halo (filled glyphs: carets, pips, triangles). */
  _fillOutlined(color) {
    const ctx = this.ctx;
    ctx.lineWidth = 2 * this.L.outline + 0.5; ctx.strokeStyle = COL.dark; ctx.stroke();
    ctx.fillStyle = color; ctx.fill();
  }
  _text(str, x, y, color, align, baseline, maxW) {
    const ctx = this.ctx;
    if (this.spriteText && !(maxW > 0)) { this._spriteText(str, x, y, color, align || 'left', baseline || 'middle'); return; }
    ctx.textAlign = align || 'left'; ctx.textBaseline = baseline || 'middle';
    ctx.lineWidth = this.L.textOutline; ctx.strokeStyle = COL.dark;
    if (maxW > 0) {   // optional: the canvas condenses a wider string to maxW px
      ctx.strokeText(str, x, y, maxW); ctx.fillStyle = color; ctx.fillText(str, x, y, maxW);
      return;
    }
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color; ctx.fillText(str, x, y);
  }
  /** _text through the sprite cache: one drawImage per label once its sprite exists. */
  _spriteText(str, x, y, color, align, baseline) {
    const ctx = this.ctx, font = ctx.font, key = font + '|' + color + '|' + align + '|' + baseline + '|' + str;
    let sp = this._sprites.get(key);
    if (sp === undefined) {
      if (this._sprites.size > 700) this._sprites.clear();
      let px = this._fontPx.get(font);
      if (px === undefined) { const m = /(\d+(?:\.\d+)?)px/.exec(font); px = m ? Number(m[1]) : 12; this._fontPx.set(font, px); }
      const k = this.k, pad = Math.ceil(this.L.textOutline) + 2, tw = ctx.measureText(str).width;
      const W = tw + 2 * pad, H = px * 1.5 + 2 * pad;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(W * k)); c.height = Math.max(1, Math.ceil(H * k));
      const g = c.getContext('2d');
      const ax = align === 'center' ? pad + tw / 2 : (align === 'right' || align === 'end') ? pad + tw : pad;
      const ay = baseline === 'top' ? pad : baseline === 'bottom' ? H - pad : baseline === 'middle' ? H / 2 : pad + px * 1.1;
      g.scale(k, k); g.font = font; g.textAlign = align; g.textBaseline = baseline;
      g.lineJoin = 'round'; g.lineWidth = this.L.textOutline; g.strokeStyle = COL.dark; g.strokeText(str, ax, ay);
      g.fillStyle = color; g.fillText(str, ax, ay);
      sp = { c, ax, ay, w: c.width / k, h: c.height / k };
      this._sprites.set(key, sp);
    }
    const k = this.k;
    ctx.drawImage(sp.c, Math.round((x - sp.ax) * k) / k, Math.round((y - sp.ay) * k) / k, sp.w, sp.h);
  }
  /** Translucent dark box with a colored border. */
  _panel(x, y, w, h, color, lw) {
    const ctx = this.ctx;
    ctx.fillStyle = COL.panel; ctx.fillRect(x, y, w, h);
    ctx.beginPath(); ctx.rect(x, y, w, h); this._stroke(color, lw);
  }
  _rrectPath(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- frame --------------------------------------------------------------------------------------------------
  render(frame) {
    if (!frame || !this.ctx) return;
    const fw = frame.w > 0 ? frame.w : this.w, fh = frame.h > 0 ? frame.h : this.h;
    const dpr = Math.min(this.maxScale, window.devicePixelRatio || 1);
    if (fw !== this.w || fh !== this.h || dpr !== this.dpr) this._setSize(fw, fh);
    if (!(this.w > 0 && this.h > 0)) return;
    const ctx = this.ctx;
    const P = this.prof, now = P ? () => performance.now() : null;
    let t0 = P ? now() : 0, t1 = 0;
    const lap = P ? (key) => { t1 = now(); P[key] = (P[key] || 0) + (t1 - t0 - (P[key] || 0)) * 0.1; t0 = t1; } : null;
    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (P) lap('clear');
    const state = frame.state || 'playing';
    if (state === 'title') return;                       // main shows DOM overlays on the title screen
    this.time = typeof frame.time === 'number' ? frame.time : this.time + (frame.dt || 1 / 60);
    this.alpha = state === 'playing' ? 1 : 0.35;
    ctx.globalAlpha = this.alpha;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.setLineDash(NO_DASH);
    const p = frame.player || DEF_PLAYER;
    const radar = frame.radar || DEF_RADAR;
    this._drawDamage(frame.damageFlash);
    if (P) lap('damage');
    const th = frame.threats;
    if (th && th.length) { this._drawThreats(th, frame.threatGlass); if (P) lap('threats'); }
    // The gun cross is drawn where the rounds actually go (projected from the gun along the nose), not at screen center
    const gc = frame.gunCross;
    if (frame.mouseAim) {
      // War Thunder-style mouse aim: the circle is where you're steering, the cross is where the guns point now
      this._drawAimCircle(frame.mouseAim);
    } else {
      this._drawPitchLadder(p);
      this._drawBankScale(p);
    }
    if (gc) this._drawBoresight(gc.x, gc.y, gc.visible !== false); else this._drawBoresight();
    this._drawVelocityVector(frame.velocityVector);
    if (P) lap('attitude');
    this._drawHeadingTape(p, radar);
    if (P) lap('heading');
    this._drawAirspeed(p);
    this._drawAltitude(p);
    if (P) lap('tapes');
    const compact = !!frame.compact;     // touch layout: sticks and buttons cover the corners
    if (!compact) this._drawThrottle(p);
    this._drawHealth(p);
    if (compact) this._drawCompactWeapons(p); else this._drawWeapons(p);
    if (P) lap('gauges');
    if (!compact) { this._drawRadar(radar, p); this._drawScore(frame); }
    if (P) lap('radar');
    this._prepTarget(frame.target, gc);                  // target box and info block first: squadmate labels avoid them
    this._drawAllies(frame.allies, compact ? frame.touchRects : null);
    this._drawContacts(frame.contacts);
    this._drawTarget(frame.target);
    if (P) lap('markers');
    this._drawWarnings(frame.warnings || DEF_WARN, p);
    this._bossOff = frame.boss ? this.L.bossH : 0;
    this._drawBoss(frame.boss);
    this._drawMessages(frame.messages);
    this._drawRadio(frame.radio);
    this._drawPills(frame);
    if (!compact) this._drawInputStatus(frame.input || DEF_INPUT);
    this._drawHitFlash(frame.hitFlash);
    ctx.globalAlpha = 1;
    if (P) lap('text');
  }

  // ---- attitude group -----------------------------------------------------------------------------------------
  _drawPitchLadder(p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const pitch = p.pitch || 0, roll = p.roll || 0;
    const R = L.clipR + 24 * s;
    ctx.save();
    if (!this.cacheLayers) { ctx.beginPath(); ctx.arc(L.cx, L.cy, L.clipR, 0, TAU); ctx.clip(); }
    ctx.translate(L.cx, L.cy); ctx.rotate(-roll * DEG);
    if (this.cacheLayers) {
      // budget mode: the whole ladder (rungs, dashes, labels) is painted once into a tall strip at zero pitch; each frame
      // blits the window within clipR of the centre, rotated, with no clip path (a circular clip is costly in software
      // Canvas2D): no dashed strokes, outlined glyphs or clipping per frame
      const st = this._ladderStrip || (this._ladderStrip = this._buildLadderStrip()), W = L.clipR;
      const k = this.k, sy = clamp(st.y0 - pitch * L.ppd - W, 0, st.h), ey = clamp(st.y0 - pitch * L.ppd + W, 0, st.h);
      if (ey > sy) ctx.drawImage(st.c, 0, sy * k, st.c.width, (ey - sy) * k, -st.w / 2, sy - st.y0 + pitch * L.ppd, st.w, ey - sy);
    } else this._ladderPaint(pitch, R);
    ctx.restore();
  }
  _buildLadderStrip() {
    const L = this.L, s = L.s, k = this.k;
    const w = 2 * (L.rungHalf + 6 * s + 3 * L.chSmall + 2 * L.textOutline + 4), pad = 16 * s, y0 = 90 * L.ppd + pad, h = 2 * y0;
    const c = document.createElement('canvas'); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
    const real = this.ctx; this.ctx = c.getContext('2d');
    this.ctx.scale(k, k); this.ctx.translate(w / 2, y0); this.ctx.lineCap = 'butt'; this.ctx.lineJoin = 'round';
    this._ladderPaint(0, Infinity);
    this.ctx = real;
    return { c, w, h, y0 };
  }
  /** Ladder in the attitude frame (origin at the centre, horizon-relative): rungs within R px of the centre. */
  _ladderPaint(pitch, R) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const ppd = L.ppd, tick = L.tick, gap = L.rungGap;
    // solid: horizon + positive rungs (end ticks point down toward the horizon)
    let y = pitch * ppd;
    if (Math.abs(y) < R) {                                // horizon: its own, slightly heavier stroke
      ctx.beginPath();
      ctx.moveTo(-L.horizonHalf, y); ctx.lineTo(-gap, y); ctx.moveTo(gap, y); ctx.lineTo(L.horizonHalf, y);
      this._stroke(COL.green, L.lw * 1.35);
    }
    ctx.beginPath();
    for (let a = 5; a <= 90; a += 5) {
      y = (pitch - a) * ppd; if (Math.abs(y) > R) continue;
      const hw = a % 10 ? L.rungHalf * 0.6 : L.rungHalf;
      ctx.moveTo(-hw, y + tick); ctx.lineTo(-hw, y); ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y); ctx.lineTo(hw, y); ctx.lineTo(hw, y + tick);
    }
    this._stroke(COL.green, L.lw);
    // dashed: negative rungs (end ticks point up)
    ctx.beginPath(); ctx.setLineDash(L.dashLadder);
    for (let a = -5; a >= -90; a -= 5) {
      y = (pitch - a) * ppd; if (Math.abs(y) > R) continue;
      const hw = a % 10 ? L.rungHalf * 0.6 : L.rungHalf;
      ctx.moveTo(-hw, y - tick); ctx.lineTo(-hw, y); ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y); ctx.lineTo(hw, y); ctx.lineTo(hw, y - tick);
    }
    this._stroke(COL.green, L.lw);
    ctx.setLineDash(NO_DASH);
    // labels every 10°
    ctx.font = L.fSmall;
    const lx = L.rungHalf + 6 * s;
    for (let a = -90; a <= 90; a += 10) {
      if (a === 0) continue;
      y = (pitch - a) * ppd; if (Math.abs(y) > R) continue;
      const str = fInt(Math.abs(a));
      this._text(str, -lx, y, COL.green, 'right', 'middle');
      this._text(str, lx, y, COL.green, 'left', 'middle');
    }
  }

  _drawBankScale(p) {
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx, cy = L.cy, r = L.bankR;
    ctx.beginPath(); ctx.arc(cx, cy, r, (-90 - 60) * DEG, (-90 + 60) * DEG);
    this._stroke(COL.greenSoft, L.lwThin);
    ctx.beginPath();
    for (let i = 0; i < BANK_TICKS.length; i++) {
      const b = BANK_TICKS[i], th = (-90 + b) * DEG, c = Math.cos(th), sn = Math.sin(th);
      const ab = Math.abs(b), len = (ab === 0 || ab === 30 || ab === 60) ? 10 * s : 6 * s;
      ctx.moveTo(cx + r * c, cy + r * sn); ctx.lineTo(cx + (r + len) * c, cy + (r + len) * sn);
    }
    this._stroke(COL.green, L.lw);
    // sky pointer: rides with the horizon frame (points at the zenith), inside the arc
    const roll = clamp(p.roll || 0, -179, 179);
    const th = (-90 - roll) * DEG, c = Math.cos(th), sn = Math.sin(th);
    const tipR = r - 3 * s, baseR = r - 13 * s, half = 6 * s;
    ctx.beginPath();
    ctx.moveTo(cx + tipR * c, cy + tipR * sn);
    ctx.lineTo(cx + baseR * c - half * sn, cy + baseR * sn + half * c);
    ctx.lineTo(cx + baseR * c + half * sn, cy + baseR * sn - half * c);
    ctx.closePath();
    this._fillOutlined(COL.green);
  }

  _drawAimCircle(m) {
    if (!m || m.aimVisible === false) return;
    const ctx = this.ctx, L = this.L, s = L.s, r = 15 * s;
    ctx.beginPath(); ctx.arc(m.aimX, m.aimY, r, 0, TAU);
    this._stroke(COL.green, L.lw);
    ctx.beginPath(); ctx.arc(m.aimX, m.aimY, 1.6 * s, 0, TAU); this._fillOutlined(COL.green);
  }
  _drawBoresight(x, y, visible = true) {
    if (!visible) return;
    const ctx = this.ctx, L = this.L, s = L.s, cx = x === undefined ? L.cx : x, cy = y === undefined ? L.cy : y, g = 5 * s, l = 12 * s;
    ctx.beginPath();
    ctx.moveTo(cx - g - l, cy); ctx.lineTo(cx - g, cy); ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + l, cy);
    ctx.moveTo(cx, cy - g - l); ctx.lineTo(cx, cy - g); ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + l);
    this._stroke(COL.green, L.lw);
    ctx.beginPath(); ctx.arc(cx, cy, 1.5 * s, 0, TAU); this._fillOutlined(COL.green);
  }

  _drawVelocityVector(vv) {
    if (!vv || vv.visible === false) return;
    const ctx = this.ctx, L = this.L, s = L.s;
    let x = vv.x, y = vv.y;
    if (!isFinite(x) || !isFinite(y)) return;
    const mx = 40 * s, my = 70 * s;
    let clamped = false;
    if (x < mx) { x = mx; clamped = true; } else if (x > L.w - mx) { x = L.w - mx; clamped = true; }
    if (y < my) { y = my; clamped = true; } else if (y > L.h - my) { y = L.h - my; clamped = true; }
    const r = 7 * s;
    if (clamped) ctx.setLineDash(L.dashVV);
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.moveTo(x - r, y); ctx.lineTo(x - r - 13 * s, y);
    ctx.moveTo(x + r, y); ctx.lineTo(x + r + 13 * s, y);
    ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 8 * s);
    this._stroke(COL.green, L.lw);
    if (clamped) ctx.setLineDash(NO_DASH);
  }

  // ---- heading tape -------------------------------------------------------------------------------------------
  _drawHeadingTape(p, radar) {
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx;
    const hdg = norm360(p.heading);
    const hw = L.hdgHalf, ppd = hw / 30, yB = L.hdgBase;
    ctx.beginPath();
    ctx.moveTo(cx - hw, yB); ctx.lineTo(cx + hw, yB);
    ctx.moveTo(cx - hw, yB - 9 * s); ctx.lineTo(cx - hw, yB + 3 * s);
    ctx.moveTo(cx + hw, yB - 9 * s); ctx.lineTo(cx + hw, yB + 3 * s);
    const first = Math.ceil((hdg - 30) / 5) * 5;
    for (let d = first; d <= hdg + 30; d += 5) {
      const x = cx + (d - hdg) * ppd;
      if (x < cx - hw + 1 || x > cx + hw - 1) continue;
      ctx.moveTo(x, yB); ctx.lineTo(x, yB - (d % 10 === 0 ? 9 : 5) * s);
    }
    this._stroke(COL.green, L.lw);
    const ly = yB + 6 * s;
    for (let d = first; d <= hdg + 30; d += 5) {
      if (d % 10) continue;
      const x = cx + (d - hdg) * ppd;
      if (Math.abs(x - cx) > hw - 8 * s) continue;
      const n = norm360(d), card = CARDINAL[n];
      if (card) { ctx.font = L.fMed; this._text(card, x, ly, COL.pale, 'center', 'top'); }
      else { ctx.font = L.fSmall; this._text(fPad3(n), x, ly, COL.green, 'center', 'top'); }
    }
    // target bearing marker on the scale (from the radar's target blip)
    const blips = radar.blips || EMPTY;
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (!b || !b.isTarget) continue;
      let rel = Math.atan2(b.dx || 0, -(b.dz || 0)) / DEG - hdg;
      rel = ((rel % 360) + 540) % 360 - 180;
      if (Math.abs(rel) <= 30) {
        const x = cx + rel * ppd;
        ctx.beginPath();
        ctx.moveTo(x, yB - 12 * s); ctx.lineTo(x + 4.5 * s, yB - 6 * s); ctx.lineTo(x, yB - 1); ctx.lineTo(x - 4.5 * s, yB - 6 * s);
        ctx.closePath(); this._fillOutlined(COL.red);
      }
      break;
    }
    // readout box + lubber caret
    const bw = L.hdgBoxW, bh = L.hdgBoxH, bx = Math.round(cx - bw / 2), by = L.hdgBoxTop;
    this._panel(bx, by, bw, bh, COL.green, L.lw);
    ctx.font = L.fHdg; this._text(fPad3(hdg), cx, by + bh / 2 + 1, COL.pale, 'center', 'middle');
    ctx.beginPath();
    ctx.moveTo(cx - 5 * s, by + bh + 1); ctx.lineTo(cx + 5 * s, by + bh + 1); ctx.lineTo(cx, by + bh + 1 + 7 * s);
    ctx.closePath(); this._fillOutlined(COL.green);
  }

  // ---- airspeed (left) & altitude (right) ---------------------------------------------------------------------
  _drawAirspeed(p) {
    const ctx = this.ctx, L = this.L, s = L.s, cy = L.cy;
    const xT = Math.round(L.cx - L.sideOff);
    // bounded: the tape loops step 20 km/h from kmh - 110 and never end for an infinite (or > ~1e17) value
    const kmh = Math.min(1e6, Math.max(0, (p.speed || 0) * 3.6));
    const half = L.tapeHalf, pxPer = half / 110;
    ctx.beginPath(); ctx.moveTo(xT, cy - half); ctx.lineTo(xT, cy + half);
    const first = Math.max(0, Math.ceil((kmh - 110) / 20) * 20);
    for (let v = first; v <= kmh + 110; v += 20) {
      const y = cy - (v - kmh) * pxPer;
      if (y < cy - half || y > cy + half) continue;
      ctx.moveTo(xT, y); ctx.lineTo(xT + (v % 100 === 0 ? 10 : 6) * s, y);
    }
    this._stroke(COL.green, L.lw);
    ctx.font = L.fSmall;
    for (let v = first; v <= kmh + 110; v += 20) {
      if (v % 100) continue;
      const y = cy - (v - kmh) * pxPer;
      if (y < cy - half + 4 * s || y > cy + half - 4 * s || Math.abs(y - cy) < 10 * s) continue;
      this._text(fInt(v), xT + 13 * s, y, COL.green, 'left', 'middle');
    }
    const bw = L.spdBoxW, bh = L.boxH, bx = Math.round(xT - 8 * s - bw), by = Math.round(cy - bh / 2);
    this._panel(bx, by, bw, bh, COL.green, L.lw);
    ctx.beginPath();
    ctx.moveTo(xT - 8 * s, cy - 5 * s); ctx.lineTo(xT - 1, cy); ctx.lineTo(xT - 8 * s, cy + 5 * s);
    ctx.closePath(); this._fillOutlined(COL.green);
    ctx.font = L.fBig; this._text(fInt(kmh), bx + bw - 7 * s, cy + 1, COL.pale, 'right', 'middle');
    ctx.font = L.fTiny; this._text('KM/H', bx + bw, by - 4 * s, COL.greenSoft, 'right', 'bottom');
    if (p.stall) { ctx.font = L.fSmall; this._text('STALL', bx + bw, by + bh + 4 * s, COL.amber, 'right', 'top'); }
    // G readout under the tape
    const g = p.gLoad == null ? 1 : p.gLoad;
    const gk = Math.round(g * 10);
    if (gk !== this._gKey) { this._gKey = gk; this._gStr = fDec1(gk / 10) + ' G'; }
    const ag = Math.abs(g), gc = ag > 9 ? COL.red : ag > 7 ? COL.amber : COL.green;
    ctx.font = L.fMed; this._text(this._gStr, bx + bw, cy + half + 16 * s, gc, 'right', 'middle');
  }

  _drawAltitude(p) {
    const ctx = this.ctx, L = this.L, s = L.s, cy = L.cy;
    const xT = Math.round(L.cx + L.sideOff);
    const alt = clamp(p.altitude || 0, -1e6, 1e6), ra = p.radarAlt == null ? alt : p.radarAlt;   // bounded: see _drawAirspeed
    const half = L.tapeHalf, pxPer = half / 300;
    const labelEvery = pxPer * 100 < 15 * L.ts ? 200 : 100;
    ctx.beginPath(); ctx.moveTo(xT, cy - half); ctx.lineTo(xT, cy + half);
    const first = Math.ceil((alt - 300) / 50) * 50;
    for (let v = first; v <= alt + 300; v += 50) {
      const y = cy - (v - alt) * pxPer;
      if (y < cy - half || y > cy + half) continue;
      ctx.moveTo(xT, y); ctx.lineTo(xT - (v % 100 === 0 ? 10 : 6) * s, y);
    }
    this._stroke(COL.green, L.lw);
    // terrain block: everything below ground level (altitude - radarAlt) is hatched amber
    const yG = cy + ra * pxPer;
    if (yG < cy + half) {
      const top = Math.max(yG, cy - half);
      ctx.globalAlpha = this.alpha * 0.35; ctx.fillStyle = COL.amber;
      ctx.fillRect(xT - 10 * s, top, 10 * s, cy + half - top);
      ctx.globalAlpha = this.alpha;
      ctx.beginPath(); ctx.moveTo(xT - 14 * s, top); ctx.lineTo(xT + 2 * s, top); this._stroke(COL.amber, L.lwThin);
    }
    ctx.font = L.fSmall;
    for (let v = first; v <= alt + 300; v += 50) {
      if (v % labelEvery) continue;
      const y = cy - (v - alt) * pxPer;
      if (y < cy - half + 4 * s || y > cy + half - 4 * s || Math.abs(y - cy) < 10 * s) continue;
      this._text(fInt(v), xT - 13 * s, y, COL.green, 'right', 'middle');
    }
    const bw = L.altBoxW, bh = L.boxH, bx = Math.round(xT + 8 * s), by = Math.round(cy - bh / 2);
    this._panel(bx, by, bw, bh, COL.green, L.lw);
    ctx.beginPath();
    ctx.moveTo(xT + 8 * s, cy - 5 * s); ctx.lineTo(xT + 1, cy); ctx.lineTo(xT + 8 * s, cy + 5 * s);
    ctx.closePath(); this._fillOutlined(COL.green);
    ctx.font = L.fBig; this._text(fInt(alt), bx + bw - 7 * s, cy + 1, COL.pale, 'right', 'middle');
    ctx.font = L.fTiny; this._text('ALT M', bx, by - 4 * s, COL.greenSoft, 'left', 'bottom');
    const rk = Math.round(ra);
    if (rk !== this._raKey) { this._raKey = rk; this._raStr = 'RA ' + fInt(rk); }
    ctx.font = L.fSmall; this._text(this._raStr, bx, by + bh + 5 * s, ra < 150 ? COL.amber : COL.green, 'left', 'top');
  }

  // ---- bottom-left: throttle + health -------------------------------------------------------------------------
  _drawThrottle(p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const x = Math.round(18 * s), bw = Math.round(12 * s), barH = L.thrH, yBot = L.thrBot, yTop = yBot - barH;
    const abH = Math.round(12 * s), abY = Math.round(yTop - 3 * s - abH);
    const thr = clamp(p.throttle || 0, 0, 1), ab = !!p.afterburner;
    ctx.fillStyle = COL.panel; ctx.fillRect(x, yTop, bw, barH); ctx.fillRect(x, abY, bw, abH);
    const fh = Math.round(barH * thr);
    ctx.globalAlpha = this.alpha * 0.85;
    ctx.fillStyle = ab ? COL.orange : COL.green;
    if (fh > 0) ctx.fillRect(x + 1, yBot - fh, bw - 2, fh);
    if (ab) ctx.fillRect(x + 1, abY + 1, bw - 2, abH - 2);
    ctx.globalAlpha = this.alpha;
    ctx.beginPath(); ctx.rect(x, yTop, bw, barH); ctx.rect(x, abY, bw, abH);
    for (let i = 1; i < 4; i++) { const y = Math.round(yBot - barH * i / 4); ctx.moveTo(x + bw, y); ctx.lineTo(x + bw + 4 * s, y); }
    this._stroke(ab ? COL.orange : COL.green, L.lwThin);
    ctx.font = L.fTiny; this._text('THR', x, abY - 4 * s, COL.greenSoft, 'left', 'bottom');
    ctx.font = L.fSmall;
    const pct = Math.round(thr * 100);
    this._text(PCT_STR[pct] || (PCT_STR[pct] = pct + '%'), x + bw + 7 * s, clamp(yBot - fh, yTop + 6 * s, yBot - 6 * s),
      ab ? COL.orange : COL.green, 'left', 'middle');
    if (ab) { ctx.font = L.fPill; this._text('AB', x + bw + 7 * s, abY + abH / 2, COL.orange, 'left', 'middle'); }
    if (p.airbrake) { ctx.font = L.fPill; this._text('BRK', x + bw + 7 * s, yBot + 2 * s, COL.amber, 'left', 'bottom'); }
  }

  _drawHealth(p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const hp = clamp(p.health == null ? 100 : p.health, 0, 100);
    const x = Math.round(18 * s), y = L.healthY, bh = L.healthH, bw = L.healthW;
    const n = 10, gap = 2 * s, segW = (bw - gap * (n - 1)) / n;
    const col = hp < 25 ? COL.red : hp < 50 ? COL.amber : COL.green;
    const pulse = hp < 25 ? 0.45 + 0.55 * Math.abs(Math.sin(this.time * TAU * 1.5)) : 1;
    ctx.fillStyle = COL.panel; ctx.fillRect(x - 3 * s, y - 3 * s, bw + 6 * s, bh + 6 * s);
    for (let i = 0; i < n; i++) {
      const sx = x + i * (segW + gap), f = clamp(hp / 10 - i, 0, 1);
      ctx.fillStyle = COL.seg; ctx.fillRect(sx, y, segW, bh);
      if (f > 0) {
        ctx.globalAlpha = this.alpha * pulse; ctx.fillStyle = col; ctx.fillRect(sx, y, segW * f, bh);
        ctx.globalAlpha = this.alpha;
      }
    }
    ctx.beginPath(); ctx.rect(x - 3 * s, y - 3 * s, bw + 6 * s, bh + 6 * s); this._stroke(col, L.lwThin);
    ctx.font = L.fTiny; this._text('HULL', x, y - 5 * s, COL.greenSoft, 'left', 'bottom');
    ctx.font = L.fSmall;
    const hk = Math.round(hp);
    this._text(PCT_STR[hk] || (PCT_STR[hk] = hk + '%'), x + bw, y - 5 * s, col, 'right', 'bottom');
  }

  // ---- bottom-right: weapons + radar --------------------------------------------------------------------------
  _drawWeapons(p) {
    const ctx = this.ctx, L = this.L, s = L.s, h = L.h;
    const xr = Math.round(L.radarLeft - 14 * s);
    const msl = Math.max(0, p.missiles | 0), ammo = Math.max(0, p.ammo | 0);
    const mc = msl === 0 ? COL.red : msl < 10 ? COL.amber : COL.green;
    const gc = ammo === 0 ? COL.red : ammo < 200 ? COL.amber : COL.green;
    if (msl !== this._mslKey) { this._mslKey = msl; this._mslStr = 'MSL ' + msl; }
    if (ammo !== this._gunKey) { this._gunKey = ammo; this._gunStr = 'GUN ' + ammo; }
    ctx.font = L.fMed;
    this._text(this._mslStr, xr, h - 78 * s, mc, 'right', 'middle');
    this._text(this._gunStr, xr, h - 36 * s, gc, 'right', 'middle');
    // countermeasure flares: READY, or the seconds left on the reload
    if (p.flareCooldown !== undefined) {
      const ready = !!p.flareReady;
      const left = ready ? -1 : Math.max(1, Math.ceil((1 - p.flareCooldown) * (p.flareReload || 7) * 10));
      if (left !== this._flrKey) { this._flrKey = left; this._flrStr = ready ? 'FLR READY' : 'FLR ' + (left / 10).toFixed(1); }
      ctx.font = L.fSmall;
      this._text(this._flrStr, xr, h - 100 * s, ready ? COL.green : COL.amber, 'right', 'middle');
    }
    // missile hardpoints: one silhouette each; a reloading hardpoint fills up from the bottom
    const hp = p.hardpoints;
    if (!hp || !hp.length) return;
    const k = 1.35 * s, y = h - 58 * s, step = 15 * s, hw = 2.4 * k, top = 7 * k, bot = 6 * k;
    for (let i = 0; i < hp.length; i++) {
      const prog = Math.max(0, Math.min(1, hp[i]));
      const px = Math.round(xr - (hp.length - i) * step + step / 2);
      ctx.beginPath();
      ctx.moveTo(px, y - top); ctx.lineTo(px + hw, y - 3 * k); ctx.lineTo(px + hw, y + bot);
      ctx.lineTo(px - hw, y + bot); ctx.lineTo(px - hw, y - 3 * k); ctx.closePath();
      if (prog >= 1) { this._fillOutlined(mc); continue; }
      this._stroke(COL.greenSoft, 1);
      const fh = (top + bot) * prog;
      ctx.fillStyle = COL.amber;
      ctx.fillRect(px - hw + 1, y + bot - fh, hw * 2 - 2, fh);
    }
  }

  /** Touch layout: one centered line (missiles, hardpoints, cannon, flares) between the thumb sticks. */
  _drawCompactWeapons(p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const msl = Math.max(0, p.missiles | 0), ammo = Math.max(0, p.ammo | 0);
    const hp = p.hardpoints || [];
    let ready = 0; for (let i = 0; i < hp.length; i++) if (hp[i] >= 1) ready++;
    const flr = p.flareCooldown === undefined || p.flareReady ? 'FLR READY' : 'FLR ' + ((1 - p.flareCooldown) * (p.flareReload || 7)).toFixed(1);
    const key = msl + '|' + ready + '|' + ammo + '|' + flr;
    if (key !== this._cwKey) { this._cwKey = key; this._cwStr = `MSL ${msl} [${ready}/${hp.length || 2}]   GUN ${ammo}   ${flr}`; }
    ctx.font = L.fSmall;
    // centered between the sticks; on narrow (portrait) screens nudged right just enough to clear the hull readout
    const half = this._cwStr.length * L.chSmall * 0.5;
    const x = Math.min(Math.max(L.cx, 18 * s + L.healthW + 13 * s + half), L.w - 8 * s - half);
    this._text(this._cwStr, x, L.h - Math.round(70 * s), msl === 0 || ammo === 0 ? COL.amber : COL.green, 'center', 'middle');
  }

  _drawRadar(radar, p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const R = L.radarR, x0 = L.radarX, y0 = L.radarY;
    const range = Math.max(1, radar.range || 8000);
    const hdg = (p.heading || 0) * DEG, ch = Math.cos(hdg), sh = Math.sin(hdg);
    if (this.cacheLayers) {
      // budget mode: the static scope (disc, rings, cross) is one cached image (dashed arcs are slow in software)
      const pad = Math.ceil(L.lw + 2 * L.outline + 2), D = 2 * (R + pad), kk = this.k;
      let bg = this._radarBg;
      if (!bg || bg.R !== R || bg.k !== kk) {
        const c = document.createElement('canvas'); c.width = Math.ceil(D * kk); c.height = Math.ceil(D * kk);
        const real = this.ctx; this.ctx = c.getContext('2d'); this.ctx.scale(kk, kk);
        this._radarScope(R + pad, R + pad, R);
        this.ctx = real;
        bg = this._radarBg = { c, R, k: kk, pad, D };
      }
      ctx.drawImage(bg.c, x0 - R - bg.pad, y0 - R - bg.pad, bg.D, bg.D);
    } else this._radarScope(x0, y0, R);
    // north marker rotates with the heading (player-up display)
    const thN = -Math.PI / 2 - hdg;
    ctx.font = L.fTiny;
    this._text('N', x0 + (R - 8 * s) * Math.cos(thN), y0 + (R - 8 * s) * Math.sin(thN), COL.greenSoft, 'center', 'middle');
    // own-ship symbol
    ctx.beginPath(); ctx.moveTo(x0, y0 - 5 * s); ctx.lineTo(x0 + 4 * s, y0 + 4 * s); ctx.lineTo(x0, y0 + 2 * s);
    ctx.lineTo(x0 - 4 * s, y0 + 4 * s); ctx.closePath(); this._fillOutlined(COL.pale);
    const k = R / range, blips = radar.blips || EMPTY, lim = R - 4 * s;
    // friendly contacts, under the hostiles: diamond = squadmate, square = ground unit, hull = ship (hollow at the rim).
    // Batched: one path for the solid ones (one outlined fill), one for the hollow ones at the rim (one stroke)
    const fr = radar.friendly || EMPTY, nf = Math.min(fr.length, 32);
    for (let pass = 0; pass < 2 && nf > 0; pass++) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < nf; i++) {
        const b = fr[i]; if (!b) continue;
        const dx = b.dx || 0, dz = b.dz || 0;
        let bx = (dx * ch + dz * sh) * k, by = (-dx * sh + dz * ch) * k;
        const d = Math.hypot(bx, by), edge = d > lim;
        if (edge !== (pass === 1)) continue;
        if (edge) { const f = lim / d; bx *= f; by *= f; }
        const sx = x0 + bx, sy = y0 + by;
        if (b.type === 'air') { const q = 3.9 * s; ctx.moveTo(sx, sy - q); ctx.lineTo(sx + q, sy); ctx.lineTo(sx, sy + q); ctx.lineTo(sx - q, sy); ctx.closePath(); }
        else if (b.type === 'naval') {
          const hw = 4.2 * s, hh = 2.4 * s;
          ctx.moveTo(sx - hw, sy - hh); ctx.lineTo(sx + hw, sy - hh); ctx.lineTo(sx + 0.55 * hw, sy + hh); ctx.lineTo(sx - 0.55 * hw, sy + hh); ctx.closePath();
        } else { const q = 2.7 * s; ctx.rect(sx - q, sy - q, 2 * q, 2 * q); }
        any = true;
      }
      if (any) { if (pass === 0) this._fillOutlined(COL.ally); else this._stroke(COL.ally, L.lwThin); }
    }
    // hostiles, batched so the cost stays flat however many there are: one path each for the dots inside the ring (one
    // outlined fill), the hollow dots pinned to the rim, the missile triangles and the altitude arrows; then the target's
    // white corners
    const nb = Math.min(blips.length, MAX_CONTACTS);
    let tx = NaN, ty = 0;
    for (let pass = 0; pass < 4; pass++) {
      ctx.beginPath(); let any = false;
      for (let i = 0; i < nb; i++) {
        const b = blips[i]; if (!b) continue;
        const missile = b.type === 'missile', ra = b.relAlt || 0;
        if (pass === 2 ? !missile : pass === 3 ? !(ra > 150 || ra < -150) : missile) continue;
        const dx = b.dx || 0, dz = b.dz || 0;
        let bx = (dx * ch + dz * sh) * k, by = (-dx * sh + dz * ch) * k;
        const d = Math.hypot(bx, by), edge = d > lim;
        if (pass < 2 && edge !== (pass === 1)) continue;
        if (edge) { const f = lim / d; bx *= f; by *= f; }
        const sx = x0 + bx, sy = y0 + by;
        if (pass < 2) {
          const r = (b.isTarget ? 3.6 : 2.8) * s;
          ctx.moveTo(sx + r, sy); ctx.arc(sx, sy, r, 0, TAU);
          if (b.isTarget) { tx = sx; ty = sy; }
        } else if (pass === 2) {
          ctx.moveTo(sx, sy - 4.5 * s); ctx.lineTo(sx + 4 * s, sy + 3 * s); ctx.lineTo(sx - 4 * s, sy + 3 * s); ctx.closePath();
        } else {
          const dir = ra > 0 ? -1 : 1;
          ctx.moveTo(sx, sy + dir * 6 * s); ctx.lineTo(sx, sy + dir * 10 * s);
          ctx.moveTo(sx - 2 * s, sy + dir * 8 * s); ctx.lineTo(sx, sy + dir * 10 * s); ctx.lineTo(sx + 2 * s, sy + dir * 8 * s);
        }
        any = true;
      }
      if (!any) continue;
      if (pass === 1) this._stroke(COL.red, L.lwThin); else if (pass === 3) this._stroke(COL.red, 1); else this._fillOutlined(COL.red);
    }
    if (tx === tx) {
      const hb = 7 * s, arm = 3.5 * s, sx = tx, sy = ty;
      ctx.beginPath();
      ctx.moveTo(sx - hb, sy - hb + arm); ctx.lineTo(sx - hb, sy - hb); ctx.lineTo(sx - hb + arm, sy - hb);
      ctx.moveTo(sx + hb - arm, sy - hb); ctx.lineTo(sx + hb, sy - hb); ctx.lineTo(sx + hb, sy - hb + arm);
      ctx.moveTo(sx + hb, sy + hb - arm); ctx.lineTo(sx + hb, sy + hb); ctx.lineTo(sx + hb - arm, sy + hb);
      ctx.moveTo(sx - hb + arm, sy + hb); ctx.lineTo(sx - hb, sy + hb); ctx.lineTo(sx - hb, sy + hb - arm);
      this._stroke(COL.white, L.lwThin);
    }
    const rk = Math.round(range / 100);
    if (rk !== this._rngKey) { this._rngKey = rk; this._rngStr = 'RDR ' + fDec1(rk / 10) + ' KM'; }
    ctx.font = L.fTiny; this._text(this._rngStr, x0 - R, y0 - R - 4 * s, COL.greenSoft, 'left', 'bottom');
  }

  _radarScope(x0, y0, R) {
    const ctx = this.ctx, L = this.L;
    ctx.beginPath(); ctx.arc(x0, y0, R, 0, TAU); ctx.fillStyle = COL.panel; ctx.fill(); this._stroke(COL.green, L.lw);
    ctx.beginPath(); ctx.arc(x0, y0, R / 2, 0, TAU); ctx.setLineDash(L.dashRing); this._stroke(COL.greenSoft, L.lwThin);
    ctx.setLineDash(NO_DASH);
    ctx.beginPath(); ctx.moveTo(x0 - R, y0); ctx.lineTo(x0 + R, y0); ctx.moveTo(x0, y0 - R); ctx.lineTo(x0, y0 + R);
    ctx.lineWidth = 1; ctx.strokeStyle = COL.greenFaint; ctx.stroke();
  }

  // ---- top-left: score block ----------------------------------------------------------------------------------
  _drawScore(f) {
    const ctx = this.ctx, L = this.L, s = L.s, ts = L.ts;
    const x = Math.round(16 * s), y = Math.round(10 * s);
    ctx.font = L.fTiny; this._text('SCORE', x, y, COL.greenSoft, 'left', 'top');
    ctx.font = L.fBig; this._text(fInt(f.score || 0), x, y + 11 * ts, COL.pale, 'left', 'top');
    let yy = y + 11 * ts + 26 * ts;
    // campaign phase, or the INFINITY round (frame.round > 0)
    const wave = f.round > 0 ? fPrefixed(ROUND_STR, 'ROUND ', f.round) : fPrefixed(WAVE_STR, 'PHASE ', f.wave || 0);
    if (L.compact) {
      ctx.font = L.fTiny; this._text(wave, x, yy, COL.green, 'left', 'top');
      return;
    }
    ctx.font = L.fSmall;
    this._text(wave, x, yy, COL.green, 'left', 'top'); yy += 14 * ts;
    this._text(fPrefixed(ENEMY_STR, 'TARGETS ', f.enemiesRemaining || 0), x, yy, COL.green, 'left', 'top'); yy += 14 * ts;
    this._text(fPrefixed(KILL_STR, 'KILLS ', f.kills || 0), x, yy, COL.green, 'left', 'top');
  }

  // ---- friendly squadmates ------------------------------------------------------------------------------------
  /**
   * Squadmate markers, on screen only (allies get no edge pointers): green round brackets "( )" where hostile
   * contacts get square corners, plus a "CALLSIGN 1.2" (km) label. Between ALLY_NEAR and ALLY_FAR the brackets
   * shrink and the whole marker fades, so distant wingmen stay quiet during a dogfight. The label hides while the
   * marker sits near the target box; otherwise it takes the first free slot (above the marker, then below) clear of
   * the target box, the other squadmate labels, the screen edges and, on the touch layout, the on-screen buttons.
   */
  _drawAllies(allies, touch) {
    if (!allies || !allies.length) return;
    const ctx = this.ctx, L = this.L, s = L.s, n = Math.min(allies.length, ALLY_MAX), R = this._allyRects;
    // target keep-out: the box, its LOCK cue and its info block (_prepTarget)
    const kx0 = this._kx0, kx1 = this._kx1, ky0 = this._ky0, ky1 = this._ky1;
    const ch = L.chSmall, lh = Math.round(12 * L.ts), pad = 3 * s;
    let nr = 0;
    ctx.font = L.fSmall;
    for (let i = 0; i < n; i++) {
      const a = allies[i];
      if (!a || !a.onScreen || a.behind || !isFinite(a.x) || !isFinite(a.y)) continue;
      const x = a.x, y = a.y, d = a.distance || 0;
      let k = (d - ALLY_NEAR) / (ALLY_FAR - ALLY_NEAR); k = k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
      const r = Math.max(4.5, (9 - 3.5 * k) * s);
      ctx.globalAlpha = this.alpha * (1 - 0.5 * k);
      ctx.beginPath();
      ctx.moveTo(x - r * ARC_C, y + r * ARC_S); ctx.arc(x, y, r, Math.PI - ARC_A, Math.PI + ARC_A);
      ctx.moveTo(x + r * ARC_C, y - r * ARC_S); ctx.arc(x, y, r, -ARC_A, ARC_A);
      this._line(COL.ally, L.lw);
      if (x > kx0 && x < kx1 && y > ky0 && y < ky1) continue;          // close to the target box: brackets only
      const cs = a.callsign || a.name || 'ALLY', ds = fDec1(Math.round(d / 100) / 10);
      const len = cs.length + 1 + ds.length, hw = len * ch * 0.5 + 2;
      const lx = clamp(x, hw + 4 * s, L.w - hw - 4 * s), x0 = lx - hw, x1 = lx + hw;
      let ly = -1;
      for (let c = 0; c < 2 && ly < 0; c++) {
        const y0 = c === 0 ? y - r - pad - lh : y + r + pad, y1 = y0 + lh;
        if (y0 < 2 || y1 > L.h - 2) continue;
        if (x1 > kx0 && x0 < kx1 && y1 > ky0 && y0 < ky1) continue;
        let free = true;
        for (let j = 0; j < nr && free; j++) if (x1 > R[4 * j] && x0 < R[4 * j + 2] && y1 > R[4 * j + 1] && y0 < R[4 * j + 3]) free = false;
        if (free && touch) for (let j = 0; j < TOUCH_KEYS.length && free; j++) {
          const b = touch[TOUCH_KEYS[j]];
          if (b && x1 > b.x - 2 && x0 < b.x + b.w + 2 && y1 > b.y - 2 && y0 < b.y + b.h + 2) free = false;
        }
        if (free) ly = y0;
      }
      if (ly < 0) continue;                                           // no free slot: brackets only
      R[4 * nr] = x0; R[4 * nr + 1] = ly; R[4 * nr + 2] = x1; R[4 * nr + 3] = ly + lh; nr++;
      const tx = lx - len * ch * 0.5, ty = ly + lh * 0.5;
      ctx.globalAlpha = this.alpha * (1 - 0.35 * k);                  // the label fades less, so it stays legible on bright sky
      this._text(cs, tx, ty, COL.ally, 'left', 'middle');
      this._text(ds, tx + (cs.length + 1) * ch, ty, COL.allySoft, 'left', 'middle');
    }
    ctx.globalAlpha = this.alpha;
  }

  // ---- contacts & target --------------------------------------------------------------------------------------
  /** Marker half-size (px): `min`, or more when the drawn model projects larger (radius r px, frame .r), so the
   *  brackets frame the model with some clearance and never cross it. */
  _mkHalf(r, min) {
    const L = this.L;
    return clamp((r > 0 ? r : 0) * MK_GROW + MK_PAD * L.s, min, Math.max(min, MK_MAX * L.m));
  }

  _drawContacts(contacts) {
    if (!contacts || !contacts.length) return;
    const ctx = this.ctx, L = this.L, s = L.s, n = Math.min(contacts.length, MAX_CONTACTS), hs0 = 11 * s;
    for (let pass = 0; pass < 2; pass++) {              // pass 0: hostile (red), pass 1: friendly (green)
      ctx.beginPath(); let any = false;
      for (let i = 0; i < n; i++) {
        const c = contacts[i];
        if (!c || !c.onScreen || c.isTarget || c.type === 'missile' || !isFinite(c.x) || !isFinite(c.y)) continue;
        if ((c.hostile !== false) !== (pass === 0) || c.distance > MK_FAR_M) continue;   // far: caret below
        const x = c.x, y = c.y, hs = this._mkHalf(c.r, hs0), arm = hs * (5 / 11);
        ctx.moveTo(x - hs, y - hs + arm); ctx.lineTo(x - hs, y - hs); ctx.lineTo(x - hs + arm, y - hs);
        ctx.moveTo(x + hs - arm, y - hs); ctx.lineTo(x + hs, y - hs); ctx.lineTo(x + hs, y - hs + arm);
        ctx.moveTo(x + hs, y + hs - arm); ctx.lineTo(x + hs, y + hs); ctx.lineTo(x + hs - arm, y + hs);
        ctx.moveTo(x - hs + arm, y + hs); ctx.lineTo(x - hs, y + hs); ctx.lineTo(x - hs, y + hs - arm);
        any = true;
      }
      if (any) this._line(pass === 0 ? COL.red : COL.green, L.lwThin);
    }
    // far hostiles: one path of small "v" carets, the tip clear of the model's top
    ctx.beginPath(); let far = false;
    const cw = 3 * s, chh = 3 * s;
    for (let i = 0; i < n; i++) {
      const c = contacts[i];
      if (!c || !c.onScreen || c.isTarget || c.type === 'missile' || c.hostile === false || !(c.distance > MK_FAR_M) || !isFinite(c.x) || !isFinite(c.y)) continue;
      const ty = c.y - Math.max(4 * s, (c.r > 0 ? c.r : 0) * MK_GROW + 2 * s);
      ctx.moveTo(c.x - cw, ty - chh); ctx.lineTo(c.x, ty); ctx.lineTo(c.x + cw, ty - chh);
      far = true;
    }
    if (far) { ctx.globalAlpha = this.alpha * MK_FAR_A; this._line(COL.red, L.lwThin); ctx.globalAlpha = this.alpha; }
    ctx.font = L.fTiny;
    for (let i = 0; i < n; i++) {
      const c = contacts[i];
      if (!c || c.type !== 'missile' || !c.onScreen || !isFinite(c.x) || !isFinite(c.y)) continue;
      const x = c.x, y = c.y;
      ctx.beginPath(); ctx.moveTo(x, y - 7 * s); ctx.lineTo(x + 6 * s, y + 5 * s); ctx.lineTo(x - 6 * s, y + 5 * s);
      ctx.closePath(); this._fillOutlined(COL.red);
      this._text('M', x + 9 * s, y, COL.red, 'left', 'middle');
      if (c.distance > 0) this._text(fDec1(c.distance / 1000), x, y + 8 * s, COL.red, 'center', 'top');
    }
  }

  /**
   * Selected target, laid out once per frame before anything draws: the distance and closure strings, the box half-size
   * (at least 22 px, more to frame a model that projects larger) and the info block's place: under the box, or above it
   * (and its LOCK cue) while under it would cover the gun cross, moving back once that spot has been clear for 0.4 s.
   * Also the keep-out rect squadmate labels avoid.
   */
  _prepTarget(t, gc) {
    this._kx0 = 0; this._kx1 = -1; this._ky0 = 0; this._ky1 = -1;
    if (!t) return;
    const L = this.L, s = L.s, ts = L.ts;
    const dk = Math.round((t.distance || 0) / 100);
    if (dk !== this._distKey) { this._distKey = dk; this._distStr = fDec1(dk / 10) + ' KM'; }
    const ck = Math.round(t.closure || 0);
    if (ck !== this._clKey) { this._clKey = ck; this._clStr = (ck >= 0 ? '+' : '-') + fInt(Math.abs(ck)) + ' M/S'; }
    if (!(t.onScreen && !t.behind && isFinite(t.x) && isFinite(t.y))) { this._tAbove = false; return; }
    const x = t.x, y = t.y, half = this._tHalf = this._mkHalf(t.r, 22 * s), ch = L.chSmall;
    // info block (_drawTargetBox), centred on tx: name, health bar as wide as the box, distance | closure
    const hw = Math.max(t.name ? t.name.length * ch * 0.5 : 0, half, 4 * s + Math.max(this._distStr.length, this._clStr.length) * ch);
    const bh = (t.name ? 13 * ts : 0) + 7 * s + 12 * ts, cue = 14 * ts + 9 * s;   // cue: the LOCK line over the box
    const tx = this._tX = clamp(x, 70 * s, L.w - 70 * s), yb = y + half + 6 * s, ya = y - half - (t.locked ? cue : 6 * s) - bh;
    const gr = 18 * s, gv = gc ? gc.visible !== false : true, gx = gc ? gc.x : L.cx, gy = gc ? gc.y : L.cy;
    const onB = gv && near(tx - hw, yb, tx + hw, yb + bh, gx, gy, gr), onA = gv && near(tx - hw, ya, tx + hw, ya + bh, gx, gy, gr);
    if (onB && !onA) { this._tAbove = true; this._tClearT = this.time; }
    else if (this._tAbove && (onA || this.time - this._tClearT > 0.4)) this._tAbove = false;
    const top = this._tY = this._tAbove ? ya : yb;
    this._kx0 = Math.min(x - half, tx - hw) - 4 * s; this._kx1 = Math.max(x + half, tx + hw) + 4 * s;
    this._ky0 = Math.min(y - half - cue, top) - 4 * s; this._ky1 = Math.max(y + half, top + bh) + 4 * s;
  }

  _drawTarget(t) {
    if (!t) return;
    if (t.onScreen && !t.behind && isFinite(t.x) && isFinite(t.y)) this._drawTargetBox(t);
    else this._drawOffscreenPointer(t);
  }

  _drawTargetBox(t) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const x = t.x, y = t.y, half = this._tHalf, lock = clamp(t.lock || 0, 0, 1), locked = !!t.locked;
    const pulse = locked ? 1 + 0.07 * Math.sin(this.time * 12) : 1;
    if (t.inSeekerCone && !locked) {                     // seeker circle shrinks onto the box as lock builds
      const r = lerp(Math.max(90 * s, half * 2.5), half * 1.45, lock);
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); this._line(COL.greenSoft, L.lwThin);
      if (lock > 0) { ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + lock * TAU); this._line(COL.green, L.lw); }
    }
    const hb = half * pulse;
    ctx.beginPath(); ctx.rect(x - hb, y - hb, 2 * hb, 2 * hb);
    if (locked) this._line(COL.green, L.lw);
    else { ctx.setLineDash(L.dashBox); this._line(COL.green, L.lwThin); ctx.setLineDash(NO_DASH); }
    if (locked) { ctx.font = L.fLock; this._text('LOCK', x, y - half - 7 * s, COL.white, 'center', 'bottom'); }
    // info block under the box, or over it while under it would cover the gun cross (kept on screen horizontally)
    const tx = this._tX;
    let ty = this._tY;
    ctx.font = L.fSmall;
    if (t.name) { this._text(t.name, tx, ty, COL.pale, 'center', 'top'); ty += 13 * L.ts; }
    const hp = clamp(t.health == null ? 1 : t.health, 0, 1), hh = 3 * s;
    ctx.fillStyle = COL.seg; ctx.fillRect(tx - half, ty, 2 * half, hh);
    ctx.fillStyle = hp > 0.5 ? COL.green : hp > 0.25 ? COL.amber : COL.red; ctx.fillRect(tx - half, ty, 2 * half * hp, hh);
    ty += hh + 4 * s;
    const cl = t.closure || 0;
    this._text(this._distStr, tx - 4 * s, ty, COL.green, 'right', 'top');
    this._text(this._clStr, tx + 4 * s, ty, cl >= 0 ? COL.green : COL.amber, 'left', 'top');
    const ld = t.lead;                                   // gun lead: put the gun cross on this ring to hit
    if (ld && isFinite(ld.x) && isFinite(ld.y)) {
      const hot = !!t.leadHot, c = hot ? COL.red : COL.white, r = 10 * s, tk = 5 * s;
      // tether from the target box edge to the ring so it's obvious which target it leads
      const dx = ld.x - x, dy = ld.y - y, dl = Math.hypot(dx, dy);
      if (dl > half * 1.6 + r) {
        const ux = dx / dl, uy = dy / dl, e = half * 1.25;
        ctx.setLineDash(L.dashBox); ctx.beginPath(); ctx.moveTo(x + ux * e, y + uy * e); ctx.lineTo(ld.x - ux * r, ld.y - uy * r);
        this._stroke(hot ? COL.red : 'rgba(255,255,255,0.55)', 1); ctx.setLineDash(NO_DASH);
      }
      ctx.beginPath(); ctx.arc(ld.x, ld.y, r, 0, TAU);
      ctx.moveTo(ld.x + r, ld.y); ctx.lineTo(ld.x + r + tk, ld.y); ctx.moveTo(ld.x - r, ld.y); ctx.lineTo(ld.x - r - tk, ld.y);
      ctx.moveTo(ld.x, ld.y + r); ctx.lineTo(ld.x, ld.y + r + tk); ctx.moveTo(ld.x, ld.y - r); ctx.lineTo(ld.x, ld.y - r - tk);
      this._stroke(c, hot ? L.lw * 1.4 : L.lw);
      ctx.beginPath(); ctx.arc(ld.x, ld.y, (hot ? 3.2 : 1.6) * s, 0, TAU); this._fillOutlined(c);
      if (hot) { ctx.font = L.fPill; this._text('GUNS', ld.x, ld.y - r - tk - 3 * s, COL.red, 'center', 'bottom'); }
    }
  }

  /** Off-screen target: arrow on an ellipse near the screen edge; "behind" uses a double chevron + REAR. */
  _drawOffscreenPointer(t) {
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx, cy = L.cy;
    let dx = t.x - cx, dy = t.y - cy;
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) { dx = 0; dy = 1; }
    const phi = Math.atan2(dy, dx), c = Math.cos(phi), sn = Math.sin(phi);
    const a = Math.max(40 * s, L.w / 2 - 64 * s), b = Math.max(40 * s, L.h / 2 - 90 * s);
    const rr = 1 / Math.sqrt((c * c) / (a * a) + (sn * sn) / (b * b));
    const px = cx + rr * c, py = cy + rr * sn;
    const locked = !!t.locked;
    const col = t.behind ? COL.amber : locked ? COL.white : COL.green;
    if (!t.behind) {
      const len = 21 * s, half = 10 * s, bx = px - len * c, by = py - len * sn;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx - half * sn, by + half * c); ctx.lineTo(bx + half * sn, by - half * c);
      ctx.closePath(); this._fillOutlined(col);
    } else {
      ctx.lineCap = 'round'; ctx.beginPath();
      for (let k = 0; k < 2; k++) {
        const tx = px - k * 10 * s * c, ty = py - k * 10 * s * sn, bx = tx - 11 * s * c, by = ty - 11 * s * sn;
        ctx.moveTo(bx - 11 * s * sn, by + 11 * s * c); ctx.lineTo(tx, ty); ctx.lineTo(bx + 11 * s * sn, by - 11 * s * c);
      }
      this._stroke(col, L.lw * 1.25); ctx.lineCap = 'butt';
    }
    // what the arrow points at: (REAR) · LOCK · name · distance · health
    const off = 54 * s, lx = px - off * c, ly = py - off * sn, lh = 12 * L.ts;
    const lines = (t.behind ? 1 : 0) + (locked ? 1 : 0) + 2;
    let yy = ly - (lines - 1) * lh * 0.5 - 3 * s;
    ctx.font = L.fSmall;
    if (t.behind) { this._text('REAR', lx, yy, COL.amber, 'center', 'middle'); yy += lh; }
    if (locked) {
      const d = 4 * s, tw = ctx.measureText('LOCK').width;
      ctx.beginPath(); ctx.moveTo(lx - tw / 2 - 9 * s, yy - d); ctx.lineTo(lx - tw / 2 - 9 * s + d, yy); ctx.lineTo(lx - tw / 2 - 9 * s, yy + d); ctx.lineTo(lx - tw / 2 - 9 * s - d, yy); ctx.closePath();
      this._fillOutlined(COL.white);
      this._text('LOCK', lx, yy, COL.white, 'center', 'middle'); yy += lh;
    }
    this._text(t.name || 'TARGET', lx, yy, locked ? COL.white : COL.pale, 'center', 'middle'); yy += lh;
    this._text(this._distStr, lx, yy, col, 'center', 'middle'); yy += 8 * s;
    const hp = clamp(t.health == null ? 1 : t.health, 0, 1), bw = 34 * s, bh = 3 * s;
    ctx.fillStyle = COL.seg; ctx.fillRect(lx - bw / 2, yy, bw, bh);
    ctx.fillStyle = hp > 0.5 ? COL.green : hp > 0.25 ? COL.amber : COL.red; ctx.fillRect(lx - bw / 2, yy, bw * hp, bh);
  }

  // ---- warnings, messages, mode pills -------------------------------------------------------------------------
  _drawWarnings(warn, p) {
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx;
    let y = L.warnY;
    const on = (this.time * 3) % 1 < 0.62;              // 3 Hz flash (dims instead of vanishing)
    const bh = Math.round(34 * L.ts);
    ctx.font = L.fWarn;
    for (let i = 0; i < WARN_DEFS.length; i++) {
      const d = WARN_DEFS[i];
      const active = d.key === 'stall' ? (warn.stall || p.stall) : warn[d.key];
      if (!active) continue;
      const bw = L.warnW[i], x = Math.round(cx - bw / 2);
      ctx.globalAlpha = this.alpha * (on ? 1 : 0.3);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, bw, bh);
      ctx.beginPath(); ctx.rect(x, y, bw, bh); this._stroke(d.color, L.lw);
      this._text(d.text, cx, y + bh / 2 + 1, d.color, 'center', 'middle');
      y += bh + 6 * s;
    }
    ctx.globalAlpha = this.alpha;
  }

  _drawMessages(msgs) {
    if (!msgs || !msgs.length) return;
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx, n = Math.min(msgs.length, 5);
    let y = L.msgY + (this._bossOff || 0);
    for (let i = 0; i < n; i++) {
      const m = msgs[i]; if (!m || !m.text) continue;
      const age = m.age || 0, dur = m.duration || 3;
      const aIn = clamp(age / 0.25, 0, 1), a = aIn * clamp((dur - age) / 0.5, 0, 1);
      if (a <= 0) continue;
      const big = !!m.big, lh = (big ? 30 : 20) * L.ts;
      ctx.font = big ? L.fMsgBig : L.fMsg;
      ctx.globalAlpha = this.alpha * a;
      // briefing lines run to ~110 characters: condensed to the screen width on narrow screens instead of clipped
      this._text(m.text, cx, y + lh / 2 + (1 - aIn) * 6 * s, big ? COL.pale : COL.green, 'center', 'middle', L.w - 16 * s);
      y += lh;
    }
    ctx.globalAlpha = this.alpha;
  }

  /** Boss health bar: name over `bars` segments; the rightmost live segment drains, broken ones stay empty. */
  _drawBoss(b) {
    if (!b) return;
    const ctx = this.ctx, L = this.L, s = L.s;
    const n = Math.max(1, Math.min(12, b.bars | 0)), frac = clamp(b.frac || 0, 0, 1);
    const bw = L.bossW, x0 = Math.round(L.cx - bw / 2), y0 = L.pillY;
    ctx.font = L.fSmall;
    this._text(b.name || 'TARGET', L.cx, y0, COL.pale, 'center', 'top');
    const by = y0 + L.bossNameH + Math.round(3 * s), bh = L.bossBarH, gap = Math.max(2, Math.round(3 * s));
    const sw = (bw - gap * (n - 1)) / n, live = frac * n, cur = Math.ceil(live - 1e-6) - 1;
    const hot = cur === 0 ? COL.red : COL.green;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = x0 + i * (sw + gap), f = clamp(live - i, 0, 1);
      ctx.fillStyle = COL.seg; ctx.fillRect(x, by, sw, bh);
      if (f > 0) { ctx.fillStyle = i === cur ? hot : COL.green; ctx.fillRect(x, by, sw * f, bh); }
      ctx.rect(x, by, sw, bh);
    }
    this._stroke(COL.greenSoft, L.lwThin);
  }

  /** Radio subtitles: speaker label (AWACS amber, WSO violet, Mainspring crimson) on its own line above the spoken text
   *  (white, dark outline). */
  _drawRadio(r) {
    if (!r || !r.text) return;
    const age = r.age || 0, dur = r.duration || 3;
    const a = clamp(age / 0.2, 0, 1) * clamp((dur - age) / 0.4, 0, 1);
    if (a <= 0) return;
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx;
    ctx.font = L.fMsg;
    const key = r.text + '|' + L.w + '|' + s;
    if (key !== this._radioKey) {                        // wrap to at most two lines (recomputed only when text/size changes)
      this._radioKey = key;
      const maxW = Math.min(L.w * 0.62, 760 * s), words = String(r.text).split(' '), out = [];
      let line = '';
      for (const w of words) {
        const t = line ? line + ' ' + w : w;
        if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
      }
      if (line) out.push(line);
      if (out.length > 2) out.splice(1, out.length - 1, out.slice(1).join(' '));
      this._radioLines = out;
    }
    const lines = this._radioLines, lh = Math.round(19 * L.ts);
    let y = L.h - Math.round(26 * s) - (lines.length - 1) * lh;
    ctx.globalAlpha = this.alpha * a;
    ctx.font = L.fPill;
    this._text(r.speaker || 'RADIO', cx, y - Math.round(lh * 1.05), RADIO_COL[r.speaker] || COL.amber, 'center', 'middle');
    ctx.font = L.fMsg;
    for (let i = 0; i < lines.length; i++) { this._text(lines[i], cx, y, COL.white, 'center', 'middle'); y += lh; }
    ctx.globalAlpha = this.alpha;
  }

  _drawPills(f) {
    const p1 = !!f.padlock, p2 = !!f.lookBack;
    if (!p1 && !p2) return;
    const L = this.L, s = L.s, gap = 8 * s, hgt = L.pillH, y = L.pillY + (this._bossOff || 0);
    const total = (p1 ? L.pillW1 : 0) + (p2 ? L.pillW2 : 0) + (p1 && p2 ? gap : 0);
    let x = Math.round(L.cx - total / 2);
    this.ctx.font = L.fPill;
    if (p1) { this._pill(x, y, L.pillW1, hgt, 'PADLOCK', COL.green); x += L.pillW1 + gap; }
    if (p2) this._pill(x, y, L.pillW2, hgt, 'REAR VIEW', COL.amber);
  }
  _pill(x, y, w, h, text, color) {
    const ctx = this.ctx;
    ctx.beginPath(); this._rrectPath(x, y, w, h, h / 2);
    ctx.fillStyle = COL.panel; ctx.fill(); this._stroke(color, this.L.lwThin);
    this._text(text, x + w / 2, y + h / 2 + 0.5, color, 'center', 'middle');
  }

  // ---- input status (bottom-left) -----------------------------------------------------------------------------
  _drawInputStatus(input) {
    const ctx = this.ctx, L = this.L, s = L.s, ts = L.ts;
    const maxW = Math.max(60, L.radarLeft - 14 * s - 18 * s);
    if (input.gamepadBlocked !== this._inBlocked || input.gamepadConnected !== this._inConn ||
        input.gamepadName !== this._inName || input.usingGamepad !== this._inUsing || maxW !== this._inMaxW ||
        !!input.pointerLocked !== this._inLocked) {   // the mouse-aim hint differs with the cursor captured or free
      this._inBlocked = input.gamepadBlocked; this._inConn = input.gamepadConnected;
      this._inName = input.gamepadName; this._inUsing = input.usingGamepad; this._inMaxW = maxW;
      this._inLocked = !!input.pointerLocked;
      this._rebuildInputLines(input, maxW);
    }
    const lines = this._inLines, color = this._inColor;
    const x = Math.round(18 * s);
    let y = L.h - 8 * s;
    ctx.font = L.fTiny;
    for (let i = lines.length - 1; i >= 0; i--) {
      let lx = x;
      if (i === 0 && this._inGlyph) { this._drawGamepadGlyph(x, y - 5.5 * ts, color); lx += 25 * s; }
      this._text(lines[i], lx, y, color, 'left', 'bottom');
      y -= 12 * ts;
    }
  }

  _rebuildInputLines(input, maxW) {
    const ctx = this.ctx, L = this.L, lines = this._inLines;
    let text, color, glyph = false;
    if (input.gamepadBlocked) {
      text = 'GAMEPAD UNAVAILABLE IN THIS BROWSER — try another browser or use mouse aim'; color = COL.amber;
    } else if (input.gamepadConnected && input.usingGamepad) {
      text = String(input.gamepadName || 'GAMEPAD').replace(/\s*\(.*$/, '').trim() || 'GAMEPAD';
      glyph = true; color = COL.green;
    } else {
      text = input.pointerLocked ? 'MOUSE AIM — C free look · Esc frees the cursor'
        : 'MOUSE AIM — click to capture the cursor · any controller button switches to gamepad';
      color = COL.greenSoft;
    }
    this._inColor = color; this._inGlyph = glyph;
    ctx.font = L.fTiny;
    const avail = maxW - (glyph ? 25 * L.s : 0);
    lines.length = 0;
    if (ctx.measureText(text).width <= avail) { lines.push(text); return; }
    const idx = text.indexOf(' — ');
    if (idx > 0) { lines.push(text.slice(0, idx)); lines.push(text.slice(idx + 3)); } else lines.push(text);
    for (let i = 0; i < lines.length; i++) {           // last resort: truncate with an ellipsis
      let ln = lines[i];
      if (ctx.measureText(ln).width <= avail) continue;
      while (ln.length > 3 && ctx.measureText(ln + '…').width > avail) ln = ln.slice(0, -1);
      lines[i] = ln + '…';
    }
  }

  /** Tiny controller glyph drawn with lines: rounded body, d-pad cross, two face buttons. */
  _drawGamepadGlyph(x, cy, color) {
    const ctx = this.ctx, L = this.L, s = L.s, w = 18 * s, h = 10 * s, y0 = cy - h / 2;
    ctx.beginPath(); this._rrectPath(x, y0, w, h, 3 * s);
    const dx = x + 5 * s;
    ctx.moveTo(dx - 2.2 * s, cy); ctx.lineTo(dx + 2.2 * s, cy); ctx.moveTo(dx, cy - 2.2 * s); ctx.lineTo(dx, cy + 2.2 * s);
    this._stroke(color, L.lwThin);
    ctx.beginPath();
    ctx.moveTo(x + w - 6 * s + 1.1 * s, cy - 1.6 * s); ctx.arc(x + w - 6 * s, cy - 1.6 * s, 1.1 * s, 0, TAU);
    ctx.moveTo(x + w - 3.8 * s + 1.1 * s, cy + 1.2 * s); ctx.arc(x + w - 3.8 * s, cy + 1.2 * s, 1.1 * s, 0, TAU);
    ctx.fillStyle = color; ctx.fill();
  }

  // ---- edge effects -------------------------------------------------------------------------------------------
  _drawDamage(v) {
    const L = this.L;
    if (!(v > 0) || !L.dmgGrad || this.cacheLayers) return;   // (budget mode: PostFX's red edge pulse carries it alone)
    const ctx = this.ctx;
    ctx.globalAlpha = this.alpha * clamp(v, 0, 1);
    ctx.fillStyle = L.dmgGrad; ctx.fillRect(0, 0, L.w, L.h);
    ctx.globalAlpha = this.alpha;
  }
  /** Where the ray from the screen centre along (c, s) (unit, y down) meets the edge rounded rect: this._ep gets the
   *  point (x, y, relative to the centre), its distance t and the outward edge normal (nx, ny). */
  _edgePoint(c, s) {
    const L = this.L, a = L.w / 2, b = L.h / 2, r = Math.min(L.thrCorner, a, b), E = this._ep;
    const ac = Math.abs(c), as = Math.abs(s);
    const ta = ac > 1e-6 ? a / ac : Infinity, tb = as > 1e-6 ? b / as : Infinity;
    let t = ta < tb ? ta : tb, x = t * c, y = t * s;
    const ix = a - r, iy = b - r;
    if (Math.abs(x) > ix && Math.abs(y) > iy) {   // a rounded corner: meet its circle instead
      const qx = x < 0 ? -ix : ix, qy = y < 0 ? -iy : iy, dq = c * qx + s * qy;
      t = dq + Math.sqrt(Math.max(0, dq * dq - qx * qx - qy * qy + r * r)); x = t * c; y = t * s;
      E.nx = (x - qx) / r; E.ny = (y - qy) / r;
    } else if (ta < tb) { E.nx = c < 0 ? -1 : 1; E.ny = 0; } else { E.nx = 0; E.ny = s < 0 ? -1 : 1; }
    E.x = x; E.y = y; E.t = t;
    return E;
  }
  /** The glow as a small image (budget mode: a scaled blit is cheaper than a big radial-gradient fill in software). */
  _threatSprite() {
    if (this._thrSprite) return this._thrSprite;
    const N = 64, c = document.createElement('canvas'); c.width = N; c.height = N;
    const g = c.getContext('2d'), gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    threatStops(gr);
    g.fillStyle = gr; g.fillRect(0, 0, N, N);
    return (this._thrSprite = c);
  }
  /** Incoming-missile edge arcs: threats[i] = { ang (screen angle from the centre, rad, y down), tti (s), fade (0..1) }.
   *  glass (0..1: the red Glassfall sky) raises the alpha up to 1.5x, as red on red needs it. One transformed fill (or
   *  blit) per arc, nothing allocated. */
  _drawThreats(threats, glass) {
    const ctx = this.ctx, L = this.L, n = Math.min(threats.length, THR_MAX), A = this._thrA, SP = this._thrSpan;
    const budget = this.cacheLayers, grad = L.thrGrad;
    if (!grad && !budget) return;
    for (let i = 0; i < n; i++) {
      const T = threats[i], u = clamp((THR_FAR - T.tti) / (THR_FAR - THR_NEAR), 0, 1);
      let a = lerp(THR_A0, THR_A1, u) * clamp(T.fade, 0, 1) * (1 + 0.5 * clamp(glass || 0, 0, 1));
      if (T.tti < THR_PULSE) a *= 0.86 + 0.18 * Math.sin(this.time * 20);   // ~3 Hz
      A[i] = a; SP[i] = lerp(THR_SPAN0, THR_SPAN1, u) * 0.5 * DEG;
    }
    ctx.globalCompositeOperation = 'lighter';
    const k = this.k, sprite = budget ? this._threatSprite() : null;
    for (let i = 0; i < n; i++) {
      const T = threats[i], ang = T.ang;
      // overlap cap: the alpha of every arc within reach of this one (itself included) sums to at most THR_CAP
      let sum = 0;
      for (let j = 0; j < n; j++) {
        let d = Math.abs(threats[j].ang - ang) % TAU; if (d > Math.PI) d = TAU - d;
        if (d < SP[i] + SP[j]) sum += A[j];
      }
      const cap = THR_CAP * (1 + 0.2 * clamp(glass || 0, 0, 1));
      const a = A[i] * (sum > cap ? cap / sum : 1);
      if (!(a > 0.004)) continue;
      const c = Math.cos(ang), s = Math.sin(ang), E = this._edgePoint(c, s);
      const u = clamp((THR_FAR - T.tti) / (THR_FAR - THR_NEAR), 0, 1);
      const along = Math.max(1.5 * E.t * Math.tan(SP[i]), 40 * L.s), depth = lerp(THR_D0, THR_D1, u) * L.m;
      // local frame: x along the edge (tangent), y inward; the unit gradient becomes an ellipse centred on the edge
      const tx = -E.ny, ty = E.nx, ix = -E.nx, iy = -E.ny;
      ctx.setTransform(k * tx * along, k * ty * along, k * ix * depth, k * iy * depth, k * (L.cx + E.x), k * (L.cy + E.y));
      ctx.globalAlpha = this.alpha * a;
      if (sprite) ctx.drawImage(sprite, 0, 16, 64, 48, -1, -0.5, 2, 1.5);
      else { ctx.fillStyle = grad; ctx.fillRect(-1, -0.5, 2, 1.5); }
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.alpha;
  }
  _drawHitFlash(v) {
    if (!(v > 0)) return;
    const ctx = this.ctx, L = this.L, s = L.s, inset = 6 * s;
    ctx.globalAlpha = this.alpha * clamp(v, 0, 1);
    ctx.lineWidth = 3 * s; ctx.strokeStyle = COL.white;
    ctx.strokeRect(inset, inset, L.w - 2 * inset, L.h - 2 * inset);
    ctx.globalAlpha = this.alpha;
  }
}
