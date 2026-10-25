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
// FULLSCREEN (js/fullscreen.js): Settings › Graphics has a Fullscreen row showing the browser's state, kept in sync by the
// fullscreenchange event (so leaving with Esc updates it too). It is not a saved setting, and it is hidden where the
// browser has no fullscreen (iPhone Safari, an iframe without allow="fullscreen"). Browsers grant fullscreen only inside a
// click, key or touch handler, so clicks and Enter / Space / ←→ on the row ask from the DOM event itself; a gamepad press
// is no user activation, and when the browser refuses it the row shows a short note. The game's shortcut key calls
// toggleFullscreen() from its keydown handler.
// FIRST-RUN DIFFICULTY: the first campaign start (Start Campaign, or a launch from Mission Select) opens a small picker
// (screen 'difficulty', a modal over the screen that opened it) before onStart: Easy, Normal, Hard, Mercenary with a
// one-line blurb each (DIFFICULTY_PICKS, from main.js DIFFICULTY), Easy pre-selected and recommended. Starting writes
// the difficulty setting (onSetting, so Settings shows it) and the 'wingnut.difficultyPicked' flag; Back cancels to the
// screen that opened it. It never shows again until Settings › Gameplay › Restore defaults clears the flag. When
// storage fails it shows once per page session. INFINITY skips it (its own ramp).
// HOME-SCREEN INSTALL: one compact line at the bottom of the title (data-act="install"), only on the GitHub Pages build
// (the page links a web app manifest; dev.html and the artifact body do not) and never when already running standalone.
// iPhone / iPad Safari has no install API, so the line opens a small hint panel (screen 'install', a modal): Tap Share,
// then Add to Home Screen; any tap, Esc / B or Got it closes it. Chromium fires beforeinstallprompt when the page is
// installable: the event is stashed (module level, so an early event is not missed) and the line calls its prompt().
// prompt() needs a user activation: clicks, taps and keys have one, a gamepad press does not, and a refusal shows a
// short note on the line. The line hides after appinstalled, after the prompt is answered (a later event brings it
// back), and when the event never fires. installKind() holds the rule; opts.installEnv overrides the detected
// environment (test_menu.html).
// CONTROL BINDINGS (js/bindings.js): Settings › Controls starts with "Controller layout" (the 'padLayout' setting: Mode 2,
// Ace Combat, Custom; choosing Custom with nothing saved copies the layout that was active) and two link rows, hidden on
// touch-only devices (opts.touchOnly overrides the detection):
//   Custom controller layout (screen 'padwiz'): the binding wizard. It reads input.padRaw every frame and steps through
//     PAD_ACTIONS ("Move the stick or press the button for PITCH UP"); while it listens, menu edges are not used (A / B
//     may be what is being bound): D-pad ← / → or Backspace / Space step back / skip, Esc or Start held 1 s cancels, and
//     the on-screen Back / Skip / Cancel buttons work by pointer. A control that already belongs to another action opens
//     the Confirm modal (kind 'pswap': Swap / Cancel). The last step is a live test of every action with Save, Redo and
//     Cancel, navigated normally (focus starts on the test panel, so pressing A to test the cannon saves nothing).
//   Keyboard bindings (screen 'keys'): every KEY_ACTIONS action with its primary key and alternates. Confirm on a slot
//     captures the next key (a capturing keydown listener, so the game never sees it); Esc (or B / a click elsewhere)
//     cancels, Del clears the slot; mouse buttons bind to Cannon and Missile only. A key used elsewhere opens the Confirm
//     modal (kind 'kswap'). Reset to defaults restores every key.
// Bindings save to 'wingnut.bindings' (versioned) and reach the game as onSetting('bindings', { pad, keys }).

import { countUnits } from './missions.js';
import { shapeAxis, STICK_EXPO, EXPO_MAX, GUN_PRECISION, GUN_PRECISION_MAX } from './input.js';
import { PAD_ACTIONS, PAD_PRESETS, KEY_ACTIONS, PadWizard, loadBindings, saveBindings, padMapFor, copyPadMap, describeBinding, describePair,
  keyName, keyOwner, rebindKey, validKey, sanitizeKeys, DEFAULT_KEYS, isMouseCode } from './bindings.js';
import { loadBest } from './infinity.js';
import { fullscreenSupported, isFullscreen, setFullscreen, onFullscreenChange } from './fullscreen.js';

// =================================================================================================================
// Settings
// =================================================================================================================
export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'auto', perfOverlay: false, invertPitch: false, mouseSens: 1, mouseKeys: 'simple', touch: 'auto', cameraShake: true, screenFlash: false,
  master: 0.8, music: 0.7, sfx: 0.9, voice: 1.0, wso: false, subtitles: true, difficulty: 'normal',
  expoPitch: STICK_EXPO, expoRoll: STICK_EXPO, expoYaw: STICK_EXPO, gunPrecision: GUN_PRECISION, padLayout: 'mode2',
});
const STORE_KEY = 'wingnut.settings';
const pct = (v) => `${Math.round(v * 100)}%`;
const times = (v) => `${v.toFixed(2)}×`;
const expoFmt = (v) => (v > 0 ? pct(v) : 'Linear');

/** Tabs of the Settings screen, in order. */
export const SETTING_TABS = [['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio'], ['gameplay', 'Gameplay']];

/** Schema the Settings screen is rendered from. Labels and copy can be edited here without touching the markup.
 *  type: 'choice' (options [value, label]) | 'toggle' (boolean) | 'slider' (min..max, step for keys/pad, dragStep for pointer).
 *  desc: help line; descs: per-value help line (replaces desc). */
export const SETTING_DEFS = [
  { key: 'quality', tab: 'graphics', type: 'choice', label: 'Quality',
    options: [['auto', 'Auto'], ['verylow', 'Very low'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
    desc: 'Auto picks a level for your GPU and drops it when the frame rate sags. Very low is for budget tablets.' },
  { key: 'perfOverlay', tab: 'graphics', type: 'toggle', label: 'Performance overlay',
    desc: 'Frame rate, GPU time and render resolution in the top corner.' },
  // Not saved: the row shows and changes the browser's fullscreen state (FULLSCREEN in the header)
  { key: 'fullscreen', tab: 'graphics', type: 'toggle', label: 'Fullscreen',
    desc: 'Hides the browser bars. Key\u00a0U toggles it; Esc also exits.' },
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
    desc: 'Triggered by hits, flak and nearby explosions.' },
  { key: 'screenFlash', tab: 'controls', type: 'toggle', label: 'Screen flash',
    desc: 'White flash on missile hits, flak and nearby explosions.' },
  // Gamepad stick expo per axis (js/input.js shapeAxis): 0 = linear, 100% = cubic, up to 150% = wider soft center; full
  // deflection is always full rate
  { key: 'expoPitch', tab: 'controls', type: 'slider', label: 'Stick expo · pitch', min: 0, max: EXPO_MAX, step: 0.02, dragStep: 0.01, format: expoFmt, expo: 'pitch',
    desc: 'Controller only. Higher values soften small stick movements for finer aim; past 100% the soft center widens. Full stick is always full rate.' },
  { key: 'expoRoll', tab: 'controls', type: 'slider', label: 'Stick expo · roll', min: 0, max: EXPO_MAX, step: 0.02, dragStep: 0.01, format: expoFmt, expo: 'roll' },
  { key: 'expoYaw', tab: 'controls', type: 'slider', label: 'Stick expo · rudder', min: 0, max: EXPO_MAX, step: 0.02, dragStep: 0.01, format: expoFmt, expo: 'yaw' },
  // js/input.js GUN_PRECISION: gain cut near center while the cannon fires (stick, keyboard and mouse aim)
  { key: 'gunPrecision', tab: 'controls', type: 'slider', label: 'Gun precision', min: 0, max: GUN_PRECISION_MAX, step: 0.05, dragStep: 0.01,
    format: (v) => (v > 0 ? `−${pct(v)}` : 'Off'),
    desc: 'Finer aim while the cannon fires: small stick and mouse movements slow down. Full stick still turns at full rate.' },
  // Gamepad layout (js/bindings.js); the Custom / Keyboard binding link rows follow it (LINK_ROWS)
  { key: 'padLayout', tab: 'controls', type: 'choice', label: 'Controller layout',
    options: [['mode2', 'Mode 2'], ['ace', 'Ace Combat'], ['custom', 'Custom']],
    descs: { mode2: 'Mode 2: left stick boost and rudder, right stick pitch and roll, RT cannon, LT missile.',
      ace: 'Ace Combat: left stick pitch and roll, bumpers rudder, triggers throttle, A cannon, B missile, Y target.',
      custom: 'Custom: your own layout. Set it up below.' } },
  { key: 'master', tab: 'audio', type: 'slider', label: 'Master volume', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct },
  { key: 'music', tab: 'audio', type: 'slider', label: 'Music', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct },
  { key: 'sfx', tab: 'audio', type: 'slider', label: 'Effects', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct,
    desc: 'Engines, weapons, explosions and cockpit warnings.' },
  { key: 'voice', tab: 'audio', type: 'slider', label: 'Voice', min: 0, max: 1, step: 0.05, dragStep: 0.01, format: pct,
    desc: 'Radio calls: AWACS, your WSO and Mainspring.' },
  { key: 'wso', tab: 'audio', type: 'toggle', label: 'WSO voice',
    desc: 'Your back-seater\'s calls and banter. Off: AWACS makes the calls.' },
  { key: 'subtitles', tab: 'audio', type: 'toggle', label: 'Radio subtitles',
    desc: 'Show radio calls as text on the HUD.' },
  { key: 'difficulty', tab: 'gameplay', type: 'choice', label: 'Difficulty',
    options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['mercenary', 'Merc']],
    descs: {
      easy: 'Easy: tougher airframe. Softer, slower bandits attack one at a time; enemy missiles turn wide.',
      normal: 'Normal: the intended balance. Two bandits attack at once.',
      hard: 'Hard: you take more damage. Bandits are tougher and sharper; four attack at once. Extra groups on some missions.',
      mercenary: 'Mercenary: no armor bonus. Toughest, sharpest bandits; no limit on attackers. Every extra group.',
    } },
];
const DEF = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d]));

/** First-run difficulty picker (FIRST-RUN DIFFICULTY in the header): [value, label, blurb]. Blurbs follow main.js
 *  DIFFICULTY: attackers at once (aggressors 1/2/4/no cap), enemy missiles after you at once (playerMissiles 1/2/3/4),
 *  flak guns firing at once (aaGuns 2/5/7/10, shipGuns 2/6/8/10), extra groups (Hard, Mercenary), enemy HP (x0.8/1/1.15/1.3) and the
 *  damage you take (armor x0.35/0.5/0.7/1.0). */
export const DIFFICULTY_PICKS = [
  ['easy', 'Easy', 'One attacker, one missile, light flak. Softer bandits.'],
  ['normal', 'Normal', 'Two attackers, two missiles at once. The intended balance.'],
  ['hard', 'Hard', 'Four attackers, extra enemy groups, tougher bandits, heavier flak.'],
  ['mercenary', 'Mercenary', 'More enemies, no limits. Toughest bandits, no armor bonus.'],
];
export const DIFFICULTY_PICKED_KEY = 'wingnut.difficultyPicked';
/** True when the first-run picker was completed and stored. Never throws (storage failure reads as not picked). */
export function loadDifficultyPicked() {
  try { return localStorage.getItem(DIFFICULTY_PICKED_KEY) === '1'; } catch { return false; }
}
/** Store or clear the flag. Returns false when storage is unavailable. */
export function saveDifficultyPicked(on) {
  try { if (on) localStorage.setItem(DIFFICULTY_PICKED_KEY, '1'); else localStorage.removeItem(DIFFICULTY_PICKED_KEY); return true; } catch { return false; }
}
const FULLSCREEN = 'fullscreen';

// ---- Home-screen install (see the header) ------------------------------------------------------------------------
let installEvent = null;                                  // the stashed beforeinstallprompt event, until used
const installSubs = new Set();                            // Menu instances to resync when it changes
const installChanged = () => { for (const f of installSubs) { try { f(); } catch { /* ignore */ } } };
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; installChanged(); });
  window.addEventListener('appinstalled', () => { installEvent = null; installChanged(); });
}
/** The live environment for installKind(). */
export function installEnv() {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  return {
    ua: String(nav.userAgent || ''), platform: String(nav.platform || ''), touchPoints: nav.maxTouchPoints | 0,
    standalone: nav.standalone === true || media('(display-mode: standalone)') || media('(display-mode: fullscreen)'),
    manifest: typeof document !== 'undefined' && !!document.querySelector('link[rel="manifest"]'),
  };
}
/** Which install entry the title shows: 'ios' (the Share hint), 'prompt' (Chromium's install prompt) or null (none).
 *  env as installEnv(); promptReady: a beforeinstallprompt event is waiting. */
export function installKind(env, promptReady) {
  if (!env || !env.manifest || env.standalone) return null;
  const ua = env.ua || '';
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua) || (env.platform === 'MacIntel' && env.touchPoints > 1);   // iPadOS asks for the desktop site
  // Safari only: other iOS browsers and in-app web views have their own (or no) Add to Home Screen
  if (ios) return /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo|YaBrowser|FBAN|FBAV|Instagram|Line\//.test(ua) ? 'ios' : null;
  return promptReady ? 'prompt' : null;
}
const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8.5 9.5H7A2 2 0 0 0 5 11.5v7.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7.5a2 2 0 0 0-2-2h-1.5"/><path d="M12 14.5V3M8.5 6.5 12 3l3.5 3.5"/></svg>';
const ADD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const INSTALL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M4.5 15.5v2a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-2"/></svg>';
const ROW_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', ' ', 'ArrowLeft', 'ArrowRight']);   // js/input.js confirm / ←→ keys

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
    'Radio voices (AWACS Claude, the WSO, Mainspring) generated with Google text-to-speech (Gemini API)',
  ] },
  { section: 'Music', lines: [
    '"Ceiling Unlimited", "Sortie", "Mainspring" and "Night Shift", original music composed in code for PROJECT WINGNUT',
    'Orchestral samples from the VSCO 2 Community Edition library (Versilian Studios / Sam Gossner, CC0)',
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
const SCREENS = ['title', 'missions', 'pause', 'debrief', 'settings', 'controls', 'credits', 'confirm', 'difficulty', 'install', 'padwiz', 'keys'];
const NO_RESUME = new Set(['padwiz', 'keys']);   // Start / P does not resume the game from these (Start held cancels the wizard)
const MODALS = new Set(['confirm', 'difficulty', 'install']);   // drawn over the dimmed screen beneath
const ROOTS = new Set(['title', 'pause', 'debrief']);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Response graph under the stick expo rows (drawn by Menu._drawExpo only while Settings › Controls is showing). */
const EXPO_GRAPH = '<div class="m-expo" aria-hidden="true"><p class="m-expo-t"><b class="m-expo-h">Pitch response</b>' +
  'Stick deflection (across) against rate (up). The faint line is linear; the dot is your stick.</p><canvas class="m-expo-c"></canvas></div>';
const linkRow = (act, label, desc, val) => `<button type="button" class="m-row m-row--link" data-nav data-act="${act}" data-link>` +
  `<span class="m-rowt"><span class="m-label">${esc(label)}</span></span><span class="m-desc">${esc(desc)}</span>` +
  `<span class="m-ctl"><span class="m-linkv">${esc(val)}</span><span class="m-chev" aria-hidden="true">›</span></span></button>`;
const LINK_ROWS = linkRow('padwiz', 'Custom controller layout', 'Bind each action by moving a stick or pressing a button.', 'Set up') +
  linkRow('keys', 'Keyboard bindings', 'Rebind every key, plus mouse buttons for cannon and missile.', 'Edit');
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

/** Gamepad card for the layout in force (map: js/bindings.js pad map). */
function padCard(map, layout) {
  const m = map || PAD_PRESETS.mode2, d = describeBinding;
  const name = layout === 'ace' ? 'Ace Combat' : layout === 'custom' ? 'Custom' : 'Mode 2';
  return `<h3>Gamepad <small>${name}</small></h3><p class="m-cnote">Xbox or PlayStation layout. Change it in Settings › Controls.</p>` + binds([
    [[k(esc(describePair(m.throttleUp, m.throttleDown)), 1)], 'Boost · airbrake'],
    [[k(esc(describePair(m.yawLeft, m.yawRight)), 1)], 'Rudder'],
    [[k(esc(describePair(m.pitchUp, m.pitchDown)), 1)], 'Pitch <em>(pull back to climb)</em>'],
    [[k(esc(describePair(m.rollLeft, m.rollRight)), 1)], 'Roll'],
    [[k(esc(d(m.missile)), 1)], 'Missile'],
    [[k(esc(d(m.gun)), 1)], 'Cannon'],
    [[k(esc(d(m.target)), 1)], 'Tap: next target · hold: padlock view'],
    [[k(esc(d(m.lookBack)), 1)], 'Look back'],
    [[k(esc(d(m.flares)), 1)], 'Flares'],
    [[k('Start', 1)], 'Pause'],
  ]);
}
const TOUCH_CARD = '<h3>Touch <small>On screen</small></h3><p class="m-cnote">The on-screen sticks and buttons mirror the gamepad.</p>' + binds([
  [[k('Left stick', 1)], '↑ boost · ↓ airbrake · ←→ rudder'],
  [[k('Right stick', 1)], 'Pitch · roll'],
  [[k('Fire buttons', 1)], 'Missile · cannon'],
  [[k('Target', 1)], 'Tap: next target · hold: padlock view'],
  [[k('Flares', 1)], 'Decoy incoming missiles'],
  [[k('Look back', 1)], 'Rear view while held'],
  [[k('Pause', 1)], 'This menu'],
]) + '<p class="m-cfoot">Show or hide them in Settings › Controls › Touch controls.</p>';
function kbCard(simple, keys) {
  const K = keys || DEFAULT_KEYS;
  const ks = (id, n = 2) => (K[id] || []).slice(0, n).map((c) => k(esc(keyName(c))));
  const first = (id) => ks(id, 1);
  return `<h3>Mouse &amp; keyboard <small>${simple ? 'Simple keys' : 'Advanced keys'}</small></h3>` +
    '<p class="m-cnote">Mouse aim: the jet flies toward the circle.</p>' + binds([
      [[k('Mouse')], 'Aim'],
      [ks('gun'), 'Cannon'],
      [ks('missile'), 'Missile'],
      [[...first('pitch-'), ...first('pitch+')], simple ? 'Boost · airbrake' : 'Pitch <em>(second key pulls up)</em>'],
      [[...first('roll-'), ...first('roll+')], 'Roll'],
      [[...first('yaw-'), ...first('yaw+')], 'Rudder'],
      [first('throttle+'), simple ? 'Hard pull' : 'Boost'],
      ...(simple ? [] : [[first('throttle-'), 'Airbrake']]),
      [first('flares'), 'Flares'],
      [first('target'), 'Tap: next target · hold: padlock view'],
      [first('freeLook'), 'Free look <em>(hold)</em>'],
      [first('lookBack'), 'Look back'],
      [[...first('pause'), k('Esc')], 'Pause'],
      ...(fullscreenSupported() ? [[first('fullscreen'), 'Fullscreen']] : []),
    ].filter(([keysHtml]) => keysHtml.length)) + '<p class="m-cfoot">Key preset: Settings › Controls › Mouse keys. Rebind: Keyboard bindings.</p>';
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
    this._diffSel = 'easy'; this._pickFor = null; this._pickedSession = false;   // first-run difficulty picker
    this._device = '';
    this._reduced = media('(prefers-reduced-motion: reduce)');
    this._instEnv = { ...installEnv(), ...(this.opts.installEnv || {}) };   // home-screen install (see the header)
    // control bindings (CONTROL BINDINGS in the header)
    this.bindings = this.opts.bindings && typeof this.opts.bindings === 'object'
      ? { pad: this.opts.bindings.pad || null, keys: sanitizeKeys(this.opts.bindings.keys) } : loadBindings();
    this._touchOnly = typeof this.opts.touchOnly === 'boolean' ? this.opts.touchOnly
      : media('(hover: none) and (pointer: coarse)') && typeof navigator !== 'undefined' && (navigator.maxTouchPoints | 0) > 0;
    this._wiz = null; this._cap = null; this._kpend = null; this._swallowClick = 0;
    this._build();
    this._setDevice(media('(hover: none) and (pointer: coarse)') ? 'touch' : 'kb');
    this._bind();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------------------------
  /** Any menu visible. */
  get open() { return !!this.el && !this.el.hidden; }
  /** 'title' | 'missions' | 'pause' | 'debrief' | 'settings' | 'controls' | 'credits' | 'confirm' | 'difficulty' | 'install', or null when closed. */
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
    this._fsSkip = this._fsKeyDone; this._fsKeyDone = false;   // _fsKey already acted on this frame's key edge
    if (!this.open || !input) return;
    // the wizard reads the raw pad while it listens; menu edges then do nothing (A / B may be what is being bound)
    if (this.screen === 'padwiz' && this._wiz && this._wizUpdate(dt, input)) return;
    if (performance.now() < (this._lockUntil || 0)) return;
    const edge = input.menuBack ? 'back' : input.menuConfirm ? 'ok' : input.menuUp ? 'up' : input.menuDown ? 'down'
      : input.menuLeft ? 'left' : input.menuRight ? 'right' : null;
    // Hint glyphs: switch on a real navigation edge. input.js also reports the on-screen touch sticks as a gamepad,
    // so without an edge only an actually connected pad may flip the hints away from keyboard glyphs.
    if (edge) this._setDevice(input.usingGamepad ? 'pad' : 'kb');
    else if (input.usingGamepad && input.gamepadConnected && this._device === 'kb') this._setDevice('pad');
    if (this._cap) { if (edge === 'back') { this._capCancel(); this._sound('back'); } return; }   // key capture: B cancels
    if (edge) this._nav(edge);
    else if (input.pausePressed && this._stack.length && this._stack[0].screen === 'pause' && !NO_RESUME.has(this.screen)) this._run('onResume');  // Start / P
    if (this.open && this.screen === 'settings' && this._tab === 'controls') this._drawExpo(input);
  }

  /** Stick expo graph: the selected axis (the focused expo row, else the last one) with its live stick dot. Redraws only
   *  when the axis, curve, size or dot changes. */
  _drawExpo(input) {
    const cv = this._expoCanvas;
    if (!cv) return;
    const f = this._focusEl, fd = f && f.dataset ? DEF[f.dataset.key] : null;
    if (fd && fd.expo) this._expoAxis = fd.expo;
    const axis = this._expoAxis || 'pitch', key = 'expo' + axis[0].toUpperCase() + axis.slice(1);
    const expo = this.settings[key];
    const raw = input && input.gamepadConnected && input.stickRaw ? Math.min(1, Math.abs(input.stickRaw[axis] || 0)) : -1;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    const sig = `${axis}|${expo}|${w}x${h}|${raw.toFixed(3)}`;
    if (sig === this._expoSig) return;
    this._expoSig = sig;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    if (this._expoHead) this._expoHead.textContent = `${axis === 'yaw' ? 'Rudder' : axis[0].toUpperCase() + axis.slice(1)} response`;
    const g = cv.getContext('2d');
    if (!g) return;
    const pad = 8 * dpr, X = (x) => pad + x * (w - 2 * pad), Y = (y) => h - pad - y * (h - 2 * pad);
    g.clearRect(0, 0, w, h);
    g.lineWidth = dpr;
    g.strokeStyle = 'rgba(156, 235, 255, 0.10)';                 // quarter grid
    g.beginPath();
    for (let i = 1; i < 4; i++) { g.moveTo(X(i / 4), Y(0)); g.lineTo(X(i / 4), Y(1)); g.moveTo(X(0), Y(i / 4)); g.lineTo(X(1), Y(i / 4)); }
    g.stroke();
    g.strokeStyle = 'rgba(156, 235, 255, 0.28)';                 // linear reference
    g.setLineDash([4 * dpr, 4 * dpr]);
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#9cebff'; g.lineWidth = 2 * dpr;           // the curve (deadzone included: what the stick really does)
    g.beginPath();
    for (let i = 0; i <= 64; i++) { const x = i / 64, y = shapeAxis(x, expo); if (i) g.lineTo(X(x), Y(y)); else g.moveTo(X(x), Y(y)); }
    g.stroke();
    if (raw >= 0) {
      const y = shapeAxis(raw, expo);
      g.fillStyle = '#ff7a1f'; g.beginPath(); g.arc(X(raw), Y(y), 4 * dpr, 0, Math.PI * 2); g.fill();
    }
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

  /** Re-read the local best on the title's INFINITY entry (the title refreshes it when it opens; call this after a run
   *  ends while the title is already showing). */
  refreshBest() { this._refreshInfinity(); }

  /** The fullscreen shortcut: call it inside the key handler (browsers refuse fullscreen elsewhere). Does nothing where
   *  fullscreen is unavailable. Resolves true when the page ends up in the new state, false otherwise; never rejects. */
  toggleFullscreen() { return this._fullscreen(!isFullscreen(), true); }

  dispose() {
    this._flushSave();
    clearTimeout(this._fsNoteT);
    if (this._inst) clearTimeout(this._inst.noteT);
    installSubs.delete(this._instSync);
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
      window.removeEventListener('keydown', h.cap, true);
      window.removeEventListener('keyup', h.key);
      window.removeEventListener('pagehide', h.flush);
      h.fsOff();
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
      this._htmlDebrief() + this._htmlSettings() + this._htmlControls() + this._htmlCredits() + this._htmlConfirm() + this._htmlDifficulty() +
      this._htmlInstall() + this._htmlPadWiz() + this._htmlKeys();
    this.root.insertBefore(el, this.root.firstChild);
    const q = (sel, r = el) => r.querySelector(sel);
    this._screens = {};
    for (const n of SCREENS) this._screens[n] = q(`[data-screen="${n}"]`);
    this._statusEls = [...el.querySelectorAll('.m-status')];
    this._tipEl = q('.m-tip'); this._qlabel = q('.m-qlabel');
    this._expoCanvas = q('.m-expo-c'); this._expoHead = q('.m-expo-h'); this._expoAxis = 'pitch'; this._expoSig = '';
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
    this._kbCard = q('.m-card--kb'); this._padCard = q('.m-card--pad'); this._creditsEl = q('.m-credits');
    for (const r of el.querySelectorAll('[data-link]')) r.hidden = this._touchOnly;   // wizards need a keyboard or a pad
    const W = this._screens.padwiz;
    this._wz = { eye: q('.m-wiz-eye', W), prompt: q('.m-wiz-prompt', W), hint: q('.m-wiz-hint', W), now: q('.m-wiz-now', W),
      live: q('.m-wiz-live', W), liveT: q('.m-wiz-livet', W), liveBar: q('.m-wiz-bar b', W), test: q('.m-wiz-test', W),
      stepAct: q('.m-wiz-stepact', W), testAct: q('.m-wiz-testact', W), sig: '' };
    this._keysList = q('.m-keys', this._screens.keys);
    const C = this._screens.confirm;
    this._cf = { title: q('.m-h2', C), text: q('.m-lede', C), yes: q('[data-act="confirm-yes"]', C) };
    this._diffItems = [...this._screens.difficulty.querySelectorAll('[data-diff]')];
    this._setTab(this._tab);
    this._syncAllRows();
    this._renderKb();
    this.setControllerStatus('Looking for a controller…', false);
    this._inst = { btn: q('[data-act="install"]', this._screens.title) };
    this._inst.icon = q('.m-install-i', this._inst.btn); this._inst.text = q('.m-install-t', this._inst.btn);
    this._instSync = () => this._syncInstall();
    installSubs.add(this._instSync);
    this._syncInstall();
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
        <p class="m-tagline">Twenty-one sorties over the Galebreak Isles.</p>
        <div class="m-rule" aria-hidden="true"></div>
        <nav class="m-list" aria-label="Main menu">
          ${entries.map(([act, label, sub], i) => item(act, pad2(i + 1), label, sub)).join('')}
        </nav>
        <footer class="m-foot">${STATUS}<p class="m-tip" hidden></p>${hints([['ud', 'Select'], ['ok', 'Confirm']])}
          <button type="button" class="m-install" data-nav data-act="install" hidden><span class="m-install-i"></span><span class="m-install-t"></span></button></footer>
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
      SETTING_DEFS.filter((d) => d.tab === id).map((d) => this._htmlRow(d) + (d.key === 'expoYaw' ? EXPO_GRAPH : '') + (d.key === 'padLayout' ? LINK_ROWS : '')).join('') +
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
          <article class="m-card m-card--pad"></article>
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

  _htmlDifficulty() {
    const rows = DIFFICULTY_PICKS.map(([v, label, blurb], i) => `<button type="button" class="m-item m-diff" role="radio" aria-checked="false" ` +
      `data-nav data-group="diff" data-nohover data-diff="${v}"><span class="m-num" aria-hidden="true">${pad2(i + 1)}</span>` +
      `<span class="m-lbl"><span class="m-diff-name">${esc(label)}${v === 'easy' ? '<em class="m-badge m-diff-rec">Recommended for new players</em>' : ''}</span>` +
      `<small>${esc(blurb)}</small></span></button>`).join('');
    return `<section class="m-screen" data-screen="difficulty" role="dialog" aria-modal="true" aria-labelledby="m-diff-h" aria-describedby="m-diff-d" hidden>
      <div class="m-panel m-panel--pick">
        <p class="m-eyebrow">First sortie</p>
        <h2 class="m-h2" id="m-diff-h">Choose difficulty</h2>
        <p class="m-lede" id="m-diff-d">Change it any time in Settings › Gameplay.</p>
        <div class="m-list m-diffs" role="radiogroup" aria-labelledby="m-diff-h">${rows}</div>
        <div class="m-actions m-actions--row m-diff-act">
          <button type="button" class="m-btn primary" data-nav data-act="diff-ok">Start <span aria-hidden="true">›</span></button>
          <button type="button" class="m-btn" data-nav data-act="back">Back</button>
        </div>
        ${hintFoot([['ud', 'Select'], ['ok', 'Start'], ['back', 'Back']])}
      </div></section>`;
  }

  /** iOS Add to Home Screen hint (modal over the title). Any tap closes it (_onClick), as do Esc / B and Got it. */
  _htmlInstall() {
    return `<section class="m-screen m-instscr" data-screen="install" role="dialog" aria-modal="true" aria-labelledby="m-inst-h" aria-describedby="m-inst-d" hidden>
      <div class="m-panel m-panel--install">
        <p class="m-eyebrow">Install</p>
        <h2 class="m-h2" id="m-inst-h">Add to Home Screen</h2>
        <p class="m-lede" id="m-inst-d">Tap Share, then Add to Home Screen. The icon opens Wingnut full screen.</p>
        <div class="m-inst-steps" aria-hidden="true">
          <span class="m-inst-step"><span class="m-inst-g">${SHARE_SVG}</span>Share</span>
          <span class="m-inst-arrow">›</span>
          <span class="m-inst-step"><span class="m-inst-g">${ADD_SVG}</span>Add to Home Screen</span>
        </div>
        <p class="m-inst-note">No Share button? Try the ••• menu.</p>
        <div class="m-actions"><button type="button" class="m-btn primary" data-nav data-act="back">Got it</button></div>
        ${hintFoot([['ok', 'Close'], ['back', 'Close']])}
      </div></section>`;
  }

  /** Gamepad binding wizard (CONTROL BINDINGS in the header). Text and lists are filled by _wizRender. */
  _htmlPadWiz() {
    return `<section class="m-screen" data-screen="padwiz" aria-labelledby="m-wiz-h" hidden>
      <div class="m-panel m-panel--wiz">
        ${head('Custom layout', 'Controller setup', 'm-wiz-h', false)}
        <div class="m-wiz" aria-live="polite">
          <p class="m-eyebrow m-wiz-eye"></p>
          <h3 class="m-wiz-prompt"></h3>
          <p class="m-wiz-hint"></p>
          <p class="m-wiz-now"></p>
          <div class="m-wiz-live"><span class="m-wiz-livet"></span><span class="m-wiz-bar" aria-hidden="true"><b></b></span></div>
          <div class="m-wiz-test m-scroll" data-nav tabindex="-1" hidden></div>
        </div>
        <div class="m-actions m-actions--row m-wiz-act m-wiz-stepact">
          <button type="button" class="m-btn" data-nav data-act="wiz-back">‹ Back</button>
          <button type="button" class="m-btn" data-nav data-act="wiz-skip">Skip ›</button>
          <button type="button" class="m-btn danger" data-nav data-act="back">Cancel</button>
        </div>
        <div class="m-actions m-actions--row m-wiz-act m-wiz-testact" hidden>
          <button type="button" class="m-btn primary" data-nav data-act="wiz-save">Save</button>
          <button type="button" class="m-btn" data-nav data-act="wiz-redo">Redo</button>
          <button type="button" class="m-btn danger" data-nav data-act="back">Cancel</button>
        </div>
        <footer class="m-foot"><p class="m-wiz-keys">Controller: D-pad ← back · D-pad → skip · hold Start 1&nbsp;s to cancel.<br>Keyboard: Backspace back · Space skip · Esc cancel.</p></footer>
      </div></section>`;
  }

  /** Keyboard and mouse bindings (rows built by _renderKeys). */
  _htmlKeys() {
    return `<section class="m-screen" data-screen="keys" aria-labelledby="m-keys-h" hidden>
      <div class="m-panel m-panel--keys">
        ${head('Keyboard &amp; mouse', 'Key bindings', 'm-keys-h', true)}
        <p class="m-keys-note">Select a slot, then press the new key. Esc cancels, Del clears. Mouse buttons bind to cannon and missile only. Esc can't be rebound.</p>
        <div class="m-body m-scroll"><div class="m-keys" role="list"></div>
          <div class="m-rowfoot"><button type="button" class="m-btn m-btn--sm" data-nav data-act="keys-reset">Restore defaults</button></div></div>
        ${hintFoot([['ud', 'Select'], ['ok', 'Rebind'], ['back', 'Back']])}
      </div></section>`;
  }

  /** Show, hide or relabel the title's install line for the current environment and stashed event. */
  _syncInstall() {
    const I = this._inst;
    if (!I || !I.btn) return;
    const kind = installKind(this._instEnv, !!installEvent);
    I.kind = kind;
    if (!I.noteText) {
      I.icon.innerHTML = kind === 'ios' ? SHARE_SVG : INSTALL_SVG;
      I.text.textContent = kind === 'ios' ? 'Add to Home Screen' : 'Install app';
    }
    const hide = !kind;
    if (I.btn.hidden !== hide) I.btn.hidden = hide;
    if (hide && this._focusEl === I.btn && this.screen === 'title') this._focus(this._defaultFocus('title'), { silent: true });
  }

  /** The install line was activated. 'prompt': call prompt() first, synchronously, so a click / key keeps its activation. */
  _install() {
    const kind = this._inst && this._inst.kind;
    if (kind === 'ios') { this._push('install'); return; }
    const e = installEvent;
    if (kind !== 'prompt' || !e) return;
    let req;
    try { req = e.prompt(); } catch (err) { req = Promise.reject(err); }
    this._sound('select');
    Promise.resolve(req).then(() => {
      if (installEvent === e) installEvent = null;       // one prompt per event: hide until the browser offers another
      installChanged();
    }, (err) => {
      if (err && err.name === 'NotAllowedError') this._installNote('Install needs a click, tap or key press.');
      else { if (installEvent === e) installEvent = null; installChanged(); }
    });
  }

  /** Show `text` on the install line for a few seconds. */
  _installNote(text) {
    const I = this._inst;
    I.noteText = text; I.text.textContent = text;
    clearTimeout(I.noteT);
    I.noteT = setTimeout(() => { I.noteText = ''; this._syncInstall(); }, 4000);
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
      else if (screen === 'padwiz') this._wizStart();
      else if (screen === 'keys') { this._capCancel(); this._renderKeys(); }
      else if (screen === 'credits') this._renderCredits();
      else if (screen === 'confirm') this._setConfirm(data);
      else if (screen === 'difficulty') this._selectDiff('easy');
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
    const under = MODALS.has(top) && this._stack.length > 1 ? this._stack[this._stack.length - 2].screen : null;
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
      case 'difficulty': return q(`[data-diff="${this._diffSel}"]`);
      case 'padwiz': return this._wiz && this._wiz.phase === 'test' ? q('.m-wiz-test') : q('[data-act="wiz-skip"]');
      case 'keys': return q('[data-kslot]');
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
      E.eye.textContent = d.eyebrow || (win ? 'Debrief' : 'Mission failed');
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
    if (kind === 'kswap' || kind === 'pswap') {
      const T = kind === 'kswap' ? this._kswapText() : this._pswapText();
      this._cf.title.textContent = T[0]; this._cf.text.textContent = T[1]; this._cf.yes.textContent = 'Swap';
      return;
    }
    const T = kind === 'restart'
      ? (inf ? ['Start a new run?', 'This run ends here and a new one starts at round 1.', 'New Run']
        : ['Restart mission?', 'Progress in this mission will be lost.', 'Restart'])
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
    D.eye.textContent = `Mission ${missionNo(m, i)}` + (m.clock ? ` · ${m.clock} local` : '');
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

  // ---- First-run difficulty picker (FIRST-RUN DIFFICULTY in the header) ------------------------------------------
  /** The picker still has to run: not chosen this session, and no stored flag (storage failure counts as none). */
  _needsPick() { return !this._pickedSession && !loadDifficultyPicked(); }
  /** Start mission i, through the picker on the first campaign start. */
  _start(i) {
    if (this._needsPick()) { this._pickFor = i; this._push('difficulty'); } else this._run('onStart', i);
  }
  _selectDiff(v) {
    if (!DIFFICULTY_PICKS.some((p) => p[0] === v)) return;
    this._diffSel = v;
    for (const b of this._diffItems) b.setAttribute('aria-checked', String(b.dataset.diff === v));
  }
  /** Save the choice (setting + flag) and start the mission the picker was opened for. */
  _confirmPick() {
    const i = this._pickFor == null ? 0 : this._pickFor;
    this._pickFor = null;
    this._set('difficulty', this._diffSel);
    this._pickedSession = true;
    saveDifficultyPicked(true);
    this._run('onStart', i);
  }

  _renderKb() {
    if (this._kbCard) this._kbCard.innerHTML = kbCard(this.settings.mouseKeys !== 'advanced', this.bindings.keys);
    if (this._padCard) this._padCard.innerHTML = padCard(padMapFor(this.settings.padLayout, this.bindings), this.settings.padLayout);
  }

  // ---- Control bindings (CONTROL BINDINGS in the header) ------------------------------------------------------------
  /** Store + persist the bindings and hand them to the game. */
  _commitBindings() {
    saveBindings(this.bindings);
    this._cb('onSetting', 'bindings', { pad: this.bindings.pad ? copyPadMap(this.bindings.pad) : null, keys: sanitizeKeys(this.bindings.keys) }, this.settings);
    this._renderKb();
  }
  /** Choosing Custom with nothing saved: start it as a copy of the layout that was active. */
  _ensureCustom(prev) {
    if (this.bindings.pad) return;
    this.bindings.pad = copyPadMap(padMapFor(prev === 'custom' ? 'mode2' : prev, this.bindings));
    this._commitBindings();
  }

  _wizStart() {
    this._wiz = new PadWizard(padMapFor(this.settings.padLayout, this.bindings));
    this._wz.sig = ''; this._wz.testBuilt = false;
    this._wizRender(null);
  }
  /** One frame of the wizard. Returns true while it is listening (menu edges must not act). */
  _wizUpdate(dt, input) {
    const w = this._wiz;
    w.update(dt, input.padRaw || null);
    if (w.phase === 'cancelled') { this._back(); return true; }
    if (w.phase === 'conflict') {
      this._pending = 'pswap';
      this._saveFocus(); this._stack.push({ screen: 'confirm', focus: null });
      this._enter('confirm', { kind: 'pswap' }, false);
      this._lockUntil = performance.now() + 350;
      this._sound('select');
      return true;
    }
    this._wizRender(input.padRaw || null);
    return w.phase !== 'test';
  }
  _wizRender(raw) {
    const w = this._wiz, Z = this._wz;
    if (!w || !Z.prompt) return;
    const N = PAD_ACTIONS.length, a = w.action, test = w.phase === 'test';
    let eye, prompt, hint, now = '';
    if (test) { eye = 'Final check'; prompt = 'Test your layout'; hint = 'Each control shows its live value. Save, or Redo the steps.'; }
    else if (w.phase === 'calib') {
      eye = 'Getting ready';
      prompt = raw ? 'Hands off the controls' : 'Connect a controller';
      hint = raw ? 'Let go of the sticks and triggers. Measuring their rest positions.' : 'Press any button on it. Esc or Cancel goes back.';
    } else {
      eye = `Step ${w.step + 1} of ${N}`;
      prompt = `Move the stick or press the button for <b>${esc(a.prompt)}</b>`;
      hint = a.hint + (a.pair ? ' A stick sets both directions at once.' : '');
      const cur = w.map[a.id];
      now = w.phase === 'release' && w.detected
        ? `Got it: <kbd class="m-k m-k--pad">${esc(w.detected.label)}</kbd>${w.inverted(a.id, w.detected.binding) ? ' <em>(inverted)</em>' : ''} · let go`
        : `Current: <kbd class="m-k m-k--pad">${esc(describeBinding(cur))}</kbd> · Skip keeps it`;
    }
    const sig = `${w.phase}|${w.step}|${!!raw}|${now}`;
    if (sig !== Z.sig) {
      Z.sig = sig;
      Z.eye.textContent = eye; Z.prompt.innerHTML = prompt; Z.hint.textContent = hint;
      Z.now.innerHTML = now; Z.now.hidden = !now;
      Z.stepAct.hidden = test; Z.testAct.hidden = !test; Z.test.hidden = !test; Z.live.hidden = test;
      if (test && !Z.testBuilt) {
        Z.testBuilt = true;
        Z.test.innerHTML = PAD_ACTIONS.map((x) => `<div class="m-wt" data-wt="${x.id}"><span class="m-wt-l">${esc(x.label)}</span>` +
          `<kbd class="m-k m-k--pad">${esc(describeBinding(w.map[x.id]))}</kbd><span class="m-wiz-bar"><b></b></span></div>`).join('');
        Z.bars = [...Z.test.querySelectorAll('.m-wt')].map((r) => [r.dataset.wt, r.querySelector('b')]);
        this._focus(Z.test, { silent: true });
      } else if (!test) Z.testBuilt = false;
    }
    if (test) {
      const v = w.values(raw);
      for (const [id, b] of Z.bars || []) { const p = `${Math.round((v[id] || 0) * 100)}%`; if (b.style.width !== p) b.style.width = p; }
    } else {
      const L = w.live, txt = L ? `Detected: ${L.label} · ${Math.round(L.value * 100)}%` : (raw ? 'Detected: nothing' : 'No controller');
      if (Z.liveT.textContent !== txt) Z.liveT.textContent = txt;
      const p = `${Math.round(Math.min(1, (L ? L.value : 0) / 0.6) * 100)}%`;
      if (Z.liveBar.style.width !== p) Z.liveBar.style.width = p;
      Z.live.classList.toggle('is-hit', !!L && L.value >= 0.6);
    }
  }
  _wizSave() {
    const w = this._wiz;
    if (!w) return;
    this.bindings.pad = copyPadMap(w.map);
    w.finish();
    this._commitBindings();
    this._set('padLayout', 'custom');
    this._back();
  }
  _pswapText() {
    const w = this._wiz, c = w && w.conflict;
    if (!c) return ['Already in use', '', 'Swap'];
    const lab = (id) => (PAD_ACTIONS.find((x) => x.id === id) || {}).label || id;
    const old = w.map[c.action];
    return [`${describeBinding(c.binding)} is in use`, `Bound to ${lab(c.with)}. Swap them? ${lab(c.with)} gets ${old ? describeBinding(old) : 'nothing'}.`];
  }

  _renderKeys() {
    const K = this.bindings.keys, simple = this.settings.mouseKeys !== 'advanced';
    this._keysList.innerHTML = KEY_ACTIONS.map((a) => {
      const list = K[a.id] || [], alt = list.slice(1).map(keyName).join(' · ');
      const sub = a.simple && simple ? `<small>Simple mouse keys: ${esc(a.simple.toLowerCase())}</small>` : '';
      return `<div class="m-krow" role="listitem"><span class="m-klabel">${esc(a.label)}${sub}</span>` +
        `<button type="button" class="m-kslot" data-nav data-kslot="${a.id}:0" aria-label="${esc(a.label)} key">${esc(list[0] ? keyName(list[0]) : '—')}</button>` +
        `<button type="button" class="m-kslot m-kslot--alt" data-nav data-kslot="${a.id}:1" aria-label="${esc(a.label)} alternate keys">${esc(alt || '—')}</button></div>`;
    }).join('');
  }
  _capStart(el) {
    const [action, slot] = String(el.dataset.kslot).split(':');
    this._capCancel();
    this._cap = { action, slot: Number(slot) || 0, el };
    el.classList.add('is-cap');
    el.textContent = 'Press a key…';
    this._sound('select');
  }
  _capCancel() {
    const c = this._cap;
    if (!c) return;
    this._cap = null;
    c.el.classList.remove('is-cap');
    const list = this.bindings.keys[c.action] || [];
    c.el.textContent = c.slot === 0 ? (list[0] ? keyName(list[0]) : '—') : (list.slice(1).map(keyName).join(' · ') || '—');
  }
  /** A captured key or mouse code (null: clear the slot). Conflicts ask first (Confirm, kind 'kswap'). */
  _capKey(code) {
    const c = this._cap;
    if (!c) return;
    if (code && !validKey(c.action, code)) { this._capCancel(); return; }
    this._cap = null; c.el.classList.remove('is-cap');
    const own = code ? keyOwner(this.bindings.keys, code, c.action) : null;
    if (own) {
      this._kpend = { action: c.action, slot: c.slot, code, other: own.action };
      this._pending = 'kswap';
      this._push('confirm', { kind: 'kswap' });
      return;
    }
    this.bindings.keys = rebindKey(this.bindings.keys, c.action, c.slot, code);
    this._commitBindings(); this._renderKeys(); this._focusSlot(c.action, c.slot);
    this._sound('adjust');
  }
  _focusSlot(action, slot) {
    const el = this._keysList.querySelector(`[data-kslot="${action}:${slot}"]`);
    if (el) this._focus(el, { silent: true });
  }
  _kswapText() {
    const p = this._kpend;
    if (!p) return ['Key in use', ''];
    const lab = (id) => (KEY_ACTIONS.find((x) => x.id === id) || {}).label || id;
    const list = this.bindings.keys[p.action] || [], old = p.slot === 0 ? list[0] : list[1];
    const gets = old && validKey(p.other, old) ? keyName(old) : 'nothing';
    return [`${keyName(p.code)} is in use`, `Bound to ${lab(p.other)}. Swap them? ${lab(p.other)} gets ${gets}.`];
  }
  _keysReset() {
    this._capCancel();
    this.bindings.keys = sanitizeKeys(DEFAULT_KEYS);
    this._commitBindings(); this._renderKeys();
    const f = this._keysList.querySelector('[data-kslot]');
    if (f) this._focus(f, { silent: true });
    this._sound('adjust');
  }
  /** Capturing keydown (window, capture phase, so js/input.js never sees these keys): key binding capture and the
   *  wizard's keyboard controls. */
  _onCapKey(e) {
    if (!this.open || e.type !== 'keydown') return;
    const scr = this.screen;
    if (scr === 'keys' && this._cap) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'Escape' || e.key === 'Escape') { this._capCancel(); this._sound('back'); }
      else if (e.code === 'Delete') this._capKey(null);
      else if (e.code) this._capKey(e.code);
      return;
    }
    if (scr === 'padwiz' && this._wiz && this._wiz.phase !== 'test') {
      const c = e.code || e.key;
      if (c === 'Escape' || c === 'Backspace' || c === 'Space' || c === ' ') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) return;
        if (c === 'Escape') { this._wiz.cancel(); this._back(); } else if (c === 'Backspace') this._wiz.back(); else this._wiz.skip();
        this._wizRender(null);
      }
    }
  }

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
    const fs = key === FULLSCREEN, v = fs ? isFullscreen() : this.settings[key];
    if (fs) row.hidden = !fullscreenSupported();
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
    const note = fs && this._fsNoteText;              // a refused fullscreen request, in place of the help line
    const desc = note || (d.descs && d.descs[v]) || d.desc || '', de = row.querySelector('.m-desc');
    if (de.textContent !== desc) de.textContent = desc;
    de.hidden = !desc;
    if (fs) de.classList.toggle('m-desc--warn', !!note);
  }

  /** Validate, store, refresh the row, queue a save, notify. Returns true when the value changed. */
  _set(key, value, notify = true) {
    if (key === FULLSCREEN) return false;               // follows the browser (_fullscreen), never stored
    const v = sanitize(key, value);
    if (v === undefined || this.settings[key] === v) return false;
    const prev = this.settings[key];
    if (key === 'padLayout' && v === 'custom') this._ensureCustom(prev);
    this.settings[key] = v;
    this._syncRow(key);
    if (key === 'mouseKeys' || key === 'padLayout') this._renderKb();
    if (key === 'difficulty' && this._detailFor >= 0) this._renderDetail(this._detailFor);   // unit counts depend on it
    this._dirty = true;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this._flushSave(), 300);
    if (notify) this._cb('onSetting', key, v, this.settings);
    return true;
  }
  _change(key, v) { if (this._set(key, v)) this._sound('adjust'); }

  _step(key, dir) {
    if (key === FULLSCREEN) { this._fsFromEdge(); return; }
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
    if (this._tab === 'gameplay') { this._pickedSession = false; saveDifficultyPicked(false); }   // the picker comes back
    this._sound(changed ? 'adjust' : 'select');
  }

  _flushSave() {
    clearTimeout(this._saveT); this._saveT = 0;
    if (this._dirty) { this._dirty = false; saveSettings(this.settings); }
  }

  // ---- Fullscreen row (js/fullscreen.js) ------------------------------------------------------------------------
  /** Ask the browser to enter or leave fullscreen; the row follows the fullscreenchange event, not the request.
   *  Entering needs a user activation: the pointer and key paths call this inside their DOM event (gesture), while
   *  gamepad edges (no gesture) are normally refused. A refusal shows a note on the row. Never rejects. */
  _fullscreen(on, gesture) {
    if (!fullscreenSupported()) return Promise.resolve(false);
    if (on === isFullscreen()) return Promise.resolve(true);
    const req = setFullscreen(on);                     // first: nothing may run between the DOM event and the request
    this._sound('adjust');
    return req.then((ok) => {
      if (!ok && on) this._fsNote(gesture ? 'The browser refused fullscreen.' : 'Fullscreen needs a click or key press.');
      return ok;
    });
  }
  /** Confirm / ←→ edge on the row from update(): a key press was already handled by _fsKey; a gamepad press asks now. */
  _fsFromEdge() { if (!this._fsSkip) this._fullscreen(!isFullscreen(), false); this._fsSkip = false; }

  /** Enter / Space / ←→ on the Fullscreen row ask right here, inside the keydown handler, because update() runs in the
   *  next animation frame, after the event. update() then skips that frame's edge for the key (_fsSkip). */
  _fsKey(e) {
    const f = this._focusEl, t = e.target;
    if (!this.open || e.repeat || !f || f.dataset.key !== FULLSCREEN || !this._cur || !this._cur.contains(f)) return;
    if (performance.now() < (this._lockUntil || 0) || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    if (!ROW_KEYS.has(ROW_KEYS.has(e.code) ? e.code : e.key)) return;
    this._fsKeyDone = true;
    this._fullscreen(!isFullscreen(), true);
  }

  /** Show `text` in place of the Fullscreen row's help line for a few seconds. */
  _fsNote(text) {
    this._fsNoteText = text;
    clearTimeout(this._fsNoteT);
    this._fsNoteT = setTimeout(() => { this._fsNoteText = ''; this._syncRow(FULLSCREEN); }, 4000);
    this._syncRow(FULLSCREEN);
  }
  _fsChanged() { this._fsNoteText = ''; clearTimeout(this._fsNoteT); this._syncRow(FULLSCREEN); }

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
    if (el.dataset.diff) this._selectDiff(el.dataset.diff);
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
      if (d.key === FULLSCREEN) { if (pointer) this._fullscreen(!isFullscreen(), true); else this._fsFromEdge(); return; }
      const def = DEF[d.key];
      if (def.type === 'toggle') this._change(d.key, !this.settings[d.key]);
      else if (def.type === 'choice' && !pointer) this._step(d.key, 1);
      return;
    }
    if (d.tab) { const first = this._firstInTab(); if (first) this._focus(first); return; }
    if (d.mission !== undefined) { if (!pointer) this._start(+d.mission); return; }
    if (d.diff) { if (!pointer) this._confirmPick(); return; }   // a click only selects (Start launches)
    if (d.kslot) { this._capStart(el); return; }
    switch (d.act) {
      case 'start': this._start(0); break;
      case 'infinity': this._run('onInfinity'); break;
      case 'launch': if (this.missions.length) this._start(this._missionSel); break;
      case 'diff-ok': this._confirmPick(); break;
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
        if (this._pending === 'kswap') { this._kswapDo(); break; }
        if (this._pending === 'pswap') { const w = this._wiz; this._pending = null; this._popTo('padwiz'); if (w) { w.resolveConflict(true); this._wizRender(null); } break; }
        if (this._pending === 'restart') this._run(this._pauseInf ? 'onInfinity' : 'onRestart'); else this._quit();
        break;
      case 'back': this._back(); break;
      case 'reset-tab': this._resetTab(); break;
      case 'padwiz': case 'keys': this._push(d.act); break;
      case 'wiz-back': if (this._wiz) { this._wiz.back(); this._wizRender(null); this._sound('back'); } break;
      case 'wiz-skip': if (this._wiz) { this._wiz.skip(); this._wizRender(null); this._sound('move'); } break;
      case 'wiz-redo': if (this._wiz) { this._wiz.reset(); this._wz.sig = ''; this._wizRender(null); this._focus(this._defaultFocus('padwiz'), { silent: true }); this._sound('select'); } break;
      case 'wiz-save': this._wizSave(); break;
      case 'keys-reset': this._keysReset(); break;
      case 'install': this._install(); break;
      default: break;
    }
  }

  /** Pop a modal back to `screen` without sounds or side effects. */
  _popTo(screen) {
    while (this._stack.length > 1 && this.screen !== screen) this._stack.pop();
    this._enter(this.screen, null, true);
  }
  _kswapDo() {
    const p = this._kpend;
    this._kpend = null; this._pending = null;
    this._popTo('keys');
    if (!p) return;
    this.bindings.keys = rebindKey(this.bindings.keys, p.action, p.slot, p.code, true);
    this._commitBindings(); this._renderKeys(); this._focusSlot(p.action, p.slot);
    this._sound('adjust');
  }

  _back() {
    const top = this.screen;
    if (!top) return;
    if (top === 'settings') this._flushSave();
    if (top === 'keys') this._capCancel();
    if (top === 'padwiz') this._wiz = null;
    if (top === 'confirm' && this._pending === 'pswap' && this._wiz) this._wiz.resolveConflict(false);
    if (top === 'confirm' && this._pending === 'kswap') this._kpend = null;
    if (this._stack.length > 1) {
      this._stack.pop();
      if (top === 'confirm') this._pending = null;
      if (top === 'padwiz' || top === 'keys') this._syncRow('padLayout');
      if (top === 'difficulty') this._pickFor = null;
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
      key: (e) => this._onKey(e), flush: () => this._flushSave(), cap: (e) => this._onCapKey(e),
    };
    window.addEventListener('keydown', this._h.cap, true);
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
    this._h.fsOff = onFullscreenChange(() => this._fsChanged());
  }

  /** Enter / Space on a focused menu element must not also trigger the browser's native button activation:
   *  activation goes through update() (input.menuConfirm) only, so it happens exactly once (Fullscreen row: _fsKey). */
  _onKey(e) {
    if (e.type === 'keydown') this._fsKey(e);
    if (!this.open || !(e.target instanceof Node) || !this.el.contains(e.target)) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
  }

  _onPointerDown(e) {
    e.stopPropagation();
    if (!this.open) return;
    if (this._cap) {                                       // key capture: a mouse button binds (cannon / missile), else cancels
      const c = this._cap, ok = e.pointerType === 'mouse' && validKey(c.action, 'Mouse' + e.button);
      this._swallowClick = e.button === 0 ? performance.now() + 1000 : 0;   // (other buttons fire no click)
      e.preventDefault();
      if (ok) this._capKey('Mouse' + e.button); else { this._capCancel(); this._sound('back'); }
      return;
    }
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
    if (this._swallowClick) { const sw = performance.now() < this._swallowClick; this._swallowClick = 0; if (sw) return; }   // the click that ended a key capture
    if (!this.open || !this._cur) return;
    if (this.screen === 'install') { this._back(); return; }   // the hint closes on any tap
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !this._cur.contains(t)) return;
    const seg = t.closest('.m-seg button');
    if (seg) {
      const row = seg.closest('.m-row'), d = DEF[row.dataset.key];
      this._focus(row, { pointer: true, silent: true });
      if (d.key === FULLSCREEN) this._fullscreen(seg.dataset.val === 'true', true);
      else this._change(row.dataset.key, d.type === 'toggle' ? seg.dataset.val === 'true' : seg.dataset.val);
      return;
    }
    if (t.closest('.m-slider')) return;                    // handled by the drag
    const el = t.closest('[data-nav], [data-act]');
    if (!el) return;
    if (el.hasAttribute('data-nav')) {
      const was = this._focusEl;
      this._focus(el, { pointer: true, silent: true });     // a tab or mission row is selected by focusing it
      if ((el.dataset.tab || el.dataset.mission !== undefined || el.dataset.diff)) { if (was !== el) this._sound('move'); return; }
    }
    this._activate(el, true);
  }

  _onDbl(e) {
    const t = e.target instanceof Element ? e.target : null, row = t && t.closest('[data-mission]'), dif = t && t.closest('[data-diff]');
    if (row && this._cur && this._cur.contains(row)) this._start(+row.dataset.mission);
    else if (dif && this._cur && this._cur.contains(dif) && this.screen === 'difficulty') this._confirmPick();
  }
}
