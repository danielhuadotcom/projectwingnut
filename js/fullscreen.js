// js/fullscreen.js — PROJECT WINGNUT fullscreen: the Fullscreen API on the whole page, with the webkit-prefixed calls
// as the fallback (iPadOS and Safari before 16.4). Pure DOM; no state beyond the request in flight.
//
// fullscreenSupported() is false where element fullscreen is unavailable: iPhone Safari, and an iframe without
// allow="fullscreen" (the claude.ai artifact viewer may be one). Hide the option and ignore the shortcut there.
// Browsers grant fullscreen only to a user activation, so call setFullscreen() synchronously inside the click, key or
// touch handler, with no await before it. A gamepad button press is not a user activation: such a request is refused,
// which resolves false (these promises never reject). Leaving needs no activation, and the player can also leave with
// Esc or the browser's own controls, so follow the state with onFullscreenChange(). Fullscreen is never restored on
// load: browsers block entering it without a gesture.

const D = typeof document !== 'undefined' ? document : null;
const ROOT = D && D.documentElement;
// One flavor for request, exit and the change event: the standard API, else the prefixed one (a browser that has both
// fires only the change events of the flavor that made the request)
const STD = !!(ROOT && typeof ROOT.requestFullscreen === 'function');
const CHANGE = STD ? 'fullscreenchange' : 'webkitfullscreenchange';
let pending = null;          // the request in flight; repeat presses while it runs get the same promise

/** Fullscreen can be requested in this document. */
export function fullscreenSupported() { return !!(D && (D.fullscreenEnabled || D.webkitFullscreenEnabled)); }

/** The page is in fullscreen now. */
export function isFullscreen() { return !!(D && (D.fullscreenElement || D.webkitFullscreenElement)); }

/** Call fn on every change, entering or leaving (Esc and the browser's controls included). Returns the unsubscribe. */
export function onFullscreenChange(fn) {
  if (!D) return () => {};
  D.addEventListener(CHANGE, fn);
  return () => D.removeEventListener(CHANGE, fn);
}

/** Enter (on = true) or leave fullscreen. Resolves true when the page ends up in the requested state, false when the
 *  browser refuses; never rejects. Entering on a touch device also tries to lock the screen to landscape. */
export function setFullscreen(on) {
  on = !!on;
  if (pending) return pending;
  if (isFullscreen() === on) return Promise.resolve(true);
  if (on && !fullscreenSupported()) return Promise.resolve(false);
  let r;
  try {
    if (on) r = STD ? ROOT.requestFullscreen({ navigationUI: 'hide' }) : ROOT.webkitRequestFullscreen();
    else r = STD ? D.exitFullscreen() : D.webkitExitFullscreen();
  } catch { return Promise.resolve(isFullscreen() === on); }
  const settle = () => {
    pending = null;
    const ok = isFullscreen() === on;
    if (ok && on) lockLandscape();
    return ok;
  };
  // the prefixed calls return nothing and report the outcome with events instead
  pending = (r && typeof r.then === 'function' ? r : prefixedOutcome()).then(settle, settle);
  return pending;
}

function prefixedOutcome() {
  return new Promise((resolve) => {
    const end = () => {
      clearTimeout(t);
      D.removeEventListener('webkitfullscreenchange', end); D.removeEventListener('webkitfullscreenerror', end);
      resolve();
    };
    const t = setTimeout(end, 2000);
    D.addEventListener('webkitfullscreenchange', end); D.addEventListener('webkitfullscreenerror', end);
  });
}

/** Touch devices: hold landscape while in fullscreen where the browser allows it; failures are ignored. */
function lockLandscape() {
  try {
    const touch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints | 0) > 0;
    const o = touch && typeof screen !== 'undefined' ? screen.orientation : null;
    if (o && typeof o.lock === 'function') { const r = o.lock('landscape'); if (r && typeof r.catch === 'function') r.catch(() => {}); }
  } catch { /* no orientation lock here */ }
}
