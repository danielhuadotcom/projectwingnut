import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Bandit flights. js/main.js spawns them, EnemyBrain flies them (js/ai.js).
//
// An armed air group splits into flights: pairs, or 4-ship flights for groups that set flight: 4 (named aces), with a
// leftover single flying alone. A flight either commits at spawn (task 'engage', boss escorts) or holds until it commits:
// it orbits a station ('patrol'), flies beside the aircraft it escorts ('escort') or climbs out after a scramble
// ('scramble'). A holding flight has no hunting role, takes no attack slot and never fires; the bandit director ignores
// it. The whole flight commits at once, then fights as before, when
//   - the player or a squadmate comes within COMMIT_RANGE of a member (for an escort, also of an aircraft it escorts),
//   - a member, or an aircraft it escorts, is hit or has a missile fired at it,
//   - a scramble's climb-out ends,
//   - or the commit timer releases it. The timer releases one flight per stagger interval while fewer than the
//     difficulty's cap of flights are committed, after QUIET_GAP when none is, and past LOITER_MAX stagger intervals
//     of holding, regardless of the cap. Slow flights (helicopters) are never released: they defend their site.
// Triggers are local: committing one flight never commits another. Checks run at 3 Hz, and nothing allocates per frame.
//
// Placement keeps time to engagement short (behavior, not distance, makes the variety): holding flights sit within
// HOLD_MAX of the phase's anchor (the player, at the start), inbound flights spawn within INBOUND_MAX and come in near
// top speed, scrambles climb out within SCRAMBLE_MAX. Campaign groups are placed from the mission data (js/main.js,
// with a fixed frame and seed per mission); generated groups (Infinity mode) take genericStations(), 2.5-4.5 km from
// the player, spread in bearing, preferably 2.5 km apart. Every station's orbit stays on the map, clear of the tunnel
// ridge and high enough over the terrain under it.

export const COMMIT_RANGE = 2200;  // m: the player or a squadmate this close to a holding flight commits it
export const HOLD_MAX = 4500;      // m: holding stations (patrols) at most this far from the phase's anchor
export const INBOUND_MAX = 7000;   // m: inbound waves (task 'engage') at most this far out (missions.js validation)
export const SCRAMBLE_MAX = 5000;  // m: scrambles climb out at most this far from the phase's anchor
const TICK = 1 / 3;                // s between commit checks
const QUIET_GAP = 5;               // s: with no flight committed, the timer releases the next one this soon
const LOITER_MAX = 4;              // stagger intervals a flight may hold before the cap stops applying to it
const CLIMB_TIME = 8;              // s of climb-out after a scramble
const TERRAIN_CLEAR = 450;         // m: holding altitude over the highest terrain under the orbit
const MAX_ALT = 4500;              // m: holding altitude ceiling (higher only over terrain that needs it)
const RIDGE_CLEAR = 500;           // m: gap between an orbit and the tunnel ridge's bounding sphere
const MAP_MARGIN = 0.85;           // orbits stay inside this fraction of the half-size (EnemyBrain turns back at 0.9)
// formation slots: right, up, back (m) in the lead's heading frame; the side is mirrored per flight
export const SLOTS = [[0, 0, 0], [210, 15, 150], [-250, -12, 180], [-470, -25, 340]];

/** Seeded generator (mulberry32): uniform [0, 1) floats, the same sequence for the same seed. */
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True while aircraft e belongs to an armed flight that still holds (uncommitted). */
export function isHolding(e) {
  const F = e.brain ? e.brain.flight : null;
  return !!F && F.loiter && !F.passive;
}

/** Orbit radius (m) for a flight cruising at `speed` m/s: about an 11 deg/s turn, 450 m for the slowest. */
export function orbitRadius(speed) { return THREE.MathUtils.clamp(speed * 5, 450, 1000); }

class Flight {
  constructor() {
    this.members = [];                 // Aircraft, lead first (an aircraft counts while alive with brain.flight === this)
    this.lead = null;                  // first live member (set at spawn and on every check)
    this.loiter = false;               // holding: no role, no attack slot, no fire
    this.mode = 'orbit';               // while holding: 'orbit' | 'escort' | 'climb'
    this.passive = false;              // unarmed: an orbit holds for good, a climb-out ends in transit; never counted
    this.slow = false;                 // slow types (helicopters): the commit timer never releases it
    this.station = new THREE.Vector3();   // orbit centre, y = holding altitude
    this.radius = 1000; this.dir = 1;  // orbit radius (m) and direction (+1 / -1)
    this.charges = null;               // escort: the aircraft it escorts (array shared by that group's escort flights)
    this.offset = new THREE.Vector3(); // escort: lead's station right, up, back (m) in the first live charge's frame
    this.until = 0;                    // scramble: game time the climb-out ends
    this.since = 0;                    // game time it began holding
    this.committedAt = -1; this.why = '';   // when and why it committed (stats, tests)
  }
}

export class Flights {
  /** @param world getHeight(x, z) @param tunnel optional, center + radius (the ridge's bounding sphere) */
  constructor(world, tunnel, worldHalf) {
    this.world = world; this.tunnel = tunnel || null; this.worldHalf = worldHalf;
    this.list = [];                    // every Flight object (pooled: live === false ones are free)
    this.lastRelease = 0;              // game time of the last timer release
    this.dirty = false;                // set by commit(): the game re-runs its director on the next frame
    this._t = 0;
    this.stats = { contact: 0, attacked: 0, timer: 0, quiet: 0, deadline: 0, climb: 0, lost: 0 };
  }

  clear() {
    for (const F of this.list) { F.live = false; F.loiter = false; F.members.length = 0; F.charges = null; F.lead = null; }
    this.lastRelease = 0; this._t = 0;
  }
  /** A phase (or a generated wave) starts: the commit timer counts from now. */
  restart(now) { this.lastRelease = now; }

  /**
   * New flight of members[0..n) (lead first, at most 4). mode 'engage' commits at once; 'orbit' holds on the station
   * (radius, dir), 'escort' beside charges at offset, 'climb' climbs out for CLIMB_TIME. Sets each member's
   * brain.flight and formation slot, and holdFire while it holds. Spawn time only.
   */
  add(members, n, mode, now, side = 1) {
    let F = null;
    for (const f of this.list) if (!f.live) { F = f; break; }
    if (!F) { F = new Flight(); this.list.push(F); }
    F.live = true; F.mode = mode === 'engage' ? 'orbit' : mode; F.loiter = mode !== 'engage';
    F.passive = false; F.slow = false; F.charges = null; F.since = now; F.committedAt = F.loiter ? -1 : now; F.why = F.loiter ? '' : 'spawn';
    F.until = mode === 'climb' ? now + CLIMB_TIME : 0;
    F.members.length = 0;
    for (let i = 0; i < n && i < SLOTS.length; i++) {
      const ac = members[i], b = ac.brain, s = SLOTS[i];
      F.members.push(ac);
      b.flight = F; b.slotOff.set(s[0] * side, s[1], s[2]);
      if (F.loiter) ac.holdFire = true;
      if (ac.brain.passive) F.passive = true;
      F.slow = (ac.speedScale || 1) < 0.5;   // too slow to come to the fight in time: the commit timer leaves it be
    }
    F.lead = F.members[0] || null;
    if (F.lead) F.station.copy(F.lead.position);   // fallback orbit (pooled: never a stale one); 'orbit' callers set theirs
    F.radius = 1000; F.dir = side;
    return F;
  }

  /** First live member of F, or null. */
  _lead(F) {
    for (const m of F.members) if (m.alive && m.brain.flight === F) return m;
    return null;
  }

  /** Commit flight F (all its live members): they fight as before, from the director's next pass. */
  commit(F, now, why) {
    if (!F.loiter || F.passive) return;
    F.loiter = false; F.why = why; F.committedAt = now; this.dirty = true;
    if (this.stats[why] !== undefined) this.stats[why]++;
    for (const m of F.members) {
      if (!m.alive || m.brain.flight !== F) continue;
      const b = m.brain;
      b.state = 'pursue'; b.stateTime = 0; b.role = null; b.target = null; b.threat = null;
      m.holdFire = false;
    }
  }

  /** Weapons hook (hit, or a missile fired at it): commits ac's own holding flight and any flights escorting it. */
  attacked(ac, now) {
    const F = ac.brain ? ac.brain.flight : null;
    if (F && F.loiter && ac.alive) this.commit(F, now, 'attacked');
    const E = ac.escorts;
    if (E) for (let i = 0; i < E.length; i++) if (E[i].live && E[i].loiter) this.commit(E[i], now, 'attacked');
  }

  /** Flights committed now (with a live member). */
  committedCount() {
    let n = 0;
    for (const F of this.list) if (F.live && !F.passive && !F.loiter && this._lead(F)) n++;
    return n;
  }

  /** The player or a live squadmate within COMMIT_RANGE of a member of F or of one of its charges. */
  _contact(F, p, allies) { return this._near(F.members, p, allies) || (F.charges !== null && this._near(F.charges, p, allies)); }
  _near(list, p, allies) {
    const R2 = COMMIT_RANGE * COMMIT_RANGE;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;
      if (m.position.distanceToSquared(p.position) < R2) return true;
      for (let j = 0; j < allies.length; j++) { const a = allies[j]; if (a.alive && m.position.distanceToSquared(a.position) < R2) return true; }
    }
    return false;
  }
  _anyAlive(list) { for (let i = 0; i < list.length; i++) if (list[i].alive) return true; return false; }

  /**
   * Commit checks (3 Hz; call every frame). cap = most flights the timer lets be committed at once, stagger = s between
   * timer releases. Drops flights with no live member, commits holding flights on contact, when an escort's charges
   * are gone or a climb-out ends, then lets the timer release the holding flight nearest the player.
   */
  update(dt, now, p, allies, cap, stagger) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = TICK;
    let committed = 0, holding = 0, best = null, bestD = Infinity, oldest = null, oldestT = Infinity;
    for (let i = 0; i < this.list.length; i++) {
      const F = this.list[i];
      if (!F.live) continue;
      const lead = this._lead(F);
      if (!lead) { F.live = false; F.loiter = false; F.lead = null; F.charges = null; continue; }
      F.lead = lead;
      if (F.passive) { if (F.loiter && F.mode === 'climb' && now >= F.until) F.loiter = false; continue; }   // unarmed: transit on
      if (!F.loiter) { committed++; continue; }
      if (F.mode === 'climb' && now >= F.until) { this.commit(F, now, 'climb'); committed++; continue; }
      if (F.charges !== null && !this._anyAlive(F.charges)) { this.commit(F, now, 'lost'); committed++; continue; }
      if (p.alive && this._contact(F, p, allies)) { this.commit(F, now, 'contact'); committed++; continue; }
      if (F.mode === 'climb' || F.slow) continue;   // slow types (helicopters) hold their site until approached or attacked
      holding++;
      const d = lead.position.distanceToSquared(p.position);
      if (d < bestD) { bestD = d; best = F; }
      if (F.since < oldestT) { oldestT = F.since; oldest = F; }
    }
    if (!holding || !p.alive) return;
    if (now - this.lastRelease < (committed === 0 ? Math.min(stagger, QUIET_GAP) : stagger)) return;
    if (committed < cap) { this.commit(best, now, committed === 0 ? 'quiet' : 'timer'); this.lastRelease = now; }
    else if (now - oldestT >= LOITER_MAX * stagger) { this.commit(oldest, now, 'deadline'); this.lastRelease = now; }
  }

  // ---- placement safety (both paths) ----------------------------------------------------------------------------
  /** True if an orbit of radius R around (x, z) stays on the map and clear of the tunnel ridge. */
  orbitFits(x, z, R) {
    const lim = this.worldHalf * MAP_MARGIN - R;
    if (Math.abs(x) > lim || Math.abs(z) > lim) return false;
    const tn = this.tunnel;
    if (tn && tn.center) {
      const dx = x - tn.center.x, dz = z - tn.center.z, c = tn.radius + R + RIDGE_CLEAR;
      if (dx * dx + dz * dz < c * c) return false;
    }
    return true;
  }
  /** Nearest point to (x, z) where an orbit of radius R fits: the request itself, else rings 400 m apart out to 8 km
   *  (searched from the side facing the map centre). Deterministic. Writes out.x / out.z. */
  fitStation(out, x, z, R) {
    if (this.orbitFits(x, z, R)) return out.set(x, out.y, z);
    const a0 = Math.atan2(-z, -x);
    for (let r = 400; r <= 8000; r += 400) {
      const steps = Math.max(12, Math.round(2 * Math.PI * r / 400));
      for (let j = 0; j < steps; j++) {
        const a = a0 + (j & 1 ? 1 : -1) * ((j + 1) >> 1) * (2 * Math.PI / steps);
        const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
        if (this.orbitFits(sx, sz, R)) return out.set(sx, out.y, sz);
      }
    }
    const lim = this.worldHalf * MAP_MARGIN - R;
    return out.set(THREE.MathUtils.clamp(x, -lim, lim), out.y, THREE.MathUtils.clamp(z, -lim, lim));
  }
  /** Holding altitude for an orbit of radius R around (x, z): wantY, raised to TERRAIN_CLEAR over the highest terrain
   *  under the orbit's band (R - 300 to R + 500 m, sampled every ~80 m around and 100 m across, and the centre), at most
   *  MAX_ALT unless the terrain needs more. Spawn time only. */
  orbitAlt(x, z, R, wantY) {
    const w = this.world, n = Math.ceil(2 * Math.PI * (R + 500) / 80);
    let h = Math.max(w.getHeight(x, z), 0);
    for (let k = 0; k < n; k++) {
      const a = k * 2 * Math.PI / n, c = Math.cos(a), s = Math.sin(a);
      for (let q = -300; q <= 500; q += 100) h = Math.max(h, w.getHeight(x + c * (R + q), z + s * (R + q)));
    }
    return Math.max(Math.min(wantY, MAX_ALT), h + TERRAIN_CLEAR);
  }

  // ---- generic path (Infinity mode) ------------------------------------------------------------------------------
  /**
   * Generic stations: n orbit centres around (px, pz), written into out[k] (Vector3: x, holding altitude, z). The first
   * station (when first is true) sits 2.5-3 km out so the fight starts at once; the rest 3.5-4.5 km out, just beyond
   * contact range with their orbit. Each is the best of a 24-bearing x 3-distance sweep: hard limits first (orbitFits), then spread
   * (distance to the nearest station taken so far, up to 6 km; under 2.5 km is penalized, not forbidden), then
   * closeness to the preferred bearing `pref` (rad from north, clockwise; NaN = none), plus seeded jitter from rand().
   * `taken` lists stations already in use (Vector3s). R = orbit radius, py = base altitude.
   */
  genericStations(out, n, px, pz, py, pref, R, rand, taken, first = true) {
    const off = rand() * Math.PI * 2, step = Math.PI / 12;
    for (let k = 0; k < n; k++) {
      const near = first && k === 0;
      let bx = 0, bz = 0, bs = -Infinity;
      for (let j = 0; j < 24; j++) {
        const b = off + j * step;
        for (let q = 0; q < 3; q++) {
          const d = near ? THREE.MathUtils.clamp(2500 + q * 250 + (rand() - 0.5) * 200, 2500, 3000) : THREE.MathUtils.clamp(3500 + q * 500 + (rand() - 0.5) * 200, 3500, 4500);
          const x = px + Math.sin(b) * d, z = pz - Math.cos(b) * d;
          if (!this.orbitFits(x, z, R)) continue;
          let sep = 6000;
          for (let i = 0; i < taken.length; i++) sep = Math.min(sep, Math.hypot(taken[i].x - x, taken[i].z - z));
          for (let i = 0; i < k; i++) sep = Math.min(sep, Math.hypot(out[i].x - x, out[i].z - z));
          let s = sep / 1000 - (sep < 2500 ? 4 : 0) + rand() * 0.8;
          if (pref === pref) { let da = Math.abs(b - pref) % (2 * Math.PI); if (da > Math.PI) da = 2 * Math.PI - da; s -= da / (Math.PI / 4); }
          if (s > bs) { bs = s; bx = x; bz = z; }
        }
      }
      if (bs === -Infinity) this.fitStation(out[k], px + Math.sin(off) * 4000, pz - Math.cos(off) * 4000, R);
      else out[k].set(bx, 0, bz);
      out[k].y = this.orbitAlt(out[k].x, out[k].z, R, py + (rand() - 0.4) * 600);
    }
    return out;
  }
}
