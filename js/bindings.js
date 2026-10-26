// js/bindings.js — PROJECT WINGNUT control bindings: gamepad layouts (Mode 2, Ace Combat, Custom), keyboard / mouse key
// bindings, their versioned storage, and the gamepad binding wizard (a pure state machine; js/menu.js draws it).
// Pure module: no DOM beyond localStorage (always inside try/catch).
//
// GAMEPAD MAP: { action: binding | null } for every PAD_ACTIONS id. A binding is
//   { t: 'b', i }            a button (standard-mapping index; analog value 0..1 for triggers), or
//   { t: 'a', i, d, r }      an axis: index i, direction d (+1 / -1: which way counts as "on"), rest r (0 for a centred
//                            stick, -1 or +1 for a trigger that reports as an axis resting at one end).
// An axis action's value is the binding's 0..1 deflection (padValue); js/input.js combines each +/- pair into one signed
// axis (pitch = pitchUp - pitchDown, ...) and applies the per-axis deadzone and stick expo to the result, so the expo
// sliders apply whatever the binding. Start (9), the D-pad (12-15) and Home (16) are reserved: Start always pauses (and,
// held 1 s, cancels the wizard), the D-pad navigates menus and steps the wizard back / forward.
//
// KEYBOARD MAP: { action: [KeyboardEvent.code, ...] } for every KEY_ACTIONS id; the first code is the primary key, the
// rest are alternates. 'Mouse0'..'Mouse4' are mouse buttons and only bind to gun / missile (the actions they fire today).
// Escape is never bindable: it always pauses and cancels a capture.
//
// STORAGE: localStorage 'wingnut.bindings' = { v: BINDINGS_VERSION, pad: map | null, keys: map }. The chosen gamepad layout
// itself is the 'padLayout' setting (js/menu.js settings). Anything unreadable, of another version or invalid falls back
// to the defaults (per entry where possible).

export const BINDINGS_KEY = 'wingnut.bindings';
export const BINDINGS_VERSION = 1;
export const PAD_LAYOUTS = ['mode2', 'ace', 'custom'];
export const RESERVED_BUTTONS = new Set([9, 12, 13, 14, 15, 16]);

/** Gamepad actions in wizard order. pair: the opposite direction of the same flight axis. */
export const PAD_ACTIONS = [
  { id: 'pitchUp', label: 'Pitch up', prompt: 'PITCH UP', hint: 'Nose up: the way you pull to climb.', axis: 'pitch', pair: 'pitchDown' },
  { id: 'pitchDown', label: 'Pitch down', prompt: 'PITCH DOWN', hint: 'Nose down.', axis: 'pitch', pair: 'pitchUp' },
  { id: 'rollRight', label: 'Roll right', prompt: 'ROLL RIGHT', hint: 'Bank to the right.', axis: 'roll', pair: 'rollLeft' },
  { id: 'rollLeft', label: 'Roll left', prompt: 'ROLL LEFT', hint: 'Bank to the left.', axis: 'roll', pair: 'rollRight' },
  { id: 'yawRight', label: 'Rudder right', prompt: 'RUDDER RIGHT', hint: 'Yaw the nose right.', axis: 'yaw', pair: 'yawLeft' },
  { id: 'yawLeft', label: 'Rudder left', prompt: 'RUDDER LEFT', hint: 'Yaw the nose left.', axis: 'yaw', pair: 'yawRight' },
  { id: 'throttleUp', label: 'Boost', prompt: 'BOOST', hint: 'Throttle up.', axis: 'throttle', pair: 'throttleDown' },
  { id: 'throttleDown', label: 'Airbrake', prompt: 'AIRBRAKE', hint: 'Throttle down.', axis: 'throttle', pair: 'throttleUp' },
  { id: 'gun', label: 'Cannon', prompt: 'CANNON', hint: 'Hold to fire the gun.' },
  { id: 'missile', label: 'Missile', prompt: 'MISSILE', hint: 'Fire a missile.' },
  { id: 'target', label: 'Target', prompt: 'TARGET', hint: 'Tap: next target. Hold: padlock view.' },
  { id: 'lookBack', label: 'Look back', prompt: 'LOOK BACK', hint: 'Rear view while held.' },
  { id: 'flares', label: 'Flares', prompt: 'FLARES', hint: 'Decoy incoming missiles.' },
  { id: 'aoaOff', label: 'AOA limiter off', prompt: 'AOA LIMITER OFF', hint: 'Hold: the nose swings free while the jet keeps its momentum.' },
];
export const PAD_IDS = PAD_ACTIONS.map((a) => a.id);
export const PAD_DEF = Object.fromEntries(PAD_ACTIONS.map((a) => [a.id, a]));

const B = (i) => ({ t: 'b', i });
const A = (i, d, r = 0) => ({ t: 'a', i, d, r });
// Standard mapping (https://w3c.github.io/gamepad/#remapping): axes 0 LX, 1 LY, 2 RX, 3 RY (down / right = +);
// buttons 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Menu, 10 L3, 11 R3, 12-15 D-pad, 16 Home.
/** Gamepad layouts. */
export const PAD_PRESETS = Object.freeze({
  // Mode 2 (RC style, the original layout): left stick throttle + rudder, right stick pitch + roll.
  mode2: Object.freeze({
    pitchUp: A(3, 1), pitchDown: A(3, -1), rollRight: A(2, 1), rollLeft: A(2, -1),
    yawRight: A(0, 1), yawLeft: A(0, -1), throttleUp: A(1, -1), throttleDown: A(1, 1),
    gun: B(7), missile: B(6), target: B(5), lookBack: B(4), flares: B(10), aoaOff: B(11),
  }),
  // Ace Combat 7: Skies Unknown default gamepad layout ("Standard" controls, Type A), per Shacknews, "Ace Combat 7
  // controls - PlayStation 4 and Xbox One" (https://www.shacknews.com/article/109486/ace-combat-7-controls-playstation-4-and-xbox-one):
  //   left stick pitch / turn / roll   -> pitch + roll (left stick X rolls: AC7's Expert behaviour, the closest match to our flight model)
  //   right stick camera               -> look back on right stick down (AC7 looks around with it; we only have the rear view)
  //   LB / RB yaw left / right         -> rudder           LT decelerate / RT accelerate -> airbrake / boost
  //   A machine gun                    -> cannon           B missile / weapon             -> missile
  //   Y change target (hold: look at target) -> target (tap: next target, hold: padlock view)
  //   L3 + R3 flare                    -> flares on L3 alone (no chorded bindings here)
  //   R3 change view                   -> AOA limiter off (hold; Project Wingman's R3)
  //   X change weapon, View radar map: no equivalent (left unbound). Menu pauses in both games.
  ace: Object.freeze({
    pitchUp: A(1, 1), pitchDown: A(1, -1), rollRight: A(0, 1), rollLeft: A(0, -1),
    yawRight: B(5), yawLeft: B(4), throttleUp: B(7), throttleDown: B(6),
    gun: B(0), missile: B(1), target: B(3), lookBack: A(3, 1), flares: B(10), aoaOff: B(11),
  }),
});
export const PRESET_NAMES = { mode2: 'Mode 2', ace: 'Ace Combat', custom: 'Custom' };

/** Keyboard / mouse actions (Settings › Controls › Keyboard bindings), in display order. */
export const KEY_ACTIONS = [
  { id: 'pitch-', label: 'Pitch down', simple: 'Boost' },
  { id: 'pitch+', label: 'Pitch up', simple: 'Airbrake' },
  { id: 'roll-', label: 'Roll left' },
  { id: 'roll+', label: 'Roll right' },
  { id: 'yaw-', label: 'Rudder left' },
  { id: 'yaw+', label: 'Rudder right' },
  { id: 'throttle+', label: 'Boost', simple: 'Hard pull' },
  { id: 'throttle-', label: 'Airbrake' },
  { id: 'gun', label: 'Cannon', mouse: true },
  { id: 'missile', label: 'Missile', mouse: true },
  { id: 'target', label: 'Target' },
  { id: 'lookBack', label: 'Look back' },
  { id: 'flares', label: 'Flares' },
  { id: 'aoaOff', label: 'AOA limiter off' },
  { id: 'freeLook', label: 'Free look' },
  { id: 'pause', label: 'Pause' },
  { id: 'fullscreen', label: 'Fullscreen' },
];
export const KEY_IDS = KEY_ACTIONS.map((a) => a.id);
const KEY_DEF = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a]));
export const DEFAULT_KEYS = Object.freeze({
  'pitch-': ['KeyW', 'ArrowUp'], 'pitch+': ['KeyS', 'ArrowDown'],              // push: nose down / pull: nose up
  'roll-': ['KeyA', 'ArrowLeft'], 'roll+': ['KeyD', 'ArrowRight'],
  'yaw-': ['KeyQ'], 'yaw+': ['KeyE'],
  'throttle+': ['ShiftLeft', 'ShiftRight', 'Equal', 'NumpadAdd'],
  'throttle-': ['KeyH', 'Minus', 'NumpadSubtract'],                             // no Ctrl: Ctrl+W would close the browser tab
  gun: ['Space', 'Mouse0'], missile: ['KeyF', 'Mouse2', 'Enter', 'NumpadEnter'],
  target: ['Tab'], lookBack: ['KeyV'], flares: ['KeyX'], aoaOff: ['KeyZ'], freeLook: ['KeyC'], pause: ['KeyP'], fullscreen: ['KeyU'],
});
/** Fixed keys outside the bindings screen (a binding to the same code wins). Escape always pauses. */
export const FIXED_KEYS = Object.freeze({ Escape: 'pause', KeyI: 'invertPitch', KeyR: 'restart', KeyG: 'graphics', Backquote: 'overlay', F9: 'overlay' });
export const UNBINDABLE_KEYS = new Set(['Escape']);
const MOUSE_RE = /^Mouse[0-4]$/;
export const isMouseCode = (c) => MOUSE_RE.test(c);

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------
const BTN_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
const STICKS = ['L stick', 'L stick', 'R stick', 'R stick'];
/** Short name of one binding, e.g. 'RT', 'R stick ↓', 'Axis 5 +'. */
export function describeBinding(b) {
  if (!b) return '—';
  if (b.t === 'b') return BTN_NAMES[b.i] || `Button ${b.i}`;
  if (b.i < 4 && !b.r) return `${STICKS[b.i]} ${b.i % 2 ? (b.d > 0 ? '↓' : '↑') : (b.d > 0 ? '→' : '←')}`;
  return `Axis ${b.i} ${b.d > 0 ? '+' : '−'}`;
}
/** A +/- pair as one label: 'R stick ↑↓' when both halves share a centred axis, else 'LB / RB'. */
export function describePair(a, b) {
  if (a && b && a.t === 'a' && b.t === 'a' && a.i === b.i && !a.r && !b.r && a.d !== b.d) {
    return a.i < 4 ? `${STICKS[a.i]} ${a.i % 2 ? '↑↓' : '←→'}` : `Axis ${a.i}`;
  }
  return `${describeBinding(a)} / ${describeBinding(b)}`;
}
const KEY_NAMES = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Del',
  ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', AltRight: 'R Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Equal: '=', Minus: '-', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .', Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', CapsLock: 'Caps',
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
};
/** Display name of a KeyboardEvent.code (or Mouse0..4). */
export function keyName(code) {
  if (!code) return '—';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit(\d)$/.exec(code); if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code); if (m) return `Num ${m[1]}`;
  return code;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation + storage
// ---------------------------------------------------------------------------------------------------------------
/** A valid copy of one pad binding, or null. */
export function sanitizeBinding(b) {
  if (!b || typeof b !== 'object') return null;
  const i = b.i;
  if (!Number.isInteger(i) || i < 0) return null;
  if (b.t === 'b') return i < 32 && !RESERVED_BUTTONS.has(i) ? { t: 'b', i } : null;
  if (b.t === 'a') {
    if (i >= 16 || (b.d !== 1 && b.d !== -1)) return null;
    const r = b.r === 1 || b.r === -1 ? b.r : 0;
    if (r && r === b.d) return null;                 // an end-resting axis can only move away from its rest
    return { t: 'a', i, d: b.d, r };
  }
  return null;
}
/** Identity of the physical control a binding uses (two actions on the same key conflict). */
export function bindingKey(b) { return !b ? '' : b.t === 'b' ? `b${b.i}` : `a${b.i}${b.d > 0 ? '+' : '-'}`; }
export function sameBinding(a, b) { return bindingKey(a) === bindingKey(b) && (!a || a.t !== 'a' || (a.r || 0) === (b.r || 0)); }
/** Full, valid, conflict-free pad map (unknown actions dropped, missing ones from `fallback`, duplicates cleared). */
export function sanitizePadMap(m, fallback = PAD_PRESETS.mode2) {
  const out = {}, used = new Set();
  for (const id of PAD_IDS) {
    const has = m && typeof m === 'object' && id in m;
    let b = has && m[id] === null ? null : (has && sanitizeBinding(m[id])) || sanitizeBinding(fallback[id]);   // null = unbound; invalid = default
    const k = bindingKey(b);
    if (k && used.has(k)) b = null;
    if (b) used.add(k);
    out[id] = b;
  }
  return out;
}
export function copyPadMap(m) { const o = {}; for (const id of PAD_IDS) o[id] = m && m[id] ? { ...m[id] } : null; return o; }
/** Valid key code for `action` (or false). */
export function validKey(action, code) {
  if (typeof code !== 'string' || !code || code.length > 32 || !/^[A-Za-z0-9]+$/.test(code) || UNBINDABLE_KEYS.has(code)) return false;
  if (isMouseCode(code)) return !!(KEY_DEF[action] && KEY_DEF[action].mouse);
  return true;
}
/** Full, valid key map: each action a list (max 4) of distinct codes, each code used by one action only. */
export function sanitizeKeys(m) {
  const out = {}, used = new Set();
  for (const id of KEY_IDS) {
    const src = m && typeof m === 'object' && Array.isArray(m[id]) ? m[id] : DEFAULT_KEYS[id];
    const list = [];
    for (const c of src) if (validKey(id, c) && !used.has(c) && list.length < 4) { used.add(c); list.push(c); }
    out[id] = list;
  }
  return out;
}
export function defaultBindings() { return { pad: null, keys: sanitizeKeys(DEFAULT_KEYS) }; }
/** { pad: map | null, keys } from storage; defaults when missing, corrupt or of another version. Never throws. */
export function loadBindings(storage) {
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = st ? st.getItem(BINDINGS_KEY) : null;
    if (!raw) return defaultBindings();
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || o.v !== BINDINGS_VERSION) return defaultBindings();
    return { pad: o.pad && typeof o.pad === 'object' ? sanitizePadMap(o.pad) : null, keys: sanitizeKeys(o.keys) };
  } catch { return defaultBindings(); }
}
/** Persist; false when storage is unavailable. */
export function saveBindings(b, storage) {
  try {
    const st = storage || localStorage;
    st.setItem(BINDINGS_KEY, JSON.stringify({ v: BINDINGS_VERSION, pad: b && b.pad ? sanitizePadMap(b.pad) : null, keys: sanitizeKeys(b && b.keys) }));
    return true;
  } catch { return false; }
}
/** The gamepad map in force for a layout. */
export function padMapFor(layout, bindings) {
  if (layout === 'custom') return bindings && bindings.pad ? bindings.pad : PAD_PRESETS.mode2;
  return PAD_PRESETS[layout] || PAD_PRESETS.mode2;
}
/** code -> action for the input layer: fixed keys, then the bindings (which win). */
export function codeMap(keys) {
  const m = { ...FIXED_KEYS };
  for (const id of KEY_IDS) for (const c of (keys && keys[id]) || []) m[c] = id;
  m.Escape = 'pause';
  return m;
}
/** Which action (other than `except`) already uses `code`, and in which slot index. */
export function keyOwner(keys, code, except) {
  for (const id of KEY_IDS) { if (id === except) continue; const i = (keys[id] || []).indexOf(code); if (i >= 0) return { action: id, index: i }; }
  return null;
}
/** Bind `code` into `action`'s slot (0 = primary, 1 = the alternates, replaced by this one key; code null clears the slot).
 *  swap: when another action owns the code it gets this slot's old key in its place (or simply loses the code when the
 *  slot was empty). Returns a new key map. */
export function rebindKey(keys, action, slot, code, swap = true) {
  const k = sanitizeKeys(keys);
  const list = k[action] || [];
  const old = slot === 0 ? (list[0] || null) : (list[1] || null);
  if (code) {
    const own = keyOwner(k, code, action);
    if (own) {
      const ol = k[own.action];
      if (swap && old && validKey(own.action, old)) ol[own.index] = old; else ol.splice(own.index, 1);
      k[own.action] = ol.filter((c, i) => ol.indexOf(c) === i);
    }
  }
  let next;
  if (slot === 0) next = code ? [code, ...list.slice(1).filter((c) => c !== code)] : list.slice(1);
  else next = code ? [list[0], code].filter(Boolean).filter((c, i, a) => a.indexOf(c) === i) : list.slice(0, 1);
  k[action] = next;
  return sanitizeKeys(k);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a pad through a map
// ---------------------------------------------------------------------------------------------------------------
/** 0..1 deflection of one binding from a raw snapshot { axes: number[], buttons: number[] } (button values 0..1). */
export function padValue(b, raw) {
  if (!b || !raw) return 0;
  if (b.t === 'b') { const v = raw.buttons && raw.buttons[b.i]; return typeof v === 'number' && v > 0 ? (v > 1 ? 1 : v) : 0; }
  const x = raw.axes && raw.axes[b.i];
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  const r = b.r || 0, span = b.d > 0 ? 1 - r : 1 + r;
  const v = ((x - r) * b.d) / (span || 1);
  return v <= 0 ? 0 : v > 1 ? 1 : v;
}
/** Swap-aware assignment: returns { map, conflict } where conflict = the action that already used this control (its
 *  binding is replaced by `action`'s previous one when swap is true, cleared otherwise). */
export function assignPad(map, action, b, swap = true) {
  const m = copyPadMap(map), k = bindingKey(b);
  let conflict = null;
  if (k) for (const id of PAD_IDS) if (id !== action && bindingKey(m[id]) === k) { conflict = id; m[id] = swap && m[action] ? { ...m[action] } : null; }
  m[action] = b ? { ...b } : null;
  return { map: m, conflict };
}
export function padConflict(map, action, b) {
  const k = bindingKey(b);
  if (!k) return null;
  for (const id of PAD_IDS) if (id !== action && bindingKey(map[id]) === k) return id;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Gamepad binding wizard (state machine; the menu feeds it raw snapshots and draws its state)
// ---------------------------------------------------------------------------------------------------------------
export const WIZ_DETECT = 0.6;       // movement past rest (as a fraction of the control's travel) that counts as a press
export const WIZ_RELEASE = 0.3;      // back within this of rest = released
export const WIZ_CALIB = 0.5;        // s of resting samples before the first step
export const WIZ_CANCEL_HOLD = 1.0;  // s Start / Menu must be held to cancel
const START = 9, DPAD_L = 14, DPAD_R = 15;

/**
 * phases: 'calib' (keep hands off; measuring rest) -> 'step' (waiting for the input of PAD_ACTIONS[step]) ->
 * 'release' (got one, waiting for everything to return to rest) -> next step ... -> 'test' (live values; save / redo).
 * 'conflict' (the control already belongs to another action: the menu asks swap / pick another, then calls
 * resolveConflict(true|false)). 'cancelled' and 'saved' are terminal. Skip / back: skip(), back() (or D-pad → / ←);
 * Start held 1 s cancels (cancel() for Esc).
 */
export class PadWizard {
  constructor(startMap) {
    this.start = sanitizePadMap(startMap || PAD_PRESETS.mode2);
    this.reset();
  }
  reset() {
    this.map = copyPadMap(this.start);
    this.phase = 'calib'; this.step = 0; this.t = 0;
    this.rest = null; this._acc = null; this._n = 0; this._btnRest = null;
    this.detected = null;      // { binding, label } last accepted (or pending) input
    this.live = null;          // { label, value } strongest current input (readout)
    this.conflict = null;      // { action, with, binding }
    this.auto = {};            // actions filled in automatically as the opposite half of a stick axis
    this.set = {};             // actions bound during this run (only these can conflict; older ones just make way)
    this.startHeld = 0; this._dpadPrev = { l: true, r: true }; this._needRest = true;
  }
  get action() { return PAD_ACTIONS[this.step] || null; }
  get done() { return this.phase === 'test' || this.phase === 'cancelled' || this.phase === 'saved'; }

  cancel() { this.phase = 'cancelled'; }
  skip() { if (this.phase === 'step' || this.phase === 'release' || this.phase === 'conflict') { this.conflict = null; this._advance(); } }
  back() {
    if (this.phase === 'test') { this.phase = 'step'; this._needRest = true; this.step = PAD_ACTIONS.length; }
    if (this.phase !== 'step' && this.phase !== 'release' && this.phase !== 'conflict') return;
    this.conflict = null;
    let s = this.step - 1;
    while (s > 0 && this.auto[PAD_ACTIONS[s].id]) s--;
    if (s < 0) s = 0;
    // stepping back over an auto-filled half undoes it (it is filled or offered again after its partner)
    for (let j = s + 1; j < PAD_ACTIONS.length; j++) {
      const id = PAD_ACTIONS[j].id;
      if (this.auto[id]) { this.map[id] = null; delete this.auto[id]; delete this.set[id]; }
    }
    this.step = s; this.phase = 'step'; this._needRest = true; this.detected = null;
  }
  /** After a conflict prompt: swap (the other action takes this one's previous binding) or try another control. */
  resolveConflict(swap) {
    const c = this.conflict;
    if (!c || this.phase !== 'conflict') return;
    this.conflict = null;
    if (swap) this._accepted(c.binding, c.with);
    else { this.phase = 'step'; this._needRest = true; this.detected = null; }
  }
  /** Save is the menu's job (it reads .map); this only marks the end. */
  finish() { this.phase = 'saved'; }

  /** Live 0..1 value of every action from a raw snapshot (the test screen). */
  values(raw) { const o = {}; for (const id of PAD_IDS) o[id] = padValue(this.map[id], raw); return o; }

  /** Feed one frame: dt in s, raw = { axes, buttons } or null (no pad). */
  update(dt, raw) {
    if (this.done && this.phase !== 'test') return;
    if (!raw) { this.live = null; return; }
    const axes = raw.axes || [], btns = raw.buttons || [];
    // Start / Menu held 1 s cancels (never bindable)
    if ((btns[START] || 0) > 0.5) { this.startHeld += dt; if (this.startHeld >= WIZ_CANCEL_HOLD) { this.cancel(); return; } } else this.startHeld = 0;
    if (this.phase === 'test') return;
    if (this.phase === 'calib') {
      if (!this._acc || this._acc.length !== axes.length) { this._acc = new Array(axes.length).fill(0); this._n = 0; this.t = 0; }
      for (let i = 0; i < axes.length; i++) this._acc[i] += Number(axes[i]) || 0;
      this._n++; this.t += dt;
      if (this.t >= WIZ_CALIB) {
        this.rest = this._acc.map((s) => s / Math.max(1, this._n));
        this._btnRest = btns.map((v) => (v > 0.5 ? 1 : 0));
        this.phase = 'step'; this._needRest = true;
      }
      return;
    }
    // D-pad ← back / → skip, on the press edge
    const dl = (btns[DPAD_L] || 0) > 0.5, dr = (btns[DPAD_R] || 0) > 0.5, P = this._dpadPrev;
    if (dl && !P.l) { P.l = dl; P.r = dr; this.back(); return; }
    if (dr && !P.r) { P.l = dl; P.r = dr; this.skip(); return; }
    P.l = dl; P.r = dr;
    if (this.phase === 'conflict') return;
    const m = this._strongest(axes, btns);
    this.live = m ? { label: describeBinding(m.binding), value: m.dev, binding: m.binding } : null;
    const atRest = !m || m.dev < WIZ_RELEASE;
    if (this.phase === 'release') { if (atRest) this._advance(); return; }
    if (this.phase !== 'step') return;
    if (this._needRest) { if (atRest) this._needRest = false; return; }
    if (!m || m.dev < WIZ_DETECT) return;
    const act = this.action, b = m.binding;
    this.detected = { binding: b, label: describeBinding(b) };
    const other = this._owner(b, act.id);
    if (other && other !== act.pair) {             // its own opposite half simply makes way (it is re-filled next)
      this.conflict = { action: act.id, with: other, binding: b };
      this.phase = 'conflict';
      return;
    }
    this._accepted(b);
  }

  /** Was this axis binding inverted relative to Mode 2 for the same axis? (for the readout) */
  inverted(id, b) {
    const ref = PAD_PRESETS.mode2[id];
    return !!(b && ref && b.t === 'a' && ref.t === 'a' && b.i === ref.i && b.d !== ref.d);
  }

  /** The action bound during this run (other than `except`) that already uses this control. */
  _owner(b, except) {
    const k = bindingKey(b);
    for (const id of PAD_IDS) if (id !== except && this.set[id] && bindingKey(this.map[id]) === k) return id;
    return null;
  }
  /** Bind `id` to `b`. Whatever else held the control makes way: `swapWith` takes `id`'s previous binding, the rest
   *  (old bindings not yet revisited) are cleared. */
  _assign(id, b, swapWith) {
    const k = bindingKey(b), prev = this.map[id];
    for (const o of PAD_IDS) {
      if (o === id || bindingKey(this.map[o]) !== k) continue;
      this.map[o] = o === swapWith && prev && bindingKey(prev) !== k ? { ...prev } : null;
    }
    this.map[id] = { ...b }; this.set[id] = true;
  }
  _accepted(b, swapWith = null) {
    const act = this.action;
    this._assign(act.id, b, swapWith);
    delete this.auto[act.id];
    this.detected = { binding: b, label: describeBinding(b) };
    // a centred stick axis covers both directions: fill the partner too, unless that half is already in use this run
    if (act.pair && b.t === 'a' && !b.r) {
      const p = act.pair, opp = { t: 'a', i: b.i, d: -b.d, r: 0 }, owner = this._owner(opp, p);
      if (PAD_IDS.indexOf(p) > this.step && (!owner || owner === act.id)) { this._assign(p, opp, null); this.auto[p] = true; }
    }
    this.phase = 'release';
  }
  _advance() {
    let s = this.step + 1;
    while (s < PAD_ACTIONS.length && this.auto[PAD_ACTIONS[s].id]) s++;
    this.detected = null;
    if (s >= PAD_ACTIONS.length) { this.step = PAD_ACTIONS.length; this.phase = 'test'; return; }
    this.step = s; this.phase = 'step'; this._needRest = true;
  }
  /** Strongest input past rest: { binding, dev } with dev as a fraction of the control's travel. Buttons win ties
   *  (triggers that report as both a button and an axis bind as the button). */
  _strongest(axes, btns) {
    let btn = null, ax = null;
    for (let i = 0; i < btns.length && i < 32; i++) {
      if (RESERVED_BUTTONS.has(i)) continue;
      const v = Number(btns[i]) || 0, r = this._btnRest ? this._btnRest[i] || 0 : 0;
      const dev = Math.max(0, v - r);
      if (dev > 0 && (!btn || dev > btn.dev)) btn = { binding: { t: 'b', i }, dev };
    }
    for (let i = 0; i < axes.length && i < 16; i++) {
      const x = Number(axes[i]) || 0, r0 = this.rest ? this.rest[i] || 0 : 0;
      const r = Math.abs(r0) > 0.5 ? Math.sign(r0) : 0;          // end-resting (trigger) axis vs. centred stick
      const delta = x - r0;
      if (r && Math.sign(delta) === r) continue;                  // can't move past its rest end
      const dev = Math.min(1, Math.abs(delta) / (r ? 2 : 1));
      if (dev > 0 && (!ax || dev > ax.dev)) ax = { binding: { t: 'a', i, d: delta > 0 ? 1 : -1, r }, dev };
    }
    if (btn && btn.dev >= WIZ_DETECT) return btn;
    const best = !ax ? btn : !btn ? ax : (ax.dev > btn.dev ? ax : btn);
    return best;
  }
}
