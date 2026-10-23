import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Allied story units (missions[].allies in js/missions.js): the Herring Guard regiment (Bad Apples, Clearance Sale) and
// the battleship Hand-Me-Down (Hostile Takeover; in Finders Keepers with four cruisers and a supply ship as escorts). PROPS:
// GroundForces targets with team 'player' and immortal = true, drawn in a friendly tint from an instance budget of their
// own (js/targets.js). They never fire and are in no target list (the game's combat lists skip team 'player'): nothing
// can hit them, enemy ground units only ever shoot at the player, the bandit director only hands out the player or a
// squadmate, and phase completion ignores them. js/main.js places them (spawnAllies) and owns the game-side results.
//
// Per frame (Game.updateGame / updateDead, inside the 'allies' profiler section), bounded and allocation-free:
//   flak     cosmetic, harmless bursts near enemy aircraft from allied guns: FLAK_RATE bursts/s in all, FLAK_PER_FRAME guns
//            looked at per frame (round-robin), each scanning the live enemy aircraft once; at most one burst per frame (a
//            second ready gun bursts on its next turn, a frame later). A 4 Hz gate switches it off unless an enemy
//            aircraft is within reach of the guns and the guns are within FLAK_CAM_RANGE of the camera.
//            No line-of-sight or terrain tests.
//   leakers  aircraft of a target: 'fleet' group (the Bodkin cruise missiles of Finders Keepers) home on the nearest live
//            escort (EnemyBrain.transitGoal; when it sinks they re-aim at once). Round-robin, each one at least every 4th
//            frame: one test against the fleet's bounding circle, then the hulls. Within LEAK_RANGE of a hull it is
//            consumed and sinks the nearest live escort; with none left it bursts harmlessly on the flagship, which can't
//            sink. Game.onLeak counts it as resolved for the phase, with no score or kill credit. The round-robin strikes
//            at most once per frame, and not in a frame where crashLeak already struck: another leaker within reach
//            strikes on its next turn, a few frames later, so strike blasts don't stack up in one frame.
//   sinking  escorts lost to leakers settle under the surface (GroundForces.updateSinking: one matrix per hull).
// Lists (units, radar blips, guns, ships, leakers) are built when units spawn and pruned in place, never per frame.
const LEAK_RANGE = 150;          // m from a ship's bow-stern line at which a leaker strikes the fleet
const FLAK_RATE = 3;             // cosmetic flak bursts per second, all allied guns together
const FLAK_BANK = 2;             // most bursts banked at once
const FLAK_PER_FRAME = 2;        // allied guns looked at per frame
const FLAK_RANGE_MAX = 2500;     // m: ship batteries (missile-armed types) throw flak this far at most
const FLAK_CAM_RANGE = 6000;     // m: no flak while the guns, or a burst, are farther than this from the camera
const FLAK_PLAYER_CLEAR = 300;   // m: never burst this close to the player
const RADAR_SPACING = 200;       // m between a land group's radar blips (one per cluster; every ship gets its own)
const MAX_FLAK = 64, MAX_ZONES = 4;
const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
// Allocation-free jitter for the flak: an LCG in a typed array that fills _rnd (no function returns a boxed double)
const _seed = new Uint32Array([0x2545f491]), _rnd = new Float64Array(4);
function fillRnd() { for (let k = 0; k < 4; k++) { _seed[0] = Math.imul(_seed[0], 1664525) + 1013904223; _rnd[k] = _seed[0] / 4294967296; } }
const CLEAR2 = FLAK_PLAYER_CLEAR * FLAK_PLAYER_CLEAR, CAM2 = FLAK_CAM_RANGE * FLAK_CAM_RANGE;

/** An allied ship: its hull line for the leak test and the point leakers home on (drawn hull, GroundTarget.size). */
class Ship {
  constructor(t, escort) {
    this.t = t; this.escort = escort;
    this.fx = -Math.sin(t.heading); this.fz = -Math.cos(t.heading); this.hl = t.size[2] / 2;
    this.aim = new THREE.Vector3(t.position.x, t.position.y + t.size[1] * 0.25, t.position.z);
  }
  /** Distance along the hull line (clamped to the hull) of the point nearest to p. */
  along(p) {
    const s = (p.x - this.t.position.x) * this.fx + (p.z - this.t.position.z) * this.fz;
    return s < -this.hl ? -this.hl : s > this.hl ? this.hl : s;
  }
  /** Squared distance from p to the hull's bow-stern line (at mid-hull height). */
  dist2(p) {
    const c = this.t.position, s = this.along(p);
    const ex = p.x - c.x - this.fx * s, ey = p.y - c.y, ez = p.z - c.z - this.fz * s;
    return ex * ex + ey * ey + ez * ez;
  }
}

export class AlliedForces {
  /** @param {object} o { ground: GroundForces, weapons: Weapons, onLeak(aircraft, sunkTarget | null, missed) } */
  constructor({ ground, weapons, onLeak = null }) {
    this.ground = ground; this.weapons = weapons; this.onLeak = onLeak;
    this.units = [];             // this mission's allied props (GroundTarget, team 'player', immortal)
    this.radar = [];             // the units shown on radar
    this.ships = [];             // Ship records; ships[0] = the flagship (the first ship placed)
    this.escorts = [];           // Ship records of the escorts: mortal, to leakers only
    this.liveEscorts = 0;
    this.flak = [];              // allied guns: units whose type shoots
    this._flakAt = new Float64Array(MAX_FLAK);   // game time each gun may burst again
    this._flakR2 = new Float64Array(MAX_FLAK);   // squared flak range of each gun
    this.leakers = []; this._goal = [];          // aircraft flying at the fleet, and the Ship each one is after
    this.zones = []; for (let i = 0; i < MAX_ZONES; i++) this.zones.push({ x: 0, z: 0, r: 0 });
    this.nZones = 0;             // circles around the placed groups that enemy units keep out of (Game.spawnSurfaceGroup)
    this.fleetCenter = new THREE.Vector3();
    this.flagName = '';          // the flagship's name (HUD callouts)
    this.stats = { flak: 0, leaks: 0, sunk: 0, flagHits: 0, splashes: 0 };
    this.clear();
  }

  /** Mission load / quit: forget every allied unit (GroundForces.clear removes the instances themselves). */
  clear() {
    this.units.length = 0; this.radar.length = 0; this.ships.length = 0; this.escorts.length = 0; this.liveEscorts = 0; this.flak.length = 0;
    this.leakers.length = 0; this._goal.length = 0; this.nZones = 0;
    this._g0 = 0; this._lk = 0; this._fk = 0; this._gateT = 0; this._flakLive = false; this._bank = FLAK_BANK; this._struck = false;
    this._fleetR = 0; this._flakCX = 0; this._flakCZ = 0; this._flakR = 0; this._flakReach = 0;
    this.flagName = '';
    const s = this.stats; s.flak = 0; s.leaks = 0; s.sunk = 0; s.flagHits = 0; s.splashes = 0;
  }
  /** True while anything here needs a per-frame update. */
  get active() { return this.units.length > 0 || this.leakers.length > 0 || this.ground.sinking.length > 0; }

  // ---- placement bookkeeping (Game.spawnAllies) ------------------------------------------------------------------
  beginGroup() { this._g0 = this.units.length; }
  /** Register a spawned allied unit; escort = mortal to leakers (ships only). */
  addUnit(t, escort = false) {
    this.units.push(t);
    if (t.def.shoots && this.flak.length < MAX_FLAK) {
      const r = Math.min(t.def.range || 1500, FLAK_RANGE_MAX), i = this.flak.length;
      this.flak.push(t); this._flakR2[i] = r * r; this._flakAt[i] = 0;
    }
    if (t.naval) {
      const s = new Ship(t, escort && this.ships.length > 0);   // the first ship is the flagship, never an escort
      this.ships.push(s);
      if (s.escort) { this.escorts.push(s); this.liveEscorts++; } else if (this.ships.length === 1) this.flagName = t.name;
    }
  }
  /** Close the group begun with beginGroup: its circle becomes a zone enemy units keep out of. */
  endGroup() {
    const U = this.units, n = U.length - this._g0;
    if (n <= 0 || this.nZones >= MAX_ZONES) return;
    let cx = 0, cz = 0;
    for (let i = this._g0; i < U.length; i++) { cx += U[i].position.x; cz += U[i].position.z; }
    cx /= n; cz /= n;
    let r = 0;
    for (let i = this._g0; i < U.length; i++) {
      const t = U[i], s = t.size, d = Math.hypot(t.position.x - cx, t.position.z - cz) + 0.5 * Math.max(s[0], s[2]);
      if (d > r) r = d;
    }
    const Z = this.zones[this.nZones++]; Z.x = cx; Z.z = cz; Z.r = r;
  }
  /** True if (x, z) lies `margin` m or more outside every allied group's circle. */
  clearOf(x, z, margin) {
    for (let i = 0; i < this.nZones; i++) {
      const Z = this.zones[i], r = Z.r + margin, dx = x - Z.x, dz = z - Z.z;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }
  /** True if no allied unit stands within `r` m of (x, z) (vehicle spacing while a group is placed). */
  spacingOk(x, z, r) {
    const U = this.units, r2 = r * r;
    for (let i = 0; i < U.length; i++) { const dx = U[i].position.x - x, dz = U[i].position.z - z; if (dx * dx + dz * dz < r2) return false; }
    return true;
  }
  /** After units spawn: rebuild the radar list, the guns' bounding circle and the fleet's bounding circle. */
  commit() {
    const U = this.units, R = this.radar, S2 = RADAR_SPACING * RADAR_SPACING;
    R.length = 0;
    for (let i = 0; i < U.length; i++) {
      const t = U[i];
      if (!t.alive) continue;
      let near = false;
      if (!t.naval) for (let j = 0; j < R.length; j++) {
        const o = R[j]; if (o.naval) continue;
        const dx = o.position.x - t.position.x, dz = o.position.z - t.position.z;
        if (dx * dx + dz * dz < S2) { near = true; break; }
      }
      if (!near) R.push(t);
    }
    const F = this.flak;
    if (F.length) {
      let cx = 0, cz = 0, r = 0, reach = 0;
      for (let i = 0; i < F.length; i++) { cx += F[i].position.x; cz += F[i].position.z; }
      cx /= F.length; cz /= F.length;
      for (let i = 0; i < F.length; i++) {
        r = Math.max(r, Math.hypot(F[i].position.x - cx, F[i].position.z - cz));
        reach = Math.max(reach, Math.sqrt(this._flakR2[i]));
      }
      this._flakCX = cx; this._flakCZ = cz; this._flakR = r; this._flakReach = reach;
    }
    const S = this.ships;
    if (S.length) {
      const c = this.fleetCenter.set(0, 0, 0);
      for (let i = 0; i < S.length; i++) c.add(S[i].t.position);
      c.multiplyScalar(1 / S.length);
      let r = 0;
      for (let i = 0; i < S.length; i++) r = Math.max(r, Math.hypot(S[i].t.position.x - c.x, S[i].t.position.z - c.z) + S[i].hl);
      this._fleetR = r;                                             // hull extent around the fleet's centre
    }
  }

  // ---- leakers ---------------------------------------------------------------------------------------------------
  /** A freshly spawned aircraft of a target: 'fleet' group: home it on the nearest live escort (or the flagship) and
   *  turn it onto that course. False when there is no fleet (it keeps its plain transit). */
  addLeaker(ac) {
    if (!this.ships.length || !ac.brain) return false;
    const s = this._goalFor(ac.position), b = ac.brain;
    this.leakers.push(ac); this._goal.push(s);
    b.setTransitGoal(s.aim);
    ac.quaternion.setFromAxisAngle(UP, Math.atan2(-(s.aim.x - ac.position.x), -(s.aim.z - ac.position.z)));
    ac.getForward(b.transitDir); ac.velocity.copy(b.transitDir).multiplyScalar(ac.speed);
    return true;
  }
  /** The nearest live escort to p, else the flagship. */
  _goalFor(p) { return this._nearestEscort(p) || this.ships[0]; }
  _nearestEscort(p) {
    const E = this.escorts; let best = null, bd = Infinity;
    for (let i = 0; i < E.length; i++) { const s = E[i]; if (!s.t.alive) continue; const d = s.t.position.distanceToSquared(p); if (d < bd) { bd = d; best = s; } }
    return best;
  }
  _dropLeaker(i) {
    const L = this.leakers, G = this._goal, last = L.length - 1, ac = L[i];
    if (ac.brain) ac.brain.setTransitGoal(null);
    L[i] = L[last]; G[i] = G[last]; L.pop(); G.pop();
  }
  /** The ship whose hull line p is within `range` m of, else null (one bounding-circle test first). While an escort is
   *  left to lose, hulls already going down count too: a salvo arriving on a sinking escort still costs the next one
   *  (every leak costs an escort). After that only the flagship can be reached. */
  _reached(p, range) {
    const c = this.fleetCenter, cx = p.x - c.x, cz = p.z - c.z, rb = this._fleetR + range;
    if (cx * cx + cz * cz > rb * rb) return null;
    const S = this.ships, R2 = range * range, wrecksCount = this.liveEscorts > 0;
    for (let i = 0; i < S.length; i++) {
      const s = S[i]; if (!wrecksCount && !s.t.alive) continue;
      const o = s.t.position, dx = p.x - o.x, dz = p.z - o.z, hl = s.hl;   // (Ship.dist2, inline)
      let a = dx * s.fx + dz * s.fz; a = a < -hl ? -hl : a > hl ? hl : a;
      const ex = dx - s.fx * a, ey = p.y - o.y, ez = dz - s.fz * a;
      if (ex * ex + ey * ey + ez * ez < R2) return s;
    }
    return null;
  }
  /** Round-robin over the leakers, ceil(n / 4) per frame: drop the dead, re-aim at the nearest live escort when the
   *  target sank, and strike when one reaches a hull (unless a strike already landed this frame: it waits its next turn). */
  _leakCheck() {
    const L = this.leakers, G = this._goal;
    for (let k = (L.length + 3) >> 2; k > 0 && L.length > 0; k--) {
      if (this._lk >= L.length) this._lk = 0;
      const i = this._lk, ac = L[i];
      if (!ac.alive || ac.brain.transitGoal === null) { this._dropLeaker(i); continue; }   // shot down (or its airframe reused)
      if (!G[i].t.alive) { const s = G[i] = this._goalFor(ac.position); ac.brain.transitGoal = s.aim; }
      if (!this._struck && this._reached(ac.position, LEAK_RANGE) !== null) { this._dropLeaker(i); this._strike(ac); continue; }
      this._lk++;
    }
  }
  /** A leaker reached the fleet: it is consumed and the nearest live escort goes down (big blast, then it sinks);
   *  with no escort left it bursts harmlessly on the flagship. The escort's effect bundle is spread over three frames:
   *  the blast now, its death (secondary blasts, burning debris, a smoke column) next frame, the spray the frame after. */
  _strike(ac) {
    this._struck = true;                                           // one strike's effects per frame (see _leakCheck)
    const W = this.weapons, esc = this._nearestEscort(ac.position);
    if (esc !== null) {
      const t = esc.t, s = esc.along(ac.position) * 0.8;
      W.explode(_p.set(t.position.x + esc.fx * s, t.position.y + t.size[1] * 0.3, t.position.z + esc.fz * s), 2.6);
      W.delayEffect('death', t.position, 1, 1, 0, t.velocity);     // next frame: secondary blasts, debris, smoke column
      W.delayEffect('impact', _p.set(t.position.x, 0.3, t.position.z), 1.6, 2);   // the frame after: water thrown up
      this.ground.sink(t);
      this.stats.sunk++; this.liveEscorts--;
      // the leakers after this escort re-aim at once, not on their next round-robin turn (one pass, per sinking)
      const L = this.leakers, G = this._goal;
      for (let i = 0; i < L.length; i++) if (G[i] === esc) { const g = G[i] = this._goalFor(L[i].position); L[i].brain.transitGoal = g.aim; }
    } else {
      const f = this.ships[0], t = f.t, s = f.along(ac.position) * 0.8;
      W.explode(_p.set(t.position.x + f.fx * s, t.position.y + t.size[1] * 0.3, t.position.z + f.fz * s), 1.4);
      this.stats.flagHits++;
    }
    this.stats.leaks++;
    if (this.onLeak) this.onLeak(ac, esc !== null ? esc.t : null);
  }
  /** The game's crash test caught aircraft `e` (sea or terrain). A leaker still homing on the fleet (not jinking from a
   *  missile) within 1 km of its ships is consumed (true: handled): within 2 x LEAK_RANGE of a hull it strikes all the
   *  same, farther out it splashes harmlessly. Anything else is an ordinary crash (false). */
  crashLeak(e) {
    const L = this.leakers;
    for (let i = 0; i < L.length; i++) {
      if (L[i] !== e) continue;
      const c = this.fleetCenter, dx = e.position.x - c.x, dz = e.position.z - c.z, r = this._fleetR + 1000;
      if (e.brain.state !== 'transit' || dx * dx + dz * dz > r * r) return false;
      this._dropLeaker(i);
      if (this._reached(e.position, 2 * LEAK_RANGE) !== null) this._strike(e);
      else {
        this.weapons.terrainImpact(_p.set(e.position.x, 0.3, e.position.z), 1);   // a miss: a column of spray
        this.stats.splashes++;
        if (this.onLeak) this.onLeak(e, null, true);
      }
      return true;
    }
    return false;
  }

  // ---- per frame -------------------------------------------------------------------------------------------------
  /**
   * @param {number} dt @param {number} time game time (s) @param {THREE.Vector3} cam camera position
   * @param {object} player @param {Array} air the game's hostile list, whose first nAir entries are its enemy aircraft
   */
  update(dt, time, cam, player, air, nAir) {
    if (this.ground.sinking.length) this.ground.updateSinking(dt);
    if (this.leakers.length) this._leakCheck();
    if (this.flak.length) this._flak(dt, time, cam, player, air, nAir);
    this._struck = false;
  }

  _flak(dt, time, cam, player, air, nAir) {
    this._bank = Math.min(FLAK_BANK, this._bank + dt * FLAK_RATE);
    this._gateT -= dt;
    if (this._gateT <= 0) {
      // 4 Hz gate: guns near the camera, and an enemy aircraft within reach of them (one pass over the enemy aircraft)
      this._gateT = 0.25; this._flakLive = false;
      const cx = this._flakCX, cz = this._flakCZ, rc = FLAK_CAM_RANGE + this._flakR, dxc = cam.x - cx, dzc = cam.z - cz;
      if (dxc * dxc + dzc * dzc < rc * rc) {
        const r = this._flakR + this._flakReach, r2 = r * r;
        for (let i = 0; i < nAir; i++) {
          const e = air[i]; if (!e.alive) continue;
          const ep = e.position, dx = ep.x - cx, dz = ep.z - cz;
          if (dx * dx + dz * dz < r2) { this._flakLive = true; break; }
        }
      }
    }
    if (!this._flakLive) return;
    const F = this.flak, n = F.length;
    for (let k = 0; k < FLAK_PER_FRAME && k < n; k++) {
      const i = this._fk = (this._fk + 1) % n, s = F[i];
      if (!s.alive || time < this._flakAt[i]) continue;
      const sp = s.position;                                         // nearest enemy aircraft inside this gun's range
      let best = null, bd = this._flakR2[i];
      for (let j = 0; j < nAir; j++) {
        const e = air[j]; if (!e.alive) continue;
        const ep = e.position, dx = ep.x - sp.x, dy = ep.y - sp.y, dz = ep.z - sp.z, d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = e; }
      }
      if (best === null) { this._flakAt[i] = time + 0.75; continue; }
      if (this._bank < 1) continue;
      // burst 35-125 m around where the aircraft will be in 0.2 s (inline math, no calls returning numbers)
      fillRnd();
      const u = _rnd[0] * 2 - 1, a = _rnd[1] * 6.2832, q = Math.sqrt(1 - u * u), miss = 35 + _rnd[2] * 90;
      const bp = best.position, bv = best.velocity;
      const px = bp.x + bv.x * 0.2 + Math.cos(a) * q * miss, py = bp.y + bv.y * 0.2 + u * miss, pz = bp.z + bv.z * 0.2 + Math.sin(a) * q * miss;
      const pp = player.position, ax = px - pp.x, ay = py - pp.y, az = pz - pp.z, cx = px - cam.x, cy = py - cam.y, cz = pz - cam.z;
      if (ax * ax + ay * ay + az * az < CLEAR2 || cx * cx + cy * cy + cz * cz > CAM2) { this._flakAt[i] = time + 0.5; continue; }
      this._bank -= 1; this._flakAt[i] = time + 1.4 + _rnd[3] * 1.2;
      // the light flak puff (as the enemy's, Game._onFlak) without its sound, flash or shake: purely cosmetic
      _p.x = px; _p.y = py; _p.z = pz;
      this.weapons.flakPuff(_p, false);
      this.stats.flak++;
      break;                                                         // one burst per frame: the next gun waits its turn
    }
  }
}
