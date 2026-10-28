// js/custom_music.js — the player's own soundtrack files (Settings › Audio): one file per music slot, kept in this
// browser's IndexedDB (nothing is uploaded anywhere). js/music.js plays a stored file through MusicDirector.setCustom,
// looping the whole file. Every call resolves (never rejects) where IndexedDB is missing or blocked (private windows):
// the game then simply has no custom tracks.

const DB_NAME = 'wingnut-music', STORE = 'slots';

/** Slots in Settings order. id = the MusicDirector track the file replaces (js/music.js TRACKS). */
export const MUSIC_SLOTS = [
  { id: 'ceiling', label: 'Title & menus', where: 'Title, menus, M2, M3' },
  { id: 'opener', label: 'Opener', where: 'Mission 1' },
  { id: 'epic', label: 'Combat', where: 'Most missions, INFINITY' },
  { id: 'night', label: 'Night', where: 'Night missions' },
  { id: 'icebreaker', label: 'Icebreaker', where: 'Mission 11' },
  { id: 'mainspring', label: 'Mainspring', where: 'Her entrances, M16' },
  { id: 'finale', label: 'Finale', where: 'Mission 21' },
];
export const MAX_BYTES = 150 * 1024 * 1024;   // a file larger than this is refused (lossless audio of a long track)
export const LONG_SECS = 600;                 // longer tracks get a memory note: decoded audio is ~11 MB per stereo minute
const MB_PER_MIN = 11;

let _db = null;
function openDb() {
  if (_db) return _db;
  _db = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return _db;
}
function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE), out = fn(st);
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : true);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

/** Every stored file: { [slot]: { name, size, duration, blob } }. */
export async function loadAll() {
  const out = {};
  const recs = await run('readonly', (st) => st.getAll());
  const keys = await run('readonly', (st) => st.getAllKeys());
  if (Array.isArray(recs) && Array.isArray(keys)) keys.forEach((k, i) => { const r = recs[i]; if (r && r.blob) out[k] = r; });
  return out;
}

/** The MusicDirector data for a stored file. */
export const trackData = (rec) => ({ title: rec.name, load: () => rec.blob.arrayBuffer() });

/** Decode a file once to check that this browser can play it; resolves its duration in seconds, rejects otherwise. */
async function probe(file) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('no audio');
  const ctx = new Ctx(1, 1, 44100);
  const bytes = await file.arrayBuffer();
  const buf = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
  if (!buf || !(buf.duration > 1)) throw new Error('too short');
  return buf.duration;
}

const fmtMin = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export { fmtMin };

/** Check and store a file for a slot. Resolves { rec } (plus warn: a note for the player) or { error }. */
export async function importFile(slot, file) {
  if (!file) return { error: 'No file chosen.' };
  if (file.size > MAX_BYTES) return { error: `That file is over ${MAX_BYTES / 1048576} MB. Try a compressed format such as MP3.` };
  let duration;
  try { duration = await probe(file); } catch { return { error: 'This browser can\'t play that file. MP3 and M4A work everywhere.' }; }
  const rec = { name: file.name, size: file.size, duration, blob: new Blob([file], { type: file.type || '' }) };
  const ok = await run('readwrite', (st) => { st.put(rec, slot); });
  if (!ok) return { error: 'Couldn\'t save the file. The browser may be out of storage space or in a private window.' };
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* best effort */ }
  const warn = duration > LONG_SECS ? `Long track (${fmtMin(duration)}): it takes about ${Math.round(duration / 60 * MB_PER_MIN)} MB of memory while it plays.` : null;
  return { rec, warn };
}

/** Forget a slot's file (the built-in track plays again). */
export function clearSlot(slot) { return run('readwrite', (st) => { st.delete(slot); }); }
