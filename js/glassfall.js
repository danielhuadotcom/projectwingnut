import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { Aircraft } from './aircraft.js';
import { EnemyBrain } from './ai.js';
import { glassfallPreset } from './timeofday.js';

// The Glassfall: thunderglass warheads detonating over a city, two scripted story events (js/missions.js):
//   'salvos'      M15 Glass Houses, phase 2 (phases[].glassfall = { impacts }): THUNDERHEAD cruise missiles home on the
//                 phase's fight (Kelderwick) and salvos keep coming faster than one pilot can stop them. They stay
//                 targetable and evasive (EnemyBrain.evasive: weave while locked, break late from missiles), kills score
//                 but are optional (they never clear the phase), and every one that reaches the city is a detonation.
//   'mainspring'  M20 Lights On (missions[].glassfall = 'mainspring'): clearing the last phase starts it in place of the
//                 completion. An untargetable, invulnerable Q12 MAINSPRING flies through: an Aircraft in no game list
//                 (not in allAircraft, so never in combatList / hostiles: no target, lock, cycling, HUD marker, radar
//                 blip or hit test) on team 'glass', whose missiles test an empty list. It calls down the detonations
//                 and shoots down every story ally (js/allies.js props) and both squadmates (normally immortal), each
//                 with a real missile and the existing death effects.
// Detonations are visual only (no damage): a white flash and a bloom pulse (PostFX), a crimson emissive dome that grows
// and fades, a ground ring, the existing explosion audio twice (near crack, then a far, delayed rumble), camera shake by
// distance, and one step of the sky toward the red Glassfall variant of the mission's preset (js/timeofday.js
// glassfallPreset): the last detonation leaves it fully red. A few seconds after the last one the mission completes
// through Game.missionComplete, which makes the player immortal; until then fighters, flak and SAMs still kill.
//
// Cost: DOMES pooled dome + ring meshes (three draw calls per blast while it is up: dome back + front, ring; hidden otherwise), one pooled Aircraft,
// no lights, nothing allocated per frame (salvo spawns reuse the game's aircraft pool). The sky steps run
// World.setLighting once per detonation, a frame after it: a re-grade of the cached sky table (no scattering model, well
// under 1 ms) and, on the last step only, the red environment map, copied from the one prepare() rendered at mission
// load (no PMREM passes, and scene.environment keeps its texture so no material is re-keyed). The blast materials are
// drawn once in Game.warmUpEffects (warmUp), so the first detonation builds no pipeline state.

const DOMES = 3;                 // pooled blasts (one every >= 5 s, each up DOME_LIFE s)
const DOME_R = 1700;             // m: final dome radius
const DOME_GROW = 2.2;           // 1/s: radius approaches DOME_R as 1 - exp(-t * DOME_GROW)
const DOME_LIFE = 5.5;           // s until a blast has faded out
const RING_R = 3400;             // m: final ground ring radius
const CRIMSON = [3.2, 0.03, 0.08];    // linear HDR dome colour: crimson (the rim and core pass the bloom threshold)
const BLOOM_PULSE = 0.8, BLOOM_DECAY = 1.4;   // bloom strength added at a blast, 1/s decay
const END_DELAY = 4;             // s from the last detonation to the mission completing
// salvos (M15)
const SALVO_GAP = 7, SALVO_SIZE = 3, SALVO_LIVE = 10;   // s between salvos, missiles per salvo, most alive at once
const SALVO_DIST = 5400;         // m from the city a salvo enters
const REACH = 450;               // m (horizontal) from the aim point at which a Thunderhead strikes
const CRASH_REACH = 1600;        // m: a Thunderhead crashing this close to the city strikes too
const GAP_MIN = 5, GAP_MAX = 7;  // s between detonations: no sooner (arrivals wait their turn), no later (a leaker)
const FIRST_MAX = 42;            // s into the phase: the first detonation by then at the latest
// Mainspring (M20)
const MAIN_DETS = 6, MAIN_FIRST = 4, MAIN_GAP = 5;   // detonations, s to the first, s between
const MAIN_SPEED = 2.2;          // speedScale (x 200 m/s cruise): faster than anything the squadron flies
const SHOT_RANGE = 4200, SHOT_COS = Math.cos(0.75), SHOT_GAP = 1.4;   // launch envelope, s between launches
const KILL_DIST = 160;           // m: a shot ending this close to its victim kills it
const CLUSTER = 280;             // m: allied land units this close to a struck unit go with it
const DEADLINE = 33;             // s: victims still alive then go down at once (fallback; the shots normally do it)

const DOME_VERT = /* glsl */`
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const DOME_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uA; uniform float uCore;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = f * f;
  vec3 c = uColor * (0.6 + 1.4 * rim) + vec3(5.0, 0.5, 0.45) * uCore * (1.0 - f) * (1.0 - f);
  gl_FragColor = vec4(c, uA * (0.45 + 0.5 * rim));
}`;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Glassfall {
  /** @param {object} game the Game (js/main.js): scene, world, weapons, post, chase, audio, profiler and its lists
   *  @param {object} opts { fxQuality, worldHalf } */
  constructor(game, { fxQuality = 'high', worldHalf = 20000 } = {}) {
    this.game = game; this.worldHalf = worldHalf;
    const scene = game.scene;
    // pooled blasts: a hemisphere (rim-lit, additive) and a flat ground ring each, sharing two geometries
    const domeGeo = new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    const ringGeo = new THREE.RingGeometry(0.9, 1, 72, 1).rotateX(-Math.PI / 2);
    this.blasts = [];
    for (let i = 0; i < DOMES; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Vector3(...CRIMSON) }, uA: { value: 0 }, uCore: { value: 0 } },
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,   // normal blend: it tints what it covers crimson
      });
      // Normal blending is order-dependent, so the far (inner) side draws first and the near side over it, as three's
      // DoubleSide two-pass would, but as two fixed materials (sharing uniforms) instead of flipping one material's
      // side, which marks it needsUpdate twice a frame. The front half is a child: same transform and visibility.
      const dome = new THREE.Mesh(domeGeo, mat); dome.name = 'glassfall-dome'; dome.visible = false; dome.frustumCulled = false;
      const frontMat = new THREE.ShaderMaterial({ uniforms: mat.uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        transparent: true, depthWrite: false, side: THREE.FrontSide, fog: false });
      const front = new THREE.Mesh(domeGeo, frontMat); front.name = 'glassfall-dome-front'; front.frustumCulled = false;
      dome.add(front);
      const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 0.25, 0.25), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.name = 'glassfall-ring'; ring.visible = false; ring.frustumCulled = false;
      dome.renderOrder = ring.renderOrder = 5; front.renderOrder = 5.001;   // front after back (same depth for the sort)
      scene.add(dome); scene.add(ring);
      if (game.profiler) { game.profiler.instrument(dome, 'glassfall'); game.profiler.instrument(ring, 'glassfall'); }
      this.blasts.push({ dome, ring, t: -1 });
    }
    // Q12 MAINSPRING: one pooled airframe, parked (hidden) until M20's ending
    const q = this.q12 = new Aircraft(scene, { team: 'glass', bodyColor: 0x7d1212, accentColor: 0xe0a020, fxQuality, airframe: 'q12' });
    q.mesh.name = 'aircraft-q12';
    q.name = 'Q12 MAINSPRING'; q.immortal = true; q.untargetable = true; q.applyDamage = () => false; q.missiles = 999; q.ammo = 0;
    q.setSize(1, true);
    const b = q.brain = new EnemyBrain(q, { skill: 0.95, worldHalf });
    b.passive = true; b.diveRange = 0; b.state = 'transit';
    if (game.tunnel) { const tn = game.tunnel; b.obstacle = (pt) => tn.collide(pt, 40) === 'wall'; }
    if (game.profiler) game.profiler.instrument(q.mesh, 'jets');
    q.kill();
    this.goal = new THREE.Vector3();       // Thunderhead aim point / Q12 transit goal (shared, no allocation)
    this.center = new THREE.Vector3();     // the city: where the detonations land
    this._q = new Float32Array(16 * 2);    // queued strike positions (x, z), ring buffer
    this.victims = []; this.shots = [];
    for (let i = 0; i < 8; i++) this.shots.push({ m: null, id: -1, v: null, d: Infinity });
    this.stats = { runs: 0, detonations: 0, forced: 0, arrivals: 0, kills: 0, killsForced: 0, shots: 0, misses: 0, salvos: 0, maxLive: 0 };
    this.bloomAdd = 0;
    this.reset();
  }

  /** Mission load, INFINITY, quit: no event, blasts hidden, the Q12 parked. (The sky is reset by the mission's preset.) */
  reset() {
    this.mode = null; this.active = false; this.played = false; this.skyStep = 0;
    this.t = 0; this.total = 0; this.det = 0; this.lastDet = -1e9; this.endT = -1; this.qHead = 0; this.qLen = 0;
    this.salvoT = 0; this.salvoN = 0; this.shotT = 0; this.victims.length = 0; this.victimsLeft = 0;
    for (const s of this.shots) { s.m = null; s.v = null; s.id = -1; }
    for (const B of this.blasts) { B.t = -1; B.dome.visible = false; B.ring.visible = false; }
    if (this.q12.alive) this.q12.kill();
    if (this.bloomAdd > 0) { this.bloomAdd = 0; this.game.post.bloomStrength = this.game.bloomBase ?? this.game.post.bloomStrength; }
  }

  /** Mission load (Game.loadMission, after the lighting): a mission with a Glassfall event has World render the red end
   *  state's environment map now, so the last sky step copies it instead of rendering it under the flash. */
  prepare(M) {
    const g = this.game;
    if (g.bench || !M || !(M.glassfall === 'mainspring' || (M.phases || []).some((p) => p.glassfall))) return;
    if (g.world.prepareEnvVariant) g.world.prepareEnvVariant(glassfallPreset(g.timeOfDay, 1));
  }
  /** Game.warmUpEffects: show (on) or hide one pooled blast at `at`, in front of the warm-up camera, so the first real
   *  detonation doesn't build the dome's and ring's pipeline state mid-mission (~0.6 s each on ANGLE / D3D12). */
  warmUp(on, at = null) {
    const B = this.blasts[0];
    if (on && at) { B.dome.position.copy(at); B.ring.position.copy(at); B.dome.scale.setScalar(60); B.ring.scale.set(80, 1, 80); }
    B.dome.material.uniforms.uA.value = on ? 0.5 : 0; B.ring.material.opacity = on ? 0.5 : 0;
    B.dome.visible = B.ring.visible = !!on; B.t = -1;
  }

  /** The red level reached so far (0..1): the share of this event's detonations fired. */
  get level() { return this.total > 0 ? this.det / this.total : 0; }

  // ---- starts -------------------------------------------------------------------------------------------------------
  /** M15 phase 2: Thunderhead salvos on the phase's fight (Kelderwick). cfg = { impacts }. */
  startSalvos(cfg) {
    const g = this.game;
    this._begin('salvos', Math.max(1, cfg.impacts | 0 || 7));
    this.center.set(g._fight ? g._fight.x : g.sortieFrame.x, 0, g._fight ? g._fight.z : g.sortieFrame.z);
    this.center.y = Math.max(g.world.getHeight(this.center.x, this.center.z), 0);
    this.goal.copy(this.center); this.goal.y += 120;
    this.salvoT = SALVO_GAP * 1.5;         // the mission's own Thunderhead groups open; generated salvos follow
  }
  /** M20's ending: the Q12 flies through, calls down the detonations and shoots down the squadmates and story allies. */
  startMainspring() {
    const g = this.game, p = g.player;
    this._begin('mainspring', MAIN_DETS);
    const F = g._fight || g.sortieFrame;
    this.center.set(F.x, 0, F.z); this.center.y = Math.max(g.world.getHeight(F.x, F.z), 0);
    const V = this.victims;
    for (const a of g.allies) if (a.alive) V.push(a);
    for (const u of g.allied.units) if (u.alive) V.push(u);
    this.victimsLeft = V.length;
    for (const a of g.allies) if (a.brain) a.brain.noFlares = true;   // Mainspring's shots are not decoyed
    // in from 7 km beyond the player's squadron, on the far side from the city, at 900 m over the ground: it overflies
    // the squadmates first, then the city and the allied units
    const q = this.q12;
    _v.subVectors(p.position, this.center); _v.y = 0;
    if (_v.lengthSq() < 1) _v.set(0, 0, 1);
    _v.normalize();
    const lim = this.worldHalf * 0.85;
    const x = THREE.MathUtils.clamp(p.position.x + _v.x * 6000 + _v.z * 2500, -lim, lim), z = THREE.MathUtils.clamp(p.position.z + _v.z * 6000 - _v.x * 2500, -lim, lim);
    const y = Math.max(g.world.getHeight(x, z), 0) + 900;
    const heading = Math.atan2(-(p.position.x - x), -(p.position.z - z));
    q.reset({ position: _v2.set(x, Math.max(y, p.position.y), z), heading, health: 1 });
    q.quaternion.setFromAxisAngle(UP, heading);
    q.speedScale = MAIN_SPEED; q.speed = 200 * MAIN_SPEED; q.throttle = 1; q.missiles = 999; q.holdFire = false;
    q.getForward(_v2); q.velocity.copy(_v2).multiplyScalar(q.speed);
    const b = q.brain;
    b.state = 'transit'; b.stateTime = 0; b.target = null; b.setTransitGoal(this.goal); b.transitAlt = q.position.y;
    this.shotT = 3;
  }
  _begin(mode, total) {
    this.reset();
    this.mode = mode; this.active = true; this.played = true; this.total = total;
    this.stats.runs++;
  }

  // ---- per frame ----------------------------------------------------------------------------------------------------
  /** Game.updateGame (alive = the player is alive: the event only advances then) and Game.updateDead (effects only). */
  update(dt, alive = true) {
    this._updateBlasts(dt);
    if (this.skyStep > 0) {   // a frame after the blast: the sky table now, the environment map only with the last step
      const k = this.skyStep; this.skyStep = 0;
      this.game.applyTime(this.game.mission && this.game.mission.time, k, k >= 1);
    }
    if (!this.active) { if (this.q12.alive) this._flyQ12(dt, false); return; }
    if (!alive) return;
    this.t += dt;
    const g = this.game;
    if (this.mode === 'salvos') this._salvos(dt);
    else this._mainspring(dt);
    if (this.endT < 0 && this.det >= this.total && (this.mode !== 'mainspring' || this.victimsLeft === 0)) this.endT = this.t + END_DELAY;
    if (this.endT >= 0 && this.t >= this.endT) {
      this.active = false;
      g.missionComplete();
    }
  }

  /** Enemy crash hook (Game.updateGame): a tagged Thunderhead crashing near the city strikes. True when handled. */
  crash(e) {
    if (!this.active || this.mode !== 'salvos' || !e._glass) return false;
    const dx = e.position.x - this.center.x, dz = e.position.z - this.center.z;
    if (dx * dx + dz * dz > CRASH_REACH * CRASH_REACH) return false;
    this._arrive(e);
    return true;
  }

  _salvos(dt) {
    const g = this.game, E = g.enemies;
    let live = 0;
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (!e.alive || e.name !== 'THUNDERHEAD') continue;
      if (!e._glass) {                     // the mission's own groups and generated salvos alike: aim at the city
        e._glass = true; e.optional = true;
        const b = e.brain; b.evasive = true; b.lockedOn = false; b.setTransitGoal(this.goal); b.transitAlt = Math.max(e.position.y, this.goal.y + 350);
      }
      const dx = e.position.x - this.goal.x, dz = e.position.z - this.goal.z;
      if (dx * dx + dz * dz < REACH * REACH) { this._arrive(e); continue; }
      live++;
    }
    if (live > this.stats.maxLive) this.stats.maxLive = live;
    // more salvos while detonations remain: faster than one pilot can stop them
    this.salvoT -= dt;
    if (this.salvoT <= 0 && this.det + this.qLen < this.total) {
      this.salvoT = SALVO_GAP;
      if (live < SALVO_LIVE) this._spawnSalvo(Math.min(SALVO_SIZE, SALVO_LIVE - live));
    }
    // detonations: queued strikes at most one per GAP_MIN; a leaker by GAP_MAX (and the first by FIRST_MAX)
    const since = this.t - this.lastDet;
    if (this.det < this.total) {
      if (this.qLen > 0 && (this.det === 0 || since >= GAP_MIN)) {
        const k = this.qHead * 2; this.qHead = (this.qHead + 1) % 16; this.qLen--;
        this._detonate(this._q[k], this._q[k + 1]);
      } else if (this.qLen === 0 && (this.det > 0 ? since >= GAP_MAX : this.t >= FIRST_MAX)) {
        this.stats.forced++;
        this._detonateNear();
      }
    }
  }
  /** A Thunderhead reached the city: consumed, its strike queued (it detonates on its turn, GAP_MIN apart). */
  _arrive(e) {
    const g = this.game;
    e.kill(); g.combatDirty = true; this.stats.arrivals++;
    if (g.target === e) { g.target = null; g.lockTimer = 0; g.locked = false; }
    if (this.det + this.qLen >= this.total || this.qLen >= 16) { g.weapons.explode(_v.set(e.position.x, Math.max(g.world.getHeight(e.position.x, e.position.z), 0) + 5, e.position.z), 1.5); return; }
    const k = ((this.qHead + this.qLen) % 16) * 2;
    this._q[k] = e.position.x; this._q[k + 1] = e.position.z; this.qLen++;
  }
  _spawnSalvo(n) {
    const g = this.game, type = g.airTypes.THUNDERHEAD, W = g.world, lim = this.worldHalf * 0.85;
    if (!type || n <= 0) return;
    const F = g.sortieFrame, a0 = (F ? F.bearing : 0) + (this.salvoN++ * 2.4) % (Math.PI * 2);   // a new bearing each salvo
    g._spawnOptional = true; g._spawnAtFleet = false;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i - (n - 1) / 2) * 0.09;
      const x = THREE.MathUtils.clamp(this.center.x + Math.sin(a) * SALVO_DIST, -lim, lim), z = THREE.MathUtils.clamp(this.center.z - Math.cos(a) * SALVO_DIST, -lim, lim);
      const y = g.clearSpawnY(x, Math.max(W.getHeight(x, z), 0, this.center.y) + 650 + i * 40, z);
      const heading = Math.atan2(-(this.center.x - x), -(this.center.z - z));
      const ac = g.spawnAircraft('THUNDERHEAD', type, _v.set(x, y, z), heading, i);
      ac._pending = false;
    }
    g._spawnOptional = false;
    this.stats.salvos++;
    g.rebuildCombatList();
  }

  _mainspring(dt) {
    const g = this.game;
    // detonations on the schedule, around the city
    if (this.det < this.total && this.t >= MAIN_FIRST + this.det * MAIN_GAP) this._detonateNear();
    this._flyQ12(dt, true);
    // shots in flight: a shot that ends near its victim kills it; one that ends far away frees the victim for another
    for (const s of this.shots) {
      if (s.m === null) continue;
      const m = s.m;
      if (m.alive && m.id === s.id) { s.d = m.position.distanceTo(s.v.position); continue; }
      if (s.v.alive && s.d < KILL_DIST) this._kill(s.v, false); else if (s.v.alive) { this.stats.misses++; s.v._shot = null; }
      s.m = null; s.v = null; s.id = -1;
    }
    if (this.t >= DEADLINE && this.victimsLeft > 0) for (const v of this.victims) if (v.alive) this._kill(v, true);
  }
  /** Fly the Q12 (EnemyBrain transit onto this.goal at its height): to the next victim while hunting, else on through. */
  _flyQ12(dt, hunting) {
    const g = this.game, q = this.q12, b = q.brain;
    let v = null;
    if (hunting) for (const o of this.victims) if (o.alive && !o._shot) { v = o; break; }
    if (v) {
      this.goal.copy(v.position);
      if (v.isGround) this.goal.y = v.position.y + 650;
      b.transitAlt = this.goal.y;
      this.shotT -= dt;
      _v.subVectors(v.position, q.position); const d = _v.length();
      q.getForward(_v2);
      if (this.shotT <= 0 && d < SHOT_RANGE && _v.dot(_v2) > SHOT_COS * d) this._shoot(v);
    } else if (b.transitGoal !== null) {   // nobody left to hunt: straight on, out over the city
      q.getForward(b.transitDir); b.transitDir.y = 0; b.transitDir.normalize(); b.setTransitGoal(null); b.transitAlt = q.position.y;
    }
    b.update(dt, null, g.world, g.weapons, g.time);
    q.update(dt);
    const h = Math.max(g.world.getHeight(q.position.x, q.position.z), 0);
    if (q.position.y < h + 60) q.position.y = h + 60;   // scripted: it never crashes
    q.updateDrawScale(g.camera.position);
  }
  _shoot(v) {
    const g = this.game, s = this.shots.find((o) => o.m === null);
    if (!s) return;
    const m = g.weapons.fireMissile(this.q12, v);
    if (!m) return;
    // a fast, agile, long-legged shot (the game's launch hook gave it the enemy profile)
    m.maxSpeed = 1050; m.boostTime = 3; m.life = 11; m.turnScale = 1.8; m.fuse = 16;
    m.carry = 0; m.blindMinTime = 0; m.termTime = g.weapons.missileTermTime;   // none of the enemy profile's dodgeability
    s.m = m; s.id = m.id; s.v = v; s.d = m.position.distanceTo(v.position);
    v._shot = s; this.shotT = SHOT_GAP; this.stats.shots++;
  }
  /** A victim goes down: a squadmate with the aircraft death effects, an allied ship sinking, a land group exploding. */
  _kill(v, forced) {
    const g = this.game, W = g.weapons;
    if (!v.alive) return;
    if (forced) this.stats.killsForced++;
    if (!v.isGround) {
      W.aircraftDeath(v); v.kill(); v._shot = null;
      const i = g.allies.indexOf(v); if (i >= 0) g.allies.splice(i, 1);
      g.combatDirty = true;
      g.message(`${v.callsign || v.name} DOWN`, false, 3);
      this.victimsLeft--; this.stats.kills++;
      return;
    }
    let fx = 0, land = 0;
    for (const u of this.victims) {
      if (!u.alive || !u.isGround || (u !== v && (u.naval || v.naval || u.position.distanceTo(v.position) > CLUSTER))) continue;
      if (u.naval) {
        W.explode(_v.set(u.position.x, u.position.y + u.size[1] * 0.3, u.position.z), 2.6);
        W.delayEffect('death', u.position, 1, 1, 0, u.velocity);
        g.ground.sink(u);
        g.message(u.name === g.allied.flagName ? `${u.name} SUNK` : 'ESCORT LOST', false, 3);
      } else {
        if (fx++ < 3) W.explode(_v.set(u.position.x, u.position.y + 3, u.position.z), 1.6);
        g.ground.kill(u); land++;
      }
      u._shot = null; this.victimsLeft--; this.stats.kills++;
    }
    g.allied.commit();
    if (land) g.message('ALLIED UNITS LOST', false, 3);
  }

  // ---- detonations --------------------------------------------------------------------------------------------------
  /** A detonation at a scattered point around the city (the schedule's, or a leaker nobody saw arrive). */
  _detonateNear() {
    const a = this.det * 2.399 + 0.7, r = this.mode === 'salvos' ? 300 + (this.det % 3) * 450 : 900 + (this.det % 3) * 900;
    this._detonate(this.center.x + Math.sin(a) * r, this.center.z - Math.cos(a) * r);
  }
  _detonate(x, z) {
    const g = this.game;
    this.det++; this.lastDet = this.t; this.stats.detonations++;
    if (g.onGlassfallDetonation) g.onGlassfallDetonation(this.det, this.mode);   // the radio script's detonation lines and music cut
    this.blast(x, z, 0);
    // the sky: one step toward the red variant (fully red on the last detonation), on the next frame (update)
    this.skyStep = this.det / this.total;
    if (this.det === 1) g.message('GLASSFALL', true, 4);
  }
  /** One thunderglass blast at (x, z), effects only (dome, ring, flash, bloom, shake, audio), y m over the ground: a
   *  Glassfall detonation, or a lone blast outside the event (M21's final-phase blast, Game.updateFinal). */
  blast(x, z, y = 0) {
    const g = this.game;
    y += Math.max(g.world.getHeight(x, z), 0);
    // pooled blast: the free one, else the oldest
    let B = this.blasts[0];
    for (const o of this.blasts) { if (o.t < 0) { B = o; break; } if (o.t > B.t) B = o; }
    B.t = 0; B.dome.position.set(x, y - 40, z); B.ring.position.set(x, y + 6, z);
    B.dome.visible = true; B.ring.visible = true;
    this._updateBlast(B);
    // flash, bloom pulse, shake and rumble by distance from the camera
    const d = _v.set(x, y, z).distanceTo(g.camera.position);
    g.post.flash(THREE.MathUtils.clamp(1.15 - d / 16000, 0.4, 1));
    this.bloomAdd = BLOOM_PULSE;
    g.chase.addShake(THREE.MathUtils.clamp(1.05 - d / 9000, 0.15, 0.9));
    g.audio.explosion(Math.min(d * 0.08, 220));                   // the crack
    g.audio.explosion(Math.min(700 + d * 0.15, 1300));            // and the deep rumble rolling in after it
    g.weapons.explode(_v.set(x, y + 20, z), 3);
  }
  _updateBlasts(dt) {
    const g = this.game;
    for (const B of this.blasts) {
      if (B.t < 0) continue;
      B.t += dt;
      if (B.t >= DOME_LIFE) { B.t = -1; B.dome.visible = false; B.ring.visible = false; continue; }
      this._updateBlast(B);
    }
    if (this.bloomAdd > 0) {
      this.bloomAdd = Math.max(0, this.bloomAdd - dt * BLOOM_DECAY * (0.4 + this.bloomAdd));
      g.post.bloomStrength = (g.bloomBase ?? 0.55) + this.bloomAdd;
    }
  }
  _updateBlast(B) {
    const t = B.t, u = B.dome.material.uniforms;
    const r = DOME_R * (1 - Math.exp(-t * DOME_GROW)) + 40;
    B.dome.scale.set(r, r * 0.85, r);
    const fadeIn = Math.min(1, t / 0.12), fade = 1 - THREE.MathUtils.smoothstep(t, 1.0, DOME_LIFE);
    u.uA.value = fadeIn * fade;
    u.uCore.value = Math.max(0, 1 - t / 0.9);
    const rr = RING_R * (1 - Math.exp(-t * 1.6)) + 60;
    B.ring.scale.set(rr, 1, rr);
    B.ring.material.opacity = fadeIn * (1 - THREE.MathUtils.smoothstep(t, 0.3, 3.2)) * 0.9;
  }
}
