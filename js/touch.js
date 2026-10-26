// js/touch.js — PROJECT WINGNUT on-screen touch controls for phones and tablets.
//
// A DOM overlay laid out like a gamepad held in landscape, matching the controller mapping (mode 2):
//   left stick   ↑ boost / ↓ airbrake (spring-loaded, center = cruise) · ↔ rudder       → lx, ly  (ly: up = +1)
//   right stick  ↕ pitch (pull ↓ toward you = nose up) · ↔ roll                          → rx, ry  (ry: down = +1)
//   top-left     LT "MSL" missile · LB "LOOK" look back (hold)
//   top-right    RB "TGT" tap = next target, hold = padlock · RT "GUN" cannon (hold, big)
//   FLR (= L3 flares) above the left stick · AOA (= R3 AOA limiter off, hold) above the right stick · pause (= Start)
//   in the top band, just right of the HUD heading tape
//
// Large screens (tablets, landscape): the shoulder buttons move off the top corners into a thumb-reach cluster around
// each stick (left: LOOK, MSL, FLR · right: TGT, GUN, AOA), sized and placed in estimated physical units (cm) so everything
// sits within ~9 cm of the bottom corners where the hands hold the device. Phones keep the top-corner layout.
//
// input.js reads `input.touch = instance` every frame ({ active, lx, ly, rx, ry, buttons, used }) and owns the
// expo/shape: sticks report raw -1..1 (circular gate, small radial deadzone rescaled so there is no step).
//
// Fixed sticks: each base ring stays where the layout puts it. It is re-anchored on resize / rotation / fullscreen
// changes only, never by a touch. Deflection is measured from that fixed center: (finger - center) / travel, clamped
// to length 1, so a thumb that slides out of the ring keeps full deflection. The knob follows the finger 1:1, even
// outside the ring, and springs back to center on release.
//
// Zero per-frame work: the DOM is only touched inside pointer / resize handlers (knob transforms, class toggles);
// the knob spring-back is a CSS transition. Pure DOM: no Three.js import.
//
// Multi-touch: Pointer Events with per-control pointerId capture. Moves/ups are routed by pointerId from window
// listeners, so a finger keeps driving its control wherever it wanders. While the flight controls are shown, a
// full-screen "sink" swallows stray touches (preventDefault on pointerdown) so the browser never synthesizes mouse
// events from them (input.js would read those as mouse-aim input). Hidden or inactive = nothing has pointer events,
// so the page's menus are never blocked.

const TRAVEL = 60;             // px from the fixed base center to full deflection (just inside the ring)
const DEADZONE = 0.08;         // radial deadzone as a fraction of TRAVEL (output rescaled to start at 0 past it)
const RING_R = 66;             // stick base ring radius (px); keep in sync with .wn-stk in the CSS below
const ZONE_W = 0.4;            // stick zones: the left / right 40% of the width ...
const ZONE_TOP = 0.3;          // ... below the top 30% of the height
const MIN_PRESS_MS = 90;       // a quick tap is reported held at least this long so a slow frame can't miss it
const TAP_MS = 350;            // menu tap (flight controls hidden): max duration ...
const TAP_SLOP = 16;           // ... and max travel (px) for a confirm / back pulse
const PULSE_MS = 120;          // confirm / back pulse length
const LIT = 0.4;               // deflection that lights the ring label in that direction
const EDGE_M = 8, GAP = 8;     // keep in sync with --wn-m / --wn-g
const PAUSE = 46;              // pause button size (px), = --wn-pz; its ::before pads the hit area to 64
// Large-screen cluster layout (tablets). A landscape container at least this big is a tablet, not a phone (phones top
// out near 430 CSS px tall in landscape):
const CLUSTER_MIN_W = 900, CLUSTER_MIN_H = 540;
// CSS px per cm on a touch screen. 96 CSS px/in is the web's reference, set for a desktop monitor at arm's length;
// handheld touch screens map more CSS px to the inch (iPads 132, 10" Android tablets 130-150, phones 150+), and neither
// devicePixelRatio nor the `resolution` media feature says anything about physical size (they are device px per CSS px).
// 132 / in (the iPad density) is the estimate: on denser screens the cluster only comes out a little tighter.
const PX_PER_CM = 132 / 2.54;
// Cluster geometry in cm, per side, from the bottom outer corner of the safe area (mirrored on the right): the stick base
// center, then each button's center as [angle from the inward horizontal (deg, counter-clockwise = up), distance from
// the stick center (cm)] and its size [w, h] (cm). Every button center stays within ~9 cm of the corner.
const CL_STICK = [4.2, 3.6];
const CL = {
  lb: { at: [8, 3.1], size: [1.5, 1.3] },     // LOOK: inboard, level with the stick
  lt: { at: [48, 3.2], size: [2.0, 1.5] },    // MSL: up and inboard
  flr: { at: [95, 2.9], size: [1.4, 1.4] },   // FLR: straight above the stick
  rb: { at: [8, 3.1], size: [1.5, 1.3] },     // TGT
  rt: { at: [48, 3.4], size: [2.4, 1.7] },    // GUN (the big one)
  aoa: { at: [95, 2.9], size: [1.4, 1.4] },   // AOA: straight above the stick (mirrors FLR)
};
const STYLE_ID = 'wn-touch-style';
const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],' +
  '[contenteditable="true"],[contenteditable=""],[data-touch-ignore]';

const CSS = `
.wn-touch{position:absolute;inset:0;z-index:4;overflow:hidden;contain:strict;pointer-events:none;visibility:hidden;
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
  --wn-c:#9CEBFF;--wn-c7:rgba(156,235,255,.72);--wn-c4:rgba(156,235,255,.42);--wn-hi:#EAFBFF;
  --wn-fd:var(--display,"Chakra Petch","Segoe UI",system-ui,sans-serif);
  --wn-fm:var(--mono,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace);
  --wn-sl:env(safe-area-inset-left,0px);--wn-sr:env(safe-area-inset-right,0px);--wn-st:env(safe-area-inset-top,0px);
  --wn-m:8px;--wn-g:8px;--wn-bph:64px;--wn-pz:46px;   /* the rest are set in px by _layout() on resize: */
  --wn-ltw:101px;--wn-lth:70px;--wn-rtw:118px;--wn-rth:78px;--wn-bpw:72px;--rest-lx:135px;--rest-rx:665px;--flr-y:133px;--pause-x:549px;
  color:var(--wn-hi);font-family:var(--wn-fd)}
.wn-touch.wn-on{visibility:visible}
.wn-touch *{box-sizing:border-box}
.wn-sink,.wn-stk,.wn-b,.wn-rot{display:none}
.wn-flight .wn-sink,.wn-flight .wn-stk{display:block}
.wn-flight .wn-b,.wn-paused .wn-pause,.wn-portrait .wn-rot{display:flex}
.wn-sink{position:absolute;inset:0;pointer-events:auto;touch-action:none}
.wn-probe{position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;
  padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)}
/* buttons: HUD-cyan outline on a dark translucent fill (no backdrop-filter: it would re-blur the WebGL frame every frame) */
.wn-b{position:absolute;top:calc(var(--wn-st) + var(--wn-m));flex-direction:column;align-items:center;justify-content:center;gap:4px;
  pointer-events:auto;touch-action:none;border:1.5px solid var(--wn-c7);border-radius:12px;color:var(--wn-hi);
  background:linear-gradient(180deg,rgba(156,235,255,.14),rgba(3,12,20,.44) 58%,rgba(3,12,20,.52));
  box-shadow:inset 0 1px 0 rgba(234,251,255,.16),0 2px 12px rgba(0,0,0,.3);text-shadow:0 1px 2px rgba(0,0,0,.85);
  transition:transform 70ms ease-out}
.wn-b b{display:block;font:700 15px/1 var(--wn-fd);letter-spacing:.14em;margin-right:-.14em}
.wn-b i{display:block;font:700 9px/1 var(--wn-fm);font-style:normal;letter-spacing:.18em;margin-right:-.18em;color:var(--wn-c7)}
.wn-b.wn-on{transform:scale(.95);border-color:var(--wn-hi);background:rgba(156,235,255,.42);
  box-shadow:0 0 18px rgba(156,235,255,.55),inset 0 0 16px rgba(234,251,255,.32)}
.wn-b.wn-on i{color:var(--wn-hi)}
.wn-lt{left:calc(var(--wn-sl) + var(--wn-m));width:var(--wn-ltw);height:var(--wn-lth);border-radius:26px 10px 10px 14px}
.wn-lb{left:calc(var(--wn-sl) + var(--wn-m) + var(--wn-ltw) + var(--wn-g));width:var(--wn-bpw);height:var(--wn-bph)}
.wn-rt{right:calc(var(--wn-sr) + var(--wn-m));width:var(--wn-rtw);height:var(--wn-rth);border-radius:10px 26px 14px 10px}
.wn-rt b{font-size:20px}
.wn-rb{right:calc(var(--wn-sr) + var(--wn-m) + var(--wn-rtw) + var(--wn-g));width:var(--wn-bpw);height:var(--wn-bph)}
.wn-flr{top:var(--flr-y);left:calc(var(--rest-lx) - 34px);width:68px;height:68px;border-radius:50%}
.wn-aoa{top:var(--flr-y);left:calc(var(--rest-rx) - 34px);width:68px;height:68px;border-radius:50%}
/* large screens: thumb-reach clusters around the sticks (positions and sizes in px from _layout) */
.wn-cl .wn-lt{left:var(--lt-x);top:var(--lt-y);border-radius:14px}
.wn-cl .wn-lb{left:var(--lb-x);top:var(--lb-y)}
.wn-cl .wn-rb{left:var(--rb-x);right:auto;top:var(--rb-y)}
.wn-cl .wn-rt{left:var(--rt-x);right:auto;top:var(--rt-y);border-radius:14px}
.wn-cl .wn-flr{left:var(--fl-x);top:var(--fl-y);width:var(--wn-flz);height:var(--wn-flz)}
.wn-cl .wn-aoa{left:var(--aoa-x);top:var(--aoa-y);width:var(--wn-flz);height:var(--wn-flz)}
/* pause: in the top band beside the HUD heading tape (x computed in _layout) */
.wn-pause{top:calc(var(--wn-st) + var(--wn-m) + 2px);left:var(--pause-x);width:var(--wn-pz);height:var(--wn-pz);border-radius:23px;
  flex-direction:row;gap:7px}
.wn-pause::before{content:"";position:absolute;inset:-9px}
.wn-pause svg{width:18px;height:18px;flex:none;fill:var(--wn-hi)}
.wn-pause b,.wn-pause .wn-iy{display:none}
.wn-paused .wn-pause{width:auto;padding:0 16px 0 13px}
.wn-paused .wn-pause .wn-ip{display:none}
.wn-paused .wn-pause .wn-iy,.wn-paused .wn-pause b{display:block}
.wn-paused .wn-pause b{font-size:13px}
/* portrait fallback (the rotate hint asks for landscape): bumpers stack under the triggers, pause centers */
.wn-portrait .wn-lb{left:calc(var(--wn-sl) + var(--wn-m));top:calc(var(--wn-st) + var(--wn-m) + var(--wn-lth) + var(--wn-g))}
.wn-portrait .wn-rb{right:calc(var(--wn-sr) + var(--wn-m));top:calc(var(--wn-st) + var(--wn-m) + var(--wn-rth) + var(--wn-g))}
.wn-portrait .wn-pause{left:auto;right:calc(var(--wn-sr) + var(--wn-m) + (var(--wn-bpw) - var(--wn-pz))/2);
  top:calc(var(--wn-st) + var(--wn-m) + var(--wn-rth) + var(--wn-g) + var(--wn-bph) + 10px)}
.wn-portrait.wn-paused .wn-pause{left:0;right:0;margin-inline:auto;width:max-content;top:calc(var(--wn-st) + var(--wn-m) + 2px)}
.wn-rot{position:absolute;z-index:3;left:0;right:0;margin-inline:auto;width:max-content;top:calc(var(--wn-st) + 10px);align-items:center;gap:8px;
  padding:7px 13px 7px 10px;border:1px solid var(--wn-c4);border-radius:999px;background:rgba(3,10,18,.78);
  font:700 11px/1 var(--wn-fm);letter-spacing:.1em;text-transform:uppercase;color:var(--wn-hi);white-space:nowrap;pointer-events:none}
.wn-flight .wn-rot{top:calc(var(--wn-st) + var(--wn-m) + var(--wn-rth) + var(--wn-g) + var(--wn-bph) + 16px)}
.wn-paused .wn-rot{top:calc(var(--wn-st) + var(--wn-m) + var(--wn-pz) + 14px)}
.wn-rot svg{width:18px;height:18px;flex:none;fill:none;stroke:var(--wn-c);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
/* fixed sticks: the element sits at its transform point (the base center, set by _layout only); visuals only, the sink
   takes the touches. The knob is not clipped to the ring: it follows the finger anywhere on screen. */
.wn-stk{position:absolute;left:0;top:0;z-index:2;width:132px;height:132px;margin:-66px 0 0 -66px;pointer-events:none;opacity:.45;
  will-change:transform;transition:opacity .32s ease}
.wn-stk.wn-act{opacity:1;transition:none}
.wn-ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--wn-c7);
  background:radial-gradient(closest-side,rgba(3,12,20,.1),rgba(3,12,20,.3) 72%,rgba(156,235,255,.14) 100%);
  box-shadow:0 0 0 1px rgba(0,0,0,.22),inset 0 0 22px rgba(156,235,255,.1)}
.wn-ring::before{content:"";position:absolute;inset:22px;border-radius:50%;border:1px dashed rgba(156,235,255,.24)}
.wn-ring span{position:absolute;font:700 9px/1 var(--wn-fm);letter-spacing:.16em;color:var(--wn-c7);text-shadow:0 1px 2px rgba(0,0,0,.85)}
.wn-ring .wn-ln,.wn-ring .wn-ls{left:0;right:0;text-align:center;text-indent:.16em}
.wn-ring .wn-ln{top:9px}
.wn-ring .wn-ls{bottom:9px}
.wn-ring .wn-lw,.wn-ring .wn-le{top:50%;margin-top:-8px;font:700 16px/16px var(--wn-fd);letter-spacing:0}
.wn-ring .wn-lw{left:8px}
.wn-ring .wn-le{right:8px}
.wn-ring span.wn-lit{color:var(--wn-hi);text-shadow:0 0 8px rgba(156,235,255,.9),0 1px 2px rgba(0,0,0,.85)}
.wn-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;will-change:transform;
  border:1.5px solid var(--wn-c);background:radial-gradient(circle at 50% 36%,rgba(234,251,255,.36),rgba(156,235,255,.15) 52%,rgba(3,12,20,.55));
  box-shadow:0 0 0 5px rgba(156,235,255,.08),0 3px 10px rgba(0,0,0,.45);transition:transform .22s cubic-bezier(.34,1.56,.64,1)}
.wn-act .wn-knob{transition:none;border-color:var(--wn-hi);box-shadow:0 0 0 6px rgba(156,235,255,.16),0 0 18px rgba(156,235,255,.5)}
@media (prefers-reduced-motion:reduce){.wn-stk,.wn-knob,.wn-b{transition:none}}
`;

const SVG_PAUSE = '<svg class="wn-ip" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';
const SVG_PLAY = '<svg class="wn-iy" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>';
const SVG_ROT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="10" width="19" height="11" rx="2"/>' +
  '<path d="M6.5 7.5a8 8 0 0 1 11-2.6"/><path d="M17.6 2.2l.3 3.1-3.1.4"/></svg>';
const stickHTML = (cls, n, s) => '<div class="wn-stk ' + cls + '"><div class="wn-ring"><span class="wn-ln">' + n +
  '</span><span class="wn-ls">' + s + '</span><span class="wn-lw">‹</span><span class="wn-le">›</span></div><div class="wn-knob"></div></div>';
const HTML =
  '<div class="wn-sink"></div>' +
  '<div class="wn-b wn-lt" data-b="missile"><b>MSL</b><i>LT</i></div>' +
  '<div class="wn-b wn-lb" data-b="lookBack"><b>LOOK</b><i>LB</i></div>' +
  '<div class="wn-b wn-rb" data-b="target"><b>TGT</b><i>RB</i></div>' +
  '<div class="wn-b wn-rt" data-b="gun"><b>GUN</b><i>RT</i></div>' +
  '<div class="wn-b wn-flr" data-b="flares"><b>FLR</b><i>L3</i></div>' +
  '<div class="wn-b wn-aoa" data-b="aoaOff"><b>AOA</b><i>R3</i></div>' +
  '<div class="wn-b wn-pause" data-b="pause">' + SVG_PAUSE + SVG_PLAY + '<b>RESUME</b></div>' +
  stickHTML('wn-stl', 'BOOST', 'BRAKE') + stickHTML('wn-str', 'DIVE', 'CLIMB') +
  '<div class="wn-rot">' + SVG_ROT + '<span>Rotate to landscape</span></div>' +
  '<div class="wn-probe"></div>';

let styleRefs = 0;   // one <style> per document, shared by instances, removed with the last one
function ensureStyle(doc) {
  if (!doc.getElementById(STYLE_ID)) {
    const el = doc.createElement('style');
    el.id = STYLE_ID; el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }
  styleRefs++;
}
function releaseStyle(doc) {
  styleRefs = Math.max(0, styleRefs - 1);
  if (styleRefs === 0) { const el = doc.getElementById(STYLE_ID); if (el && el.parentNode) el.parentNode.removeChild(el); }
}
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const px = (v) => (Math.round(v * 10) / 10) + 'px';

export class TouchControls {
  /**
   * @param {HTMLElement} container  the #game element (positioned); the overlay is appended to it, above #ui
   * @param {object} [opts]
   *   onAnyTouch(event)      called on every touch/pen pointerdown anywhere on the page (the first one also turns
   *                          `active` on in 'auto' mode)
   *   onActiveChange(active) called when `active` flips
   *   onInput(touch)         called synchronously whenever the reported state changes (same moments `used` is set)
   *   deadzone, travel       tuning: radial deadzone (0..1 of travel), px from the base center to full deflection
   */
  constructor(container, { onAnyTouch = null, onActiveChange = null, onInput = null, deadzone = DEADZONE, travel = TRAVEL } = {}) {
    const doc = (container && container.ownerDocument) || document;
    this._doc = doc;
    this._win = doc.defaultView || window;
    this.container = container || doc.body;

    // ---- public state read by input.js every frame --------------------------------------------------------------
    this.active = false;                 // touch controls in use (coarse pointer / touch seen / forced on)
    this.lx = 0; this.ly = 0;            // left stick: rudder, boost(+)/airbrake(-)
    this.rx = 0; this.ry = 0;            // right stick: roll, pull(+) = nose up
    this.buttons = { gun: false, missile: false, target: false, lookBack: false, flares: false, aoaOff: false, pause: false, confirm: false, back: false };
    this.used = false;                   // set on every change; input.js clears it each frame
    // ---- extras ---------------------------------------------------------------------------------------------------
    this.mode = 'auto';                  // 'auto' | 'on' | 'off'
    this.visible = false;                // flight controls shown (setVisible(true))
    this.paused = false;                 // setVisible('paused'): only the resume button is shown
    this.supported = typeof this._win.PointerEvent === 'function';
    this.lastTouchTime = 0;              // performance.now() of the last touch-down anywhere on the page
    this.pitchInverted = false;
    this.cluster = false;                // large-screen layout: buttons in thumb-reach clusters around the sticks (_layout)

    this._onAnyTouch = typeof onAnyTouch === 'function' ? onAnyTouch : null;
    this._onActiveChange = typeof onActiveChange === 'function' ? onActiveChange : null;
    this._onInput = typeof onInput === 'function' ? onInput : null;
    this._dz = clamp(Number(deadzone) || 0, 0, 0.5);
    this._travel = Math.max(20, Number(travel) || TRAVEL);
    this._zoneW = ZONE_W; this._zoneTop = ZONE_TOP;
    this._vis = 'hidden';                // 'hidden' | 'flight' | 'paused'
    this._coarse = false; this._sawTouch = false; this._mouseSup = false; this._padSup = false;
    this._owners = new Map();            // pointerId -> { el, name, stick }
    this._cnt = {}; this._t0 = {}; this._relT = {}; this._pulseT = {};
    this._tap = null;                    // menu tap tracker (flight controls hidden)
    this._safe = { l: 0, r: 0, t: 0, b: 0 };
    this._disposed = false;

    // ---- DOM ------------------------------------------------------------------------------------------------------
    ensureStyle(doc);
    const root = this.root = doc.createElement('div');
    root.className = 'wn-touch';
    root.setAttribute('aria-hidden', 'true');   // redundant visual controls; keyboard / gamepad remain the accessible path
    root.innerHTML = HTML;
    this.container.appendChild(root);
    this._sink = root.querySelector('.wn-sink');
    this._probe = root.querySelector('.wn-probe');
    const q = (s) => root.querySelector(s);
    this._els = { lt: q('.wn-lt'), lb: q('.wn-lb'), rb: q('.wn-rb'), rt: q('.wn-rt'), flr: q('.wn-flr'), aoa: q('.wn-aoa'), pause: q('.wn-pause') };
    const mk = (side, cls) => {
      const el = q(cls);
      // bx, by: the fixed base center (container px, written by _layout only) · fx, fy: the holding finger (client px)
      // rl, rt: the container's client origin while held
      return { side, el, knob: el.querySelector('.wn-knob'), lab: Array.prototype.slice.call(el.querySelectorAll('.wn-ring span')),
        id: null, bx: 0, by: 0, fx: 0, fy: 0, rl: 0, rt: 0, mask: 0 };
    };
    this._sticks = { l: mk('l', '.wn-stl'), r: mk('r', '.wn-str') };
    this._placeKnob(this._sticks.l, 0, 0); this._placeKnob(this._sticks.r, 0, 0);

    // ---- listeners (all event-driven; nothing runs per frame) ------------------------------------------------------
    const win = this._win;
    this._h = {
      rootDown: (e) => this._onRootDown(e),
      rootTouch: (e) => { if (e.cancelable) e.preventDefault(); },   // iOS: no double-tap zoom / callout / click synthesis
      ctx: (e) => { if (e.cancelable) e.preventDefault(); },
      winDown: (e) => this._onWinDown(e),
      winMove: (e) => this._onWinMove(e),
      winUp: (e) => this._onWinUp(e, false),
      winCancel: (e) => this._onWinUp(e, true),
      winTouch: (e) => this._onWinTouchStart(e),
      release: () => this._releaseAll(),
      vis: () => { if (doc.visibilityState === 'hidden') this._releaseAll(); },
      pad: () => { if (this.mode === 'auto' && this.active) { this._padSup = true; this._refreshActive(); } },
      mq: (e) => { this._coarse = !!(e && e.matches); this._refreshActive(); },
      layout: () => this._layout(),
    };
    const H = this._h;
    root.addEventListener('pointerdown', H.rootDown, { passive: false });
    root.addEventListener('touchstart', H.rootTouch, { passive: false });
    root.addEventListener('contextmenu', H.ctx);
    if (this.supported) {
      win.addEventListener('pointerdown', H.winDown, { capture: true, passive: true });
      win.addEventListener('pointermove', H.winMove, { capture: true, passive: true });
      win.addEventListener('pointerup', H.winUp, { capture: true, passive: true });
      win.addEventListener('pointercancel', H.winCancel, { capture: true, passive: true });
    } else {
      win.addEventListener('touchstart', H.winTouch, { capture: true, passive: true });
    }
    win.addEventListener('blur', H.release);
    win.addEventListener('gamepadconnected', H.pad);
    doc.addEventListener('visibilitychange', H.vis);
    this._mq = null;
    try {
      if (win.matchMedia) {
        this._mq = win.matchMedia('(pointer: coarse)');
        this._coarse = !!this._mq.matches;
        if (this._mq.addEventListener) this._mq.addEventListener('change', H.mq); else if (this._mq.addListener) this._mq.addListener(H.mq);
      }
    } catch (e) { this._mq = null; }
    this._ro = null;
    try {
      if (typeof win.ResizeObserver === 'function') { this._ro = new win.ResizeObserver(H.layout); this._ro.observe(root); }
    } catch (e) { this._ro = null; }
    win.addEventListener('resize', H.layout);          // safe-area insets change on rotation even when RO is missing
    win.addEventListener('orientationchange', H.layout);
    doc.addEventListener('fullscreenchange', H.layout);
    doc.addEventListener('webkitfullscreenchange', H.layout);

    this._layout();
    this._refreshActive();
    this._applyClasses();
  }

  // ===============================================================================================================
  // Public API
  // ===============================================================================================================
  /** true: flight controls · false: hidden (menus) · 'paused': only the pause button, shown as RESUME. Idempotent. */
  setVisible(on) {
    const v = (on === 'paused' || on === 'pause') ? 'paused' : (on ? 'flight' : 'hidden');
    if (v === this._vis || this._disposed) return;
    this._vis = v;
    this.visible = v === 'flight'; this.paused = v === 'paused';
    this._releaseAll();
    this._applyClasses();
  }

  /** 'auto' (detect) | 'on' (force) | 'off' (never). */
  setMode(mode) {
    const m = (mode === 'on' || mode === 'off') ? mode : 'auto';
    if (m === this.mode || this._disposed) return;
    this.mode = m;
    this._mouseSup = false; this._padSup = false;
    this._refreshActive();
  }

  /** Swap the right stick's DIVE / CLIMB labels to match input.invertPitch. */
  setPitchInverted(v) {
    this.pitchInverted = !!v;
    const lab = this._sticks.r.lab;
    lab[0].textContent = v ? 'CLIMB' : 'DIVE';
    lab[1].textContent = v ? 'DIVE' : 'CLIMB';
  }

  /** Control rectangles in container px ({x,y,w,h}, null when hidden) + the stick zones, e.g. for HUD avoidance.
   *  Reads layout: call on resize / visibility changes, not per frame. */
  getRects() {
    const out = {};
    if (!this.root) return out;
    const r = this.root.getBoundingClientRect();
    for (const k in this._els) {
      const b = this._els[k].getBoundingClientRect();
      out[k] = b.width > 0 ? { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height } : null;
    }
    const zy = r.height * this._zoneTop, zw = r.width * this._zoneW, zh = r.height - zy;
    out.leftZone = { x: 0, y: zy, w: zw, h: zh };
    out.rightZone = { x: r.width - zw, y: zy, w: zw, h: zh };
    return out;
  }

  /** Optional helper (call from a user gesture, e.g. the title tap): fullscreen + landscape lock where the browser
   *  allows it (Android Chrome); silently does nothing elsewhere (iPhone Safari). Resolves to "is fullscreen". */
  async requestFullscreenLandscape() {
    const doc = this._doc, el = doc.documentElement;
    try {
      if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch (e) { /* refused or unsupported */ }
    try {
      const o = this._win.screen && this._win.screen.orientation;
      if (o && typeof o.lock === 'function') await o.lock('landscape');
    } catch (e) { /* lock needs fullscreen / not supported */ }
    return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  }

  dispose() {
    if (this._disposed) return;
    this._releaseAll();
    this._disposed = true;
    for (const k in this._pulseT) if (this._pulseT[k]) clearTimeout(this._pulseT[k]);
    const H = this._h, win = this._win, doc = this._doc, root = this.root;
    root.removeEventListener('pointerdown', H.rootDown, { passive: false });
    root.removeEventListener('touchstart', H.rootTouch, { passive: false });
    root.removeEventListener('contextmenu', H.ctx);
    win.removeEventListener('pointerdown', H.winDown, { capture: true });
    win.removeEventListener('pointermove', H.winMove, { capture: true });
    win.removeEventListener('pointerup', H.winUp, { capture: true });
    win.removeEventListener('pointercancel', H.winCancel, { capture: true });
    win.removeEventListener('touchstart', H.winTouch, { capture: true });
    win.removeEventListener('blur', H.release);
    win.removeEventListener('gamepadconnected', H.pad);
    win.removeEventListener('resize', H.layout);
    win.removeEventListener('orientationchange', H.layout);
    doc.removeEventListener('fullscreenchange', H.layout);
    doc.removeEventListener('webkitfullscreenchange', H.layout);
    doc.removeEventListener('visibilitychange', H.vis);
    try { if (this._mq) { if (this._mq.removeEventListener) this._mq.removeEventListener('change', H.mq); else if (this._mq.removeListener) this._mq.removeListener(H.mq); } } catch (e) { /* ignore */ }
    try { if (this._ro) this._ro.disconnect(); } catch (e) { /* ignore */ }
    this._ro = null; this._mq = null;
    if (root.parentNode) root.parentNode.removeChild(root);
    const cst = this.container.style;
    this.container.classList.remove('wn-touch-ui'); cst.removeProperty('--wn-ov-top'); cst.removeProperty('--wn-ov-side');
    releaseStyle(doc);
    this.active = false; this.visible = false; this.paused = false;
    this.lx = this.ly = this.rx = this.ry = 0;
    for (const k in this.buttons) this.buttons[k] = false;
  }

  // ===============================================================================================================
  // Detection / visibility
  // ===============================================================================================================
  _refreshActive() {
    const a = !this._disposed && this.supported && (this.mode === 'on' ||
      (this.mode === 'auto' && !this._mouseSup && !this._padSup && (this._coarse || this._sawTouch)));
    if (a === this.active) return;
    this.active = a;
    if (!a) this._releaseAll();
    this._applyClasses();
    if (this._onActiveChange) { try { this._onActiveChange(a); } catch (e) { /* caller's problem */ } }
  }

  _applyClasses() {
    const c = this.root.classList;
    c.toggle('wn-on', this.active);
    c.toggle('wn-flight', this._vis === 'flight');
    c.toggle('wn-paused', this._vis === 'paused');
    // on the container: page overlays (the perf readout) move clear of the controls while any of them show
    this.container.classList.toggle('wn-touch-ui', this.active && this._vis !== 'hidden');
  }

  /** Resize / rotation / fullscreen: cache the safe-area insets, anchor the fixed stick bases, feed the CSS a few px
   *  variables. The only place the bases move. */
  _layout() {
    const root = this.root;
    if (!root || this._disposed) return;
    const r = root.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (!(w > 0 && h > 0)) return;
    const cs = this._win.getComputedStyle(this._probe), sf = this._safe;
    sf.l = parseFloat(cs.paddingLeft) || 0; sf.r = parseFloat(cs.paddingRight) || 0;
    sf.t = parseFloat(cs.paddingTop) || 0; sf.b = parseFloat(cs.paddingBottom) || 0;
    const st = root.style, L = this._sticks.l, R = this._sticks.r;
    const cluster = w > h && w >= CLUSTER_MIN_W && h >= CLUSTER_MIN_H;
    let ltw, lth, rtw, rth, bpw, bph = 64, flrY, lbRight, rbLeft;
    if (cluster) {
      // tablets: physical units (cm -> px), shrunk if the screen is too small for the whole cluster
      const u = Math.min(PX_PER_CM, (w - sf.l - sf.r) / 19, (h - sf.t - sf.b) / 12.5);
      const size = (k) => [Math.max(64, Math.round(CL[k].size[0] * u)), Math.max(64, Math.round(CL[k].size[1] * u))];
      const sx = CL_STICK[0] * u, sy = CL_STICK[1] * u;
      L.bx = Math.round(sf.l + sx); R.bx = Math.round(w - sf.r - sx); L.by = R.by = Math.round(h - sf.b - sy);
      // a button's top-left in container px: its center at [angle, distance] from its side's stick center (x mirrored)
      const place = (k, side) => {
        const c = CL[k], a = c.at[0] * Math.PI / 180, d = c.at[1] * u, z = size(k), S = side === 'l' ? L : R;
        const cx = S.bx + (side === 'l' ? 1 : -1) * Math.cos(a) * d, cy = S.by - Math.sin(a) * d;
        st.setProperty('--' + (k === 'flr' ? 'fl' : k) + '-x', px(Math.round(cx - z[0] / 2)));
        st.setProperty('--' + (k === 'flr' ? 'fl' : k) + '-y', px(Math.round(cy - z[1] / 2)));
        return z;
      };
      [ltw, lth] = place('lt', 'l'); [bpw, bph] = place('lb', 'l'); place('rb', 'r'); [rtw, rth] = place('rt', 'r');
      st.setProperty('--wn-flz', px(place('flr', 'l')[0])); place('aoa', 'r');
      flrY = 0;
      lbRight = sf.l + EDGE_M; rbLeft = w - sf.r - EDGE_M;   // the top corners are free
    } else {
      // phones: sticks near the bottom corners, shoulder buttons in the top corners
      const inset = Math.max(RING_R + 26, 0.16 * w);
      const restY = Math.round(h - sf.b - RING_R - Math.max(16, 0.06 * h));   // whole px: crisp rings, exact centers
      L.bx = Math.round(sf.l + inset); R.bx = Math.round(w - sf.r - inset); L.by = R.by = restY;
      // FLR / AOA: above the left / right stick's resting ring (more clearance on tall screens so a high thumb landing doesn't hit it),
      // but no higher than the top of the stick zone
      flrY = Math.max(h * this._zoneTop - 10, restY - RING_R - Math.max(34, 0.08 * h) - 68);
      // shoulder buttons grow a little on bigger screens (hit targets never under 64 px)
      ltw = clamp(0.12 * w, 88, 112); lth = clamp(0.18 * h, 68, 84);
      rtw = clamp(0.14 * w, 104, 132); rth = clamp(0.2 * h, 76, 92);
      bpw = clamp(0.085 * w, 72, 84);
      rbLeft = w - sf.r - EDGE_M - rtw - GAP - bpw; lbRight = sf.l + EDGE_M + ltw + GAP + bpw;
    }
    // pause: beside the HUD heading tape (hud.js: center ± min(26% w, 31% min(w,h))), right side if it fits, else
    // left side, else as close to the tape's right end as RB allows (small phones: it then covers the tape's end)
    const hdg = Math.min(0.26 * w, 0.31 * Math.min(w, h));
    let pauseX = w / 2 + hdg + 6;
    if (pauseX + PAUSE + GAP > rbLeft) {
      const leftX = w / 2 - hdg - 6 - PAUSE;
      pauseX = leftX >= lbRight + GAP ? leftX : Math.max(lbRight + GAP, rbLeft - GAP - PAUSE);
    }
    st.setProperty('--wn-ltw', px(ltw)); st.setProperty('--wn-lth', px(lth));
    st.setProperty('--wn-rtw', px(rtw)); st.setProperty('--wn-rth', px(rth));
    st.setProperty('--wn-bpw', px(bpw)); st.setProperty('--wn-bph', px(bph));
    st.setProperty('--rest-lx', px(L.bx)); st.setProperty('--rest-rx', px(R.bx)); st.setProperty('--flr-y', px(flrY)); st.setProperty('--pause-x', px(pauseX));
    root.classList.toggle('wn-cl', cluster);
    this.cluster = cluster;
    // Where an overlay of the page (the perf readout) can sit without covering a control: top center, under the HUD
    // heading tape and the pause button, clear of any top-corner buttons. Published on the container as CSS variables
    // (with the class wn-touch-ui while controls show; see _applyClasses): --wn-ov-top (px from the top), --wn-ov-side
    // (px to keep clear on each side).
    const hs = clamp(Math.min(w, h) / 900, 0.6, 2.2), hts = Math.max(0.78, hs);   // hud.js layout scales
    const hdgBottom = Math.round(6 * hs) + Math.round(20 * hts) + Math.round(16 * hs) + 2 + Math.round(6 * hs) + Math.round(12 * hts);
    const cst = this.container.style;
    cst.setProperty('--wn-ov-top', px(Math.max(hdgBottom, sf.t + EDGE_M + 2 + PAUSE) + 8));
    cst.setProperty('--wn-ov-side', px(Math.max(lbRight, w - rbLeft) + GAP));
    root.classList.toggle('wn-portrait', h > w);
    // re-anchor both bases, held or not; a thumb that stays down through the change is re-measured against the new
    // center, so the reported deflection keeps matching the knob
    this._placeBase(L); this._placeBase(R);
    if (L.id !== null) { L.rl = r.left; L.rt = r.top; this._stickTo(L, L.fx, L.fy); }
    if (R.id !== null) { R.rl = r.left; R.rt = r.top; this._stickTo(R, R.fx, R.fy); }
  }

  // ===============================================================================================================
  // Pointer routing
  // ===============================================================================================================
  /** Window capture phase, every pointerdown on the page: device detection + menu taps. Never cancels anything. */
  _onWinDown(e) {
    const pt = e.pointerType;
    if (pt === 'touch' || pt === 'pen') {
      this.lastTouchTime = now();
      this._sawTouch = true;
      this._mouseSup = false;
      if (this._vis === 'flight') this._padSup = false;   // touching the screen mid-flight brings the sticks back
      this._refreshActive();
      if (this._onAnyTouch) { try { this._onAnyTouch(e); } catch (err) { /* caller's problem */ } }
      if (this.active && this._vis !== 'flight') this._tapDown(e);
    } else if (pt === 'mouse' && e.isTrusted && this.mode === 'auto' && this.active) {
      this._mouseSup = true;              // a real mouse took over (hybrid laptop, iPad trackpad): hide until the next touch
      this._refreshActive();
    }
  }

  /** Only fires when no Pointer Events exist: detection only (the controls themselves need Pointer Events). */
  _onWinTouchStart(e) {
    this.lastTouchTime = now();
    this._sawTouch = true;
    this._refreshActive();
    if (this._onAnyTouch) { try { this._onAnyTouch(e); } catch (err) { /* caller's problem */ } }
  }

  /** A pointer went down on the overlay (a button or the full-screen sink). */
  _onRootDown(e) {
    if (!this.active || this._disposed) return;
    const pt = e.pointerType;
    if (!(pt === 'touch' || pt === 'pen' || (pt === 'mouse' && this.mode === 'on' && e.button === 0))) return;
    const t = e.target;
    const btn = t && t.closest ? t.closest('.wn-b') : null;
    if (btn) {
      if (e.cancelable) e.preventDefault();          // no compat mouse events / focus / selection
      if (this._owners.has(e.pointerId) || (this._vis === 'paused' && btn !== this._els.pause)) return;
      const name = btn.getAttribute('data-b');
      this._capture(btn, e.pointerId);
      this._owners.set(e.pointerId, { el: btn, name, stick: null });
      this._btnDown(name, btn, e);
      return;
    }
    if (t !== this._sink) return;
    if (e.cancelable) e.preventDefault();            // stray touches die here too (no synthesized mouse clicks)
    if (this._vis !== 'flight' || this._owners.has(e.pointerId)) return;
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < r.height * this._zoneTop) return;
    const side = x < r.width * this._zoneW ? 'l' : (x > r.width * (1 - this._zoneW) ? 'r' : '');
    if (!side) return;
    const s = this._sticks[side];
    if (s.id !== null) return;                       // that stick already has a thumb: ignore the extra finger
    this._capture(this._sink, e.pointerId);
    this._owners.set(e.pointerId, { el: this._sink, name: '', stick: s });
    this._stickStart(s, e.pointerId, e.clientX, e.clientY, r);
  }

  _onWinMove(e) {
    const o = this._owners.get(e.pointerId);
    if (o !== undefined) {
      if (o.stick) this._stickTo(o.stick, e.clientX, e.clientY);
      return;
    }
    const tp = this._tap;
    if (tp) {
      const p = tp.pts.get(e.pointerId);
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) tp.bad = true;
    }
  }

  _onWinUp(e, cancel) {
    const o = this._owners.get(e.pointerId);
    if (o !== undefined) { this._owners.delete(e.pointerId); this._releaseOwner(o, e.pointerId, false); }
    const tp = this._tap;
    if (tp && tp.pts.has(e.pointerId)) {
      tp.pts.delete(e.pointerId);
      if (cancel) tp.bad = true;
      if (tp.pts.size === 0) {
        this._tap = null;
        if (!tp.bad && now() - tp.t0 <= TAP_MS * (tp.max > 1 ? 1.5 : 1) && this.active && this._vis !== 'flight') {
          this._pulse(tp.max > 1 ? 'back' : 'confirm');
        }
      }
    }
  }

  _capture(el, id) { try { el.setPointerCapture(id); } catch (e) { /* synthetic / already-gone pointer */ } }
  _uncapture(el, id) { try { if (el.hasPointerCapture && el.hasPointerCapture(id)) el.releasePointerCapture(id); } catch (e) { /* ignore */ } }

  _releaseOwner(o, id, force) {
    this._uncapture(o.el, id);
    if (o.stick) this._stickEnd(o.stick);
    else this._btnUp(o.name, o.el, force);
  }

  /** Drop every held control right now (visibility / mode change, blur, tab hidden). */
  _releaseAll() {
    if (this._owners.size) {
      this._owners.forEach((o, id) => this._releaseOwner(o, id, true));
      this._owners.clear();
    }
    for (const k in this._relT) if (this._relT[k]) { clearTimeout(this._relT[k]); this._relT[k] = 0; this._setBtn(k, false); }
    for (const k in this._cnt) this._cnt[k] = 0;
    this._tap = null;
  }

  // ===============================================================================================================
  // Buttons
  // ===============================================================================================================
  _btnDown(name, el, e) {
    this._cnt[name] = (this._cnt[name] || 0) + 1;
    if (this._relT[name]) { clearTimeout(this._relT[name]); this._relT[name] = 0; }
    if (this._cnt[name] === 1) this._t0[name] = now();
    el.classList.add('wn-on');
    if (!this.buttons[name]) {
      this.buttons[name] = true;
      this._changed();
      if ((name === 'missile' || name === 'flares') && e && e.isTrusted) this._haptic(12);
    }
  }

  _btnUp(name, el, force) {
    const c = (this._cnt[name] || 0) - 1;
    this._cnt[name] = c > 0 ? c : 0;
    if (c > 0) return;                               // another finger still holds it
    el.classList.remove('wn-on');
    const held = now() - (this._t0[name] || 0);
    if (!force && held < MIN_PRESS_MS) {
      this._relT[name] = setTimeout(() => { this._relT[name] = 0; if (!this._cnt[name]) this._setBtn(name, false); }, MIN_PRESS_MS - held);
    } else this._setBtn(name, false);
  }

  _setBtn(name, v) { if (this.buttons[name] !== v) { this.buttons[name] = v; this._changed(); } }

  /** Menu helpers while the flight controls are hidden: quick one-finger tap on a non-interactive spot = confirm,
   *  two-finger tap = back. Short pulses so a polling reader sees exactly one held->released cycle. */
  _tapDown(e) {
    let tp = this._tap;
    if (!tp) tp = this._tap = { pts: new Map(), max: 0, t0: now(), bad: false };
    tp.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (tp.pts.size > tp.max) tp.max = tp.pts.size;
    if (tp.max > 2) tp.bad = true;
    const t = e.target;
    if (t && t.closest && (t.closest(INTERACTIVE) || this.root.contains(t))) tp.bad = true;
  }

  _pulse(name) {
    if (this._pulseT[name]) clearTimeout(this._pulseT[name]);
    this._setBtn(name, true);
    this._pulseT[name] = setTimeout(() => { this._pulseT[name] = 0; this._setBtn(name, false); }, PULSE_MS);
  }

  _haptic(ms) {
    try { const n = this._win.navigator; if (n && typeof n.vibrate === 'function') n.vibrate(ms); } catch (e) { /* refused */ }
  }

  _changed() {
    this.used = true;
    if (this._onInput) { try { this._onInput(this); } catch (e) { /* caller's problem */ } }
  }

  // ===============================================================================================================
  // Fixed sticks
  // ===============================================================================================================
  /** A thumb landed in a stick's zone. The base stays where it is: the knob jumps under the thumb and an off-center
   *  touch-down deflects at once, like a fixed stick (the deadzone absorbs small offsets). */
  _stickStart(s, id, cx, cy, r) {
    s.id = id; s.rl = r.left; s.rt = r.top;
    s.el.classList.add('wn-act');                    // knob transition off: it tracks the finger 1:1
    this._stickTo(s, cx, cy);
  }

  /** The holding finger is at client (cx, cy). Deflection = (finger - fixed base center) / travel, clamped to length 1,
   *  then the radial deadzone (rescaled so there is no step). The knob follows the finger, even outside the ring. */
  _stickTo(s, cx, cy) {
    s.fx = cx; s.fy = cy;
    const dx = cx - s.rl - s.bx, dy = cy - s.rt - s.by, d = Math.hypot(dx, dy);
    this._placeKnob(s, dx, dy);
    const m = Math.min(d / this._travel, 1);
    let vx = 0, vy = 0;
    if (m > this._dz) { const sc = (m - this._dz) / (1 - this._dz) / d; vx = dx * sc; vy = dy * sc; }
    this._setStick(s, vx, vy);
  }

  _stickEnd(s) {
    s.id = null;
    s.el.classList.remove('wn-act');                 // transition back on: the knob springs to center (the base never moved)
    this._placeKnob(s, 0, 0);
    this._setStick(s, 0, 0);
  }

  _setStick(s, vx, vy) {
    vx = clamp(vx, -1, 1) || 0; vy = clamp(vy, -1, 1) || 0;     // `|| 0` folds -0
    let changed;
    if (s.side === 'l') {
      const ly = -vy || 0;                           // screen up = boost = +1
      changed = vx !== this.lx || ly !== this.ly; this.lx = vx; this.ly = ly;
    } else {
      changed = vx !== this.rx || vy !== this.ry; this.rx = vx; this.ry = vy;   // pull down = nose up = +1
    }
    const mask = (vy < -LIT ? 1 : 0) | (vy > LIT ? 2 : 0) | (vx < -LIT ? 4 : 0) | (vx > LIT ? 8 : 0);
    if (mask !== s.mask) {
      s.mask = mask;
      for (let i = 0; i < 4; i++) s.lab[i].classList.toggle('wn-lit', (mask & (1 << i)) !== 0);
    }
    if (changed) this._changed();
  }

  _placeBase(s) { s.el.style.transform = 'translate3d(' + px(s.bx) + ',' + px(s.by) + ',0)'; }
  _placeKnob(s, kx, ky) { s.knob.style.transform = 'translate3d(' + px(kx) + ',' + px(ky) + ',0)'; }
}
