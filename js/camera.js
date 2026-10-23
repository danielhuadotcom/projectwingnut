import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Chase / padlock / rear camera with rotational lag (no translational lag, so the jet never leaves the frame).
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _dir = new THREE.Vector3(), _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
  }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a * (this.shakeScale ?? 1)); }
  snap(aircraft) {
    aircraft.getForward(this.sFwd); aircraft.getUp(this.sUp);
    this.sDir.copy(this.sFwd);
  }
  // mode: 'chase' | 'padlock' | 'rear' | 'orbit' | 'wreck'
  update(dt, aircraft, target, mode, time) {
    const cam = this.camera;
    aircraft.getForward(_fwd); aircraft.getUp(_up); aircraft.getRight(_right);
    const speedFrac = THREE.MathUtils.clamp(aircraft.speed / 460, 0, 1);
    const modeChanged = mode !== this.mode; this.mode = mode;
    // Smooth the basis (rotational lag). Faster catch-up in padlock/rear.
    // Project Wingman-style rotational lag: the camera trails the jet's rotation by ~0.3 s, so in hard maneuvers the
    // jet visibly swings off-axis (belly or back toward the camera) and settles back when the maneuver ends.
    const kRot = 1 - Math.exp(-dt / (mode === 'chase' ? 0.3 : 0.11));
    this.sFwd.lerp(_fwd, kRot).normalize();
    // Up mostly follows the jet (the horizon tilts with it, as in PW) with a little world-up for stability
    _tmp.copy(_up).multiplyScalar(0.8).addScaledVector(WORLD_UP, 0.2).normalize();
    this.sUp.lerp(_tmp, 1 - Math.exp(-dt / (mode === 'chase' ? 0.26 : 0.11))).normalize();

    let desiredFov = this.baseFov + speedFrac * speedFrac * 14 + (aircraft.afterburner ? 4 : 0);
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
    } else if (mode === 'padlock' && target) {
      _dir.subVectors(target.position, aircraft.position).normalize();
      if (modeChanged) this.sDir.copy(this.sFwd);
      this.sDir.lerp(_dir, 1 - Math.exp(-dt * 7)).normalize();
      // Behind the player along the player->target axis, lifted so the player sits low in frame
      _tmp2.copy(WORLD_UP).lerp(this.sUp, 0.35).normalize();
      this.pos.copy(aircraft.position).addScaledVector(this.sDir, -(26 + speedFrac * 6)).addScaledVector(_tmp2, 9);
      this.look.copy(aircraft.position).lerp(target.position, 0.9);
      cam.up.copy(_tmp2);
      desiredFov += 4;
    } else {
      // Close chase camera (the jet fills a good part of the frame) that looks slightly into the turn
      const r = aircraft._rates;
      const kS = 1 - Math.exp(-dt / 0.25);
      const pr = r ? THREE.MathUtils.clamp(r.pitch / 1.57, -1, 1) : 0, yr = r ? THREE.MathUtils.clamp(r.yaw / 0.3, -1, 1) : 0;
      this.shiftUp += (pr * 5.5 - this.shiftUp) * kS;
      this.shiftRight += (yr * 3 - this.shiftRight) * kS;
      const dist = 17 + speedFrac * 6;
      this.pos.copy(aircraft.position).addScaledVector(this.sFwd, -dist).addScaledVector(this.sUp, 4.2);
      _tmp2.crossVectors(this.sFwd, this.sUp).normalize();
      this.look.copy(aircraft.position).addScaledVector(this.sFwd, 40).addScaledVector(this.sUp, 2.4 + this.shiftUp).addScaledVector(_tmp2, this.shiftRight);
      cam.up.copy(this.sUp);
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
