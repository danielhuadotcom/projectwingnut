// js/hud.js — PROJECT WINGNUT · fighter-style 2D canvas HUD overlay.
// Pure Canvas2D: deliberately NO Three.js import (the HUD only receives screen-space data — see SPEC.md "js/hud.js").
//
// Visual language: phosphor green primary, amber cautions, red warnings/hostiles, green friendlies. Target markers are
// shaped by type (air / ground / naval); the selected target's is thicker with a hot core, and closes solid when locked.
// Every line/glyph is drawn in two passes (thick dark under, thin bright over) and text is stroked dark then filled,
// which keeps the HUD legible over bright sky/snow without shadowBlur (far too expensive per frame).
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
  core: '#FFE9E4',             // hot inner line of the selected target's (red) marker
  halo: 'rgba(0,0,0,0.62)',    // thin dark halo under target markers and their arrowheads
};

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
// Target markers. Half-size = clamp(r * MK_GROW + MK_PAD, L.mkMin, L.mkMax) for a projected model radius of r px;
// below PIP_R px a solid centre pip marks the model. Shapes: air square corners, ground diamond corners (vertices GND_K
// half-sizes out), naval a hull (deck / keel half-widths HULL_TOP / HULL_BOT, half-height HULL_H, per half-size).
const MK_GROW = 1.1, MK_PAD = 3, PIP_R = 3.5, GND_K = 1.15;
const HULL_TOP = 1.3, HULL_BOT = 0.85, HULL_H = 0.66;
const HULL_L = Math.hypot(HULL_TOP - HULL_BOT, 2 * HULL_H), HULL_UX = (HULL_TOP - HULL_BOT) / HULL_L, HULL_UY = 2 * HULL_H / HULL_L;
const MK_NEAR = 3000, MK_FAR = 5500;       // m: non-selected hostiles dim a little past these (never hidden)
const MK_ALPHA = [1, 0.8, 0.62];           // alpha per distance band
const TAG_MAX = 4;                         // "TGT" tags on non-selected contacts per frame, nearest first
const MAX_CONTACTS = 128;                  // safety bound on frame.contacts and radar blips (js/main.js fills at most 96)
const LOCK_HZ = 2.5;                       // locked-marker pulse
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
    // target markers: tagged-contact picks, marker extents scratch, selected-target layout and keep-out (_prepTarget)
    this._tagI = new Int16Array(TAG_MAX); this._tagD = new Float32Array(TAG_MAX); this._tagR = new Float32Array(4 * TAG_MAX);
    this._mex = 0; this._mey = 0;
    this._tOn = false; this._tH = 0; this._tEx = 0; this._tEy = 0; this._tLx = 0; this._tLy = 0; this._tLw = 0; this._tAlignR = false; this._tSideT = -1;
    this._kx0 = 0; this._kx1 = -1; this._ky0 = 0; this._ky1 = -1;
    this._inBlocked = null; this._inConn = null; this._inName = null; this._inUsing = null; this._inLocked = null; this._inMaxW = -1;
    this._inLines = []; this._inColor = COL.green; this._inGlyph = false;
    this._ro = null;
    try {
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.container);
      }
    } catch (e) { this._ro = null; }
    this.resize();
  }

  /** Read the container size and (re)allocate the backing store (DPR capped at 2). */
  resize() {
    const el = this.container;
    let w = el.clientWidth, h = el.clientHeight;
    if (!(w > 0) || !(h > 0)) { w = window.innerWidth; h = window.innerHeight; }
    this._setSize(w, h);
  }

  _setSize(w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    if (!(w > 0 && h > 0)) return;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._layout();
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
    // target markers: 2 px strokes (thicker on big screens; 1.5x for the selected target) over a thin dark halo,
    // half-sizes L.mkMin..L.mkMax (18..64 px boxes up to s = 1); the selected target's label lines and health bar
    L.mkLw = clamp(1.8 * s, 2, 3.4); L.mkSel = L.mkLw * 1.5; L.mkCore = Math.max(1, L.mkSel * 0.38);
    L.mkHalo = s < 1.3 ? 1.25 : 1.6; L.mkPip = 0.8;
    L.mkMin = 9 * Math.max(1, s); L.mkMax = 32 * Math.max(1, s);
    L.tLh1 = Math.round(14 * ts); L.tLh2 = Math.round(12 * ts); L.tGap = Math.round(7 * s);
    L.tBarW = Math.round(40 * s); L.tBarH = Math.max(2, Math.round(3 * s)); L.tBarGap = Math.round(3 * s);
    L.tLabelH = L.tLh1 + L.tLh2 + L.tBarGap + L.tBarH;
    const F = (px, wt) => (wt ? wt + ' ' : '') + Math.max(9, Math.round(px)) + 'px ' + FONT;
    L.fTiny = F(9.5 * ts); L.fSmall = F(11 * ts); L.fMed = F(13 * ts);
    L.fBig = F(20 * ts, 500); L.fHdg = F(15 * ts, 600); L.fLock = F(14 * ts, 700); L.fPill = F(11 * ts, 700);
    L.fWarn = F(26 * ts, 700); L.fMsg = F(15 * ts, 500); L.fMsgBig = F(23 * ts, 700); L.fTag = F(9.5 * ts, 700);
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
    L.chSmall = ctx.measureText('0000000000').width / 10;   // monospace advance: squadmate labels are laid out by length
    ctx.font = L.fMed;
    L.chMed = ctx.measureText('0000000000').width / 10;     // (and the target label's name line, and TGT tags)
    ctx.font = L.fTag;
    L.chTag = ctx.measureText('0000000000').width / 10;
    // target label keep-outs: the speed and altitude tapes with their scale numbers and readout boxes
    L.koSpd0 = L.cx - L.sideOff - 8 * s - L.spdBoxW; L.koSpd1 = L.cx - L.sideOff + 13 * s + 4 * L.chSmall;
    L.koAlt0 = L.cx + L.sideOff - 13 * s - 5 * L.chSmall; L.koAlt1 = L.cx + L.sideOff + 8 * s + L.altBoxW;
    L.koTape0 = L.cy - L.tapeHalf - 6 * s; L.koTape1 = L.cy + L.tapeHalf + 6 * s;
    try {
      const g = ctx.createRadialGradient(L.cx, L.cy, m * 0.55, L.cx, L.cy, Math.max(w, h) * 0.78);
      g.addColorStop(0, 'rgba(255,30,20,0)'); g.addColorStop(0.55, 'rgba(255,30,20,0.35)'); g.addColorStop(1, 'rgba(255,30,20,0.85)');
      L.dmgGrad = g;
    } catch (e) { L.dmgGrad = null; }
    this._inMaxW = -1;   // invalidate the wrapped input-status cache
  }

  // ---- primitives ---------------------------------------------------------------------------------------------
  /** Two-pass stroke of the current path: dark halo under, bright line over. */
  _stroke(color, lw) {
    const ctx = this.ctx;
    ctx.lineWidth = lw + 2 * this.L.outline; ctx.strokeStyle = COL.dark; ctx.stroke();
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
    ctx.textAlign = align || 'left'; ctx.textBaseline = baseline || 'middle';
    ctx.lineWidth = this.L.textOutline; ctx.strokeStyle = COL.dark;
    if (maxW > 0) {   // optional: the canvas condenses a wider string to maxW px
      ctx.strokeText(str, x, y, maxW); ctx.fillStyle = color; ctx.fillText(str, x, y, maxW);
      return;
    }
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color; ctx.fillText(str, x, y);
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
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (fw !== this.w || fh !== this.h || dpr !== this.dpr) this._setSize(fw, fh);
    if (!(this.w > 0 && this.h > 0)) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const state = frame.state || 'playing';
    if (state === 'title') return;                       // main shows DOM overlays on the title screen
    this.time = typeof frame.time === 'number' ? frame.time : this.time + (frame.dt || 1 / 60);
    this.alpha = state === 'playing' ? 1 : 0.35;
    ctx.globalAlpha = this.alpha;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.setLineDash(NO_DASH);
    const p = frame.player || DEF_PLAYER;
    const radar = frame.radar || DEF_RADAR;
    this._drawDamage(frame.damageFlash);
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
    this._drawHeadingTape(p, radar);
    this._drawAirspeed(p);
    this._drawAltitude(p);
    const compact = !!frame.compact;     // touch layout: sticks and buttons cover the corners
    if (!compact) this._drawThrottle(p);
    this._drawHealth(p);
    if (compact) this._drawCompactWeapons(p); else this._drawWeapons(p);
    if (!compact) { this._drawRadar(radar, p); this._drawScore(frame); }
    this._prepTarget(frame, compact ? frame.touchRects : null);   // target layout first: squadmate labels avoid it
    this._drawAllies(frame.allies, compact ? frame.touchRects : null);
    this._drawContacts(frame.contacts);
    this._drawTarget(frame.target);
    this._drawWarnings(frame.warnings || DEF_WARN, p);
    this._bossOff = frame.boss ? this.L.bossH : 0;
    this._drawBoss(frame.boss);
    this._drawMessages(frame.messages);
    this._drawRadio(frame.radio);
    this._drawPills(frame);
    if (!compact) this._drawInputStatus(frame.input || DEF_INPUT);
    this._drawHitFlash(frame.hitFlash);
    ctx.globalAlpha = 1;
  }

  // ---- attitude group -----------------------------------------------------------------------------------------
  _drawPitchLadder(p) {
    const ctx = this.ctx, L = this.L, s = L.s;
    const pitch = p.pitch || 0, roll = p.roll || 0;
    const ppd = L.ppd, R = L.clipR + 24 * s, tick = L.tick, gap = L.rungGap;
    ctx.save();
    ctx.beginPath(); ctx.arc(L.cx, L.cy, L.clipR, 0, TAU); ctx.clip();
    ctx.translate(L.cx, L.cy); ctx.rotate(-roll * DEG);
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
    ctx.restore();
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
    ctx.beginPath(); ctx.arc(x0, y0, R, 0, TAU); ctx.fillStyle = COL.panel; ctx.fill(); this._stroke(COL.green, L.lw);
    ctx.beginPath(); ctx.arc(x0, y0, R / 2, 0, TAU); ctx.setLineDash(L.dashRing); this._stroke(COL.greenSoft, L.lwThin);
    ctx.setLineDash(NO_DASH);
    ctx.beginPath(); ctx.moveTo(x0 - R, y0); ctx.lineTo(x0 + R, y0); ctx.moveTo(x0, y0 - R); ctx.lineTo(x0, y0 + R);
    ctx.lineWidth = 1; ctx.strokeStyle = COL.greenFaint; ctx.stroke();
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
    // target keep-out: its marker with the TGT / LOCK cues and its label (_prepTarget)
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
      this._mkStroke(COL.ally, L.mkLw);
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
        if (free && this._onTouch(x0, y0, x1, y1, touch)) free = false;
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
  // Hostile markers: the shape tells the type (air: square corners, ground: diamond corners, naval: a hull, wide deck
  // line over a narrower keel), the size follows the projected model radius (L.mkMin..L.mkMax) and a solid centre pip
  // marks models only a few pixels across. Markers are batched into one path per style and stroked twice, a thin dark
  // halo and then the color, so they read on bright sky, sea glare, haze and terrain.

  /** Marker half-size (px) for a projected model radius of r px. */
  _mkSize(r) { const L = this.L; return clamp((r > 0 ? r : 0) * MK_GROW + MK_PAD, L.mkMin, L.mkMax); }
  /** Half extents of a marker of half-size h, written to this._mex / this._mey. */
  _mkExt(kind, h) {
    if (kind === 'ground') this._mex = this._mey = h * GND_K;
    else if (kind === 'naval') { this._mex = h * HULL_TOP; this._mey = h * HULL_H; }
    else this._mex = this._mey = h;
  }
  /** Append one marker to the current path: its corner brackets, or the closed outline when `closed` (locked). */
  _mkPath(kind, x, y, h, closed) {
    const ctx = this.ctx;
    if (kind === 'ground') {
      const q = h * GND_K;
      if (closed) { ctx.moveTo(x, y - q); ctx.lineTo(x + q, y); ctx.lineTo(x, y + q); ctx.lineTo(x - q, y); ctx.closePath(); return; }
      const a = q * 0.32;                                  // chevron arms run along the diamond's edges
      ctx.moveTo(x - a, y - q + a); ctx.lineTo(x, y - q); ctx.lineTo(x + a, y - q + a);
      ctx.moveTo(x + q - a, y - a); ctx.lineTo(x + q, y); ctx.lineTo(x + q - a, y + a);
      ctx.moveTo(x + a, y + q - a); ctx.lineTo(x, y + q); ctx.lineTo(x - a, y + q - a);
      ctx.moveTo(x - q + a, y + a); ctx.lineTo(x - q, y); ctx.lineTo(x - q + a, y - a);
    } else if (kind === 'naval') {
      const tw = h * HULL_TOP, bw = h * HULL_BOT, hh = h * HULL_H;
      if (closed) { ctx.moveTo(x - tw, y - hh); ctx.lineTo(x + tw, y - hh); ctx.lineTo(x + bw, y + hh); ctx.lineTo(x - bw, y + hh); ctx.closePath(); return; }
      const a = h * 0.42, ax = a * HULL_UX, ay = a * HULL_UY;  // slanted arms run along the hull sides
      ctx.moveTo(x - tw + a, y - hh); ctx.lineTo(x - tw, y - hh); ctx.lineTo(x - tw + ax, y - hh + ay);
      ctx.moveTo(x + tw - a, y - hh); ctx.lineTo(x + tw, y - hh); ctx.lineTo(x + tw - ax, y - hh + ay);
      ctx.moveTo(x - bw + a * 0.8, y + hh); ctx.lineTo(x - bw, y + hh); ctx.lineTo(x - bw - ax, y + hh - ay);
      ctx.moveTo(x + bw - a * 0.8, y + hh); ctx.lineTo(x + bw, y + hh); ctx.lineTo(x + bw + ax, y + hh - ay);
    } else {
      if (closed) { ctx.rect(x - h, y - h, 2 * h, 2 * h); return; }
      const a = h * 0.45;
      ctx.moveTo(x - h, y - h + a); ctx.lineTo(x - h, y - h); ctx.lineTo(x - h + a, y - h);
      ctx.moveTo(x + h - a, y - h); ctx.lineTo(x + h, y - h); ctx.lineTo(x + h, y - h + a);
      ctx.moveTo(x + h, y + h - a); ctx.lineTo(x + h, y + h); ctx.lineTo(x + h - a, y + h);
      ctx.moveTo(x - h + a, y + h); ctx.lineTo(x - h, y + h); ctx.lineTo(x - h, y + h - a);
    }
  }
  /** Append the centre pip: a tiny closed square that the stroke fills in and the halo pass outlines. */
  _pipPath(x, y) { const p = this.L.mkPip; this.ctx.rect(x - p, y - p, 2 * p, 2 * p); }
  /** Two-pass marker stroke of the current path: dark halo under, color over (with square caps the halo wraps the ends). */
  _mkStroke(color, lw) {
    const ctx = this.ctx;
    ctx.lineWidth = lw + 2 * this.L.mkHalo; ctx.strokeStyle = COL.halo; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.stroke();
  }
  /** Fill the current path over the same dark halo (off-screen arrowheads). */
  _mkFill(color) {
    const ctx = this.ctx;
    ctx.lineWidth = 2 * this.L.mkHalo; ctx.strokeStyle = COL.halo; ctx.stroke();
    ctx.fillStyle = color; ctx.fill();
  }
  /** Distance band of a non-selected hostile: 0 near (full strength), 1, 2 far (dimmest). Tagged units stay in band 0. */
  _band(c) { const d = c.distance || 0; return c.tag || d < MK_NEAR ? 0 : d < MK_FAR ? 1 : 2; }
  /** Keeps the TAG_MAX nearest tagged contacts (indices into contacts, nearest first) in this._tagI; returns the count. */
  _tagInsert(nt, i, d) {
    const I = this._tagI, D = this._tagD;
    let k = nt;
    if (nt < TAG_MAX) nt++;
    else if (d >= D[TAG_MAX - 1]) return nt;
    else k = TAG_MAX - 1;
    while (k > 0 && D[k - 1] > d) { I[k] = I[k - 1]; D[k] = D[k - 1]; k--; }
    I[k] = i; D[k] = d;
    return nt;
  }
  /** True if the rect overlaps one of the touch layout's buttons (frame.touchRects; null on other layouts). */
  _onTouch(x0, y0, x1, y1, touch) {
    if (!touch) return false;
    for (let j = 0; j < TOUCH_KEYS.length; j++) {
      const b = touch[TOUCH_KEYS[j]];
      if (b && x1 > b.x - 2 && x0 < b.x + b.w + 2 && y1 > b.y - 2 && y0 < b.y + b.h + 2) return true;
    }
    return false;
  }

  /**
   * Contacts other than the selected target: one path per distance band (far bands dim a little, nothing is hidden),
   * drawn far to near, then friendly contacts (green) if any. Bosses and mission-priority units (contact.tag) get a "TGT"
   * tag, the TAG_MAX nearest of them. Missiles keep their own glyph and range readout.
   */
  _drawContacts(contacts) {
    if (!contacts || !contacts.length) return;
    const ctx = this.ctx, L = this.L, s = L.s, n = Math.min(contacts.length, MAX_CONTACTS);
    let nt = 0;
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    for (let b = MK_ALPHA.length - 1; b >= -1; b--) {    // b = -1: friendly contacts
      ctx.beginPath(); let any = false;
      for (let i = 0; i < n; i++) {
        const c = contacts[i];
        if (!c || !c.onScreen || c.isTarget || c.type === 'missile' || !isFinite(c.x) || !isFinite(c.y)) continue;
        if (b < 0 ? c.hostile !== false : c.hostile === false || this._band(c) !== b) continue;
        this._mkPath(c.kind, c.x, c.y, this._mkSize(c.r), false);
        if (!(c.r >= PIP_R)) this._pipPath(c.x, c.y);
        if (c.tag && b >= 0) nt = this._tagInsert(nt, i, c.distance || 0);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = this.alpha * (b < 0 ? 1 : MK_ALPHA[b]);
      this._mkStroke(b < 0 ? COL.ally : COL.red, L.mkLw);
    }
    ctx.globalAlpha = this.alpha; ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    if (nt > 0) {                                        // tags clear of the selected target's label and of each other
      const R = this._tagR, hw = 1.5 * L.chTag + 1, th = L.tLh2;
      let nr = 0;
      ctx.font = L.fTag;
      for (let k = 0; k < nt; k++) {
        const c = contacts[this._tagI[k]];
        this._mkExt(c.kind, this._mkSize(c.r));
        const ty = c.y - this._mey - 3 * s, x0 = c.x - hw, x1 = c.x + hw, y0 = ty - th;
        if (x1 > this._kx0 && x0 < this._kx1 && ty > this._ky0 && y0 < this._ky1) continue;
        let free = true;
        for (let j = 0; j < nr && free; j++) if (x1 > R[4 * j] && x0 < R[4 * j + 2] && ty > R[4 * j + 1] && y0 < R[4 * j + 3]) free = false;
        if (!free) continue;
        R[4 * nr] = x0; R[4 * nr + 1] = y0; R[4 * nr + 2] = x1; R[4 * nr + 3] = ty; nr++;
        this._text('TGT', c.x, ty, COL.amber, 'center', 'bottom');
      }
    }
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
   * Selected-target layout, once per frame before anything draws: marker size and extents, the label box (name over
   * distance and closure, health bar under) beside the marker: on the right, or on the left when that covers less
   * (_lblScore: touch buttons, the lead ring, the reticle, the tapes, other markers) or the right is off screen; it
   * switches sides at most every 0.4 s so it never flickers. Also the keep-out rect squadmate labels avoid, and the
   * cached distance strings.
   */
  _prepTarget(f, touch) {
    this._tOn = false; this._kx0 = 0; this._kx1 = -1; this._ky0 = 0; this._ky1 = -1;
    const t = f.target;
    if (!t) return;
    const L = this.L, s = L.s;
    const dk = Math.round((t.distance || 0) / 100);
    if (dk !== this._distKey) { this._distKey = dk; this._distStr = fDec1(dk / 10) + ' KM'; }
    const ck = Math.round(t.closure || 0);
    if (ck !== this._clKey) { this._clKey = ck; this._clStr = (ck >= 0 ? '+' : '-') + fInt(Math.abs(ck)) + ' M/S'; }
    const name = t.name || 'TARGET';
    const w = this._tLw = Math.max(name.length * L.chMed, (this._distStr.length + 1 + this._clStr.length) * L.chSmall, L.tBarW);
    if (!(t.onScreen && !t.behind && isFinite(t.x) && isFinite(t.y))) return;
    this._tOn = true;
    const x = t.x, y = t.y, h = this._tH = this._mkSize(t.r) + 2 * s;
    this._mkExt(t.kind, h);
    const ex = this._tEx = this._mex, ey = this._tEy = this._mey, hgt = L.tLabelH, m = 4 * s;
    const top = clamp(y - hgt * 0.5, m, L.h - m - hgt), xr = x + ex + L.tGap, xl = x - ex - L.tGap - w;
    const okR = xr + w <= L.w - m, okL = xl >= m;
    const sR = okR ? this._lblScore(xr, top, xr + w, top + hgt, f, touch) : 1e9;
    const sL = okL ? this._lblScore(xl, top, xl + w, top + hgt, f, touch) : 1e9;
    const left = sL < sR;                                // the right side wins ties
    if (left !== this._tAlignR && (Math.abs(this.time - this._tSideT) > 0.4 || !okR || !okL)) { this._tAlignR = left; this._tSideT = this.time; }
    const lx = clamp(this._tAlignR ? xl : xr, m, L.w - m - w);   // (clamped only when neither side fits)
    this._tLx = lx; this._tLy = top;
    const cue = L.tLh2 + 3 * s;                          // TGT above the marker, LOCK under it
    this._kx0 = Math.min(x - ex, lx) - m; this._kx1 = Math.max(x + ex, lx + w) + m;
    this._ky0 = Math.min(y - ey - cue, top) - m; this._ky1 = Math.max(y + ey + cue, top + hgt) + m;
  }

  /** What a label rect would cover, scored: a touch button 100, the gun cross (boresight) or the aim circle 30 each (the
   *  aiming references outrank everything else in view), the gun lead ring 12, a tape 4, each other on-screen marker 2. */
  _lblScore(x0, y0, x1, y1, f, touch) {
    const L = this.L, s = L.s, ld = f.target.lead, g = f.gunCross, a = f.mouseAim, cs = f.contacts;
    let sc = this._onTouch(x0, y0, x1, y1, touch) ? 100 : 0;
    if (ld && near(x0, y0, x1, y1, ld.x, ld.y, 17 * s)) sc += 12;
    if (g ? g.visible !== false && near(x0, y0, x1, y1, g.x, g.y, 18 * s) : near(x0, y0, x1, y1, L.cx, L.cy, 18 * s)) sc += 30;
    if (a && a.aimVisible !== false && near(x0, y0, x1, y1, a.aimX, a.aimY, 17 * s)) sc += 30;
    if (y1 > L.koTape0 && y0 < L.koTape1 && ((x1 > L.koSpd0 && x0 < L.koSpd1) || (x1 > L.koAlt0 && x0 < L.koAlt1))) sc += 4;
    if (cs) for (let i = 0, n = Math.min(cs.length, MAX_CONTACTS); i < n; i++) {
      const c = cs[i];
      if (c && c.onScreen && !c.isTarget && near(x0, y0, x1, y1, c.x, c.y, L.mkMin)) sc += 2;
    }
    return sc;
  }

  _drawTarget(t) {
    if (!t) return;
    if (this._tOn) this._drawTargetBox(t);
    else this._drawOffscreenPointer(t);
  }

  /**
   * Target label: name (pale) over distance (cyan) and closure, then a thin health bar. `align` places the block of
   * width this._tLw: 0 starts at ax, 1 ends at ax, 0.5 centres on it. Text widths come from the monospace advance.
   */
  _label(t, ax, top, align) {
    const ctx = this.ctx, L = this.L, name = t.name || 'TARGET', w = this._tLw, x0 = ax - align * w;
    ctx.font = L.fMed;
    this._text(name, x0 + (w - name.length * L.chMed) * align, top + L.tLh1 * 0.5, COL.pale, 'left', 'middle');
    ctx.font = L.fSmall;
    const ds = this._distStr, cs = this._clStr, ch = L.chSmall;
    const lx = x0 + (w - (ds.length + 1 + cs.length) * ch) * align, ly = top + L.tLh1 + L.tLh2 * 0.5;
    this._text(ds, lx, ly, COL.green, 'left', 'middle');
    this._text(cs, lx + (ds.length + 1) * ch, ly, (t.closure || 0) >= 0 ? COL.greenSoft : COL.amber, 'left', 'middle');
    const hp = clamp(t.health == null ? 1 : t.health, 0, 1), bw = L.tBarW, bh = L.tBarH;
    const bx = x0 + (w - bw) * align, by = top + L.tLh1 + L.tLh2 + L.tBarGap;
    ctx.fillStyle = COL.halo; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = hp > 0.5 ? COL.green : hp > 0.25 ? COL.amber : COL.red; ctx.fillRect(bx, by, bw * hp, bh);
  }

  /**
   * Selected target on screen: its type marker, thicker, red with a hot inner line. In the seeker cone the brackets
   * close in from 1.5x as the lock builds; once locked the shape closes, solid red, pulsing gently (LOCK_HZ), with LOCK
   * under it. TGT above it for bosses and mission-priority units, the label beside it, the gun lead ring.
   */
  _drawTargetBox(t) {
    const ctx = this.ctx, L = this.L, s = L.s, x = t.x, y = t.y;
    const kind = t.kind, h = this._tH, ex = this._tEx, ey = this._tEy;
    const locked = !!t.locked, lock = clamp(t.lock || 0, 0, 1);
    const pulse = locked ? 0.5 + 0.5 * Math.sin(this.time * TAU * LOCK_HZ) : 0;
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    if (locked) this._mkPath(kind, x, y, h * (1 + 0.05 * pulse), true);
    else {
      const e = t.inSeekerCone ? 1 - (1 - lock) * (1 - lock) : 1;
      this._mkPath(kind, x, y, h * (1 + 0.5 * (1 - e)), false);
    }
    if (!(t.r >= PIP_R)) this._pipPath(x, y);
    this._mkStroke(COL.red, L.mkSel);
    ctx.globalAlpha = this.alpha * (locked ? 0.2 + 0.8 * pulse : 0.9);
    ctx.lineWidth = L.mkCore; ctx.strokeStyle = COL.core; ctx.stroke();
    ctx.globalAlpha = this.alpha;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    if (t.tag) { ctx.font = L.fTag; this._text('TGT', x, y - ey - 3 * s, COL.amber, 'center', 'bottom'); }
    if (locked) {
      ctx.font = L.fPill; ctx.globalAlpha = this.alpha * (0.8 + 0.2 * pulse);
      this._text('LOCK', x, y + ey + 3 * s, COL.red, 'center', 'top');
      ctx.globalAlpha = this.alpha;
    }
    this._label(t, this._tAlignR ? this._tLx + this._tLw : this._tLx, this._tLy, this._tAlignR ? 1 : 0);
    const ld = t.lead;                                   // gun lead: put the gun cross on this ring to hit
    if (ld && isFinite(ld.x) && isFinite(ld.y)) {
      const hot = !!t.leadHot, c = hot ? COL.red : COL.white, r = 10 * s, tk = 5 * s, e0 = Math.max(ex, ey);
      // tether from the marker edge to the ring so it's obvious which target it leads
      const dx = ld.x - x, dy = ld.y - y, dl = Math.hypot(dx, dy);
      if (dl > e0 * 1.3 + r) {
        const ux = dx / dl, uy = dy / dl, e = e0 * 1.1;
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

  /**
   * Off-screen target: a notched arrowhead on an ellipse just inside the screen edge, pointing at it (two, in amber, when
   * it is behind), and inward of it the same label as on screen, with REAR / LOCK / TGT cues above the name.
   */
  _drawOffscreenPointer(t) {
    const ctx = this.ctx, L = this.L, s = L.s, cx = L.cx, cy = L.cy;
    let dx = t.x - cx, dy = t.y - cy;
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) { dx = 0; dy = 1; }
    const phi = Math.atan2(dy, dx), c = Math.cos(phi), sn = Math.sin(phi);
    const a = Math.max(40 * s, L.w / 2 - 56 * s), b = Math.max(40 * s, L.h / 2 - 84 * s);
    const rr = 1 / Math.sqrt((c * c) / (a * a) + (sn * sn) / (b * b));
    const px = cx + rr * c, py = cy + rr * sn;
    const locked = !!t.locked, behind = !!t.behind, col = behind ? COL.amber : COL.red;
    const len = 19 * s, half = 10 * s, notch = 6 * s, step = len - notch + 4 * s, nA = behind ? 2 : 1;
    ctx.lineJoin = 'miter'; ctx.beginPath();
    for (let k = 0; k < nA; k++) {
      const tx = px - k * step * c, ty = py - k * step * sn, bx = tx - len * c, by = ty - len * sn;
      ctx.moveTo(tx, ty); ctx.lineTo(bx - half * sn, by + half * c);
      ctx.lineTo(tx - (len - notch) * c, ty - (len - notch) * sn); ctx.lineTo(bx + half * sn, by - half * c); ctx.closePath();
    }
    if (locked) ctx.globalAlpha = this.alpha * (0.7 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * TAU * LOCK_HZ)));
    this._mkFill(col); ctx.lineJoin = 'round'; ctx.globalAlpha = this.alpha;
    // label inward of the arrow, on the side facing the screen centre
    const back = len + (nA - 1) * step + 8 * s, ax = px - back * c, ay = py - back * sn;
    const align = c > 0.38 ? 1 : c < -0.38 ? 0 : 0.5, ta = align === 1 ? 'right' : align === 0 ? 'left' : 'center';
    const cue = L.tLh2, hgt = ((behind ? 1 : 0) + (locked ? 1 : 0) + (t.tag ? 1 : 0)) * cue + L.tLabelH, m = 4 * s, w = this._tLw;
    let top = clamp(sn > 0.38 ? ay - hgt : sn < -0.38 ? ay : ay - hgt * 0.5, m, L.h - m - hgt);
    const x0 = clamp(ax - align * w, m, L.w - m - w), tx = x0 + align * w;
    ctx.font = L.fPill;
    if (behind) { this._text('REAR', tx, top + cue * 0.5, COL.amber, ta, 'middle'); top += cue; }
    if (locked) { this._text('LOCK', tx, top + cue * 0.5, COL.red, ta, 'middle'); top += cue; }
    if (t.tag) { this._text('TGT', tx, top + cue * 0.5, COL.amber, ta, 'middle'); top += cue; }
    this._label(t, tx, top, align);
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

  /** Radio subtitles: speaker label (amber) on its own line above the spoken text (white, dark outline). */
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
    this._text(r.speaker || 'RADIO', cx, y - Math.round(lh * 1.05), COL.amber, 'center', 'middle');
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
      text = 'GAMEPAD BLOCKED BY THIS FRAME — open the artifact in its own tab or play locally'; color = COL.amber;
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
    if (!(v > 0) || !L.dmgGrad) return;
    const ctx = this.ctx;
    ctx.globalAlpha = this.alpha * clamp(v, 0, 1);
    ctx.fillStyle = L.dmgGrad; ctx.fillRect(0, 0, L.w, L.h);
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
