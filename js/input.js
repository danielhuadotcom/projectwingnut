// js/input.js — PROJECT WINGNUT input layer: standard gamepad (mode-2 RC ergonomics) merged with keyboard.
// Pure DOM / Gamepad API module: no Three.js needed here.
//
// Contract (see SPEC.md "js/input.js"): axes pitch/roll/yaw/throttleDelta in -1..1, held booleans, one-frame edge
// flags that are true for exactly one update() call, and status fields for the HUD. All edge flags are computed
// INSIDE update() from state accumulated by the event handlers, never set directly by the handlers. The one exception
// is the fullscreen key (U): browsers only grant fullscreen inside the key handler itself, so it calls
// onFullscreenKey(event) synchronously instead of raising an edge.

const DEADZONE = 0.12;          // per-axis deadzone before rescaling
const ATTACK_TIME = 0.15;       // s for a keyboard axis to reach full deflection
const RELEASE_TIME = 0.10;      // s for a keyboard axis to return to center
const STICK_ACTIVE = 0.25;      // stick magnitude that counts as "the player is using the gamepad"
const GUN_THRESHOLD = 0.25;     // right trigger analog threshold
const MISSILE_THRESHOLD = 0.35; // left trigger analog threshold
const MAX_DT = 0.25;            // clamp for update(dt) so a long tab-switch doesn't produce a huge ramp step
const STORAGE_KEY = 'wingnut.invertPitch';

// Standard-mapping indices (https://w3c.github.io/gamepad/#remapping). Non-standard pads fall back to the same indices.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 };
const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 };

// Keyboard map: KeyboardEvent.code -> action. Actions ending in +/- are axis directions.
const KEYMAP = {
  KeyW: 'pitch-', ArrowUp: 'pitch-',          // push: nose down
  KeyS: 'pitch+', ArrowDown: 'pitch+',        // pull: nose up
  KeyA: 'roll-', ArrowLeft: 'roll-',
  KeyD: 'roll+', ArrowRight: 'roll+',
  KeyQ: 'yaw-', KeyE: 'yaw+',
  ShiftLeft: 'throttle+', ShiftRight: 'throttle+', Equal: 'throttle+', NumpadAdd: 'throttle+',
  KeyH: 'throttle-', Minus: 'throttle-', NumpadSubtract: 'throttle-',   // no Ctrl: Ctrl+W would close the browser tab
  Space: 'gun',
  KeyF: 'missile', Enter: 'missile', NumpadEnter: 'missile',
  Tab: 'target',
  KeyV: 'lookBack',
  Escape: 'pause', KeyP: 'pause',
  KeyI: 'invertPitch',
  KeyR: 'restart',
  KeyG: 'graphics',
  KeyX: 'flares',
  KeyC: 'freeLook',
  Backquote: 'overlay', F9: 'overlay',
  KeyU: 'fullscreen',                          // onFullscreenKey, called inside the keydown handler (see the header)
};
// Fallback for browsers / layouts where `code` is missing: KeyboardEvent.key -> code.
const KEY_TO_CODE = {
  w: 'KeyW', s: 'KeyS', a: 'KeyA', d: 'KeyD', q: 'KeyQ', e: 'KeyE', f: 'KeyF', v: 'KeyV', p: 'KeyP', i: 'KeyI', r: 'KeyR', g: 'KeyG', '`': 'Backquote', x: 'KeyX', c: 'KeyC', u: 'KeyU',
  '=': 'Equal', '+': 'NumpadAdd', '-': 'Minus', ' ': 'Space', Shift: 'ShiftLeft', h: 'KeyH',
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
};
const AXES = ['pitch', 'roll', 'yaw', 'throttle'];
const BUTTON_ACTIONS = ['gun', 'missile', 'target', 'lookBack', 'pause', 'invertPitch', 'restart', 'graphics', 'overlay', 'flares'];

/** Deadzone + rescale to 0..1 past the deadzone + expo curve (fine control near center, full range at the ends). */
export function shapeAxis(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  let m = (a - DEADZONE) / (1 - DEADZONE);
  if (m > 1) m = 1;
  const e = EXPO * m * m * m + (1 - EXPO) * m;    // half deflection -> ~20% rate: fine control near center
  return v < 0 ? -e : e;
}
const EXPO = 0.8;
/** Expo only (no deadzone): for the on-screen touch sticks, which apply their own deadzone. */
export function expoOnly(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const m = Math.min(1, Math.abs(v)), e = EXPO * m * m * m + (1 - EXPO) * m;
  return v < 0 ? -e : e;
}

function clamp1(v) { return v > 1 ? 1 : v < -1 ? -1 : v; }
function isEditable(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}
function prettyGamepadName(id) {
  if (typeof id !== 'string') return null;
  // Chrome ids look like "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)" — drop the cruft.
  let s = id.replace(/\((?:[^()]*(?:STANDARD GAMEPAD|Vendor:|Product:|XInput)[^()]*)\)/gi, '').replace(/\s+/g, ' ').trim();
  if (!s) s = id.trim();
  if (s.length > 40) s = s.slice(0, 39).trimEnd() + '…';
  return s || null;
}

export class Input {
  /**
   * @param {Window|Element} target  keydown/keyup are attached here (default: window). blur/visibility/gamepad events
   *                                 always go on the owning window so keys are cleared when the page loses focus.
   */
  constructor(target) {
    const win = (typeof window !== 'undefined') ? window : null;
    this._target = target || win;
    this._win = (this._target && this._target.window === this._target) ? this._target
      : (this._target && this._target.ownerDocument && this._target.ownerDocument.defaultView) || win;
    this._doc = this._win ? this._win.document : null;

    // ---- public axes / buttons / edges / status --------------------------------------------------------------
    this.pitch = 0; this.roll = 0; this.yaw = 0; this.throttleDelta = 0;
    this.gun = false; this.missile = false; this.targetButton = false; this.lookBack = false;
    this.gunPressed = false; this.missilePressed = false; this.targetPressed = false; this.targetReleased = false;
    this.pausePressed = false; this.restartPressed = false; this.invertPitchToggled = false; this.anyPressed = false;
    this.gunReleased = false; this.missileReleased = false;            // extras (symmetry with target*)
    this.gamepadConnected = false; this.gamepadName = null; this.gamepadId = null; this.gamepadIndex = -1;
    this.gamepadBlocked = false; this.gamepadSupported = !!(this._win && this._win.navigator && typeof this._win.navigator.getGamepads === 'function');
    this.usingGamepad = false;
    this.keyboardActive = false;        // extra: any mapped key currently held
    this.gunAnalog = 0; this.missileAnalog = 0;   // extras: raw trigger values 0..1 (keyboard = 0/1)
    this.invertPitch = false;
    try {
      const v = this._win && this._win.localStorage ? this._win.localStorage.getItem(STORAGE_KEY) : null;
      this.invertPitch = v === '1' || v === 'true';
    } catch (e) { /* storage blocked: default false */ }

    // ---- private state ----------------------------------------------------------------------------------------
    this._keys = new Set();             // currently held KeyboardEvent codes (mapped ones only)
    this._kbAxis = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };      // ramped keyboard axis values
    this._press = { gun: 0, missile: 0, target: 0, lookBack: 0, pause: 0, invertPitch: 0, restart: 0, graphics: 0, overlay: 0, flares: 0 }; // keydowns since last update
    this._anyKeyDowns = 0;
    this._kbActivity = false;           // any keydown since last update (flips usingGamepad off)
    this._prev = { gun: false, missile: false, target: false, pause: false, invertPitch: false, restart: false }; // reported held state last frame
    this._gpPrevPressed = new Array(32).fill(false);
    this._gpPressEdge = false;          // any gamepad button went down since the last update
    this._gpHeldPrev = { pause: false, invertPitch: false, restart: false, dl: false, dr: false, du: false, l3: false };
    this.flaresPressed = false;          // left stick click (L3) / X: countermeasure flares
    // Menu navigation edges (one frame): D-pad / arrows / WASD-free, A or Enter confirms, B or Esc goes back
    this.menuUp = false; this.menuDown = false; this.menuLeft = false; this.menuRight = false;
    this.menuConfirm = false; this.menuBack = false;
    this._gpMenuPrev = { u: false, d: false, l: false, r: false, a: false, b: false };
    this._kbMenu = { u: 0, d: 0, l: 0, r: 0, a: 0, b: 0 };
    // Optional on-screen touch controls (js/touch.js): an object exposing { active, lx, ly, rx, ry, buttons:{...} }
    this.touch = null;
    // Menu edges: D-pad right / G = next graphics preset, D-pad left = previous, D-pad up / ` / F9 = perf overlay
    this.graphicsNextPressed = false; this.graphicsPrevPressed = false; this.overlayToggled = false;
    this.onFullscreenKey = null;        // fn(KeyboardEvent): U went down (no repeat, no Ctrl/Alt/Meta), inside the keydown handler
    this._pollGamepads = this.gamepadSupported;
    this._gpConnectHint = false;        // a gamepadconnected event arrived; poll even if we had given up
    this._disposed = false;
    // ---- mouse (War Thunder-style mouse aim when no gamepad is in use) --------------------------------------------
    this._mdx = 0; this._mdy = 0; this._wheel = 0;
    this._mLeft = false; this._mRight = false; this._mLeftPrev = false; this._mRightPrev = false; this._mRightTap = 0;
    this.mouseMoveX = 0; this.mouseMoveY = 0; this.wheel = 0;
    this.mouseLeft = false; this.mouseRight = false; this.mouseRightPressed = false;
    this.pointerLocked = false; this.mouseActive = false; this.freeLook = false;
    this.kb = null;                     // ramped keyboard axes { pitch, roll, yaw, throttle } (set in update)
    this._onMouseMove = (e) => {
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (Math.abs(dx) + Math.abs(dy) > 0) { this._mdx += dx; this._mdy += dy; this._mouseUsed = true; }
    };
    this._onMouseDown = (e) => { if (e.button === 0) this._mLeft = true; else if (e.button === 2) { this._mRight = true; this._mRightTap++; } this._mouseUsed = true; };
    this._onMouseUp = (e) => { if (e.button === 0) this._mLeft = false; else if (e.button === 2) this._mRight = false; };
    this._onContext = (e) => { e.preventDefault(); };
    this._onWheel = (e) => { this._wheel += e.deltaY || 0; };
    this._onLockChange = () => { this.pointerLocked = !!(this._doc && this._doc.pointerLockElement); if (!this.pointerLocked) { this._mLeft = this._mRight = false; } };

    // ---- listeners --------------------------------------------------------------------------------------------
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => this._clearKeys();
    this._onVisibility = () => { if (this._doc && this._doc.visibilityState === 'hidden') this._clearKeys(); };
    this._onGpConnected = (e) => {
      this._gpConnectHint = true;
      if (this.gamepadSupported && !this.gamepadBlocked) this._pollGamepads = true;
      if (e && e.gamepad && this.gamepadIndex < 0) this.gamepadIndex = e.gamepad.index;
    };
    this._onGpDisconnected = (e) => {
      if (e && e.gamepad && e.gamepad.index === this.gamepadIndex) this._dropGamepad();
    };
    if (this._target && this._target.addEventListener) {
      this._target.addEventListener('keydown', this._onKeyDown);
      this._target.addEventListener('keyup', this._onKeyUp);
    }
    if (this._win && this._win.addEventListener) {
      this._win.addEventListener('blur', this._onBlur);
      this._win.addEventListener('gamepadconnected', this._onGpConnected);
      this._win.addEventListener('gamepaddisconnected', this._onGpDisconnected);
      this._win.addEventListener('mousemove', this._onMouseMove);
      this._win.addEventListener('mousedown', this._onMouseDown);
      this._win.addEventListener('mouseup', this._onMouseUp);
      this._win.addEventListener('contextmenu', this._onContext);
      this._win.addEventListener('wheel', this._onWheel, { passive: true });
    }
    if (this._doc && this._doc.addEventListener) {
      this._doc.addEventListener('visibilitychange', this._onVisibility);
      this._doc.addEventListener('pointerlockchange', this._onLockChange);
    }
  }
  /** Ask for pointer lock (call from a click handler); harmless if refused or unsupported. */
  requestPointerLock(el) {
    if (!el || !el.requestPointerLock || this.pointerLocked) return;
    // raw (unaccelerated) movement where supported, plain lock otherwise
    try {
      const raw = !/[?&]rawmouse=0/.test(location.search);
      const r = raw ? el.requestPointerLock({ unadjustedMovement: true }) : el.requestPointerLock();
      if (r && r.catch) r.catch(() => { try { const r2 = el.requestPointerLock(); if (r2 && r2.catch) r2.catch(() => {}); } catch { /* refused */ } });
    } catch { try { el.requestPointerLock(); } catch { /* refused */ } }
  }
  exitPointerLock() { try { if (this._doc && this._doc.exitPointerLock && this.pointerLocked) this._doc.exitPointerLock(); } catch { /* ignore */ } }

  // =============================================================================================================
  // Keyboard handlers: only record state; edges are derived in update().
  // =============================================================================================================
  _codeOf(e) {
    let code = e.code;
    if (!code || !KEYMAP[code]) {
      const alt = KEY_TO_CODE[e.key] || (typeof e.key === 'string' ? KEY_TO_CODE[e.key.toLowerCase()] : undefined);
      if (alt && KEYMAP[alt]) code = alt;
    }
    return code;
  }

  _keyDown(e) {
    if (this._disposed || !e) return;
    if (isEditable(e.target)) return;
    const code = this._codeOf(e);
    const action = KEYMAP[code];
    if (!e.repeat) {
      this._anyKeyDowns++; this._kbActivity = true;
      const M = this._kbMenu;
      if (code === 'ArrowUp') M.u++; else if (code === 'ArrowDown') M.d++; else if (code === 'ArrowLeft') M.l++; else if (code === 'ArrowRight') M.r++;
      else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') M.a++; else if (code === 'Escape' || code === 'Backspace') M.b++;
    }
    if (!action) return;
    // fullscreen: plain U (Shift allowed: it is held for boost); Ctrl / Alt / Meta combos are left to the browser and OS
    if (action === 'fullscreen' && (e.ctrlKey || e.altKey || e.metaKey)) return;
    // Swallow browser defaults for the keys we use (Tab focus change, Space/arrows scrolling, Ctrl/Shift combos
    // like Ctrl+S / Ctrl+P / Ctrl+F while flying). Browsers refuse to block a few (Ctrl+W, Ctrl+T) — nothing to do.
    if (e.preventDefault) e.preventDefault();
    if (e.repeat) return;
    if (action === 'fullscreen') { if (typeof this.onFullscreenKey === 'function') this.onFullscreenKey(e); return; }
    if (!this._keys.has(code)) {
      this._keys.add(code);
      if (this._press[action] !== undefined) this._press[action]++;
    }
  }

  _keyUp(e) {
    if (this._disposed || !e) return;
    const code = this._codeOf(e);
    const action = KEYMAP[code];
    if (!action) return;
    if (e.preventDefault) e.preventDefault();
    this._keys.delete(code);
    // Chrome collapses ShiftLeft/ShiftRight keyups when both were down; be forgiving about the sibling key.
    if (code === 'ShiftLeft' || code === 'ShiftRight') { if (!e.shiftKey) { this._keys.delete('ShiftLeft'); this._keys.delete('ShiftRight'); } }
    if (code === 'ControlLeft' || code === 'ControlRight') { if (!e.ctrlKey) { this._keys.delete('ControlLeft'); this._keys.delete('ControlRight'); } }
  }

  // held keys and mouse buttons: after a blur / hidden tab their keyup / mouseup may never arrive (stuck gun)
  _clearKeys() { this._keys.clear(); this._mLeft = this._mRight = false; }

  /** True if any held key maps to `action` (e.g. 'gun', 'pitch+'). */
  _kbHeld(action) {
    for (const code of this._keys) if (KEYMAP[code] === action) return true;
    return false;
  }

  // =============================================================================================================
  // Gamepad polling
  // =============================================================================================================
  _dropGamepad() {
    this.gamepadConnected = false; this.gamepadName = null; this.gamepadId = null; this.gamepadIndex = -1;
    this._gpPrevPressed.fill(false);
    this._gpHeldPrev.pause = this._gpHeldPrev.invertPitch = this._gpHeldPrev.restart = false;
  }

  /** Returns the active Gamepad object or null. Sets gamepadBlocked and stops polling on a SecurityError. */
  _pollGamepad() {
    if (!this._pollGamepads || this.gamepadBlocked) return null;
    const nav = this._win && this._win.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') { this.gamepadSupported = false; this._pollGamepads = false; return null; }
    let pads;
    try { pads = nav.getGamepads(); } catch (err) {
      // Permissions-Policy: gamepad=() in an iframe → SecurityError. Stop asking; HUD tells the player.
      this.gamepadBlocked = true; this._pollGamepads = false; this._dropGamepad();
      return null;
    }
    if (!pads) return null;
    let best = null, bestScore = -1;
    const n = pads.length | 0;
    for (let i = 0; i < n; i++) {
      const gp = pads[i];
      if (!gp || !gp.buttons || !gp.buttons.length || gp.connected === false) continue;
      // Prefer: the pad we already use, then standard mapping, then anything with at least 4 axes.
      let score = (gp.mapping === 'standard' ? 2 : 0) + ((gp.axes && gp.axes.length >= 4) ? 1 : 0);
      if (gp.index === this.gamepadIndex) score += 4;
      if (score > bestScore) { best = gp; bestScore = score; }
    }
    if (!best) { if (this.gamepadConnected) this._dropGamepad(); return null; }
    if (!this.gamepadConnected || best.index !== this.gamepadIndex) {
      this._gpPrevPressed.fill(false);
      this.gamepadIndex = best.index;
      this.gamepadId = best.id || null;
      this.gamepadName = prettyGamepadName(best.id) || 'Gamepad';
      this.gamepadConnected = true;
    }
    return best;
  }

  // =============================================================================================================
  // Per-frame update: merge devices, ramp keyboard axes, compute edges.
  // =============================================================================================================
  update(dt) {
    if (this._disposed) return;
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) dt = 1 / 60;
    if (dt > MAX_DT) dt = MAX_DT;

    // ---- keyboard axes: ramp toward -1/0/+1 -------------------------------------------------------------------
    const kb = this._kbAxis;
    for (let i = 0; i < 4; i++) {
      const name = AXES[i];
      const target = (this._kbHeld(name + '+') ? 1 : 0) - (this._kbHeld(name + '-') ? 1 : 0);
      let cur = kb[name];
      if (cur !== target) {
        // moving away from center = attack rate, toward center (release or sign flip) = release rate
        const towardCenter = target === 0 || (cur !== 0 && (cur > 0) !== (target > 0));
        const step = dt / (towardCenter ? RELEASE_TIME : ATTACK_TIME);
        if (towardCenter && target !== 0 && Math.abs(cur) <= step + 1e-9) {
          // crossed zero this frame: spend the remainder attacking toward the new direction
          const rem = Math.max(0, step - Math.abs(cur));
          cur = (target > 0 ? 1 : -1) * Math.min(1, rem * (RELEASE_TIME / ATTACK_TIME));
        } else if (cur < target) cur = Math.min(target, cur + step);
        else cur = Math.max(target, cur - step);
        if (Math.abs(cur - target) < 1e-6) cur = target;   // snap: no 1e-16 residue when returning to center
        kb[name] = cur;
      }
    }
    const kbGun = this._kbHeld('gun'), kbMissile = this._kbHeld('missile'), kbTarget = this._kbHeld('target');
    const kbLook = this._kbHeld('lookBack'), kbPause = this._kbHeld('pause'), kbInvert = this._kbHeld('invertPitch'), kbRestart = this._kbHeld('restart');
    this.keyboardActive = this._keys.size > 0;

    // ---- gamepad -----------------------------------------------------------------------------------------------
    let gpPitch = 0, gpRoll = 0, gpYaw = 0, gpThr = 0, gpGunV = 0, gpMisV = 0;
    let gpTarget = false, gpLook = false, gpPause = false, gpInvert = false, gpRestart = false, gpDL = false, gpDR = false, gpDU = false, gpL3 = false;
    let gpDD = false, gpA = false, gpB = false, lsU = false, lsD = false, lsL = false, lsR = false;
    let gpActive = false;
    this._gpPressEdge = false;
    const gp = this._pollGamepad();
    if (gp) {
      const ax = gp.axes || [];
      const rawLX = ax[AXIS.LX] || 0, rawLY = ax[AXIS.LY] || 0, rawRX = ax[AXIS.RX] || 0, rawRY = ax[AXIS.RY] || 0;
      gpYaw = shapeAxis(rawLX);
      gpThr = -shapeAxis(rawLY);                 // gamepad up is -Y; push up = +throttle
      gpRoll = shapeAxis(rawRX);
      gpPitch = shapeAxis(rawRY);                // pull back (+Y) = nose up (+1)
      if (Math.abs(rawLX) > STICK_ACTIVE || Math.abs(rawLY) > STICK_ACTIVE || Math.abs(rawRX) > STICK_ACTIVE || Math.abs(rawRY) > STICK_ACTIVE) gpActive = true;
      const b = gp.buttons;
      const nb = Math.min(b.length, 32);
      for (let i = 0; i < nb; i++) {
        const btn = b[i];
        const pressed = !!(btn && (btn.pressed === true || (typeof btn === 'number' ? btn > 0.5 : false)));
        if (pressed && !this._gpPrevPressed[i]) this._gpPressEdge = true;
        if (pressed) gpActive = true;
        this._gpPrevPressed[i] = pressed;
      }
      for (let i = nb; i < 32; i++) this._gpPrevPressed[i] = false;
      gpMisV = triggerValue(b[BTN.LT]);
      gpGunV = triggerValue(b[BTN.RT]);
      if (gpMisV > MISSILE_THRESHOLD || gpGunV > GUN_THRESHOLD) gpActive = true;
      gpTarget = isPressed(b[BTN.RB]);
      gpLook = isPressed(b[BTN.LB]);
      gpPause = isPressed(b[BTN.START]);
      gpInvert = isPressed(b[BTN.BACK]);
      gpRestart = isPressed(b[BTN.Y]);
      gpDU = isPressed(b[12]); gpDL = isPressed(b[14]); gpDR = isPressed(b[15]);
      gpL3 = isPressed(b[10]);
      gpDD = isPressed(b[13]); gpA = isPressed(b[BTN.A]); gpB = isPressed(b[BTN.B]);
      lsU = rawLY < -0.6; lsD = rawLY > 0.6; lsL = rawLX < -0.6; lsR = rawLX > 0.6;
    }

    // ---- on-screen touch controls (phones): a second "gamepad" with the same mode-2 layout ---------------------------
    const T = this.touch;
    if (T && T.active) {
      const tb = T.buttons || {};
      if (T.used) { gpActive = true; T.used = false; }
      gpYaw = clamp1(gpYaw + expoOnly(T.lx || 0)); gpThr = clamp1(gpThr + (T.ly || 0));        // left stick: ↑ boost, ↔ rudder
      gpRoll = clamp1(gpRoll + expoOnly(T.rx || 0)); gpPitch = clamp1(gpPitch + expoOnly(T.ry || 0));  // right stick: pull (↓) = nose up
      if (tb.gun) gpGunV = 1; if (tb.missile) gpMisV = 1;
      gpTarget = gpTarget || !!tb.target; gpLook = gpLook || !!tb.lookBack; gpPause = gpPause || !!tb.pause; gpL3 = gpL3 || !!tb.flares;
      gpA = gpA || !!tb.confirm; gpB = gpB || !!tb.back;
    }
    // ---- menu navigation edges ----------------------------------------------------------------------------------
    {
      const M = this._kbMenu, G = this._gpMenuPrev;
      const u = gpDU || lsU, d = gpDD || lsD, l = gpDL || lsL, r = gpDR || lsR;
      this.menuUp = M.u > 0 || (u && !G.u); this.menuDown = M.d > 0 || (d && !G.d);
      this.menuLeft = M.l > 0 || (l && !G.l); this.menuRight = M.r > 0 || (r && !G.r);
      this.menuConfirm = M.a > 0 || (gpA && !G.a); this.menuBack = M.b > 0 || (gpB && !G.b);
      G.u = u; G.d = d; G.l = l; G.r = r; G.a = gpA; G.b = gpB;
      M.u = M.d = M.l = M.r = M.a = M.b = 0;
    }
    // ---- mouse: consume accumulated motion, button edges ------------------------------------------------------------
    this.mouseMoveX = this._mdx; this.mouseMoveY = this._mdy; this._mdx = 0; this._mdy = 0;
    this.wheel = this._wheel; this._wheel = 0;
    this.mouseLeft = this._mLeft; this.mouseRight = this._mRight;
    this.mouseRightPressed = this._mRightTap > 0 || (this._mRight && !this._mRightPrev); this._mRightTap = 0;
    this._mRightPrev = this._mRight;
    if (this._mouseUsed) { this.mouseActive = true; this._kbActivity = true; this._mouseUsed = false; }
    this.freeLook = this._kbHeld('freeLook');
    this.kb = this._kbAxis;

    // ---- which device is the player on? -------------------------------------------------------------------------
    if (this._kbActivity) this.usingGamepad = false;
    if (gpActive) this.usingGamepad = true;
    this._kbActivity = false;

    // ---- axes (merged, clamped, inverted) ------------------------------------------------------------------------
    let pitch = clamp1(gpPitch + kb.pitch);
    if (this.invertPitch) pitch = -pitch;
    this.pitch = pitch;
    this.roll = clamp1(gpRoll + kb.roll);
    this.yaw = clamp1(gpYaw + kb.yaw);
    this.throttleDelta = clamp1(gpThr + kb.throttle);
    const P = this._press, prev = this._prev;
    this.gunAnalog = Math.max(gpGunV, (kbGun || P.gun > 0) ? 1 : 0);
    this.missileAnalog = Math.max(gpMisV, (kbMissile || P.missile > 0) ? 1 : 0);

    // ---- held booleans + one-frame edges -------------------------------------------------------------------------
    // A key tapped entirely between two frames still registers as held for one frame (press counter), so the
    // Pressed edge fires now and the Released edge fires on the next update.
    const gunHeld = kbGun || gpGunV > GUN_THRESHOLD || P.gun > 0 || this.mouseLeft;
    const misHeld = kbMissile || gpMisV > MISSILE_THRESHOLD || P.missile > 0 || this.mouseRight || this.mouseRightPressed;
    const tgtHeld = kbTarget || gpTarget || P.target > 0;
    this.gun = gunHeld; this.missile = misHeld; this.targetButton = tgtHeld;
    this.lookBack = kbLook || gpLook || P.lookBack > 0;
    this.gunPressed = gunHeld && !prev.gun;        this.gunReleased = !gunHeld && prev.gun;
    this.missilePressed = misHeld && !prev.missile; this.missileReleased = !misHeld && prev.missile;
    this.targetPressed = tgtHeld && !prev.target;  this.targetReleased = !tgtHeld && prev.target;
    prev.gun = gunHeld; prev.missile = misHeld; prev.target = tgtHeld;

    // Momentary actions: keyboard uses the keydown counter (so a tap between frames counts), gamepad uses the
    // held-state transition of its button.
    const gh = this._gpHeldPrev;
    this.pausePressed = P.pause > 0 || (gpPause && !gh.pause);
    this.restartPressed = P.restart > 0 || (gpRestart && !gh.restart);
    this.invertPitchToggled = P.invertPitch > 0 || (gpInvert && !gh.invertPitch);
    gh.pause = gpPause; gh.restart = gpRestart; gh.invertPitch = gpInvert;
    this.graphicsNextPressed = P.graphics > 0 || (gpDR && !gh.dr);
    this.graphicsPrevPressed = gpDL && !gh.dl;
    this.overlayToggled = P.overlay > 0 || (gpDU && !gh.du);
    gh.dl = gpDL; gh.dr = gpDR; gh.du = gpDU;
    this.flaresPressed = P.flares > 0 || (gpL3 && !gh.l3);
    gh.l3 = gpL3;
    void kbPause; void kbInvert; void kbRestart; // (held state of momentary keys is intentionally unused)

    this.anyPressed = this._anyKeyDowns > 0 || this._gpPressEdge;

    // (invert pitch is changed from the settings menu; the toggle edge is only reported, never applied mid-flight)

    // consume per-frame counters
    P.gun = P.missile = P.target = P.lookBack = P.pause = P.invertPitch = P.restart = P.graphics = P.overlay = P.flares = 0;
    this._anyKeyDowns = 0;
  }

  /** Set & persist the pitch inversion preference (also toggled internally by I / Back-Select). */
  setInvertPitch(v) {
    this.invertPitch = !!v;
    try { if (this._win && this._win.localStorage) this._win.localStorage.setItem(STORAGE_KEY, this.invertPitch ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._target && this._target.removeEventListener) {
      this._target.removeEventListener('keydown', this._onKeyDown);
      this._target.removeEventListener('keyup', this._onKeyUp);
    }
    if (this._win && this._win.removeEventListener) {
      this._win.removeEventListener('blur', this._onBlur);
      this._win.removeEventListener('gamepadconnected', this._onGpConnected);
      this._win.removeEventListener('gamepaddisconnected', this._onGpDisconnected);
      this._win.removeEventListener('mousemove', this._onMouseMove);
      this._win.removeEventListener('mousedown', this._onMouseDown);
      this._win.removeEventListener('mouseup', this._onMouseUp);
      this._win.removeEventListener('contextmenu', this._onContext);
      this._win.removeEventListener('wheel', this._onWheel);
    }
    if (this._doc && this._doc.removeEventListener) this._doc.removeEventListener('pointerlockchange', this._onLockChange);
    if (this._doc && this._doc.removeEventListener) this._doc.removeEventListener('visibilitychange', this._onVisibility);
    this._clearKeys();
    this._dropGamepad();
    this.pitch = this.roll = this.yaw = this.throttleDelta = 0;
    this.gun = this.missile = this.targetButton = this.lookBack = false;
    this.gunPressed = this.missilePressed = this.targetPressed = this.targetReleased = false;
    this.pausePressed = this.restartPressed = this.invertPitchToggled = this.anyPressed = false;
    this.graphicsNextPressed = this.graphicsPrevPressed = this.overlayToggled = this.flaresPressed = false;
  }
}

/** Analog trigger value 0..1 from a GamepadButton (or a bare number on odd pads). */
function triggerValue(btn) {
  if (btn == null) return 0;
  if (typeof btn === 'number') return btn > 1 ? 1 : btn < 0 ? 0 : btn;
  const v = btn.value;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? 1 : v < 0 ? 0 : v;
  return btn.pressed ? 1 : 0;
}
function isPressed(btn) {
  if (btn == null) return false;
  if (typeof btn === 'number') return btn > 0.5;
  return btn.pressed === true || (typeof btn.value === 'number' && btn.value > 0.5);
}
