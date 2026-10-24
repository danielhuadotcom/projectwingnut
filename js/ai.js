import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { FLIGHT } from './aircraft.js';
import { AIRCRAFT_TYPES } from './missions.js';

// Pilot brains.
// EnemyBrain: bank-to-turn steering + a small state machine (pursue / evade / extend / avoid terrain). It chases any
//   target aircraft: the player, or one of the player's squadmates. While its flight holds (js/flights.js) it flies
//   the holding pattern instead: orbit, escort or climb-out as the flight lead, formation on the lead otherwise.
// WingmanBrain (the player's immortal squadmates): loose formation on a lead, engages the bandit the game assigns with
//   EnemyBrain's pursuit, defeats incoming missiles with flares (enemy aces and bosses have none: they Cobra), keeps
//   within 3 km of the lead while fighting.
const _local = new THREE.Vector3(), _toP = new THREE.Vector3(), _fwd = new THREE.Vector3(), _pFwd = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pt = new THREE.Vector3(), _up = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _rel = new THREE.Vector3(), _vr = new THREE.Vector3(), _hf = new THREE.Vector3(), _slot = new THREE.Vector3(), _away = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const controls = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 };
const EVADE_TTI = 2.2;    // s: an evasive transit (EnemyBrain.evasive) breaks hard once a missile is this close to impact
const LAUNCH_GAP = 1.5;   // s: the AI never launches at one target within this of its previous launch at it
// Break discipline (EnemyBrain, aces and bosses): energy. PULL_MAX + PULL_MAX_SKILL x skill s of continuous max-G pull,
// then UNLOAD + UNLOAD_SKILL x skill s unloaded with the pull capped at UNLOAD_PULL (skill 0.95: 1.95 s, then 2.4 s;
// other aces than bosses unload 0.8 s longer)
const PULL_MAX = 1.0, PULL_MAX_SKILL = 1.0, UNLOAD = 3.5, UNLOAD_SKILL = -1.2, UNLOAD_PULL = 0.3;
// No flares: a player missile in a close tail chase can't be out-turned late, so breaks alone rarely save an ace.
// Limit break (aces and bosses): a post-stall Cobra (Aircraft.startPostStall, js/aircraft.js:
// nose past vertical, a flat spin, speed collapsing toward the stall). When the soonest player-team missile on it is
// under COBRA_TTI s (+ 0-COBRA_TTI_VAR random) from impact and it has the room (clear of the ground and the ceiling, fast
// enough to have speed to bleed), every missile on it within COBRA_LOCK s (x 0.85-1.15) of impact loses its lock and the
// pop-up and speed collapse take the jet off their courses: one Cobra defeats a whole salvo. It then flies slow:
// COBRA_RECOVER s after the maneuver with the pull capped at COBRA_RECOVER_PULL and no breaks (missiles fired after it
// connect), and a boss's next Cobra waits COBRA_CD + 0-COBRA_CD_VAR s from the start of this one. Halve the volley: one
// half baits the Cobra, the other lands in the recovery.
const COBRA_TTI = 0.45, COBRA_TTI_VAR = 0.55, COBRA_LOCK = 1.9, COBRA_DUR = 2.0, COBRA_RECOVER = 2.6, COBRA_RECOVER_PULL = 0.4;
const COBRA_CD = 6, COBRA_CD_VAR = 4;
// Regular aces (ace: true, no bars) fly the same Cobra, tuned down: a COBRA_CD_ACE + 0-COBRA_CD_ACE_VAR s cooldown, and per
// incoming missile they go for it only with odds COBRA_P_ACE + COBRA_P_ACE_SKILL x skill (bosses always do).
const COBRA_CD_ACE = 12, COBRA_CD_ACE_VAR = 6, COBRA_P_ACE = 0.4, COBRA_P_ACE_SKILL = 0.3;
// Altitude game (bandits only, EnemyBrain.altGame): out of a close turning fight a bandit wants 300-800 m (by skill) over
// its target; holding flights orbit there, slot-waiters stack above it, attackers dive in from it and zoom back up.
export const ALT_CEILING = 4500;  // m ASL: hard cap, enforced in the steering. Highest terrain is ~2.6 km; matches the
                                  //   holding / spawn ceiling (js/flights.js MAX_ALT, Game.spawnAirGroup)
const ALT_FLOOR_AGL = 350;        // m: altitude-game aim points stay this far over the ground under the jet (the hard
                                  //   floor is _senseTerrain's pull-up: 200 m + 2.5 s of sink, 180 m along the path)

/** Missile rationing for every enemy launcher (bandits, SAM sites, ships; O(1)): no launch at a target within max(its
 *  `missileGap`, LAUNCH_GAP) s of the last enemy launch at it (`_missileAt`), and a target with `missileCap` (the player
 *  per difficulty, squadmates 1) has at most that many enemy missiles after it (`_inboundCount`: the game counts the
 *  player's every frame; a squadmate's own scan counts its decoyed ones too). A refused launcher keeps its missile and
 *  its cooldown and tries again; noteLaunch(T) books a launch that went out. */
export function launchAllowed(T, weapons) {
  if (!T) return true;
  if (T._missileAt !== undefined && weapons.time - T._missileAt < Math.max(T.missileGap || 0, LAUNCH_GAP)) return false;
  return T.missileCap === undefined || (T._inboundCount || 0) < T.missileCap;
}
export function noteLaunch(T, weapons) {
  T._missileAt = weapons.time;
  if (T.missileCap !== undefined) T._inboundCount = (T._inboundCount || 0) + 1;
}

export class EnemyBrain {
  constructor(aircraft, { skill = 0.5, worldHalf = 20000 } = {}) {
    this.ac = aircraft;
    this.skill = skill;
    this.worldHalf = worldHalf;
    this.state = 'pursue';
    this.stateTime = 0;
    this.burst = 0;          // gun burst timer
    this.burstPause = 0;
    this.missileCooldown = 12 + Math.random() * 8;
    this.pursuitThrottle = 0.3;    // thrust while closing from mid range (light boost, below the afterburner detent)
    this.evadeDir = Math.random() < 0.5 ? -1 : 1;
    this.jinkTimer = 0;
    this.aimNoise = new THREE.Vector3();
    this.velEst = new THREE.Vector3();   // lagged estimate of the target's velocity: turning targets are hard to lead
    this.noiseTimer = 0;
    this.throttleTarget = 0;        // thrust axis command: -1 airbrake .. 0 cruise .. +1 boost
    this.passive = false;           // unarmed types (transports, AWACS, bombers, drones, cruise missiles): transit + jink
    this.evasive = false;           // passive only (the Glassfall's Thunderheads, js/glassfall.js): weave along the course
    this.lockedOn = false;          //   while the game reports a player lock (lockedOn), hard-break late (< EVADE_TTI s)
                                    //   instead of at the launch, so pursuit-guided shots mostly overshoot
    this._breaking = false;         // (evasive: breaking from a missile this frame)
    this.obstacle = null;           // optional (point) => truthy when the point is inside solid structure (tunnel ridge)
    this.transitDir = new THREE.Vector3(0, 0, -1);
    this.transitAlt = 0;            // transit altitude (0 = hold the current one)
    this.transitGoal = null;        // optional point (Vector3) a passive transit flies to instead of along transitDir (set it
    this.diveRange = 3000;          //   with setTransitGoal): at transitAlt, then a glide straight at it of at most ~18 deg,
                                    //   begun max(diveRange, 3 x the height above it) m out (cruise missiles)
    this.target = null;             // aircraft the game assigned to this brain (the game passes it to update)
    this.role = null;               // bandit director: 'player' | 'squad' (hunts the player / a squadmate), null = unassigned
    this.roleSince = 0;             // game time of the last role change
    this.threat = null;             // aircraft whose guns-on aspect makes us break, checked every frame; null = the target
    this.flight = null;             // bandit flight (js/flights.js); while it holds (flight.loiter) this brain flies _hold
    this.slotOff = new THREE.Vector3();   // formation slot on the flight lead: right, up, back (m) in its heading frame
    this.terrainMargin = 1;         // scales the terrain-avoidance floors (squadmates fly more cautiously)
    this.altGame = true;            // altitude game (perch above the target, dive-and-zoom attacks); off for squadmates
    this.altCap = true;             // hard ALT_CEILING; off for squadmates
    this._altOn = true; this._altT = 0;   // altitude game active this spell (rerolled every 6-12 s, odds by skill)
    this._flatT = 0;                // s spent in a flat close chase (no height over the target): a long one ends in a zoom
    this._stackOff = Math.random() * 400; // m: extra height of this bandit's slot-waiting stack (spreads the stack)
    this.burstGap = 0;              // s added between gun bursts
    this.shotAngle = 0.15; this.shotMin = 700; this.shotMax = 2500;   // missile envelope: rad off the nose, range (m)
    this.gunAngle = 0.045; this.gunRange = 650;     // gun burst starts when lined up this well (rad) this close (m)...
    this.gunHold = 0.08; this.gunHoldRange = 750;   // ...and keeps firing while within these
    // per-frame sensing results (declared here so every brain keeps one shape)
    this._agl = 0; this._aheadAgl = 0; this._sink = 0; this._overWater = false; this._diving = false;
    this._inbound = false; this._minTti = Infinity; this._minRange = Infinity; this._threatMsl = null; this._scanned = false;
    // Break discipline (aces and bosses: AIRCRAFT_TYPES entries with ace or bars; everyone else keeps the plain rule
    // below): consistency, not capability. Per incoming missile the brain rolls a plan (_planBreak): a break at the time
    // to impact it judges right (an ace's ~0.7-1.8 s, spread by skill), an early break as soon as it notices the launch,
    // or a misjudged one (no missile break), and whether it goes for the Cobra limit break (COBRA_*) if that's ready.
    // A guns-on threat makes it
    // break after a reaction delay instead of on the first frame. A max-G pull costs energy: after PULL_MAX s of
    // continuous hard pull (skill-scaled) it must unload for a few seconds (pull capped, no fresh break), so back-to-back
    // perfect breaks aren't free and a stable tail position gets its shot.
    this.breakDiscipline = false;   // (resolved from the aircraft's type name in update)
    this._typeName = null; this._boss = false;
    this._mslId = -1; this._mslPlan = 2; this._mslTti = 0; this._mslNotice = 0;
    this._pull = 0; this._tired = 0; this._gunT = 0; this._gunDelay = -1; this._cobraGo = false;
    this._cobraCd = 0; this._cobraTti = COBRA_TTI; this._recover = 0;   // (rerolled per Cobra)
    this.cobras = 0;                // stats: boss Cobras flown
  }

  /** Roll how this brain will answer missile m (break discipline above). */
  _planBreak(m) {
    const s = this.skill, r = Math.random();
    this._mslId = m.id;
    this._mslNotice = (0.15 + 0.5 * (1 - s)) * (0.5 + Math.random());          // s after launch before it can react
    const pMiss = (this._boss ? 0.2 : 0.3) + 0.3 * (1 - s), pEarly = 0.08 + 0.3 * Math.max(0, s - 0.55);
    this._mslPlan = r < pMiss ? 0 : r < pMiss + pEarly ? 1 : 2;
    this._mslTti = (0.9 + 0.6 * s) * (0.45 + 0.8 * Math.random());              // timed: break once the tti is under this
    this._cobraGo = this._boss || Math.random() < COBRA_P_ACE + COBRA_P_ACE_SKILL * s;
  }

  /** Room for a Cobra: clear of the ground (and not about to pop toward it), under the ceiling, and fast enough that
   *  bleeding the speed means something. */
  _cobraRoom() {
    const ac = this.ac, ss = ac.speedScale || 1;
    ac.getUp(_up);
    if (this._agl < 450 || this._aheadAgl < 350 || (_up.y < -0.25 && this._agl < 1500)) return false;
    if (ac.position.y > ALT_CEILING - 250 && _up.y > 0.3) return false;
    return ac.speed > FLIGHT.MIN_SPEED * Math.min(1, ss * 1.2) * 1.9;
  }

  // Steer toward a world point; writes pitch/roll/yaw into controls. gain scales aggressiveness.
  /** Fly a passive transit to `goal` (Vector3, kept by reference; null = back to transitDir), starting with the cruise leg. */
  setTransitGoal(goal) { this.transitGoal = goal; this._diving = false; }

  steerToward(point, gain = 1) {
    const ac = this.ac;
    _local.subVectors(point, ac.position);
    const dist = _local.length();
    if (dist < 1e-3) { controls.pitch = controls.roll = controls.yaw = 0; return 0; }
    _local.multiplyScalar(1 / dist);
    _q.copy(ac.quaternion).invert();
    _local.applyQuaternion(_q); // local: x right, y up, -z forward
    const angleOff = Math.acos(THREE.MathUtils.clamp(-_local.z, -1, 1));
    const rollErr = Math.atan2(_local.x, _local.y);       // rotate so the target is "up"
    const rollWeight = Math.min(1, angleOff / 0.25);
    let roll = THREE.MathUtils.clamp(rollErr * 1.8 * rollWeight, -1, 1);
    let pitch = THREE.MathUtils.clamp(angleOff * 2.8, 0, 1) * Math.max(0.12, Math.cos(rollErr));
    if (angleOff < 0.25) { // fine aim: small direct corrections
      pitch = THREE.MathUtils.clamp(_local.y * 4, -1, 1);
      roll = THREE.MathUtils.clamp(_local.x * 3.5, -1, 1);
    }
    const yaw = THREE.MathUtils.clamp(_local.x * 1.6, -1, 1) * (angleOff < 0.5 ? 1 : 0.3);
    controls.pitch = pitch * gain; controls.roll = roll * gain; controls.yaw = yaw * gain;
    return angleOff;
  }

  /** Threat from one hostile aircraft: it points at us (aspect > 0.9) inside 1600 m while it is ahead of us. */
  _threatFrom(h) {
    _rel.subVectors(h.position, this.ac.position);
    const d = _rel.length();
    if (!(d < 1600)) return false;
    h.getForward(_pFwd);
    _tmp.copy(_rel).multiplyScalar(-1 / Math.max(d, 1e-3)); // from the threat to us
    return _pFwd.dot(_tmp) > 0.9 && _rel.dot(_fwd) > 0;
  }

  /** Missile rationing (launchAllowed above). */
  canLaunchAt(T, weapons) { return launchAllowed(T, weapons); }

  /** One pass over the live missiles: those guiding on us (_inbound, the soonest time to impact _minTti and its missile
   *  _threatMsl, the closest range _minRange). countAll also counts ones our flares decoyed into ac._inboundCount. */
  _scanMissiles(weapons, countAll) {
    const ac = this.ac, ms = weapons.missiles;
    let inbound = false, minTti = Infinity, minRange = Infinity, threat = null, count = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; if (!m.alive) continue;
      if (m.target !== ac) { if (countAll && m.decoyedFrom === ac) count++; continue; }
      inbound = true; count++;
      _tmp.subVectors(m.position, ac.position); const d = _tmp.length();
      const vc = Math.max(50, -(_tmp.x * (m.velocity.x - ac.velocity.x) + _tmp.y * (m.velocity.y - ac.velocity.y) + _tmp.z * (m.velocity.z - ac.velocity.z)) / Math.max(d, 1));
      const tti = d / vc;
      if (tti < minTti) { minTti = tti; threat = m; }
      if (d < minRange) minRange = d;
    }
    this._inbound = inbound; this._minTti = minTti; this._minRange = minRange; this._threatMsl = threat;
    if (countAll) ac._inboundCount = count;
  }

  /** Ground clearance under the jet and along its predicted path (1, 2 and 3.5 s ahead; solid structures count as
   *  terrain) plus its sink rate: sets _agl, _aheadAgl, _sink, and _overWater (every sample over the sea). True when
   *  terrain avoidance must take over. */
  _senseTerrain(world) {
    const ac = this.ac;
    const groundH = world.getHeight(ac.position.x, ac.position.z);
    this._agl = ac.position.y - Math.max(groundH, 0);
    let aheadAgl = Infinity, wet = groundH < 0;
    for (let i = 0; i < 3; i++) {
      const t = i === 0 ? 1 : i === 1 ? 2 : 3.5;
      _pt.copy(ac.position).addScaledVector(ac.velocity, t);
      const h = world.getHeight(_pt.x, _pt.z);
      if (h >= 0) wet = false;
      let c = _pt.y - Math.max(h, 0);
      if (this.obstacle && this.obstacle(_pt)) { c = Math.min(c, 0); wet = false; }   // treat solid structures like terrain
      if (c < aheadAgl) aheadAgl = c;
    }
    this._aheadAgl = aheadAgl; this._overWater = wet;
    this._sink = Math.max(0, -ac.velocity.y);
    const m = this.terrainMargin;
    return this._agl < (200 + this._sink * 2.5) * m || aheadAgl < 180 * m;
  }

  /** Holding pattern of an uncommitted flight (js/flights.js): the lead orbits the station at cruise speed, keeps its
   *  escort station beside the aircraft it escorts, or climbs out after a scramble; the others fly their formation slots
   *  on the lead. No target, no weapons, missile cooldown paused; terrain, ceiling and map-edge avoidance come first. */
  _hold(dt, world, target) {
    const ac = this.ac, F = this.flight, L = F.lead;
    this.stateTime += dt;
    ac.getForward(_fwd);
    let C = null;
    if (F.mode === 'escort' && F.charges !== null) for (let i = 0; i < F.charges.length; i++) if (F.charges[i].alive) { C = F.charges[i]; break; }
    const low = this._senseTerrain(world);
    if (low) {
      _pt.copy(ac.position).addScaledVector(_fwd, 300).addScaledVector(WORLD_UP, 900);
      this.steerToward(_pt, 1); this.throttleTarget = 0.2;
    } else if (ac.position.y > 7500) {
      _pt.copy(ac.position).addScaledVector(_fwd, 800).addScaledVector(WORLD_UP, -600);
      this.steerToward(_pt, 0.7); this.throttleTarget = 0;
    } else if (Math.abs(ac.position.x) > this.worldHalf * 0.9 || Math.abs(ac.position.z) > this.worldHalf * 0.9) {
      _pt.set(0, Math.max(800, ac.position.y), 0);
      this.steerToward(_pt, 0.8); this.throttleTarget = 0.2;
    } else if (L !== ac && L !== null && L.alive) {
      this._slotOn(L, this.slotOff);
      _slot.y = Math.max(_slot.y, ac.position.y - this._agl + 200);   // floor from this frame's terrain sense
      this._flySlot(_slot, L.velocity);
    } else if (F.mode === 'climb') {
      _pt.copy(ac.position).addScaledVector(_fwd, 1500); _pt.y += 420;   // ~15 deg climb-out on the takeoff heading
      this.steerToward(_pt, 0.6); this.throttleTarget = 1;
    } else if (C !== null) {
      this._slotOn(C, F.offset);
      _slot.y = Math.max(_slot.y, ac.position.y - this._agl + 300);
      this._flySlot(_slot, C.velocity);
    } else {
      // orbit the station: aim along the tangent, pulled onto the circle, at the holding altitude
      const S = F.station, look = Math.max(600, F.radius);
      _tmp.set(ac.position.x - S.x, 0, ac.position.z - S.z);
      const dh = _tmp.length() || 1; _tmp.multiplyScalar(1 / dh);
      const pull = THREE.MathUtils.clamp((F.radius - dh) / look, -3, 1), d = F.dir;
      // holding altitude: the station's, raised to the perch over the target (altitude game), climbing at most ~8 deg
      let y = S.y;
      if (this.altGame && target && target.alive) y = Math.max(y, Math.min(this._wantAlt(target), ac.position.y + look * 0.15));
      _pt.set(ac.position.x + (_tmp.x * pull - _tmp.z * d) * look, y, ac.position.z + (_tmp.z * pull + _tmp.x * d) * look);
      this.steerToward(_pt, 0.5); this.throttleTarget = y > ac.position.y + 100 ? 0.4 : 0;
    }
    if (!low && this.altCap) this._capAlt();
    controls.throttleDelta = THREE.MathUtils.clamp(this.throttleTarget, -1, 1);
    ac.setControls(controls);
  }

  /** World position (into _slot) of the offset o (right, up, back in m) in aircraft L's heading frame: from its
   *  horizontal velocity, so a banking or rolling L doesn't swing the slot about. */
  _slotOn(L, o) {
    _hf.set(L.velocity.x, 0, L.velocity.z);
    if (_hf.lengthSq() < 1) { L.getForward(_hf); _hf.y = 0; }
    if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, -1);
    _hf.normalize();
    return _slot.set(L.position.x - _hf.z * o.x - _hf.x * o.z, L.position.y + o.y, L.position.z + _hf.x * o.x - _hf.z * o.z);
  }

  /** Fly toward a moving slot by velocity matching: wanted velocity = the lead's + a pull toward the slot (firm near it,
   *  a steady ~150 m/s closure from afar); the nose follows it and the thrust axis is fed the wanted speed. */
  _flySlot(slot, leadVel) {
    const ac = this.ac;
    _rel.subVectors(slot, ac.position);
    const d = _rel.length();
    const k = d < 300 ? 0.5 : 150 / d;             // 1/s: firm near the slot, a steady ~150 m/s closure from afar
    _vr.copy(leadVel).addScaledVector(_rel, k);
    const v = _vr.length(), vWant = THREE.MathUtils.clamp(v, FLIGHT.BRAKE_SPEED + 20, FLIGHT.AB_SPEED);
    _pt.copy(ac.position).addScaledVector(_vr, 1000 / Math.max(v, 1));
    this.steerToward(_pt, 1);
    // thrust axis: the setting whose target speed is vWant (feed-forward, on the type's speed scale), plus a correction
    // on the speed error
    const C = FLIGHT.CRUISE_SPEED, vs = vWant / (ac.speedScale || 1);
    const ff = vs >= C ? (vs - C) / (FLIGHT.AB_SPEED - C) : (vs - C) / (C - FLIGHT.BRAKE_SPEED);
    this.throttleTarget = THREE.MathUtils.clamp(ff + (vWant - ac.speed) / 30, -1, 1);
  }

  /** Perch altitude over target T (altitude game): 300-800 m above it by skill, at least ALT_FLOOR_AGL over the ground
   *  under the jet (this frame's terrain sense), at most 200 m under ALT_CEILING. */
  _wantAlt(T) {
    const y = Math.max(T.position.y + 300 + 500 * this.skill, this.ac.position.y - this._agl + ALT_FLOOR_AGL);
    return Math.min(y, ALT_CEILING - 200);
  }

  /** Hard ceiling: when the jet would pass within 100 m of ALT_CEILING in the next 3 s of climb, overrides the steering
   *  (not the throttle) with a push toward a level point 300 m under it. Call after the steering, never while terrain
   *  avoidance flies (the ground wins). */
  _capAlt() {
    const ac = this.ac;
    if (ac.position.y + Math.max(0, ac.velocity.y) * 3 < ALT_CEILING - 100) return;
    _hf.set(ac.velocity.x, 0, ac.velocity.z);
    if (_hf.lengthSq() < 1) { ac.getForward(_hf); _hf.y = 0; }
    if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, -1);
    _hf.normalize();
    _pt.copy(ac.position).addScaledVector(_hf, 1500); _pt.y = ALT_CEILING - 300;
    this.steerToward(_pt, 1);
  }

  update(dt, target, world, weapons, time) {
    const ac = this.ac;
    if (!ac.alive) return;
    if (this.flight !== null && this.flight.loiter) { this._hold(dt, world, target); return; }
    this.stateTime += dt;
    this.missileCooldown -= dt;
    this.noiseTimer -= dt;
    if (this.altGame) {   // altitude game spells: aces almost always play it, rookies about half the time
      this._altT -= dt;
      if (this._altT <= 0) { this._altT = 6 + Math.random() * 6; this._altOn = !this.passive && Math.random() < 0.3 + 0.7 * this.skill; }
    } else this._altOn = false;
    if (target) this.velEst.lerp(target.velocity, 1 - Math.exp(-dt / 0.7));
    if (this.noiseTimer <= 0) { // aim wobble: shrinks with skill, grows when the target is maneuvering hard
      this.noiseTimer = 0.5 + Math.random() * 0.7;
      const jink = target && target._rates ? Math.min(1, Math.abs(target._rates.pitch) / 1.2 + Math.abs(target._rates.roll) / 4) : 0;
      const n = (1.1 - this.skill) * 110 + jink * 70;
      this.aimNoise.set((Math.random() - 0.5) * n, (Math.random() - 0.5) * n, (Math.random() - 0.5) * n);
    }
    ac.getForward(_fwd);
    const targetAlive = target && target.alive;
    let dist = Infinity, angleToTarget = Math.PI;
    if (targetAlive) {
      _toP.subVectors(target.position, ac.position);
      dist = _toP.length();
      angleToTarget = Math.acos(THREE.MathUtils.clamp(_toP.dot(_fwd) / Math.max(dist, 1e-3), -1, 1));
    }
    // Threat assessment: one aircraft per frame, `threat` (the player, for bandits hunting a squadmate) or the target
    let threatened = false;
    const watch = this.threat || target;
    if (watch && watch.alive) threatened = this._threatFrom(watch);
    if (this._scanned) this._scanned = false; else this._scanMissiles(weapons, false);   // (a WingmanBrain scans first)
    const missileInbound = this._inbound, minTti = this._minTti;
    // Rookies break as soon as they see the launch (too early: the missile corrects). Better pilots wait for the moment
    // they judge right, with skill-scaled errors (break discipline: _planBreak), and tire after a long max-G break.
    let breakNow;
    if (ac.name !== this._typeName) {   // pooled airframes change type on respawn
      this._typeName = ac.name; const T = AIRCRAFT_TYPES[ac.name];
      this.breakDiscipline = !(this instanceof WingmanBrain) && !!T && (T.ace === true || T.bars > 0);
      this._boss = !!T && T.bars > 0;   // bosses misjudge less and recover faster than the other aces
      if (this.breakDiscipline) this._cobraTti = COBRA_TTI + COBRA_TTI_VAR * Math.random();
    }
    if (!this.breakDiscipline) breakNow = missileInbound && (this.skill < 0.55 || minTti < 0.9 + this.skill * 0.6);
    else {
      breakNow = false;
      if (missileInbound) {
        const m = this._threatMsl;
        if (m.id !== this._mslId) this._planBreak(m);
        if (m.age >= this._mslNotice) {
          breakNow = this._mslPlan === 1 || (this._mslPlan === 2 && minTti < this._mslTti);
        }
      }
      // guns-on threat: break after a reaction delay (rolled when the threat appears), not on the first frame
      if (threatened) {
        if (this._gunDelay < 0) this._gunDelay = (1.0 + 1.2 * (1 - this.skill)) * (0.5 + Math.random());
        this._gunT += dt; threatened = this._gunT >= this._gunDelay;
      } else { this._gunT = Math.max(0, this._gunT - dt); if (this._gunT === 0) this._gunDelay = -1; }
      this._tired = Math.max(0, this._tired - dt); this._recover = Math.max(0, this._recover - dt); this._cobraCd -= dt;
      if (this._tired > 0 || this._recover > 0) { breakNow = false; threatened = false; }   // unloading
    }                                                                  // (energy, below) or after a Cobra: no fresh break

    // Terrain / boundary / ceiling overrides. A passive transit closing on its goal over open sea (diving onto a ship)
    // ignores the sea-level floor: hitting the goal is the point
    let lowTerrain = this._senseTerrain(world);
    const goal = this.passive ? this.transitGoal : null;
    if (goal !== null) {
      // the glide onto the goal starts 3x the height above it out (at least diveRange) and carries on unless an evasion
      // throws it 1.5 km back out
      const gx = goal.x - ac.position.x, gy = goal.y - ac.position.y, gz = goal.z - ac.position.z, goalD = Math.sqrt(gx * gx + gz * gz);
      const glide = Math.max(this.diveRange, -3 * gy);
      this._diving = this._diving ? goalD < glide + 1500 : goalD < glide;
      // the sea-level floor gives way only while it glides nose-on at the goal (within ~30 deg): turning onto a new one,
      // the floor still holds
      if (lowTerrain && this._diving && this.state === 'transit' && this._overWater
        && gx * _fwd.x + gy * _fwd.y + gz * _fwd.z > 0.86 * Math.sqrt(goalD * goalD + gy * gy)) lowTerrain = false;
    } else this._diving = false;
    const outOfBounds = Math.abs(ac.position.x) > this.worldHalf * 0.9 || Math.abs(ac.position.z) > this.worldHalf * 0.9;
    // Boss limit break (COBRA_*): the maneuver flies the jet (no steering, no guns) until it ends; the ground or the
    // ceiling cut it short
    if (this.breakDiscipline) {
      let fly = ac.postStall;
      if (fly) { if (lowTerrain || ac.position.y > ALT_CEILING + 150) ac.abortPostStall(); }
      else if (missileInbound && this._cobraGo && this._cobraCd <= 0 && !lowTerrain && this._threatMsl.age >= this._mslNotice && minTti < this._cobraTti && this._cobraRoom()) {
        if (ac.startPostStall({ dur: COBRA_DUR * (0.9 + 0.2 * Math.random()), spins: 1, dir: Math.random() < 0.5 ? -1 : 1 })) {
          weapons.breakLock(ac, COBRA_LOCK * (0.85 + 0.3 * Math.random()));
          if (weapons.vaporBurst) weapons.vaporBurst(ac);
          this._cobraCd = this._boss ? COBRA_CD + COBRA_CD_VAR * Math.random() : COBRA_CD_ACE + COBRA_CD_ACE_VAR * Math.random(); this._cobraTti = COBRA_TTI + COBRA_TTI_VAR * Math.random();
          this._recover = COBRA_DUR * 1.1 + COBRA_RECOVER; this._tired = 0; this._pull = 0; this.cobras++;
          this.state = 'pursue'; this.stateTime = 0; this.burst = 0; fly = true;
        }
      }
      if (fly) {
        controls.pitch = controls.roll = controls.yaw = 0; controls.throttleDelta = 1;
        ac.setControls(controls);
        return;
      }
    }

    let fireGun = false;
    if (lowTerrain) {
      // Pull up hard, wings toward level
      _pt.copy(ac.position).addScaledVector(_fwd, 300).addScaledVector(WORLD_UP, 900);
      this.steerToward(_pt, 1);
      this.throttleTarget = 0.2;
    } else if (ac.position.y > 7500) {
      _pt.copy(ac.position).addScaledVector(_fwd, 800).addScaledVector(WORLD_UP, -600);
      this.steerToward(_pt, 0.7); this.throttleTarget = 0;
    } else if (outOfBounds && this.state !== 'evade') {
      _pt.set(0, Math.max(800, ac.position.y), 0);
      this.steerToward(_pt, 0.8); this.throttleTarget = 0.2;
    } else {
      if (this.passive && this.evasive) {
        // Evasive transit: weave while locked, break hard late when a missile closes; back on course 1.5 s after both end
        this._breaking = missileInbound && minTti < EVADE_TTI;
        if ((this._breaking || this.lockedOn) && this.state !== 'evade') { this.state = 'evade'; this.stateTime = 0; this.evadeDir = Math.random() < 0.5 ? -1 : 1; this.jinkTimer = 0; }
        else if (!this._breaking && !this.lockedOn && this.state === 'evade' && this.stateTime > 1.5) { this.state = 'transit'; this.stateTime = 0; }
        else if (this.state !== 'evade') this.state = 'transit';
      } else if (this.passive) {
        // Transit straight along the assigned heading at constant altitude; jink when a missile comes in
        if (missileInbound && this.state !== 'evade') { this.state = 'evade'; this.stateTime = 0; this.evadeDir = Math.random() < 0.5 ? -1 : 1; this.jinkTimer = 0; }
        else if (!missileInbound && this.state === 'evade' && this.stateTime > 2.5) { this.state = 'transit'; this.stateTime = 0; }
        else if (this.state !== 'evade') this.state = 'transit';
      }
      // State transitions
      if (!this.passive && this.state !== 'evade' && (breakNow || threatened) && (this.breakDiscipline || Math.random() < 0.6 + this.skill * 0.4)) {
        this.state = 'evade'; this.stateTime = 0; this.evadeDir = Math.random() < 0.5 ? -1 : 1; this.jinkTimer = 0;
      }
      if (!this.passive && this.state === 'evade' && this.stateTime > 2.5 + this.skill * 2 && !missileInbound) { this.state = dist < 500 ? 'extend' : 'pursue'; this.stateTime = 0; }
      const alt = this._altOn && targetAlive;
      // slashing attacks: past the target (or with it behind the beam, close in), extend and zoom back to the perch
      // a flat close chase (within 2 km, under 200 m over the target, out of gun range) that drags on ends the same way:
      // zoom up and come back down on it (high yo-yo)
      if (alt && this.state === 'pursue' && dist < 2000 && dist > this.gunRange && ac.position.y - target.position.y < 200) this._flatT += dt;
      else this._flatT = Math.max(0, this._flatT - dt);
      if (this.state === 'pursue' && targetAlive
        && (alt ? this.aggressor !== false && ((dist < 700 && angleToTarget > 1.3) || this._flatT > 5 + (1 - this.skill) * 4) : dist < 260 && angleToTarget > 1.0)) { this.state = 'extend'; this.stateTime = 0; this._flatT = 0; }
      if (this.state === 'extend' && (alt ? this.stateTime > 8 || (this.stateTime > 2.5 && ac.position.y > this._wantAlt(target) - 100)
        || (this.stateTime > 3 && ac.speed < 125 * (ac.speedScale || 1)) : this.stateTime > 4)) { this.state = 'pursue'; this.stateTime = 0; }
      if (!targetAlive && !this.passive) this.state = 'patrol';

      if (this.state === 'transit') {
        if (goal === null) { _pt.copy(ac.position).addScaledVector(this.transitDir, 3000); _pt.y = this.transitAlt || ac.position.y; this.steerToward(_pt, 0.45); }
        else if (!this._diving) {               // en route: head for the goal at the transit altitude
          _pt.set(goal.x - ac.position.x, 0, goal.z - ac.position.z).setLength(3000).add(ac.position); _pt.y = this.transitAlt || ac.position.y;
          this.steerToward(_pt, 0.45);
        } else this.steerToward(goal, 0.9);     // terminal glide: straight at it
        this.throttleTarget = 0;
      } else if (this.state === 'evade' && this.evasive && !this._breaking) {
        // Evasive transit, locked: weave across the course (toward the goal, else along transitDir), a jink every ~1 s
        this.jinkTimer -= dt;
        if (this.jinkTimer <= 0) { this.jinkTimer = 0.7 + Math.random() * 0.6; this.evadeDir = -this.evadeDir; }
        if (goal !== null) _tmp.set(goal.x - ac.position.x, 0, goal.z - ac.position.z).normalize(); else _tmp.copy(this.transitDir);
        _pt.copy(ac.position).addScaledVector(_tmp, 1400).addScaledVector(_tmp.set(-_tmp.z, 0, _tmp.x), 650 * this.evadeDir);
        _pt.y = (this.transitAlt || ac.position.y) + 140 * this.evadeDir;
        this.steerToward(_pt, 1);
        this.throttleTarget = 1;
      } else if (this.state === 'evade') {
        // Hard break turn perpendicular to the threat, with periodic jinks and a rolling component
        this.jinkTimer -= dt;
        if (this.jinkTimer <= 0) { this.jinkTimer = 1.1 + Math.random() * 0.8; this.evadeDir *= Math.random() < 0.45 ? -1 : 1; }
        ac.getRight(_tmp);
        _pt.copy(ac.position).addScaledVector(_tmp, 600 * this.evadeDir).addScaledVector(_fwd, 300).addScaledVector(WORLD_UP, missileInbound ? -150 : 120);
        this.steerToward(_pt, 1);
        controls.pitch = Math.max(controls.pitch, 0.85);
        this.throttleTarget = 1;
      } else if (this.state === 'extend') {
        _pt.copy(ac.position).addScaledVector(_fwd, 1500).addScaledVector(WORLD_UP, 300);
        if (this._altOn && targetAlive) {
          // zoom climb toward the perch, traded against speed: level off when slow, nose down near the stall
          _pt.y = Math.max(ac.position.y + 250, this._wantAlt(target) + 150);
          const vs = ac.speed / (ac.speedScale || 1);
          if (vs < 150) _pt.y = ac.position.y - (vs < 110 ? 200 : 0);
        }
        this.steerToward(_pt, 0.8);
        this.throttleTarget = 1;
      } else if (this.state === 'patrol') {
        _pt.set(Math.sin(time * 0.05) * 6000, 1500, Math.cos(time * 0.05) * 6000);
        this.steerToward(_pt, 0.5); this.throttleTarget = 0;
      } else if (this.aggressor === false && targetAlive) {
        // No attack slot (difficulty limit): orbit a ~2.4 km ring around the target without attacking, ready to cut in;
        // from farther out, boost straight in (time to engagement: in the fight within seconds, weapons held)
        _tmp.subVectors(ac.position, target.position); _tmp.y = 0;
        const dh = _tmp.length() || 1; _tmp.multiplyScalar(1 / dh);
        // the stack: slot-waiters hold above the fight (altitude game), else 300 m over the target
        const sy = Math.min(this._altOn ? Math.max(this._wantAlt(target) + 150 + this._stackOff, 900) : Math.max(target.position.y + 300, 900), ALT_CEILING - 200);
        if (dh > 3000) {
          // boost in at 300 m over the target or the height we have (up to the stack): no climb before the ring
          _pt.copy(target.position).addScaledVector(this.velEst, 2); _pt.y = Math.max(target.position.y + 300, 900, Math.min(sy, ac.position.y));
          this.steerToward(_pt, 0.7); this.throttleTarget = 1;
        } else {   // on the ring: keep pace with the target (thrust on the speed difference and the gap to the ring)
          const pull = THREE.MathUtils.clamp((2400 - dh) / 1200, -1, 1);
          _pt.set(ac.position.x - _tmp.z * 1500 + _tmp.x * pull * 1500, sy,
            ac.position.z + _tmp.x * 1500 + _tmp.z * pull * 1500);
          this.steerToward(_pt, 0.5);
          this.throttleTarget = THREE.MathUtils.clamp((target.speed - ac.speed) / 120 + (dh - 2400) / 800, -0.5, 1);
        }
      } else {
        // Pursue: lead pursuit toward where the target will be when our rounds arrive
        const tLead = Math.min(dist, 1100) / 950;   // lead only matters inside cannon range
        _pt.copy(target.position).addScaledVector(this.velEst, tLead).add(this.aimNoise);
        let yOff = 0;
        if (this._altOn) {
          // altitude game: inside 3 km aim toward the perch (at most ~6 deg over the target), fading out from 2.4 km in so
          // the attack is a dive onto it; beyond 3 km keep the height we have but don't climb (time to engagement:
          // climbing bleeds speed). A fast dive never aims under 150 m + 2 s of sink over the ground
          const wy = this._wantAlt(target);
          yOff = dist > 3000 ? THREE.MathUtils.clamp(Math.min(wy, ac.position.y) - _pt.y, 0, dist * 0.08)
            : THREE.MathUtils.clamp(wy - _pt.y, 0, dist * 0.1) * THREE.MathUtils.smoothstep(dist, 900, 2400);
          _pt.y += yOff;
          if (this._sink > 40) _pt.y = Math.max(_pt.y, ac.position.y - this._agl + 150 + this._sink * 2);
        }
        const angleOff = this.steerToward(_pt, 0.55 + this.skill * 0.45);
        this.throttleTarget = dist > 3000 ? 1 : dist > 800 ? this.pursuitThrottle : THREE.MathUtils.clamp((target.speed - ac.speed) / 120, -0.8, 0.45);
        // Guns: short bursts when lined up
        if (angleOff < this.gunAngle && dist < this.gunRange) {
          this.burstPause -= dt;
          if (this.burstPause <= 0) { this.burst = 0.2 + this.skill * 0.25; this.burstPause = 1.8 + (1 - this.skill) * 2.2 + this.burstGap; }
        }
        // Missile: in the envelope, off cooldown, and the target isn't already rationed out
        if (angleOff + yOff / Math.max(dist, 1) < this.shotAngle && dist > this.shotMin && dist < this.shotMax && this.missileCooldown <= 0 && ac.missiles > 0 && this.canLaunchAt(target, weapons)) {
          if (weapons.fireMissile(ac, target)) {
            this.missileCooldown = this.missileReload || (14 + (1 - this.skill) * 10);
            noteLaunch(target, weapons);
          }
        }
      }
    }
    if (this.burst > 0) { this.burst -= dt; fireGun = ac.alive && targetAlive && angleToTarget < this.gunHold && dist < this.gunHoldRange; }
    if (fireGun && !this.passive && this.gunsOnly !== 'none') weapons.fireGun(ac);
    if (!lowTerrain && this.altCap) this._capAlt();

    // Throttle toward target
    controls.throttleDelta = THREE.MathUtils.clamp(this.throttleTarget, -1, 1);
    // Skill-based sloppiness
    const slop = (1 - this.skill) * 0.15;
    controls.pitch = THREE.MathUtils.clamp(controls.pitch + Math.sin(time * 1.7 + this.noiseTimer) * slop, -1, 1);
    // energy (break discipline): PULL_MAX s of continuous max-G pull (a break, or a hard turn after its target) must be
    // paid for by unloading for UNLOAD s, the pull capped at UNLOAD_PULL. Never while terrain avoidance flies
    if (this.breakDiscipline && !lowTerrain) {
      if (this._recover > 0) { controls.pitch = Math.min(controls.pitch, COBRA_RECOVER_PULL); controls.throttleDelta = 1; }
      else if (this._tired > 0) controls.pitch = Math.min(controls.pitch, UNLOAD_PULL);
      else if (controls.pitch > 0.8) {
        this._pull += dt;
        if (this._pull > PULL_MAX + PULL_MAX_SKILL * this.skill) {
          this._pull = 0; this._tired = UNLOAD + UNLOAD_SKILL * this.skill + (this._boss ? 0 : 0.8);
          if (this.state === 'evade') { this.state = 'pursue'; this.stateTime = 0; }
        }
      } else this._pull = Math.max(0, this._pull - dt * 0.6);
    }
    ac.setControls(controls);
  }
}

/**
 * Squadmate pilot (an immortal ally of the player). Priorities each frame: terrain, collision avoidance with the lead,
 * a flare break when an enemy missile closes (time to impact < 2 s or range < 1.2 km), then either engaging the bandit
 * the game assigned (EnemyBrain pursuit, guns and missiles, at a gentle rate) or loose formation on the lead. Beyond
 * `leash` from the lead it breaks off and heads back; inside `personal` it spreads out so it never crowds the player.
 */
export class WingmanBrain extends EnemyBrain {
  constructor(aircraft, opts = {}) {
    super(aircraft, opts);
    this.lead = null;                              // aircraft to fly formation on and stay near (the player)
    this.mates = null;                             // other squadmates (collision avoidance)
    this.avoidDir = new THREE.Vector3(0, 1, 0);    // escape direction of the current collision-avoidance maneuver
    this.side = 1;                                 // formation side: +1 right of the lead, -1 left
    this.slot = new THREE.Vector3(170, 20, 70);    // formation slot: right (times side), up, back from the lead (m)
    this.standoff = false;                         // wide cover position (bandits about, none for us, e.g. a boss duel)
    this.leash = 3000;                             // m from the lead: break off and head back beyond this (fights stay near the player)
    this.personal = 800;                           // m from the lead: spread out inside this while engaging
    this.terrainMargin = 1.7;                      // stronger terrain avoidance than the bandits
    this.altGame = false; this.altCap = false;     // no altitude game or bandit ceiling (squadmates fly as before)
    this.burstGap = 3;                             // squadmates fire rarely: extra s between gun bursts (snapshots
    this.gunAngle = 0.07; this.gunRange = 900; this.gunHold = 0.12; this.gunHoldRange = 1000;   // from a bit farther out)
    this.missileReload = 45;                       // s between missile shots, and only from a good position:
    this.shotAngle = 0.08; this.shotMin = 900; this.shotMax = 2000;
    this.flareBursts = 0;                          // stats: flare bursts deployed
    this.reset();
  }

  /** Back to formation with fresh timers (mission start). */
  reset() {
    this.state = 'pursue'; this.stateTime = 0;
    this.target = null; this.pickT = 0; this.standoff = false;
    this.returning = false; this.mode = 'form';
    this.flareT = 0; this.breakT = 0; this.sepT = 0; this.avoidT = 0;
    this.noFlares = false;                         // (js/glassfall.js: Mainspring's shots are not decoyed)
    this.burst = 0; this.burstPause = 0;
    this.missileCooldown = 20 + Math.random() * 20;
  }

  /** World position of the formation slot, in the lead's heading frame (a rolling lead doesn't swing it about); kept
   *  250 m above `floorY` (a ground height the caller already has) when given. Leaves the lead's horizontal heading in _hf. */
  slotPosition(out, floorY) {
    const L = this.lead;
    _hf.set(L.velocity.x, 0, L.velocity.z);
    if (_hf.lengthSq() < 1) { L.getForward(_hf); _hf.y = 0; }
    if (_hf.lengthSq() < 1e-6) _hf.set(0, 0, -1);
    _hf.normalize();
    const wide = this.standoff;
    const lat = this.slot.x * this.side * (wide ? 9 : 1), back = this.slot.z * (wide ? 8 : 1), up = this.slot.y * (wide ? 15 : 1);
    out.set(L.position.x - _hf.z * lat - _hf.x * back, L.position.y + up, L.position.z + _hf.x * lat - _hf.z * back);
    if (floorY !== undefined) out.y = Math.max(out.y, floorY + 250);
    return out;
  }

  update(dt, target, world, weapons, time) {
    const ac = this.ac, L = this.lead;
    if (!ac.alive) return;
    this.flareT -= dt; this.breakT -= dt; this.sepT -= dt; this.avoidT -= dt;
    ac.getForward(_fwd);
    // ---- missile defense: the AI sends at most one missile our way at a time; when it closes (time to impact < 2 s or
    //      range < 1.2 km), flares and a hard break. One missile scan per frame (shared with EnemyBrain.update).
    this._scanMissiles(weapons, true);
    const threat = this._threatMsl;
    if (threat && !this.noFlares && this.flareT <= 0 && threat.age > 0.3 && (this._minTti < 2 || this._minRange < 1200)) {
      weapons.deployFlares(ac);                    // decoys every missile tracking us within flareDecoyRange
      this.flareT = 4; this.breakT = 2.2; this.flareBursts++;   // at most one burst per 4 s
      ac.getRight(_tmp); _rel.subVectors(threat.position, ac.position);
      this.evadeDir = _rel.dot(_tmp) > 0 ? -1 : 1;  // break away from the missile's side
    }
    // ---- leash and personal space around the lead
    const leadOk = !!(L && L.alive);
    const dLead = leadOk ? ac.position.distanceTo(L.position) : 0;
    if (this.returning && dLead < this.leash * 0.7) this.returning = false;
    else if (!this.returning && dLead > this.leash) this.returning = true;
    const engage = !!(target && target.alive && leadOk && !this.returning);
    // collision avoidance with the lead and the other squadmates (tighter in formation, where slots are ~180 m apart);
    // once started, the escape runs at least 1 s
    let avoid = leadOk && this._onCollision(L, engage ? 150 : 60);
    if (!avoid && this.mates) for (let i = 0; i < this.mates.length; i++) { const o = this.mates[i]; if (o.alive && o !== ac && this._onCollision(o, engage ? 80 : 50)) { avoid = true; break; } }
    if (avoid) { this.avoidT = 1; this.avoidDir.copy(_away); } else avoid = this.avoidT > 0;
    // personal space: closing on the lead inside `personal` while engaging, spread out for a moment
    if (engage && dLead < this.personal && this.sepT <= 0) {
      _rel.subVectors(L.position, ac.position); _vr.subVectors(ac.velocity, L.velocity);
      if (_rel.dot(_vr) > 0) this.sepT = 1.2;
    }
    if (engage && !avoid && this.breakT <= 0 && this.sepT <= 0) {
      this.mode = 'engage';
      this._scanned = true;                        // EnemyBrain.update reuses this frame's missile scan
      super.update(dt, target, world, weapons, time);
      return;
    }
    // ---- own flying: terrain > collision avoidance > flare break > spread out > formation
    this.mode = avoid ? 'avoid' : this.breakT > 0 ? 'break' : engage ? 'separate' : 'form';
    if (this._senseTerrain(world)) {
      _pt.copy(ac.position).addScaledVector(_fwd, 300).addScaledVector(WORLD_UP, 900);
      this.steerToward(_pt, 1); this.throttleTarget = 0.3;
    } else if (avoid) {
      // collision escape: no time to roll inverted, so pull (or push) at once toward the escape side, rolling to suit
      _local.copy(this.avoidDir).applyQuaternion(_q.copy(ac.quaternion).invert());
      const pull = _local.y >= 0 ? 1 : -1;
      controls.pitch = pull;
      controls.roll = THREE.MathUtils.clamp(_local.x * 1.5, -1, 1) * pull;
      controls.yaw = THREE.MathUtils.clamp(_local.x * 2, -1, 1);
      this.throttleTarget = 0.3;
    } else if (this.breakT > 0) {
      ac.getRight(_tmp);
      _pt.copy(ac.position).addScaledVector(_tmp, 600 * this.evadeDir).addScaledVector(_fwd, 300).addScaledVector(WORLD_UP, 80);
      this.steerToward(_pt, 1);
      controls.pitch = Math.max(controls.pitch, 0.85);
      this.throttleTarget = 1;
    } else if (engage) {
      // spread away from the lead while turning toward the fight
      _away.subVectors(ac.position, L.position); _away.y = 0;
      if (_away.lengthSq() < 1) _away.set(this.side, 0, 0);
      _away.normalize();
      _tmp.subVectors(target.position, ac.position).normalize();
      _pt.copy(ac.position).addScaledVector(_away, 900).addScaledVector(_tmp, 600);
      _pt.y = Math.max(ac.position.y, target.position.y);
      this.steerToward(_pt, 0.8); this.throttleTarget = 0.5;
    } else this._formation();
    controls.throttleDelta = THREE.MathUtils.clamp(this.throttleTarget, -1, 1);
    ac.setControls(controls);
  }

  /** Closest approach to aircraft `o` within the next 3.5 s (constant velocities): under `r` m sets _away (unit escape
   *  direction: away from it at that moment, biased to climb or dive apart, whichever side we are on) and returns true. */
  _onCollision(o, r) {
    const ac = this.ac;
    _rel.subVectors(o.position, ac.position);
    if (_rel.lengthSq() > 2500 * 2500) return false;
    _vr.subVectors(o.velocity, ac.velocity);
    const vr2 = _vr.lengthSq();
    const tca = vr2 > 1 ? THREE.MathUtils.clamp(-_rel.dot(_vr) / vr2, 0, 3.5) : 0;
    _rel.addScaledVector(_vr, tca);
    const miss = _rel.length();
    if (miss >= r) return false;
    if (miss < 1) _away.set(0, 0, 0); else _away.copy(_rel).multiplyScalar(-1 / miss);
    _away.y += ac.position.y >= o.position.y ? 0.8 : -0.8;
    _away.normalize();
    return true;
  }

  /** Fly the formation slot by velocity matching: wanted velocity = the lead's + a pull toward the slot (stronger when
   *  close, capped), the nose follows it and the thrust axis is fed the wanted speed. */
  _formation() {
    const ac = this.ac, L = this.lead;
    if (!L || !L.alive) {      // no lead (shot down): loiter in a wide turn
      ac.getRight(_tmp);
      _pt.copy(ac.position).addScaledVector(_fwd, 1500).addScaledVector(_tmp, 400);
      _pt.y = Math.max(ac.position.y, ac.position.y - this._agl + 600);   // ground from this frame's terrain sense
      this.steerToward(_pt, 0.4); this.throttleTarget = 0;
      return;
    }
    this.slotPosition(_slot, ac.position.y - this._agl);   // slot floor from this frame's terrain sense (no extra query)
    this._flySlot(_slot, L.velocity);
  }
}
