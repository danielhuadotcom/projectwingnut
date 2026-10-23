// js/menu.js — PROJECT WINGNUT front end: title, mission select, pause, debrief, settings, controls, credits.
// Pure DOM module (no Three.js). The markup is generated here; every style lives in src/page.html under `.menu`.
//
// Usage (main.js):
//   const settings = loadSettings();                       // merged over DEFAULT_SETTINGS, persisted in 'wingnut.settings'
//   const menu = new Menu(document.querySelector('#ui'), { settings, missions: MISSIONS, onStart, onResume, onRestart,
//                                                         onQuit, onNext, onSetting, onSound, onInfinity });
//   menu.show('title');
//   every frame: input.update(dt); if (menu.open) menu.update(dt, input);
// INFINITY (js/infinity.js), the endless mode: the title lists it under Start Campaign when onInfinity is given (it
// starts a new run), with the local best on its second line. In a run, show('pause', { mode: 'infinity', round })
// offers New Run in place of Restart Mission (onInfinity after a confirm), and the end screen is
// show('debrief', { mode: 'infinity', title, round, roundsCleared, kills, score, best, newBest }) with New Run and Quit.
//
// Navigation works three ways and they can be mixed freely:
//   pointer  hovering highlights an item, click/tap activates it, sliders drag, segments click;
//   keyboard and gamepad through the one-frame edges of js/input.js (menuUp/Down/Left/Right/Confirm/Back, plus
//            pausePressed so Start / P resume from anywhere in the pause menu).
// Focus moves spatially (to the nearest item in the pressed direction), so every responsive layout navigates
// correctly without per-layout tables. On a settings row left/right changes the value (sliders step 5 %, toggles
// flip, choices cycle); the change applies live through onSetting(key, value, settings) and is saved.
// The Menu hides itself before calling onStart / onResume / onRestart / onNext, and shows the title before onQuit.

import { countUnits } from './missions.js';
import { loadBest } from './infinity.js';

// =================================================================================================================
// Settings
// =================================================================================================================
export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'auto', perfOverlay: false, invertPitch: false, mouseSens: 1, mouseKeys: 'simple', touch: 'auto', cameraShake: true, screenFlash: false,
  master: 0.8, music: 0.7, sfx: 0.9, voice: 1.0, subtitles: true, difficulty: 'normal',
});
const STORE_KEY = 'wingnut.settings';
const pct = (v) => `${Math.round(v * 100)}%`;
const times = (v) => `${v.toFixed(2)}×`;

/** Tabs of the Settings screen, in order. */
export const SETTING_TABS = [['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio'], ['gameplay', 'Gameplay']];

/** Schema the Settings screen is rendered from. Labels and copy can be edited here without touching the markup.
 *  type: 'choice' (options [value, label]) | 'toggle' (boolean) | 'slider' (min..max, step for keys/pad, dragStep for pointer).
 *  desc: help line; descs: per-value help line (replaces desc). */
export const SETTING_DEFS = [
  { key: 'quality', tab: 'graphics', type: 'choice', label: 'Quality',
    options: [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
    desc: 'Auto starts from your GPU and steps the level down or up to hold the frame rate.' },
  { key: 'perfOverlay', tab: 'graphics', type: 'toggle', label: 'Performance overlay',
    desc: 'Frame rate, GPU time and render resolution in the top corner.' },
  { key: 'invertPitch', tab: 'controls', type: 'toggle', label: 'Invert pitch',
    desc: 'Push forward to climb, on the stick and the pitch keys.' },
  { key: 'mouseSens', tab: 'controls', type: 'slider', label: 'Mouse sensitivity', min: 0.25, max: 3, step: 0.05, dragStep: 0.05, format: times,
    desc: 'How fast the aim circle follows the mouse.' },
  { key: 'mouseKeys', tab: 'controls', type: 'choice', label: 'Mouse keys',
    options: [['simple', 'Simple'], ['advanced', 'Advanced']],
    descs: { simple: 'Simple: W/S boost and airbrake, Shift pulls hard.', advanced: 'Advanced: W/S pitch, Shift boost, H airbrake.' } },
  { key: 'touch', tab: 'controls', type: 'choice', label: 'Touch controls',
    options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']],
    desc: 'On-screen sticks and buttons. Auto shows them on touch screens.' },
  { key: 'cameraShake', tab: 'controls', type: 'toggle', label: 'Camera shake',
    desc: 'Shake from hits, flak and nearby explosions.' },
  { key: 'screenFlash', tab: 'controls', type: 'toggle', label: 'Screen flash',
    desc: 'White flash from missile hits, flak and nearby explosions.' },
  { key: 'master', tab: 'audio', type: 'slider', label: 'Master volume', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct },
  { key: 'music', tab: 'audio', type: 'slider', label: 'Music', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct },
  { key: 'sfx', tab: 'audio', type: 'slider', label: 'Effects', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct,
    desc: 'Engines, weapons, explosions and cockpit warnings.' },
  { key: 'voice', tab: 'audio', type: 'slider', label: 'Voice', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct,
    desc: 'AWACS radio calls.' },
  { key: 'subtitles', tab: 'audio', type: 'toggle', label: 'AWACS subtitles',
    desc: 'Show radio calls as text on the HUD.' },
  { key: 'difficulty', tab: 'gameplay', type: 'choice', label: 'Difficulty',
    options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['mercenary', 'Merc']],
    descs: {
      easy: 'Easy: tougher airframe, softer and slower bandits, one attacks at a time, their missiles turn wide.',
      normal: 'Normal: the intended balance. Two bandits press the attack at once.',
      hard: 'Hard: you take more damage, bandits are tougher and sharper, four attack at once, extra units on some missions.',
      mercenary: 'Mercenary: no armor bonus, the toughest and sharpest bandits, no limit on attackers, every extra unit. Death awaits.',
    } },
];
const DEF = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d]));

/** Valid value for `key`, or undefined. Numbers are clamped and rounded to 0.01. */
function sanitize(key, v) {
  const d = DEF[key];
  if (!d) return undefined;
  if (d.type === 'toggle') {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1' || v === 1) return true;
    if (v === 'false' || v === '0' || v === 0) return false;
    return undefined;
  }
  if (d.type === 'choice') return d.options.some((o) => o[0] === v) ? v : undefined;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(Math.min(d.max, Math.max(d.min, n)) * 100) / 100;
}

/** Settings from localStorage 'wingnut.settings' merged over DEFAULT_SETTINGS (invalid entries fall back to the default).
 *  First run: picks up the older per-feature keys 'wingnut.quality' and 'wingnut.invertPitch'. Never throws. */
export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') for (const k of Object.keys(s)) { const v = sanitize(k, o[k]); if (v !== undefined) s[k] = v; }
    } else {
      const q = sanitize('quality', localStorage.getItem('wingnut.quality'));
      if (q !== undefined) s.quality = q;
      const ip = localStorage.getItem('wingnut.invertPitch');
      if (ip === '1' || ip === 'true') s.invertPitch = true;
    }
  } catch { /* storage blocked or corrupt: defaults */ }
  return s;
}

/** Persist the known keys of `s`. Returns false when storage is unavailable. */
export function saveSettings(s) {
  try {
    const o = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) { const v = sanitize(k, s && s[k]); o[k] = v === undefined ? DEFAULT_SETTINGS[k] : v; }
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
    return true;
  } catch { return false; }
}

// =================================================================================================================
// Credits (rendered every time the screen opens, so entries pushed later show up)
// =================================================================================================================
export const CREDITS = [
  { section: 'About', lines: [
    'PROJECT WINGNUT: Wingnut and the Loose Screws fly for the Skerry League in the Galebreak Isles, where everyone wants the thunderglass.',
    'An unofficial fan project inspired by arcade flight games such as Project Wingman (Sector D2 / Humble Games). Not affiliated with or endorsed by them. Setting, story, names and aircraft are original.',
  ] },
  { section: 'Engine', lines: [
    'three.js r170, MIT License',
    'WebGL 2 rendering and Web Audio, running entirely in the browser',
  ] },
  { section: 'Mission data', lines: [
    'Per-mission enemy compositions and unit performance figures adapted from community documentation (projectwingman.wiki.gg), scaled down for performance',
  ] },
  { section: 'Voice', lines: [
    '"AWACS Claude" radio calls, voiced with Google text-to-speech (Gemini API)',
  ] },
  { section: 'Music', lines: [
    '"Ceiling Unlimited", an original orchestral theme composed in code for PROJECT WINGNUT',
    'Rendered from the VSCO 2 Community Edition sample library (Versilian Studios / Sam Gossner, CC0)',
  ] },
  { section: 'Sound effects', lines: [
    '"Saab J35D Draken – start engine and taxiing" by Work With Sounds / Torsten Nilsson (Wikimedia Commons, with Wikimedia Sverige), CC BY 4.0, modified',
    '"Canadian CF 18 maneuvers (Quinte International Air Show, CFB Trenton, 2016)" by lonemonk (freesound.org), CC BY 3.0, modified',
    'CC0 sounds by editoredr401, rubberduck, Kenney, Joth, Thimras, qubodup, BMacZero and HaelDB (freesound.org, OpenGameArt.org, kenney.nl)',
    'Warning tones and fallback sounds synthesized in real time with the Web Audio API',
  ] },
];

// =================================================================================================================
// Markup helpers
// =================================================================================================================
const SCREENS = ['title', 'missions', 'pause', 'debrief', 'settings', 'controls', 'credits', 'confirm'];
const ROOTS = new Set(['title', 'pause', 'debrief']);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const gap = (a0, a1, b0, b1) => Math.max(0, b0 - a1, a0 - b1);   // distance between two intervals (0 = overlapping)
function media(q) { try { return typeof matchMedia === 'function' && matchMedia(q).matches; } catch { return false; } }
const missionNo = (m, i) => pad2(m && m.id != null ? m.id : i + 1);
const fmtNum = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString() : '–');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const item = (act, num, label, sub) => `<button type="button" class="m-item" data-nav data-act="${act}">` +
  `<span class="m-num" aria-hidden="true">${num}</span><span class="m-lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>` +
  '<span class="m-chev" aria-hidden="true">›</span></button>';
// Hint glyphs swap between keyboard keycaps and gamepad buttons with the device class on .menu (see page.html)
const hints = (list) => `<div class="m-hints" aria-hidden="true">${list.map(([g, t]) => `<span><i class="m-g m-g-${g}"></i>${t}</span>`).join('')}</div>`;
const hintFoot = (list) => `<footer class="m-foot m-foot--hints">${hints(list)}</footer>`;
const STATUS = '<p class="m-status" role="status"><i class="m-dot" aria-hidden="true"></i><span class="m-status-t"></span></p>';
const backBtn = (nav) => `<button type="button" class="m-back" data-act="back" aria-label="Back"${nav ? ' data-nav' : ''}><span class="m-back-i" aria-hidden="true">‹</span><span class="m-back-t">Back</span></button>`;
const head = (eyebrow, title, id, nav) => `<header class="m-head"><div class="m-headt"><p class="m-eyebrow">${eyebrow}</p>` +
  `<h2 class="m-h2" id="${id}">${title}</h2></div>${backBtn(nav)}</header>`;
const k = (t, pad) => `<kbd class="m-k${pad ? ' m-k--pad' : ''}">${t}</kbd>`;
const binds = (rows) => `<dl class="m-binds">${rows.map(([keys, what]) => `<div><dt>${keys.join('')}</dt><dd>${what}</dd></div>`).join('')}</dl>`;

const PAD_CARD = '<h3>Gamepad <small>Mode 2</small></h3><p class="m-cnote">Xbox or PlayStation layout.</p>' + binds([
  [[k('L stick ↑↓', 1)], 'Boost · airbrake'],
  [[k('L stick ←→', 1)], 'Rudder'],
  [[k('R stick', 1)], 'Pitch · roll <em>(pull back to climb)</em>'],
  [[k('LT', 1)], 'Missile'],
  [[k('RT', 1)], 'Cannon'],
  [[k('RB', 1)], 'Tap: next target · hold: padlock view'],
  [[k('LB', 1)], 'Look back'],
  [[k('L3', 1)], 'Flares <em>(click the left stick)</em>'],
  [[k('Start', 1)], 'Pause'],
]);
const TOUCH_CARD = '<h3>Touch <small>On screen</small></h3><p class="m-cnote">The on-screen sticks and buttons mirror the gamepad.</p>' + binds([
  [[k('Left stick', 1)], '↑ boost · ↓ airbrake · ←→ rudder'],
  [[k('Right stick', 1)], 'Pitch · roll'],
  [[k('Fire buttons', 1)], 'Missile · cannon'],
  [[k('Target', 1)], 'Tap: next target · hold: padlock view'],
  [[k('Flares', 1)], 'Break incoming missiles'],
  [[k('Look back', 1)], 'Rear view while held'],
  [[k('Pause', 1)], 'This menu'],
]) + '<p class="m-cfoot">Show or hide them in Settings › Controls › Touch controls.</p>';
function kbCard(simple) {
  return `<h3>Mouse &amp; keyboard <small>${simple ? 'Simple keys' : 'Advanced keys'}</small></h3>` +
    '<p class="m-cnote">Mouse aim: the jet flies toward the circle.</p>' + binds([
      [[k('Mouse')], 'Aim'],
      [[k('LMB'), k('Space')], 'Cannon'],
      [[k('RMB'), k('F')], 'Missile'],
      [[k('W'), k('S')], simple ? 'Boost · airbrake' : 'Pitch <em>(S pulls up)</em>'],
      [[k('A'), k('D')], 'Roll'],
      [[k('Q'), k('E')], 'Rudder'],
      [[k('Shift')], simple ? 'Hard pull' : 'Boost'],
      ...(simple ? [] : [[[k('H')], 'Airbrake']]),
      [[k('X')], 'Flares'],
      [[k('Tab')], 'Tap: next target · hold: padlock view'],
      [[k('C')], 'Free look <em>(hold)</em>'],
      [[k('V')], 'Look back'],
      [[k('P'), k('Esc')], 'Pause'],
    ]) + '<p class="m-cfoot">Key preset: Settings › Controls › Mouse keys.</p>';
}

/** Debrief stats: [[label, value], ...], or a string like 'SCORE 12,400 · KILLS 14' split into chips. */
function statItems(stats) {
  if (Array.isArray(stats)) return stats.map((s) => (Array.isArray(s) ? [String(s[0] ?? ''), String(s[1] ?? '')] : ['', String(s)]));
  if (typeof stats !== 'string' || !stats.trim()) return [];
  return stats.split(/\s*[·|•]\s*/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^(.*?[^\d\s,.])\s+(\d[\d,.:%]*\S*)$/);
    return m ? [m[1], m[2]] : ['', p];
  });
}

// =================================================================================================================
// Menu
// =================================================================================================================
export class Menu {
  /**
   * @param {HTMLElement} rootEl  #ui; the menu container is inserted as its first child (so #loading/#perf/#err stay on top)
   * @param {object} opts { settings, missions, onStart(i), onResume(), onRestart(), onQuit(), onNext(),
   *                        onSetting(key, value, settings), onSound(kind), onInfinity() }
   *                        kind: 'move' | 'adjust' | 'select' | 'back'; without onInfinity the title has no INFINITY entry
   */
  constructor(rootEl, opts = {}) {
    this.root = rootEl || document.body;
    this.opts = opts || {};
    const s = this.opts.settings;
    /** The live settings object (the one passed in, mutated in place, so the game can read it directly). */
    this.settings = s && typeof s === 'object' && !Object.isFrozen(s) ? s : loadSettings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const v = sanitize(key, this.settings[key]);
      this.settings[key] = v === undefined ? DEFAULT_SETTINGS[key] : v;
    }
    this.missions = Array.isArray(this.opts.missions) ? this.opts.missions : [];
    this._stack = [];           // [{ screen, focus }] ; focus = element to restore when returning to that screen
    this._cur = null;           // current screen element
    this._focusEl = null;       // the highlighted item (pointer hover or keyboard/gamepad focus)
    this._lock = 0;             // s during which update() ignores input (opening, debrief)
    this._tab = 'graphics';
    this._missionSel = 0; this._detailFor = -1; this._missionIndex = -1;
    this._deb = { canNext: false, infinity: false }; this._pending = null; this._pauseInf = false;
    this._dirty = false; this._saveT = 0; this._drag = null; this._px = -1; this._py = -1;
    this._device = '';
    this._reduced = media('(prefers-reduced-motion: reduce)');
    this._build();
    this._setDevice(media('(hover: none) and (pointer: coarse)') ? 'touch' : 'kb');
    this._bind();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------------------------
  /** Any menu visible. */
  get open() { return !!this.el && !this.el.hidden; }
  /** 'title' | 'missions' | 'pause' | 'debrief' | 'settings' | 'controls' | 'credits' | 'confirm', or null when closed. */
  get screen() { return this.open && this._stack.length ? this._stack[this._stack.length - 1].screen : null; }

  /**
   * Show a screen. title / pause / debrief start a fresh stack; the others stack on top of whatever is open
   * (Back returns there), or stand alone when the menu was closed (Back then closes the menu and calls onResume).
   * data: pause { missionIndex?, subtitle? } or { mode: 'infinity', round } ·
   *       debrief { title, stats, canNext, success?, eyebrow?, subtitle?, missionIndex? } or
   *               { mode: 'infinity', title, round, roundsCleared, kills, score, best, newBest, stats? } ·
   *       missions { selected? } · settings { tab? }
   */
  show(screen, data) {
    if (!SCREENS.includes(screen)) return;
    const wasOpen = this.open;
    if (wasOpen && screen === this.screen) {
      if (screen === 'debrief') { this._lock = 0.8; this._lockUntil = performance.now() + 800; }
      this._enter(screen, data || {}, false);
      return;
    }
    if (!wasOpen || ROOTS.has(screen)) this._stack = [{ screen, focus: null }];
    else { this._saveFocus(); this._stack.push({ screen, focus: null }); }
    // Ignore input briefly so the key that opened the menu (Esc also sends menuBack) or a mashed fire button
    // (Space is gun and confirm) doesn't act on it straight away.
    this._lock = screen === 'debrief' ? 0.8 : (wasOpen ? 0 : 0.25);
    this._lockUntil = performance.now() + this._lock * 1000;   // wall-clock, so slow frames can't stretch it
    this.el.hidden = false;
    this._enter(screen, data || {}, false);
  }

  hide() {
    this._flushSave();
    this._drag = null;
    const ae = document.activeElement;
    if (ae && this.el.contains(ae) && ae.blur) ae.blur();
    if (this._focusEl) this._focusEl.classList.remove('is-focus');
    this._focusEl = null; this._cur = null; this._stack = []; this._pending = null;
    this.el.hidden = true;
  }

  /** Feed the frame's input edges (js/input.js). No-op while closed. */
  update(dt, input) {
    if (!this.open || !input) return;
    if (performance.now() < (this._lockUntil || 0)) return;
    const edge = input.menuBack ? 'back' : input.menuConfirm ? 'ok' : input.menuUp ? 'up' : input.menuDown ? 'down'
      : input.menuLeft ? 'left' : input.menuRight ? 'right' : null;
    // Hint glyphs: switch on a real navigation edge. input.js also reports the on-screen touch sticks as a gamepad,
    // so without an edge only an actually connected pad may flip the hints away from keyboard glyphs.
    if (edge) this._setDevice(input.usingGamepad ? 'pad' : 'kb');
    else if (input.usingGamepad && input.gamepadConnected && this._device === 'kb') this._setDevice('pad');
    if (edge) this._nav(edge);
    else if (input.pausePressed && this._stack.length && this._stack[0].screen === 'pause') this._run('onResume');  // Start / P
  }

  /** Controller line on the title and pause screens. ok = connected (cyan) vs. warning (amber). Empty text hides it. */
  setControllerStatus(text, ok) {
    const t = String(text ?? '');
    for (const p of this._statusEls) {
      p.querySelector('.m-status-t').textContent = t;
      p.classList.toggle('ok', !!ok);
      p.hidden = !t;
    }
  }

  /** Graphics level actually in use, shown beside the Quality setting (e.g. 'AUTO · MEDIUM'). */
  setQualityLabel(text) {
    if (!this._qlabel) return;
    this._qlabel.textContent = String(text ?? '');
    this._qlabel.hidden = !text;
  }

  /** Small hint under the title menu (e.g. 'Click or press a key once to enable sound'). Empty hides it. */
  setTip(text) { if (this._tipEl) { this._tipEl.textContent = String(text ?? ''); this._tipEl.hidden = !text; } }

  /** Change a setting from outside (hotkeys) so the menu stays in sync. Saves; calls onSetting only if notify. */
  setSetting(key, value, notify = false) { return this._set(key, value, notify); }

  /** Force the hint glyph set: 'kb' (keyboard + mouse) | 'pad' | 'touch' (hints hidden). Normally automatic. */
  setDevice(kind) { this._setDevice(kind); }

  dispose() {
    this._flushSave();
    const el = this.el, h = this._h;
    if (h) {
      el.removeEventListener('pointerdown', h.down);
      el.removeEventListener('pointermove', h.move);
      el.removeEventListener('pointerup', h.up);
      el.removeEventListener('pointercancel', h.up);
      el.removeEventListener('click', h.click);
      el.removeEventListener('dblclick', h.dbl);
      for (const t of ['mousedown', 'touchstart', 'wheel']) el.removeEventListener(t, h.stop);
      window.removeEventListener('keydown', h.key);
      window.removeEventListener('keyup', h.key);
      window.removeEventListener('pagehide', h.flush);
    }
    this._h = null;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    this._stack = []; this._cur = null; this._focusEl = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------------------------------------------
  _build() {
    const el = this.el = document.createElement('div');
    el.className = 'menu'; el.id = 'menu'; el.hidden = true;
    // Taps on the panels are handled here; js/touch.js must not also turn them into confirm / back pulses (a tap on
    // the briefing text would launch the selected mission, a tap on the credits text would leave the screen).
    el.setAttribute('data-touch-ignore', '');
    el.innerHTML = '<div class="m-scrim" aria-hidden="true"></div>' + this._htmlTitle() + this._htmlMissions() + this._htmlPause() +
      this._htmlDebrief() + this._htmlSettings() + this._htmlControls() + this._htmlCredits() + this._htmlConfirm();
    this.root.insertBefore(el, this.root.firstChild);
    const q = (sel, r = el) => r.querySelector(sel);
    this._screens = {};
    for (const n of SCREENS) this._screens[n] = q(`[data-screen="${n}"]`);
    this._statusEls = [...el.querySelectorAll('.m-status')];
    this._tipEl = q('.m-tip'); this._qlabel = q('.m-qlabel');
    const M = this._screens.missions;
    this._detail = {
      el: q('.m-detail', M), eye: q('.m-d-eye', M), name: q('.m-dname', M), loc: q('.m-d-loc', M), chip: q('.m-d-chip', M),
      brief: q('.m-brief', M), stats: q('.m-stats', M), note: q('.m-note', M),
    };
    const D = this._screens.debrief;
    this._debEls = { eye: q('.m-deb-eye', D), title: q('.m-deb-title', D), sub: q('.m-deb-sub', D), stats: q('.m-deb-stats', D),
      next: q('[data-act="next"]', D), retry: q('[data-act="retry"]', D), missions: q('[data-act="missions"]', D), run: q('[data-act="infinity"]', D) };
    this._pauseSub = q('.m-pause-sub', this._screens.pause);
    this._pauseRestart = q('[data-act="restart"] .m-lbl', this._screens.pause);
    this._infSub = q('[data-act="infinity"] .m-lbl small', this._screens.title);
    this._kbCard = q('.m-card--kb'); this._creditsEl = q('.m-credits');
    const C = this._screens.confirm;
    this._cf = { title: q('.m-h2', C), text: q('.m-lede', C), yes: q('[data-act="confirm-yes"]', C) };
    this._setTab(this._tab);
    this._syncAllRows();
    this._renderKb();
    this.setControllerStatus('Looking for a controller…', false);
  }

  _htmlTitle() {
    const m0 = this.missions[0];
    const entries = [['start', 'Start Campaign', m0 ? `Mission ${missionNo(m0, 0)} · ${m0.name || ''}` : '']];
    if (typeof this.opts.onInfinity === 'function') entries.push(['infinity', 'Infinity', this._infinityLine()]);
    entries.push(['missions', 'Mission Select'], ['settings', 'Settings'], ['controls', 'Controls'], ['credits', 'Credits']);
    return `<section class="m-screen m-title" data-screen="title" data-wrap aria-labelledby="m-title-h" hidden>
      <div class="m-panel m-panel--title">
        <p class="m-eyebrow">Arcade jet combat</p>
        <h1 class="m-logo" id="m-title-h"><span class="m-logo-1">Project</span><span class="m-logo-2">Wingnut</span></h1>
        <p class="m-tagline">The Galebreak Isles. Twenty-one sorties. Own the sky.</p>
        <div class="m-rule" aria-hidden="true"></div>
        <nav class="m-list" aria-label="Main menu">
          ${entries.map(([act, label, sub], i) => item(act, pad2(i + 1), label, sub)).join('')}
        </nav>
        <footer class="m-foot">${STATUS}<p class="m-tip" hidden></p>${hints([['ud', 'Select'], ['ok', 'Confirm']])}</footer>
      </div></section>`;
  }

  _htmlMissions() {
    const rows = this.missions.map((m, i) => `<button type="button" class="m-mis" role="option" aria-selected="false" data-nav data-group="missions" data-nohover data-right="[data-act=launch]" data-mission="${i}">` +
      `<span class="m-mis-n">${missionNo(m, i)}</span><span class="m-mis-name">${esc(m.name || `Mission ${i + 1}`)}</span>` +
      `<span class="m-mis-loc">${esc(m.location || m.setting || '')}</span></button>`).join('');
    return `<section class="m-screen" data-screen="missions" aria-labelledby="m-mis-h" hidden>
      <div class="m-panel m-panel--wide m-panel--missions">
        ${head(`Campaign · ${this.missions.length} sorties`, 'Mission Select', 'm-mis-h', false)}
        <div class="m-mbody">
          <div class="m-mlist m-scroll" role="listbox" aria-label="Missions">${rows}</div>
          <article class="m-detail m-scroll" aria-live="polite">
            <p class="m-eyebrow m-d-eye"></p>
            <h3 class="m-dname"></h3>
            <p class="m-dloc"><span class="m-d-loc"></span><span class="m-chip m-d-chip"></span></p>
            <p class="m-brief"></p>
            <div class="m-stats"></div>
            <p class="m-note" hidden></p>
            <div class="m-dact"><button type="button" class="m-btn primary" data-nav data-act="launch" data-left="[data-group=missions][aria-selected=true]">Launch <span aria-hidden="true">›</span></button></div>
          </article>
        </div>
        ${hintFoot([['ud', 'Mission'], ['ok', 'Launch'], ['back', 'Back']])}
      </div></section>`;
  }

  _htmlPause() {
    return `<section class="m-screen" data-screen="pause" data-wrap aria-labelledby="m-pause-h" hidden>
      <div class="m-panel m-panel--menu">
        <p class="m-eyebrow">Mission hold</p>
        <h2 class="m-h2" id="m-pause-h">Paused</h2>
        <p class="m-sub m-pause-sub" hidden></p>
        <div class="m-rule" aria-hidden="true"></div>
        <nav class="m-list" aria-label="Pause menu">
          ${item('resume', '01', 'Resume')}
          ${item('restart', '02', 'Restart Mission')}
          ${item('settings', '03', 'Settings')}
          ${item('controls', '04', 'Controls')}
          ${item('quit', '05', 'Quit to Title')}
        </nav>
        <footer class="m-foot">${STATUS}${hints([['ud', 'Select'], ['ok', 'Confirm'], ['back', 'Resume']])}</footer>
      </div></section>`;
  }

  _htmlDebrief() {
    return `<section class="m-screen m-debrief" data-screen="debrief" aria-labelledby="m-deb-h" hidden>
      <div class="m-panel m-panel--debrief">
        <p class="m-eyebrow m-deb-eye"></p>
        <h2 class="m-h2 m-deb-title" id="m-deb-h"></h2>
        <p class="m-sub m-deb-sub" hidden></p>
        <div class="m-deb-stats"></div>
        <div class="m-actions">
          <button type="button" class="m-btn" data-nav data-act="retry">Retry</button>
          <button type="button" class="m-btn" data-nav data-act="infinity" hidden>New Run</button>
          <button type="button" class="m-btn" data-nav data-act="next">Next Mission <span aria-hidden="true">›</span></button>
          <button type="button" class="m-btn" data-nav data-act="missions">Mission Select</button>
          <button type="button" class="m-btn" data-nav data-act="quit">Quit to Title</button>
        </div>
        ${hintFoot([['ud', 'Select'], ['ok', 'Confirm']])}
      </div></section>`;
  }

  _htmlRow(d) {
    const id = `m-set-${d.key}`;
    let role, ctl;
    if (d.type === 'slider') {
      role = `role="slider" aria-valuemin="${d.min}" aria-valuemax="${d.max}"`;
      ctl = '<div class="m-slider" aria-hidden="true"><div class="m-trk"><div class="m-fill"></div></div><div class="m-thumb"></div></div>' +
        '<output class="m-val" aria-hidden="true"></output>';
    } else {
      const toggle = d.type === 'toggle', opts = toggle ? [['false', 'Off'], ['true', 'On']] : d.options;
      role = toggle ? 'role="switch"' : 'role="radiogroup"';
      ctl = `<div class="m-seg"${toggle ? ' aria-hidden="true"' : ''}>` + opts.map(([v, t]) =>
        `<button type="button" tabindex="-1"${toggle ? '' : ' role="radio"'} data-val="${esc(v)}">${esc(t)}</button>`).join('') + '</div>';
    }
    return `<div class="m-row m-row--${d.type}" data-nav data-key="${d.key}" tabindex="-1" ${role} aria-labelledby="${id}" aria-describedby="${id}-d">` +
      `<div class="m-rowt"><span class="m-label" id="${id}">${esc(d.label)}</span>` +
      (d.key === 'quality' ? '<span class="m-badge m-qlabel" title="Graphics level in use" hidden></span>' : '') + '</div>' +
      `<p class="m-desc" id="${id}-d"></p><div class="m-ctl">${ctl}</div></div>`;
  }

  _htmlSettings() {
    const tabs = SETTING_TABS.map(([id, label]) => `<button type="button" class="m-tab" role="tab" id="m-tab-${id}" aria-controls="m-tp-${id}" ` +
      `aria-selected="false" data-nav data-group="tabs" data-nohover data-tab="${id}">${esc(label)}</button>`).join('');
    const panels = SETTING_TABS.map(([id]) => `<div class="m-tabpanel" role="tabpanel" id="m-tp-${id}" aria-labelledby="m-tab-${id}" data-tabpanel="${id}" hidden>` +
      SETTING_DEFS.filter((d) => d.tab === id).map((d) => this._htmlRow(d)).join('') +
      '<div class="m-rowfoot"><button type="button" class="m-btn m-btn--sm" data-nav data-act="reset-tab">Restore defaults</button></div></div>').join('');
    return `<section class="m-screen" data-screen="settings" aria-labelledby="m-set-h" hidden>
      <div class="m-panel m-panel--settings">
        ${head('Options · auto-saved', 'Settings', 'm-set-h', false)}
        <div class="m-tabs" role="tablist" aria-label="Settings sections">${tabs}</div>
        <div class="m-body m-scroll">${panels}</div>
        ${hintFoot([['ud', 'Select'], ['lr', 'Adjust'], ['back', 'Back']])}
      </div></section>`;
  }

  _htmlControls() {
    return `<section class="m-screen" data-screen="controls" aria-labelledby="m-ctl-h" hidden>
      <div class="m-panel m-panel--wide m-panel--controls">
        ${head('Flight manual', 'Controls', 'm-ctl-h', true)}
        <div class="m-body m-scroll"><div class="m-cards">
          <article class="m-card">${PAD_CARD}</article>
          <article class="m-card m-card--kb"></article>
          <article class="m-card">${TOUCH_CARD}</article>
        </div></div>
        ${hintFoot([['ud', 'Scroll'], ['back', 'Back']])}
      </div></section>`;
  }

  _htmlCredits() {
    return `<section class="m-screen" data-screen="credits" aria-labelledby="m-cr-h" hidden>
      <div class="m-panel m-panel--credits">
        ${head('Project Wingnut', 'Credits', 'm-cr-h', true)}
        <div class="m-body m-scroll"><div class="m-credits"></div></div>
        ${hintFoot([['ud', 'Scroll'], ['back', 'Back']])}
      </div></section>`;
  }

  _htmlConfirm() {
    return `<section class="m-screen" data-screen="confirm" role="alertdialog" aria-modal="true" aria-labelledby="m-cf-h" aria-describedby="m-cf-d" hidden>
      <div class="m-panel m-panel--confirm">
        <p class="m-eyebrow">Confirm</p>
        <h2 class="m-h2" id="m-cf-h"></h2>
        <p class="m-lede" id="m-cf-d"></p>
        <div class="m-actions m-actions--row">
          <button type="button" class="m-btn danger" data-nav data-act="confirm-yes"></button>
          <button type="button" class="m-btn" data-nav data-act="back">Cancel</button>
        </div>
        ${hintFoot([['lr', 'Select'], ['ok', 'Confirm'], ['back', 'Cancel']])}
      </div></section>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Screen state
  // ---------------------------------------------------------------------------------------------------------------
  _saveFocus() { const top = this._stack[this._stack.length - 1]; if (top) top.focus = this._focusEl; }

  _push(screen, data) {
    this._saveFocus();
    this._stack.push({ screen, focus: null });
    this._enter(screen, data || {}, false);
    this._sound('select');
  }

  /** Make `screen` (top of the stack) visible and focus its default item, or the remembered one when returning. */
  _enter(screen, data, restoring) {
    if (data && Number.isInteger(data.missionIndex)) this._missionIndex = data.missionIndex;
    if (!restoring) {
      if (screen === 'missions') {
        const sel = data && Number.isInteger(data.selected) ? data.selected : (this._missionIndex >= 0 ? this._missionIndex : this._missionSel);
        this._selectMission(sel);
      } else if (screen === 'title') this._refreshInfinity();
      else if (screen === 'pause') this._setPause(data);
      else if (screen === 'debrief') this._setDebrief(data);
      else if (screen === 'settings') { if (data && data.tab) this._setTab(data.tab); this._syncAllRows(); }
      else if (screen === 'controls') this._renderKb();
      else if (screen === 'credits') this._renderCredits();
      else if (screen === 'confirm') this._setConfirm(data);
    }
    this._render();
    const entry = this._stack[this._stack.length - 1];
    let f = restoring && entry ? entry.focus : null;
    if (!f || !f.isConnected || !this._cur.contains(f) || !f.getClientRects().length) f = this._defaultFocus(screen);
    if (this._focusEl) this._focusEl.classList.remove('is-focus');
    this._focusEl = null;
    if (f) this._focus(f, { silent: true });
    if (!restoring && screen !== 'settings') { const b = this._cur.querySelector('.m-body'); if (b) b.scrollTop = 0; }
  }

  _render() {
    const top = this.screen;
    const under = top === 'confirm' && this._stack.length > 1 ? this._stack[this._stack.length - 2].screen : null;
    for (const name of SCREENS) {
      const el = this._screens[name], vis = name === top || name === under;
      if (el.hidden === vis) el.hidden = !vis;
      el.classList.toggle('m-under', name === under);
      el.inert = name === under;
    }
    this._cur = this._screens[top] || null;
    this.el.dataset.screen = top || '';
    this.el.dataset.scrim = top === 'title' ? 'title' : 'dim';
  }

  _defaultFocus(screen) {
    const S = this._screens[screen];
    if (!S) return null;
    const q = (sel) => S.querySelector(sel);
    switch (screen) {
      case 'title': return q('[data-act="start"]');
      case 'missions': return q(`[data-mission="${this._missionSel}"]`) || q('[data-act="launch"]');
      case 'pause': return q('[data-act="resume"]');
      case 'debrief': return q(this._deb.infinity ? '[data-act="infinity"]' : this._deb.canNext ? '[data-act="next"]' : '[data-act="retry"]');
      case 'settings': return q(`[data-tab="${this._tab}"]`);
      default: return q('[data-act="back"]');      // controls, credits, confirm (Cancel)
    }
  }

  _setPause(d) {
    const inf = this._pauseInf = !!(d && d.mode === 'infinity');
    const i = d && Number.isInteger(d.missionIndex) ? d.missionIndex : this._missionIndex;
    const m = this.missions[i];
    const txt = (d && d.subtitle) || (inf ? `Infinity${Number(d.round) > 0 ? ` · Round ${Number(d.round)}` : ''}`
      : m ? `Mission ${missionNo(m, i)} · ${m.name || ''}` : '');
    this._pauseSub.textContent = txt; this._pauseSub.hidden = !txt;
    this._pauseRestart.textContent = inf ? 'New Run' : 'Restart Mission';
  }

  /** Second line of the title's INFINITY entry: the local best (js/infinity.js loadBest never throws). */
  _infinityLine() {
    let b = null;
    try { b = loadBest(); } catch { b = null; }
    return b ? `Best ${fmtNum(b.score)} · ${plural(b.rounds, 'round', 'rounds')}` : 'Endless rounds · one life';
  }
  _refreshInfinity() { if (this._infSub) this._infSub.textContent = this._infinityLine(); }

  _setDebrief(d = {}) {
    const E = this._debEls, inf = d.mode === 'infinity', canNext = !inf && !!d.canNext;
    const win = d.success != null ? !!d.success : canNext;
    this._deb = { canNext, infinity: inf };
    this._screens.debrief.classList.toggle('is-win', win);
    this._screens.debrief.classList.toggle('is-fail', !win);
    E.title.textContent = d.title || (win ? 'Mission accomplished' : 'Shot down');
    let sub, items;
    if (inf) {
      // INFINITY run over: rounds cleared, kills, score and the local best; New Run or Quit (no retry: one life)
      E.eye.textContent = d.eyebrow || 'Infinity · run over';
      const round = Number(d.round);
      sub = d.subtitle || [round > 0 ? `Round ${round}` : '', d.newBest ? 'New local best' : ''].filter(Boolean).join(' · ');
      const best = d.best && typeof d.best === 'object' ? d.best.score : d.best;
      items = d.stats ? statItems(d.stats) : [['Rounds cleared', fmtNum(d.roundsCleared ?? 0)], ['Kills', fmtNum(d.kills ?? 0)],
        ['Score', fmtNum(d.score ?? 0)], ['Best', Number(best) > 0 ? fmtNum(best) : '–']];
    } else {
      E.eye.textContent = d.eyebrow || (win ? 'Mission complete' : 'Mission failed');
      const i = Number.isInteger(d.missionIndex) ? d.missionIndex : this._missionIndex, m = this.missions[i];
      sub = d.subtitle || (m ? `Mission ${missionNo(m, i)} · ${m.name || ''}` : '');
      items = statItems(d.stats);
    }
    E.sub.textContent = sub; E.sub.hidden = !sub;
    E.stats.innerHTML = items.map(([label, value]) => `<div class="m-stat">${label ? `<span>${esc(label)}</span>` : ''}<b>${esc(value)}</b></div>`).join('');
    E.stats.hidden = !items.length;
    E.next.hidden = !canNext;
    E.next.classList.toggle('primary', canNext);
    E.retry.hidden = inf; E.missions.hidden = inf; E.run.hidden = !inf;
    E.retry.classList.toggle('primary', !canNext && !inf);
    E.run.classList.toggle('primary', inf);
  }

  _setConfirm(d) {
    const kind = (d && d.kind) || this._pending || 'quit', inf = this._pauseInf;
    const T = kind === 'restart'
      ? (inf ? ['Start a new run?', 'This run ends here and a new one starts at round 1.', 'New Run']
        : ['Restart mission?', 'The mission starts over from the beginning.', 'Restart'])
      : (inf ? ['Quit to title?', 'This run ends here.', 'Quit'] : ['Quit to title?', 'Progress in this mission will be lost.', 'Quit']);
    this._cf.title.textContent = T[0]; this._cf.text.textContent = T[1]; this._cf.yes.textContent = T[2];
  }

  _setTab(tab) {
    if (!SETTING_TABS.some(([t]) => t === tab)) return;
    this._tab = tab;
    const S = this._screens.settings;
    for (const b of S.querySelectorAll('.m-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of S.querySelectorAll('.m-tabpanel')) p.hidden = p.dataset.tabpanel !== tab;
    const body = S.querySelector('.m-body'); if (body) body.scrollTop = 0;
  }

  _firstInTab() {
    const p = this._screens.settings.querySelector(`[data-tabpanel="${this._tab}"]`);
    return p ? p.querySelector('[data-nav]') : null;
  }

  _selectMission(i) {
    const n = this.missions.length;
    if (!n) return;
    i = clamp(i | 0, 0, n - 1);
    this._missionSel = i;
    for (const b of this._screens.missions.querySelectorAll('.m-mis')) b.setAttribute('aria-selected', String(+b.dataset.mission === i));
    if (this._detailFor !== i) { this._renderDetail(i); this._detailFor = i; }
  }

  _renderDetail(i) {
    const m = this.missions[i], D = this._detail;
    if (!m) return;
    D.eye.textContent = `Mission ${missionNo(m, i)}` + (m.time ? ` · ${m.time} local` : '');
    D.name.textContent = m.name || `Mission ${i + 1}`;
    D.loc.textContent = m.location || '';
    D.chip.textContent = m.setting || ''; D.chip.hidden = !m.setting;
    D.brief.textContent = m.briefing || '';
    // Briefing and target counts only: phase counts and labels would give away how the mission unfolds.
    let n = null;
    try { n = countUnits(m, this.settings.difficulty); } catch { n = null; }
    const cells = [['Air', n && n.air], ['Ground', n && n.ground], ['Naval', n && n.naval]];
    D.stats.innerHTML = cells.map(([label, v]) => `<div${v ? '' : ' class="is-zero"'}><b>${v == null ? '–' : v}</b><span>${label}</span></div>`).join('');
    D.note.textContent = n && n.optional ? `Includes ${n.optional} optional target${n.optional === 1 ? '' : 's'}.` : '';
    D.note.hidden = !(n && n.optional);
    D.el.scrollTop = 0;
  }

  _renderKb() { if (this._kbCard) this._kbCard.innerHTML = kbCard(this.settings.mouseKeys !== 'advanced'); }

  _renderCredits() {
    this._creditsEl.innerHTML = CREDITS.map((c) => `<section class="m-credit"><h3>${esc(c && c.section)}</h3><div>` +
      ((c && Array.isArray(c.lines)) ? c.lines : []).map((l) => `<p>${esc(l)}</p>`).join('') + '</div></section>').join('');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings rows
  // ---------------------------------------------------------------------------------------------------------------
  _syncAllRows() { for (const d of SETTING_DEFS) this._syncRow(d.key); }

  _syncRow(key) {
    const d = DEF[key], row = this.el.querySelector(`.m-row[data-key="${key}"]`);
    if (!d || !row) return;
    const v = this.settings[key];
    if (d.type === 'slider') {
      const txt = d.format ? d.format(v) : String(v);
      row.style.setProperty('--p', `${((v - d.min) / (d.max - d.min)) * 100}%`);
      row.querySelector('.m-val').textContent = txt;
      row.setAttribute('aria-valuenow', String(v)); row.setAttribute('aria-valuetext', txt);
    } else {
      const sv = String(v);
      for (const b of row.querySelectorAll('.m-seg button')) {
        const on = b.dataset.val === sv;
        b.classList.toggle('is-on', on);
        if (d.type === 'choice') b.setAttribute('aria-checked', String(on));
      }
      if (d.type === 'toggle') row.setAttribute('aria-checked', String(!!v));
    }
    const desc = (d.descs && d.descs[v]) || d.desc || '', de = row.querySelector('.m-desc');
    if (de.textContent !== desc) de.textContent = desc;
    de.hidden = !desc;
  }

  /** Validate, store, refresh the row, queue a save, notify. Returns true when the value changed. */
  _set(key, value, notify = true) {
    const v = sanitize(key, value);
    if (v === undefined || this.settings[key] === v) return false;
    this.settings[key] = v;
    this._syncRow(key);
    if (key === 'mouseKeys') this._renderKb();
    if (key === 'difficulty' && this._detailFor >= 0) this._renderDetail(this._detailFor);   // unit counts depend on it
    this._dirty = true;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this._flushSave(), 300);
    if (notify) this._cb('onSetting', key, v, this.settings);
    return true;
  }
  _change(key, v) { if (this._set(key, v)) this._sound('adjust'); }

  _step(key, dir) {
    const d = DEF[key], v = this.settings[key];
    if (!d) return;
    if (d.type === 'toggle') this._change(key, !v);
    else if (d.type === 'choice') {
      const n = d.options.length, i = Math.max(0, d.options.findIndex((o) => o[0] === v));
      this._change(key, d.options[(i + dir + n) % n][0]);
    } else this._change(key, Math.round((v + dir * d.step) / d.step) * d.step);
  }

  _resetTab() {
    let changed = false;
    for (const d of SETTING_DEFS) if (d.tab === this._tab) changed = this._set(d.key, DEFAULT_SETTINGS[d.key]) || changed;
    this._sound(changed ? 'adjust' : 'select');
  }

  _flushSave() {
    clearTimeout(this._saveT); this._saveT = 0;
    if (this._dirty) { this._dirty = false; saveSettings(this.settings); }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------------------------------------------
  _nav(edge) {
    this._setKbNav(true);
    if (edge === 'back') this._back();
    else if (edge === 'ok') this._activate(this._focusEl, false);
    else if (edge === 'up' || edge === 'down') this._move(edge);
    else {
      const dir = edge === 'left' ? -1 : 1, f = this._focusEl;
      if (f && f.dataset.key && this._cur && this._cur.contains(f)) this._step(f.dataset.key, dir);
      else this._move(edge);
    }
  }

  _items() {
    return this._cur ? [...this._cur.querySelectorAll('[data-nav]')].filter((el) => el.getClientRects().length > 0) : [];
  }

  /** Spatial move: nearest item whose center lies in the pressed direction, preferring items in line with the current one. */
  _move(dir) {
    const items = this._items();
    if (!items.length) return;
    const cur = this._focusEl && items.includes(this._focusEl) ? this._focusEl : null;
    if (!cur) { this._focus(this._defaultFocus(this.screen) || items[0]); return; }
    const vert = dir === 'up' || dir === 'down', sgn = dir === 'down' || dir === 'right' ? 1 : -1;
    let best = cur.dataset.tab && dir === 'down' ? this._firstInTab() : null;
    if (!best) {
      const a = cur.getBoundingClientRect();
      let bestScore = Infinity;
      for (const el of items) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const dc = vert ? (b.top + b.bottom - a.top - a.bottom) / 2 : (b.left + b.right - a.left - a.right) / 2;
        if (dc * sgn <= 1) continue;
        const edge = vert ? (sgn > 0 ? b.top - a.bottom : a.top - b.bottom) : (sgn > 0 ? b.left - a.right : a.left - b.right);
        const across = vert ? gap(a.left, a.right, b.left, b.right) : gap(a.top, a.bottom, b.top, b.bottom);
        const score = Math.max(0, edge) + across * 3 + Math.abs(dc) * 0.01;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (!best && vert && this._cur.hasAttribute('data-wrap')) best = this._wrapTarget(items, cur, sgn);
      if (!best && cur.hasAttribute(`data-${dir}`)) {        // explicit fallback, e.g. mission row -> Launch when stacked
        const alt = this._cur.querySelector(cur.getAttribute(`data-${dir}`));
        if (alt && alt.getClientRects().length) best = alt;
      }
      // Entering a group (tab bar, mission list) lands on its selected member, not merely the geometrically nearest one
      if (best && best.dataset.group && best.dataset.group !== cur.dataset.group) {
        const sel = this._cur.querySelector(`[data-group="${best.dataset.group}"][aria-selected="true"]`);
        if (sel && sel.getClientRects().length) best = sel;
      }
    }
    if (best) this._focus(best);
    else if (vert) {
      const sc = this._cur.querySelector('.m-body');
      if (sc) sc.scrollBy({ top: sgn * Math.max(90, sc.clientHeight * 0.45), behavior: this._reduced ? 'auto' : 'smooth' });
    }
  }

  _wrapTarget(items, cur, sgn) {
    const a = cur.getBoundingClientRect();
    let best = null, bv = -Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      if (gap(a.left, a.right, b.left, b.right) > 0) continue;
      const v = -sgn * (b.top + b.bottom);
      if (v > bv) { bv = v; best = el; }
    }
    return best;
  }

  /** Highlight `el`. Keyboard/gamepad focus also moves DOM focus and scrolls it into view; pointer hover does neither. */
  _focus(el, o = {}) {
    if (!el) return;
    const prev = this._focusEl;
    if (prev && prev !== el) prev.classList.remove('is-focus');
    this._focusEl = el;
    el.classList.add('is-focus');
    if (el.dataset.tab && el.dataset.tab !== this._tab) this._setTab(el.dataset.tab);
    if (el.dataset.mission !== undefined) this._selectMission(+el.dataset.mission);
    if (!o.pointer) {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      this._reveal(el);
    }
    if (prev !== el && !o.silent) this._sound('move');
  }

  /** Scroll the nearest .m-scroll container so `el` is visible (never scrolls #game or the page). */
  _reveal(el) {
    const sc = el.closest('.m-scroll');
    if (!sc || sc.scrollHeight <= sc.clientHeight) return;
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect(), pad = 10;
    let d = 0;
    if (r.top < s.top + pad) d = r.top - s.top - pad;
    else if (r.bottom > s.bottom - pad) d = Math.min(r.bottom - s.bottom + pad, r.top - s.top - pad);
    if (d) sc.scrollBy({ top: d, behavior: this._reduced ? 'auto' : 'smooth' });
  }

  _activate(el, pointer) {
    if (!el || !this._cur || !this._cur.contains(el)) return;
    const d = el.dataset;
    if (d.key) {                                           // settings row: confirm flips a toggle / cycles a choice
      const def = DEF[d.key];
      if (def.type === 'toggle') this._change(d.key, !this.settings[d.key]);
      else if (def.type === 'choice' && !pointer) this._step(d.key, 1);
      return;
    }
    if (d.tab) { const first = this._firstInTab(); if (first) this._focus(first); return; }
    if (d.mission !== undefined) { if (!pointer) this._run('onStart', +d.mission); return; }
    switch (d.act) {
      case 'start': this._run('onStart', 0); break;
      case 'infinity': this._run('onInfinity'); break;
      case 'launch': if (this.missions.length) this._run('onStart', this._missionSel); break;
      case 'missions': this._push('missions', { selected: this._missionIndex >= 0 ? this._missionIndex : this._missionSel }); break;
      case 'settings': case 'controls': case 'credits': this._push(d.act); break;
      case 'resume': this._run('onResume'); break;
      case 'retry': this._run('onRestart'); break;
      case 'next': this._run('onNext'); break;
      case 'restart': this._pending = 'restart'; this._push('confirm', { kind: 'restart' }); break;
      case 'quit':
        if (this.screen === 'pause') { this._pending = 'quit'; this._push('confirm', { kind: 'quit' }); } else this._quit();
        break;
      case 'confirm-yes':
        if (this._pending === 'restart') this._run(this._pauseInf ? 'onInfinity' : 'onRestart'); else this._quit();
        break;
      case 'back': this._back(); break;
      case 'reset-tab': this._resetTab(); break;
      default: break;
    }
  }

  _back() {
    const top = this.screen;
    if (!top) return;
    if (top === 'settings') this._flushSave();
    if (this._stack.length > 1) {
      this._stack.pop();
      if (top === 'confirm') this._pending = null;
      this._enter(this.screen, null, true);
      this._sound('back');
    } else if (top === 'pause' || !ROOTS.has(top)) this._run('onResume', undefined, 'back');   // a sub-screen opened on its own closes
  }

  /** Close the menu and fire a game callback. */
  _run(name, arg, sound = 'select') {
    this._sound(sound);
    this.hide();
    if (arg === undefined) this._cb(name); else this._cb(name, arg);
  }

  _quit() {
    this._sound('select');
    this._stack = [{ screen: 'title', focus: null }];
    this._pending = null;
    this._lock = 0.25;
    this._lockUntil = performance.now() + this._lock * 1000;   // update() reads the wall-clock lock (see show())
    this.el.hidden = false;
    this._enter('title', {}, false);
    this._cb('onQuit');
  }

  _cb(name, ...args) {
    const f = this.opts[name];
    if (typeof f === 'function') { try { f(...args); } catch (e) { console.error(`menu ${name} callback failed`, e); } }
  }
  _sound(kind) { const f = this.opts.onSound; if (typeof f === 'function') { try { f(kind); } catch { /* ignore */ } } }

  _setDevice(kind) {
    if (!['kb', 'pad', 'touch'].includes(kind) || kind === this._device) return;
    if (this._device) this.el.classList.remove(`dev-${this._device}`);
    this._device = kind;
    this.el.classList.add(`dev-${kind}`);
  }
  _setKbNav(on) { this.el.classList.toggle('kbnav', !!on); }

  // ---------------------------------------------------------------------------------------------------------------
  // DOM events. Pointer events never reach the game's window listeners; keys are left alone for js/input.js.
  // ---------------------------------------------------------------------------------------------------------------
  _bind() {
    const el = this.el;
    this._h = {
      down: (e) => this._onPointerDown(e), move: (e) => this._onPointerMove(e), up: (e) => this._onPointerUp(e),
      click: (e) => this._onClick(e), dbl: (e) => this._onDbl(e), stop: (e) => e.stopPropagation(),
      key: (e) => this._onKey(e), flush: () => this._flushSave(),
    };
    el.addEventListener('pointerdown', this._h.down);
    el.addEventListener('pointermove', this._h.move);
    el.addEventListener('pointerup', this._h.up);
    el.addEventListener('pointercancel', this._h.up);
    el.addEventListener('click', this._h.click);
    el.addEventListener('dblclick', this._h.dbl);
    for (const t of ['mousedown', 'touchstart', 'wheel']) el.addEventListener(t, this._h.stop, { passive: true });
    window.addEventListener('keydown', this._h.key);
    window.addEventListener('keyup', this._h.key);
    window.addEventListener('pagehide', this._h.flush);
  }

  /** Enter / Space on a focused menu element must not also trigger the browser's native button activation:
   *  activation goes through update() (input.menuConfirm) only, so it happens exactly once. */
  _onKey(e) {
    if (!this.open || !(e.target instanceof Node) || !this.el.contains(e.target)) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
  }

  _onPointerDown(e) {
    e.stopPropagation();
    if (!this.open) return;
    this._setDevice(e.pointerType === 'touch' ? 'touch' : 'kb');
    this._setKbNav(false);
    const sl = e.target instanceof Element ? e.target.closest('.m-slider') : null;
    if (sl && e.button === 0 && this._cur && this._cur.contains(sl)) {
      const row = sl.closest('.m-row');
      this._focus(row, { pointer: true, silent: true });
      this._drag = { sl, key: row.dataset.key, id: e.pointerId, from: this.settings[row.dataset.key] };
      try { sl.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      this._dragTo(e.clientX);
      e.preventDefault();
    }
  }

  _onPointerMove(e) {
    if (this._drag && e.pointerId === this._drag.id) { this._dragTo(e.clientX); return; }
    if (!this.open || e.pointerType === 'touch') return;
    if (e.clientX === this._px && e.clientY === this._py) return;   // only real movement (not layout shifts under a still mouse)
    this._px = e.clientX; this._py = e.clientY;
    this._setDevice('kb');
    this._setKbNav(false);
    const t = e.target instanceof Element ? e.target.closest('[data-nav]') : null;
    if (t && t !== this._focusEl && !t.hasAttribute('data-nohover') && this._cur && this._cur.contains(t)) this._focus(t, { pointer: true, silent: true });
  }

  _onPointerUp(e) {
    const g = this._drag;
    if (!g || e.pointerId !== g.id) return;
    this._drag = null;
    try { g.sl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.settings[g.key] !== g.from) this._sound('adjust');
  }

  _dragTo(x) {
    const g = this._drag, d = DEF[g.key], r = g.sl.getBoundingClientRect();
    if (!d || r.width <= 0) return;
    const t = clamp((x - r.left) / r.width, 0, 1), st = d.dragStep || d.step;
    this._set(g.key, Math.round((d.min + t * (d.max - d.min)) / st) * st);
  }

  _onClick(e) {
    e.stopPropagation();
    if (!this.open || !this._cur) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !this._cur.contains(t)) return;
    const seg = t.closest('.m-seg button');
    if (seg) {
      const row = seg.closest('.m-row'), d = DEF[row.dataset.key];
      this._focus(row, { pointer: true, silent: true });
      this._change(row.dataset.key, d.type === 'toggle' ? seg.dataset.val === 'true' : seg.dataset.val);
      return;
    }
    if (t.closest('.m-slider')) return;                    // handled by the drag
    const el = t.closest('[data-nav], [data-act]');
    if (!el) return;
    if (el.hasAttribute('data-nav')) {
      const was = this._focusEl;
      this._focus(el, { pointer: true, silent: true });     // a tab or mission row is selected by focusing it
      if ((el.dataset.tab || el.dataset.mission !== undefined)) { if (was !== el) this._sound('move'); return; }
    }
    this._activate(el, true);
  }

  _onDbl(e) {
    const row = e.target instanceof Element ? e.target.closest('[data-mission]') : null;
    if (row && this._cur && this._cur.contains(row)) this._run('onStart', +row.dataset.mission);
  }
}
