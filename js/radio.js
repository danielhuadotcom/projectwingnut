// js/radio.js — PROJECT WINGNUT radio scheduler: one channel for AWACS Claude, the WSO and Mainspring, plus the story
// script's MUSIC cues. js/awacs.js only plays what this module puts on air (its radio chain and AWACS clips); the story
// lines and their triggers come from js/dialogue_data.js (built by tools/build_dialogue.mjs from the approved script),
// their clips from assets/dialogue/<id>.mp3, fetched per mission.
//
// Priorities (lower number wins the channel):
//   critical  tactical calls (missile, break, pull up, hit, tunnel): break into a flavor or ambient line with a short
//             radio click, at most once every CRIT_EVERY s; expire quickly in the queue (EXPIRY: stale warnings help nobody)
//   plot      phase, boss, Glassfall and completion lines: always queued, never dropped (except by a speaker going silent)
//   flavor    scheduled some seconds into a phase, play only on a quiet channel, dropped if their phase ends first
//   ambient   AWACS chatter (kills, contacts, area clear): short expiry
// Lines never overlap: at least GAP s from one line's end to the next start, PLOT_HOLD s more after a plot line (not for
// a line chained "after" it). No duplicate keys in the queue. MUSIC cues ride the same queue but never take the channel:
// "after #n" fires as line n ends, "with #n" as it starts, a triggered cue at once; cues are never dropped.
//
// The scheduler runs on its own clock (update(dt)) with each clip's known length, so its decisions are the same with or
// without audio (headless tests, a muted or locked AudioContext): a line without a decoded clip still holds the channel
// and shows its subtitle for its length.
//
// Story rules handled here: the WSO takes AWACS's tactical calls 60 % of the time where the pool has a version (in a
// noAwacs mission every time, and AWACS says nothing); the WSO goes silent below the mission's wsoBlackout boss health;
// The WSO voice can be switched off (wsoOn): AWACS then takes every pooled call and its own tunnel commentary, and
// the WSO's script lines and WSO-only calls are silent. "Typical." from Mainspring replaces the AWACS death call while she is in the fight; the tunnel calls are the WSO's
// (AWACS keeps its crash line); AWACS goes silent after the first detonation of the M20 Glassfall.
import { DIALOGUE, DIALOGUE_PATH } from './dialogue_data.js';
import { AWACS_CLIPS } from './awacs_clips.js';

const PRI = { critical: 0, plot: 1, flavor: 2, ambient: 3 };
const GAP = 1.5;            // s from the end of one line to the start of the next
const PLOT_HOLD = 1.0;      // s extra after a plot line, unless the next line is chained after it
const BREAK_IN = 0.12;      // s of radio click between a cut line and the critical call breaking in
const CRIT_EVERY = 5;       // s: a critical call breaks into a line at most this often
const CRIT_TTL = 2.5, AMBIENT_TTL = 3;
const DEBRIEF_CAP = 8;      // s past the completion hold the debrief waits for plot lines
const WSO_SHARE = 0.6;      // share of pool-backed AWACS calls the WSO takes
const LABELS = { AWACS: 'AWACS CLAUDE', WSO: 'WSO SPANNER', MAINSPRING: 'MAINSPRING' };
// AWACS event keys: priority class, default cooldown (s)
const CRITICAL = new Set(['missileIncoming', 'pullUp', 'checkSix', 'playerHit', 'lowHealth', 'tunnelCrash', 'outOfBounds', 'playerDown']);
// Per-trigger cooldowns (s), shared by the AWACS and WSO versions of a call; they start when a line goes on air. Kept
// short: variety (the rotation below) and the short expiry keep reactions from repeating, not long cooldowns.
const COOLDOWNS = { kill: 2, groundKill: 2, missileIncoming: 4, pullUp: 4 };
// WSO-only calls (no AWACS version): a random cooldown in [a, b] s after each one, short expiry, never the same variant twice running
const WSO_CALLS = { lockOn: [12, 20], gunSolution: [12, 20] };
// Time-sensitive calls go stale fast: the s a queued line may wait before it is dropped (a line already on air plays out).
// Others: critical CRIT_TTL, ambient AMBIENT_TTL; plot lines and MUSIC cues never expire. A dropped line does not use up
// its cooldown (cooldowns start when a line goes on air).
const EXPIRY = { gunSolution: 0.4, lockOn: 0.6, checkSix: 0.8, missileIncoming: 0.8, pullUp: 0.8,
  missileDefeated: 1.5, kill: 1.5, groundKill: 1.5, streak: 1.5 };
const DEFAULT_COOLDOWN = 6;
// Story-line delays (s after the trigger) for head lines; chained lines follow their head
const DELAY = { flavor: { start: 4, phase: 3, clear: 1.5, firstKill: 1.2 }, plot: { start: 0.5, phase1: 5 } };
// Pool lines that call the bandit "he": skipped when the bandit is Mainspring
const HE = /\b(he|he's|him)\b/i;
const CLIPS = new Map();    // dialogue id -> { buffer, bytes, state }: fetched once per page, shared by every Radio

export class Radio {
  /**
   * @param awacs   js/awacs.js instance (radio chain and AWACS clips)
   * @param music   js/music.js MusicDirector (cues; duck() while a line is on air)
   * @param opts    { onSubtitle(label, text, seconds, speaker), rand = Math.random, fetchClips = true }
   */
  constructor(awacs, music, opts = {}) {
    this.awacs = awacs; this.music = music;
    this.onSubtitle = opts.onSubtitle || null;
    this.rand = opts.rand || Math.random;
    this.t = 0;                       // scheduler clock (s)
    this.queue = [];
    this.cur = null;                  // line on air { ...item, start, end }
    this.freeAt = 0;                  // channel free from
    this.lastBreakIn = -1e9;
    this.events = [];                 // log: { t, ev, id, speaker, pri, text? } (capped)
    this._seq = 0;
    this._cool = {};                  // key -> last time said
    this._bags = {}; this._next = {}; this._lastClip = {};
    this.fetchClips = opts.fetchClips !== false;
    this.wsoOn = opts.wso !== false;   // Settings > Audio > WSO voice: Off = AWACS makes every call, the WSO's lines are silent
    this.byId = {}; for (const e of DIALOGUE) this.byId[e.id] = e;
    this.pool = {};                   // AWACS key -> WSO pool lines
    for (const e of DIALOGUE) if (e.on === 'pool') (this.pool[e.key] || (this.pool[e.key] = [])).push(e);
    this.tunnel = {}; for (const e of DIALOGUE) if (/^tunnel/.test(e.on || '')) this.tunnel[e.on] = e;
    this.typical = DIALOGUE.find((e) => e.on === 'deathMainspring') || null;
    this.resetMission(null);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // mission flow (js/main.js)
  /** A new sortie (or INFINITY run, M = null): clear everything, fetch the mission's clips, queue its start lines. */
  resetMission(M, game = null) {
    this.stop();
    this.M = M; this.game = game;
    this.script = M && M.id ? DIALOGUE.filter((e) => e.mission === M.id) : [];
    this.phase = 0;
    this.done = {}; this.dropped = {}; this.started = {};
    this.wsoSilent = false; this.awacsSilent = false; this.noAwacs = !!(M && M.noAwacs);
    this.firstKillSaid = false; this.completed = false;
    this.bossMarks = {};
    if (M) this.load(this.script.filter((e) => e.dur).map((e) => e.id).concat(this.globalIds()));
    else this.load(this.globalIds());
  }
  /** Lines any sortie may use: the WSO pool, the tunnel calls, "Typical.". */
  globalIds() { return DIALOGUE.filter((e) => e.dur && !e.mission).map((e) => e.id); }
  missionStart() { this.phase = Math.max(this.phase, 1); this._fire({ on: 'start' }); }
  phaseStart(n) {
    this.phase = n;
    for (const q of this.queue) if (q.pri === 'flavor' && q.phase < n) this._drop(q, 'phase ended');
    this.queue = this.queue.filter((q) => !q._gone);
    this._fire({ on: 'phase', n });
  }
  phaseClear(n) { this._fire({ on: 'clear', n }, { phase: n + 1 }); }
  firstKill() { if (this.firstKillSaid) return; this.firstKillSaid = true; this._fire({ on: 'firstKill' }); }
  glassfall() { this._fire({ on: 'glassfall' }); }
  detonation(n, mode) {
    this._fire({ on: 'detonation', n });
    if (n === 1 && mode === 'mainspring') { this.awacsSilent = true; this._dropSpeaker('AWACS'); }   // AWACS goes silent (M20)
  }
  /** Boss health crossed below pct (50, 25) of its full health. */
  boss(pct) {
    if (this.bossMarks[pct]) return;
    this.bossMarks[pct] = true;
    this._fire({ on: 'boss', n: pct }, { exemptSilence: true });
    const B = this.M && this.M.wsoBlackout;
    if (B && pct / 100 <= B + 1e-9 && !this.wsoSilent) { this.wsoSilent = true; this._dropSpeaker('WSO', true); this._log('blackout', 'WSO'); }
  }
  /** Mission complete: queued flavor, ambient and critical lines go; the last phase's clear lines (promoted to plot) and
   *  the completion lines queue. */
  complete(lastPhase) {
    if (this.completed) return;
    this.completed = true;
    for (const q of this.queue) if (q.pri !== 'plot' && q.kind !== 'cue') this._drop(q, 'mission complete');
    this.queue = this.queue.filter((q) => !q._gone);
    this._fire({ on: 'clear', n: lastPhase }, { promote: true });
    this._fire({ on: 'complete' });
  }
  get hasCompleteLines() { return this.script.some((e) => e.on === 'complete'); }
  /** True while a plot line is on air or queued (the debrief waits for it, up to DEBRIEF_CAP). */
  get plotPending() { return !!(this.cur && this.cur.pri === 'plot') || this.queue.some((q) => q.pri === 'plot' && q.kind === 'voice' && !q.gate); }
  get debriefCap() { return DEBRIEF_CAP; }
  get speaking() { return !!this.cur; }
  /** The player is down. mainspring: she is in the fight ("Typical." replaces the AWACS call). */
  playerDown(mainspring) {
    for (const q of this.queue) if (q.pri !== 'plot' && q.kind !== 'cue') this._drop(q, 'player down');
    this.queue = this.queue.filter((q) => !q._gone);
    if (mainspring && this.typical) {
      if (this.cur && this.cur.pri !== 'plot') this._cut('player down');
      this._enqueue(this._story(this.typical, 'plot', 0), true);
      return;
    }
    this.say('playerDown');
  }

  // ---------------------------------------------------------------------------------------------------------------
  /**
   * An AWACS event (js/awacs_clips.js key). opts: { cooldown, subject (the aircraft the call is about) }.
   * Returns true if a line was queued.
   */
  say(key, opts = {}) {
    const cd = opts.cooldown !== undefined ? +opts.cooldown || 0 : WSO_CALLS[key] ? 0 : (COOLDOWNS[key] ?? DEFAULT_COOLDOWN);
    if (this.t - (this._cool[key] ?? -1e9) < cd) return false;
    if (WSO_CALLS[key] && this.t < (this._next[key] ?? -1e9)) return false;
    if (this._has(key)) return false;                                     // no duplicates
    const pri = CRITICAL.has(key) ? 'critical' : 'ambient';
    // tunnel calls: the WSO's lines replace AWACS's commentary
    if (this.tunnel[key] && this.wsoOn) {
      if (this.wsoSilent) return false;
      const it = this._story(this.tunnel[key], 'critical', key === 'tunnelEnter' ? 1.0 : 0);
      it.key = key; it.ttl = this.t + (key === 'tunnelEnter' ? 3.5 : CRIT_TTL);
      return this._enqueue(it);
    }
    const pool = (this.wsoOn ? this.pool[key] || [] : []).filter((e) => !(opts.subject && (opts.subject.mainspring || /MAINSPRING/.test(opts.subject.name || '')) && HE.test(e.text)));
    const awacsOk = !this.noAwacs && !this.awacsSilent && AWACS_CLIPS[key];
    let wso = pool.length > 0 && !this.wsoSilent && (this.noAwacs || this.awacsSilent || !AWACS_CLIPS[key] || this.rand() < WSO_SHARE);
    if (!wso && !awacsOk) return false;
    // never the same clip twice in a row within a trigger: a version with one clip that just played hands over to the other
    const only = (n, id) => n === 1 && this._lastClip[key] === id;
    if (wso && only(pool.length, pool[0] && pool[0].id)) { if (awacsOk) wso = false; else return false; }
    else if (!wso && awacsOk && only(AWACS_CLIPS[key].length, key + '#0')) { if (pool.length && !this.wsoSilent) wso = true; else return false; }
    let it;
    if (wso) {
      it = this._story(this._rotate('wso:' + key, pool), pri, 0);
    } else {
      const clips = AWACS_CLIPS[key];
      const i = this._rotate('awacs:' + key, clips.map((c, k) => k));
      it = { kind: 'voice', id: key + '#' + i, speaker: 'AWACS', text: clips[i].text, dur: clips[i].dur, awacs: [key, i], pri };
    }
    it.key = key; it.at = this.t;
    it.ttl = this.t + (EXPIRY[key] ?? (pri === 'critical' ? CRIT_TTL : AMBIENT_TTL));
    return this._enqueue(it);
  }

  /** Next variant of a call: a shuffled rotation through all of them, never the same one twice in a row (also across a
   *  reshuffle). items: the variants; bag key: per trigger and speaker. Variants filtered out for this call are skipped. */
  _rotate(bagKey, items) {
    const bag = this._bags[bagKey] || (this._bags[bagKey] = { left: [], last: null });
    const ids = items.map((x) => (typeof x === 'object' ? x.id : x));
    bag.left = bag.left.filter((x) => ids.includes(x));
    if (!bag.left.length) {
      bag.left = ids.slice();
      for (let i = bag.left.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)) % (i + 1); [bag.left[i], bag.left[j]] = [bag.left[j], bag.left[i]]; }
      if (bag.left.length > 1 && bag.left[0] === bag.last) bag.left.push(bag.left.shift());
    }
    const id = bag.left.shift(); bag.last = id;
    return items[ids.indexOf(id)];
  }

  /** Cut the line on air and drop the queue (quit, restart). */
  stop() {
    if (this.cur) { if (this.awacs && this.awacs.cutTransmission) this.awacs.cutTransmission(); this._log('cut', this.cur.id, Object.assign({}, this.cur, { why: 'stop' })); this.cur = null; }
    this.queue.length = 0; this.freeAt = this.t + (this.events.length ? GAP : 0);
    if (this.music && this.music.duck) this.music.duck(false);
  }
  /** Drop everything queued (cues included); the line on air finishes (the debrief opening). */
  flush() { for (const q of this.queue) this._drop(q, 'flush'); this.queue.length = 0; }
  /** Pause: break off the line on air; the queue waits (update with running = false). */
  pause() {
    if (this.cur) { if (this.awacs && this.awacs.cutTransmission) this.awacs.cutTransmission(); this._finish(this.cur, 'cut'); this.cur = null; }
  }

  // ---------------------------------------------------------------------------------------------------------------
  /** Every frame. running = false holds the clock (pause, title). */
  update(dt, running = true) {
    if (!running) return;
    this.t += dt;
    const t = this.t;
    this._decodePending();
    if (this.cur && t >= this.cur.end) { const c = this.cur; this.cur = null; this._finish(c, 'end'); }
    // housekeeping: expired items; flavor waiting for a dropped head
    for (const q of this.queue) {
      if (q._gone) continue;
      if (q.ttl !== undefined && t > q.ttl) this._drop(q, 'expired');
      else if (q.after && this.dropped[q.after] && q.pri === 'flavor') this._drop(q, 'head dropped');
    }
    // cues: triggered ones at once, "after" ones once their line has ended (or was dropped)
    for (const q of this.queue) {
      if (q._gone || q.kind !== 'cue') continue;
      if (q.with) { if (this.dropped[q.with]) this._cue(q); continue; }
      if (!q.after || this.done[q.after] || this.dropped[q.after]) this._cue(q);
    }
    this.queue = this.queue.filter((q) => !q._gone);
    // a critical call may break into a flavor or ambient line
    if (this.cur && (this.cur.pri === 'flavor' || this.cur.pri === 'ambient') && t - this.lastBreakIn >= CRIT_EVERY) {
      const c = this._best(true);
      if (c && c.pri === 'critical') { this.lastBreakIn = t; this._cut('break-in'); this._start(c, true); return; }
    }
    if (this.cur || t < this.freeAt) return;
    const next = this._best(false);
    if (next) this._start(next, false);
  }

  // ---------------------------------------------------------------------------------------------------------------
  _best(criticalOnly) {
    const t = this.t;
    let best = null, hasHigher = false;
    for (const q of this.queue) {
      if (q._gone || q.kind !== 'voice' || q.at > t) continue;
      if (q.after && !this.done[q.after] && !this.dropped[q.after]) continue;   // waits for its head
      if (q.with) continue;
      if (q.gate === 'alone' && !(this.game && this.game.radioAlone && this.game.radioAlone())) continue;
      if (criticalOnly && q.pri !== 'critical') continue;
      if (q.pri !== 'flavor') hasHigher = true;
      if (!best || PRI[q.pri] < PRI[best.pri] || (PRI[q.pri] === PRI[best.pri] && q.seq < best.seq)) best = q;
    }
    if (best && best.pri === 'flavor' && hasHigher) return null;
    return best;
  }
  _start(q, breakIn) {
    q._gone = true;
    this.queue = this.queue.filter((x) => !x._gone);
    const t = this.t;
    const lead = breakIn ? BREAK_IN : 0;
    const buf = this._buffer(q);
    let dur = q.dur || 1.5;
    if (buf && this.awacs && this.awacs.transmit) { const d = this.awacs.transmit(buf, { breakIn, label: q.id }); if (d > 0) dur = d; }
    this.cur = Object.assign(q, { start: t, end: t + lead + dur, audio: !!buf });
    this.started[q.id] = true;
    if (q.key) {                                   // cooldowns start on air
      this._cool[q.key] = t; this._lastClip[q.key] = q.id;
      if (WSO_CALLS[q.key]) { const [a, b] = WSO_CALLS[q.key]; this._next[q.key] = t + a + (b - a) * this.rand(); }
    }
    this._log(breakIn ? 'break-in' : 'start', q.id, q);
    if (this.onSubtitle && q.text) { try { this.onSubtitle(LABELS[q.speaker] || q.speaker, q.text, dur, q.speaker); } catch (e) { console.error(e); } }
    if (this.music && this.music.duck) this.music.duck(true);
    for (const c of this.queue) if (c.kind === 'cue' && c.with === q.id) this._cue(c);   // "with #n" cues
    this.queue = this.queue.filter((x) => !x._gone);
  }
  _finish(c, how) {
    if (how === 'end') this.done[c.id] = true; else this.dropped[c.id] = true;
    if (c.alias) { if (how === 'end') this.done[c.alias] = true; else this.dropped[c.alias] = true; }   // lines chained after the WSO beat it stood in for
    const chained = this.queue.some((q) => q.after === c.id && q.kind === 'voice');
    this.freeAt = this.t + GAP + (c.pri === 'plot' && !chained ? PLOT_HOLD : 0);
    this._log(how, c.id, c);
    if (this.music && this.music.duck) this.music.duck(false);
  }
  _cut(why) {
    const c = this.cur; if (!c) return;
    if (this.awacs && this.awacs.cutTransmission) this.awacs.cutTransmission();
    this.cur = null;
    this.dropped[c.id] = true;
    this._log('cut', c.id, Object.assign({}, c, { why }));
  }
  _cue(q) {
    q._gone = true; this.done[q.id] = true;
    this._log('cue', q.id, q);
    if (this.music && this.music.cue) { try { this.music.cue(q.music); } catch (e) { console.error(e); } }
  }
  _drop(q, why) { q._gone = true; this.dropped[q.id] = true; this._log('drop', q.id, Object.assign({}, q, { why })); }
  _dropSpeaker(speaker, keepExempt = false) {
    for (const q of this.queue) if (q.speaker === speaker && !(keepExempt && q.exempt)) this._drop(q, speaker + ' silent');
    this.queue = this.queue.filter((q) => !q._gone);
  }
  _has(key) {
    if (this.cur && (this.cur.key === key || this.cur.id === key)) return true;
    return this.queue.some((q) => !q._gone && (q.key === key || q.id === key));
  }
  _enqueue(it, front = false) {
    if (it.kind === 'voice') {
      if (it.speaker === 'WSO' && ((this.wsoSilent && !it.exempt) || !this.wsoOn)) return false;
      if (it.speaker === 'AWACS' && (this.noAwacs || this.awacsSilent)) return false;
    }
    if (this._has(it.key || it.id)) return false;
    const e = this.byId[it.id];
    if (e && e.mission && (this.done[it.id] || this.started[it.id])) return false;   // a mission's story line plays once
    it.seq = front ? -1e6 + this._seq++ : this._seq++;
    this.queue.push(it);
    this._log('queue', it.id, it);
    return true;
  }
  /** A story line (js/dialogue_data.js entry) as a queue item. */
  _story(e, pri, delay) {
    return { kind: e.music ? 'cue' : 'voice', id: e.id, speaker: e.speaker, text: e.text, dur: e.dur, music: e.music, pri,
      at: this.t + delay, after: e.after, with: e.with, gate: e.gate, phase: this.phase, story: true };
  }
  /** Queue the script lines whose trigger matches, with every line chained after or with them. */
  _fire(trig, opts = {}) {
    const heads = this.script.filter((e) => e.on === trig.on && (trig.n === undefined || e.n === trig.n) && !e.after && !e.with);
    if (!heads.length) return;
    this._log('trigger', trig.on + (trig.n !== undefined ? ' ' + trig.n : ''));
    const add = (e, head) => {
      let pri = e.pri === 'cue' ? 'plot' : e.pri;
      if (opts.promote && pri === 'flavor') pri = 'plot';
      let delay = 0;
      if (head && !e.music) {
        const D = pri === 'flavor' ? DELAY.flavor : DELAY.plot;
        delay = pri === 'flavor' ? (D[trig.on] ?? 0) : trig.on === 'start' ? D.start : trig.on === 'phase' && trig.n === 1 ? D.phase1 : 0;
        if (opts.promote) delay = 0;
      }
      const fb = !this.wsoOn && e.speaker === 'WSO' ? this.script.find((f) => f.fallbackFor === e.id) : null;
      const it = fb ? Object.assign(this._story(fb, pri, delay), { alias: e.id }) : this._story(e, pri, delay);   // WSO voice off: AWACS carries the beat
      if (opts.phase) it.phase = opts.phase;
      if (opts.exemptSilence) it.exempt = true;
      if (it.kind === 'cue' && !it.after && !it.with) { this.queue.push(Object.assign(it, { seq: this._seq++ })); this._log('queue', it.id, it); }
      else this._enqueue(it);
      for (const f of this.script) if (f.after === e.id || f.with === e.id) add(f, false);
    };
    for (const h of heads) add(h, true);
  }
  // ---- clips ------------------------------------------------------------------------------------------------------
  /** Fetch dialogue clips (ids) once; decoded as soon as the AudioContext exists. */
  load(ids) {
    if (typeof fetch !== 'function' || !this.fetchClips) return;
    for (const id of ids) {
      if (CLIPS.has(id)) continue;
      const c = { buffer: null, bytes: null, state: 'fetch' };
      CLIPS.set(id, c);
      fetch(DIALOGUE_PATH + id + '.mp3').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
        .then((b) => { c.bytes = b; c.state = b ? 'fetched' : 'failed'; });
    }
  }
  _decodePending() {
    const ctx = this.awacs && this.awacs.fx && this.awacs.fx.ctx;
    if (!ctx) return;
    for (const c of CLIPS.values()) {
      if (c.state !== 'fetched') continue;
      c.state = 'decoding';
      const done = (buf) => { c.buffer = buf || null; c.state = buf ? 'ready' : 'failed'; c.bytes = null; };
      try {
        const p = ctx.decodeAudioData(c.bytes, done, () => done(null));
        if (p && typeof p.then === 'function') p.then(done, () => done(null));
      } catch (e) { done(null); }
    }
  }
  /** Decoded buffer for a queue item, or null (the line then plays silently with its subtitle). */
  _buffer(q) {
    if (q.awacs) return this.awacs && this.awacs.clipBuffer ? this.awacs.clipBuffer(q.awacs[0], q.awacs[1]) : null;
    const c = CLIPS.get(q.id);
    return c && c.buffer ? c.buffer : null;
  }
  /** Clip load state: { total, ready, failed }. */
  get clipStats() {
    let total = 0, ready = 0, failed = 0;
    for (const c of CLIPS.values()) { total++; if (c.state === 'ready') ready++; else if (c.state === 'failed') failed++; }
    return { total, ready, failed };
  }
  _log(ev, id, q) {
    const e = { t: Math.round(this.t * 100) / 100, ev, id };
    if (q && q.speaker) { e.speaker = q.speaker; e.pri = q.pri; }
    if (q && q.why) e.why = q.why;
    if (q && q.text && (ev === 'start' || ev === 'break-in')) e.text = q.text;
    if (q && q.music && ev === 'cue') e.music = q.music.action + (q.music.track ? ' ' + q.music.track : '');
    if (q && q.end && (ev === 'start' || ev === 'break-in')) e.end = Math.round(q.end * 100) / 100;
    this.events.push(e);
    if (this.events.length > 600) this.events.splice(0, this.events.length - 600);
  }
}
