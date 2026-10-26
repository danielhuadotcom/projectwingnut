import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Chase (+ padlock orbit) / rear camera with rotational lag (no translational lag, so the jet never leaves the frame).
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _dir = new THREE.Vector3(), _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3();
const _pF = new THREE.Vector3(), _pU = new THREE.Vector3(), _pR = new THREE.Vector3(), _pH = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Padlock: the chase camera orbits the jet toward the target (same FOV, distance and offsets) instead of switching to a
// separate view. The orbit is a yaw (about the chase up) then a pitch (about the yawed right), both relative to the
// lagged chase basis, each driven by an exact critically damped spring (95% settled in ~4.7/omega s). Pitch is capped
// short of the vertical so the basis never degenerates (no gimbal roll-spin; a target overhead stays in view), and yaw
// is unwrapped against the current value with a committed side, so a target dead astern never flips the swing.
const PAD_OMEGA = 17;                       // ~0.28 s to settle (in and out)
const PAD_MAX_PITCH = 75 * Math.PI / 180;
const PAD_SIDE_ZONE = 0.4;                  // rad short of +-pi inside which the committed swing side is kept
const TWO_PI = Math.PI * 2;
const AOA_TWEEN = 0.5;                      // s, held view -> new heading after the AOA limiter (camera lock)
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
const _bR = new THREE.Vector3(), _bU = new THREE.Vector3(), _bB = new THREE.Vector3();
/** Camera-style orientation (looking down -Z) from a forward and a rough up. */
function basisQuat(q, fwd, up) {
  _bR.crossVectors(fwd, up);
  if (_bR.lengthSq() < 1e-8) _bR.set(1, 0, 0);
  _bR.normalize(); _bU.crossVectors(_bR, fwd).normalize(); _bB.copy(fwd).negate();
  return q.setFromRotationMatrix(_m4.makeBasis(_bR, _bU, _bB));
}
// Exact critically damped step toward `goal`: state in s[0] (value) / s[1] (velocity), no allocation.
function springStep(s, i, goal, omega, dt) {
  const x = s[i] - goal, v = s[i + 1];
  const e = Math.exp(-omega * dt), tmp = (v + omega * x) * dt;
  s[i + 1] = (v - omega * tmp) * e;
  s[i] = goal + (x + tmp) * e;
}

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.baseFov = 66;
    this.sFwd = new THREE.Vector3(0, 0, -1);   // smoothed forward
    this.sUp = new THREE.Vector3(0, 1, 0);     // smoothed up
    this.sDir = new THREE.Vector3(0, 0, -1);   // smoothed dir to target (padlock)
    this.look = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.shake = 0;
    this.shakeSeed = Math.random() * 100;
    this.fov = this.baseFov;
    this.mode = 'chase';
    this.orbit = 0;
    this.shiftUp = 0; this.shiftRight = 0;   // PW-style view-model shift (look into the turn)
    this.lookDir = new THREE.Vector3(0, 0, -1);   // mouse-aim camera direction (aim + free look), set by main
    // Padlock orbit state: [yaw, yawVel, pitch, pitchVel, weight, weightVel]; padSide = committed swing side (+-1)
    this.pad = new Float64Array(6); this.padSide = 1;
    this.ground = null;      // optional World (getHeight) for the terrain clamp, set by main
    this.inTunnel = false;   // set by main: inside the bore the tunnel's own clamp applies, not the terrain one
    this.aoaLock = true;     // AOA limiter camera lock (setting)
    this._aoaTw = 1e9;       // -1 = held by the lock; 0..AOA_TWEEN = easing onto the new heading; past it = normal lag
  }
  resetPadlock() { this.pad.fill(0); this.padSide = 1; }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a * (this.shakeScale ?? 1)); }
  snap(aircraft) {
    aircraft.getForward(this.sFwd); aircraft.getUp(this.sUp);
    this.sDir.copy(this.sFwd);
    this._aoaTw = 1e9;
    this.resetPadlock();
  }
  // mode: 'chase' | 'padlock' | 'rear' | 'orbit' | 'wreck'
  update(dt, aircraft, target, mode, time) {
    const cam = this.camera;
    aircraft.getForward(_fwd); aircraft.getUp(_up); aircraft.getRight(_right);
    const speedFrac = THREE.MathUtils.clamp(aircraft.speed / 460, 0, 1);
    this.mode = mode;
    // Smooth the basis (rotational lag). Faster catch-up in rear view; padlock keeps the chase lag.
    // Project Wingman-style rotational lag: the camera trails the jet's rotation by ~0.3 s, so in hard maneuvers the
    // jet visibly swings off-axis (belly or back toward the camera) and settles back when the maneuver ends.
    const chaseLike = mode === 'chase' || mode === 'padlock';   // padlock is the chase camera, orbited
    // Up mostly follows the jet (the horizon tilts with it, as in PW) with a little world-up for stability
    _tmp.copy(_up).multiplyScalar(0.8).addScaledVector(WORLD_UP, 0.2).normalize();
    // AOA limiter off with the camera lock (aoaLock, a setting): the view holds where it was while the jet spins in place,
    // then on release eases from the held view onto the new heading over AOA_TWEEN s (slerped: no flip through a
    // reversed view). Without the lock the lag just tightens.
    const locked = this.aoaLock && aircraft.aoaOff && aircraft.alive && mode !== 'mouseaim';
    if (locked) this._aoaTw = -1;
    else if (this._aoaTw < 0) { this._aoaTw = 0; basisQuat(_qA, this.sFwd, this.sUp); }
    if (locked) { /* held */ } else if (this._aoaTw >= 0 && this._aoaTw < AOA_TWEEN) {
      this._aoaTw += dt;
      const u = Math.min(1, this._aoaTw / AOA_TWEEN), e = u * u * (3 - 2 * u);
      basisQuat(_qB, _fwd, _tmp);
      _qC.slerpQuaternions(_qA, _qB, e);
      this.sFwd.set(0, 0, -1).applyQuaternion(_qC); this.sUp.set(0, 1, 0).applyQuaternion(_qC);
    } else {
      const kRot = 1 - Math.exp(-dt / (chaseLike ? (aircraft.aoaOff ? 0.2 : 0.3) : 0.11));
      this.sFwd.lerp(_fwd, kRot).normalize();
      this.sUp.lerp(_tmp, 1 - Math.exp(-dt / (chaseLike ? 0.26 : 0.11))).normalize();
    }

    let desiredFov = this.baseFov + speedFrac * speedFrac * 14 + (aircraft.afterburner && !aircraft.aoaOff ? 4 : 0);   // (AOA off: the burner follows the stick)
    if (mode === 'orbit') {
      // Title screen: slow cinematic orbit
      this.orbit += dt * 0.12;
      const r = 42;
      this.pos.set(aircraft.position.x + Math.cos(this.orbit) * r, aircraft.position.y + 9 + Math.sin(this.orbit * 0.7) * 5, aircraft.position.z + Math.sin(this.orbit) * r);
      this.look.copy(aircraft.position).addScaledVector(_fwd, 6);
      // Frame the jet right of center so the title card (left) doesn't cover it on wide screens
      const aspect = cam.aspect || 1.6;
      if (aspect > 1.3) {
        _dir.subVectors(this.look, this.pos).normalize();
        _tmp2.crossVectors(_dir, WORLD_UP).normalize();
        this.look.addScaledVector(_tmp2, -Math.min(24, (aspect - 1.2) * 42));
      }
      cam.up.copy(WORLD_UP);
      desiredFov = 50;
    } else if (mode === 'wreck') {
      // Player destroyed: hold position, look at the wreck (aircraft.position frozen by main)
      this.look.lerp(aircraft.position, 1 - Math.exp(-dt * 3));
      cam.up.lerp(WORLD_UP, 1 - Math.exp(-dt * 2)).normalize();
      desiredFov = 55;
    } else if (mode === 'mouseaim') {
      // War Thunder-style: the camera looks where you aim (not where the jet points), horizon level; the jet chases
      // the reticle at the screen center. aimDir is set by main (unit vector), lookDir adds free look.
      const d = this.lookDir;
      const k = 1 - Math.exp(-dt / 0.06);
      this.sDir.lerp(d, k).normalize();
      const dist = 19 + speedFrac * 6;
      this.pos.copy(aircraft.position).addScaledVector(this.sDir, -dist).addScaledVector(this.mouseUp || WORLD_UP, 5);
      const mu = this.mouseUp || WORLD_UP;
      this.look.copy(aircraft.position).addScaledVector(this.sDir, 120).addScaledVector(mu, 4);
      cam.up.copy(mu);
    } else if (mode === 'rear') {
      // In front of the jet, looking back past it at whatever is on our tail
      this.pos.copy(aircraft.position).addScaledVector(this.sFwd, 24 + speedFrac * 6).addScaledVector(this.sUp, 6);
      this.look.copy(aircraft.position).addScaledVector(this.sFwd, -40).addScaledVector(this.sUp, 1);
      cam.up.copy(this.sUp);
    } else {
      // Close chase camera (the jet fills a good part of the frame) that looks slightly into the turn. Padlock orbits
      // this same rig around the jet toward the target.
      const r = aircraft._rates;
      const kS = 1 - Math.exp(-dt / 0.25);
      const pr = r ? THREE.MathUtils.clamp(r.pitch / 1.57, -1, 1) : 0, yr = r ? THREE.MathUtils.clamp(r.yaw / 0.3, -1, 1) : 0;
      const hold = locked ? 0 : 1;                                   // (no look-into-turn while the view is held)
      this.shiftUp += (pr * 5.5 * hold - this.shiftUp) * kS;
      this.shiftRight += (yr * 3 * hold - this.shiftRight) * kS;
      const dist = 17 + speedFrac * 6;
      _tmp2.crossVectors(this.sFwd, this.sUp).normalize();          // chase right
      const P = this.pad;
      let gYaw = 0, gPitch = 0, gW = 0;
      if (mode === 'padlock' && target) {
        // Target direction in the chase basis -> yaw / pitch goals
        _dir.subVectors(target.position, aircraft.position);
        const fx = _dir.dot(_tmp2), fy = _dir.dot(this.sUp), fz = _dir.dot(this.sFwd);
        gPitch = Math.min(PAD_MAX_PITCH, Math.max(-PAD_MAX_PITCH, Math.atan2(fy, Math.hypot(fx, fz))));
        let d = Math.atan2(fx, fz) - P[0];
        d -= TWO_PI * Math.round(d / TWO_PI);                        // nearest equivalent, in [-pi, pi]
        // Near dead astern keep swinging the way we already go (no left/right flip-flop as the target jitters)
        if (Math.abs(d) > Math.PI - PAD_SIDE_ZONE && Math.sign(d) !== this.padSide) d -= Math.sign(d) * TWO_PI;
        else if (Math.abs(d) > 1e-3) this.padSide = Math.sign(d);
        gYaw = P[0] + d; gW = 1;
      }
      springStep(P, 0, gYaw, PAD_OMEGA, dt);
      springStep(P, 2, gPitch, PAD_OMEGA, dt);
      springStep(P, 4, gW, PAD_OMEGA, dt);
      if (P[0] > Math.PI || P[0] < -Math.PI) P[0] -= TWO_PI * Math.round(P[0] / TWO_PI);   // keep yaw bounded
      if (gW === 0 && Math.abs(P[0]) + Math.abs(P[2]) + Math.abs(P[1]) + Math.abs(P[3]) < 1e-4 && P[4] < 1e-3) P.fill(0);   // settled: exact chase
      const w = Math.min(1, Math.max(0, P[4])), shiftK = 1 - w;      // the look-into-turn shift fades out while padlocked
      if (P[0] !== 0 || P[2] !== 0) {
        // Orbit the chase basis: yaw about sUp, then pitch about the yawed right
        // (sFwd / sUp are smoothed separately, so orthonormalize the up first: a rigid rotation, no skew)
        _right.copy(this.sUp).addScaledVector(this.sFwd, -this.sUp.dot(this.sFwd)).normalize();
        const cy = Math.cos(P[0]), sy = Math.sin(P[0]), cp = Math.cos(P[2]), sp = Math.sin(P[2]);
        _pH.copy(this.sFwd).multiplyScalar(cy).addScaledVector(_tmp2, sy);            // yawed forward (horizontal)
        _pF.copy(_pH).multiplyScalar(cp).addScaledVector(_right, sp);
        _pU.copy(_right).multiplyScalar(cp).addScaledVector(_pH, -sp);
        _pR.crossVectors(_pF, _pU);
      } else { _pF.copy(this.sFwd); _pU.copy(this.sUp); _pR.copy(_tmp2); }
      this.pos.copy(aircraft.position).addScaledVector(_pF, -dist).addScaledVector(_pU, 4.2);
      this.look.copy(aircraft.position).addScaledVector(_pF, 40).addScaledVector(_pU, 2.4 + this.shiftUp * shiftK).addScaledVector(_pR, this.shiftRight * shiftK);
      cam.up.copy(_pU);
    }
    if (mode !== 'chase' && mode !== 'padlock') this.resetPadlock();   // rear / mouse aim / wreck / orbit: other rigs
    // Terrain clamp (chase rigs only; inside the tunnel bore main applies the tunnel's own clamp afterwards)
    if (chaseLike && this.ground && !this.inTunnel) {
      const gh = Math.max(this.ground.getHeight(this.pos.x, this.pos.z), 0) + 3;
      if (this.pos.y < gh) this.pos.y = gh;
    }
    // Shake
    if (this.shake > 0) {
      const s = this.shake * 0.9;
      const t = time * 37 + this.shakeSeed;
      _tmp.set(Math.sin(t * 1.3) + Math.sin(t * 2.9) * 0.5, Math.cos(t * 1.7) + Math.sin(t * 3.7) * 0.5, Math.sin(t * 2.3) * 0.5).multiplyScalar(s);
      this.shake = Math.max(0, this.shake - dt * 2.2);
    } else _tmp.set(0, 0, 0);
    cam.position.copy(this.pos).add(_tmp);
    cam.lookAt(this.look);
    this.fov += (desiredFov - this.fov) * (1 - Math.exp(-dt * 4));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}
