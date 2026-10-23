import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Enemy pilot brain: bank-to-turn steering + a small state machine (pursue / evade / extend / avoid terrain).
const _local = new THREE.Vector3(), _toP = new THREE.Vector3(), _fwd = new THREE.Vector3(), _pFwd = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pt = new THREE.Vector3(), _up = new THREE.Vector3(), _tmp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const controls = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 };

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
    this.velEst = new THREE.Vector3();   // lagged estimate of the player's velocity: turning targets are hard to lead
    this.noiseTimer = 0;
    this.throttleTarget = 0;        // thrust axis command: -1 airbrake .. 0 cruise .. +1 boost
    this.passive = false;           // unarmed types (transports, AWACS, bombers, drones, cruise missiles): transit + jink
    this.obstacle = null;           // optional (point) => truthy when the point is inside solid structure (tunnel ridge)
    this.transitDir = new THREE.Vector3(0, 0, -1);
  }

  // Steer toward a world point; writes pitch/roll/yaw into controls. gain scales aggressiveness.
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

  update(dt, player, world, weapons, time) {
    const ac = this.ac;
    if (!ac.alive) return;
    this.stateTime += dt;
    this.missileCooldown -= dt;
    this.noiseTimer -= dt;
    if (player) this.velEst.lerp(player.velocity, 1 - Math.exp(-dt / 0.7));
    if (this.noiseTimer <= 0) { // aim wobble: shrinks with skill, grows when the player is maneuvering hard
      this.noiseTimer = 0.5 + Math.random() * 0.7;
      const jink = player && player._rates ? Math.min(1, Math.abs(player._rates.pitch) / 1.2 + Math.abs(player._rates.roll) / 4) : 0;
      const n = (1.1 - this.skill) * 110 + jink * 70;
      this.aimNoise.set((Math.random() - 0.5) * n, (Math.random() - 0.5) * n, (Math.random() - 0.5) * n);
    }
    ac.getForward(_fwd);
    const playerAlive = player && player.alive;
    let dist = Infinity, angleToPlayer = Math.PI;
    if (playerAlive) {
      _toP.subVectors(player.position, ac.position);
      dist = _toP.length();
      angleToPlayer = Math.acos(THREE.MathUtils.clamp(_toP.dot(_fwd) / Math.max(dist, 1e-3), -1, 1));
    }
    // Threat assessment
    let threatened = false;
    if (playerAlive) {
      player.getForward(_pFwd);
      _tmp.copy(_toP).multiplyScalar(-1 / Math.max(dist, 1e-3)); // from player to us
      const playerAspect = _pFwd.dot(_tmp);     // 1 = player pointing at us
      threatened = playerAspect > 0.9 && dist < 1600 && _toP.dot(_fwd) > 0; // and we're flying away from them
    }
    let missileInbound = false, minTti = Infinity;
    const ms = weapons.missiles;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; if (!m.alive || m.target !== ac) continue;
      missileInbound = true;
      _tmp.subVectors(m.position, ac.position); const d = _tmp.length();
      const vc = Math.max(50, -(_tmp.x * (m.velocity.x - ac.velocity.x) + _tmp.y * (m.velocity.y - ac.velocity.y) + _tmp.z * (m.velocity.z - ac.velocity.z)) / Math.max(d, 1));
      minTti = Math.min(minTti, d / vc);
    }
    // Rookies break as soon as they see the launch (too early: the missile corrects). Aces wait for the last
    // second and a half, which is when a hard break makes the missile overshoot.
    const breakNow = missileInbound && (this.skill < 0.55 || minTti < 0.9 + this.skill * 0.6);

    // Terrain / boundary / ceiling overrides
    const groundH = world.getHeight(ac.position.x, ac.position.z);
    const agl = ac.position.y - Math.max(groundH, 0);
    // Clearance along the predicted path (1, 2 and 3.5 s ahead); sink rate raises the safety floor
    let aheadAgl = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = i === 0 ? 1 : i === 1 ? 2 : 3.5;
      _pt.copy(ac.position).addScaledVector(ac.velocity, t);
      let c = _pt.y - Math.max(world.getHeight(_pt.x, _pt.z), 0);
      if (this.obstacle && this.obstacle(_pt)) c = Math.min(c, 0);   // treat solid structures like terrain
      if (c < aheadAgl) aheadAgl = c;
    }
    const sink = Math.max(0, -ac.velocity.y);
    const outOfBounds = Math.abs(ac.position.x) > this.worldHalf * 0.9 || Math.abs(ac.position.z) > this.worldHalf * 0.9;

    let fireGun = false;
    if (agl < 200 + sink * 2.5 || aheadAgl < 180) {
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
      if (this.passive) {
        // Transit straight along the assigned heading at constant altitude; jink when a missile comes in
        if (missileInbound && this.state !== 'evade') { this.state = 'evade'; this.stateTime = 0; this.evadeDir = Math.random() < 0.5 ? -1 : 1; this.jinkTimer = 0; }
        else if (!missileInbound && this.state === 'evade' && this.stateTime > 2.5) { this.state = 'transit'; this.stateTime = 0; }
        else if (this.state !== 'evade') this.state = 'transit';
      }
      // State transitions
      if (!this.passive && this.state !== 'evade' && (breakNow || threatened) && Math.random() < 0.6 + this.skill * 0.4) {
        this.state = 'evade'; this.stateTime = 0; this.evadeDir = Math.random() < 0.5 ? -1 : 1; this.jinkTimer = 0;
      }
      if (!this.passive && this.state === 'evade' && this.stateTime > 2.5 + this.skill * 2 && !missileInbound) { this.state = dist < 500 ? 'extend' : 'pursue'; this.stateTime = 0; }
      if (this.state === 'pursue' && playerAlive && dist < 260 && angleToPlayer > 1.0) { this.state = 'extend'; this.stateTime = 0; }
      if (this.state === 'extend' && this.stateTime > 4) { this.state = 'pursue'; this.stateTime = 0; }
      if (!playerAlive && !this.passive) this.state = 'patrol';

      if (this.state === 'transit') {
        _pt.copy(ac.position).addScaledVector(this.transitDir, 3000); _pt.y = this.transitAlt || ac.position.y;
        this.steerToward(_pt, 0.45); this.throttleTarget = 0;
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
        this.steerToward(_pt, 0.8);
        this.throttleTarget = 1;
      } else if (this.state === 'patrol') {
        _pt.set(Math.sin(time * 0.05) * 6000, 1500, Math.cos(time * 0.05) * 6000);
        this.steerToward(_pt, 0.5); this.throttleTarget = 0;
      } else if (this.aggressor === false && playerAlive) {
        // No attack slot (difficulty limit): orbit a ~3.5 km ring around the player without attacking, ready to cut in
        _tmp.subVectors(ac.position, player.position); _tmp.y = 0;
        const dh = _tmp.length() || 1; _tmp.multiplyScalar(1 / dh);
        const pull = THREE.MathUtils.clamp((3500 - dh) / 1500, -1, 1);
        _pt.set(ac.position.x - _tmp.z * 1500 + _tmp.x * pull * 1500, Math.max(player.position.y + 300, 900),
          ac.position.z + _tmp.x * 1500 + _tmp.z * pull * 1500);
        this.steerToward(_pt, 0.5); this.throttleTarget = 0;
      } else {
        // Pursue: lead pursuit toward where the player will be when our rounds arrive
        const tLead = Math.min(dist, 1100) / 950;   // lead only matters inside cannon range
        _pt.copy(player.position).addScaledVector(this.velEst, tLead).add(this.aimNoise);
        const angleOff = this.steerToward(_pt, 0.55 + this.skill * 0.45);
        this.throttleTarget = dist > 3000 ? 1 : dist > 800 ? this.pursuitThrottle : THREE.MathUtils.clamp((player.speed - ac.speed) / 120, -0.8, 0.45);
        // Guns: short bursts when lined up
        if (angleOff < 0.045 && dist < 650) {
          this.burstPause -= dt;
          if (this.burstPause <= 0) { this.burst = 0.2 + this.skill * 0.25; this.burstPause = 1.8 + (1 - this.skill) * 2.2; }
        }
        // Missile: in the envelope and off cooldown
        if (angleOff < 0.15 && dist > 700 && dist < 2500 && this.missileCooldown <= 0 && ac.missiles > 0) {
          if (weapons.fireMissile(ac, player)) this.missileCooldown = this.missileReload || (14 + (1 - this.skill) * 10);
        }
      }
    }
    if (this.burst > 0) { this.burst -= dt; fireGun = ac.alive && playerAlive && angleToPlayer < 0.08 && dist < 750; }
    if (fireGun && !this.passive && this.gunsOnly !== 'none') weapons.fireGun(ac);

    // Throttle toward target
    controls.throttleDelta = THREE.MathUtils.clamp(this.throttleTarget, -1, 1);
    // Skill-based sloppiness
    const slop = (1 - this.skill) * 0.15;
    controls.pitch = THREE.MathUtils.clamp(controls.pitch + Math.sin(time * 1.7 + this.noiseTimer) * slop, -1, 1);
    ac.setControls(controls);
  }
}
