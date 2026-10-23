// Missile dodge/accuracy test: scripted geometries, many randomized trials per scenario, hit rates per tuning.
import * as THREE from 'three';
globalThis.window = globalThis; globalThis.document = { createElement: () => ({ getContext: () => null, style: {} }) };
const { Aircraft } = await import('../js/aircraft.js');
const { Weapons } = await import('../js/weapons.js');
const E = process.env;
const world = { getHeight: () => -100, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(), cloudDensityAt: () => 0 };
const scene = new THREE.Scene();
const V = (x, y, z) => new THREE.Vector3(x, y, z), UP = V(0, 1, 0);
function trial(scn, cfg, rnd) {
  let hit = false;
  const w = new Weapons(scene, world, { onHit: (t) => { if (t === tgt) hit = true; } });
  w.missileTurnRateBoost = cfg.boost; w.missileTurnRateCoast = cfg.coast;
  w.missileSeekerCos = Math.cos(cfg.seeker * Math.PI / 180); w.missileFuse = cfg.fuse;
  if (cfg.lag !== undefined) w.missileLag = cfg.lag; if (cfg.blind !== undefined) w.missileBlindRange = cfg.blind;
  if (cfg.life) w.missileLife = cfg.life; if (cfg.vmax) w.missileMaxSpeed = cfg.vmax; if (cfg.boostT) w.missileBoostTime = cfg.boostT;
  const shooter = new Aircraft(scene, { team: cfg.shooterTeam || 'player', position: V(0, 3000, 0), heading: 0 });
  shooter.speed = 220; shooter.applyDamage = () => false;
  const tgt = new Aircraft(scene, { team: 'enemy', position: V(0, 3000, 0), heading: 0 });
  tgt.applyDamage = () => false; tgt.handling.pitch = cfg.tgtPitch ?? 0.8; tgt.handling.roll = 0.85;
  scn.setup(shooter, tgt, rnd);
  shooter.getForward(V(0, 0, 0)); shooter.velocity.copy(shooter.getForward(V())).multiplyScalar(shooter.speed);
  tgt.velocity.copy(tgt.getForward(V())).multiplyScalar(tgt.speed);
  const brk = scn.win ? scn.win[0] + rnd() * (scn.win[1] - scn.win[0]) : 0;
  const m = w.fireMissile(shooter, tgt);
  if (m && cfg.scale) m.turnScale = cfg.scale;
  const dt = 1 / 60;
  let t = 0, breakAt = -1;
  while (t < 8 && m && m.alive && !hit) {
    // target behaviour
    const toM = V().subVectors(m.position, tgt.position); const dist = toM.length();
    const closing = Math.max(1, -V().subVectors(m.velocity, tgt.velocity).dot(toM.clone().normalize()));
    const tti = dist / closing;
    let ctl = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 };
    if (scn.maneuver && tti < brk) {
      if (breakAt < 0) breakAt = t;
      // break: roll so the missile is on the beam (perpendicular), then max pull
      const local = toM.clone().applyQuaternion(tgt.quaternion.clone().invert()).normalize();
      const rollErr = Math.atan2(local.x, local.y) + (scn.into ? 0 : Math.PI / 2);
      ctl = { pitch: 1, roll: THREE.MathUtils.clamp(Math.sin(rollErr) * 2.5, -1, 1), yaw: 0, throttleDelta: scn.brake ? -1 : 0 };
    }
    tgt.setControls(ctl); tgt.update(dt); shooter.setControls({ pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 }); shooter.update(dt);
    w.update(dt, [shooter, tgt], null);
    t += dt;
  }
  shooter.dispose(); tgt.dispose(); w.dispose();
  return hit;
}
let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const yawQ = (deg) => new THREE.Quaternion().setFromAxisAngle(UP, -deg * Math.PI / 180);
const tailSetup = (s, t, r) => { t.position.set((r() - 0.5) * 200, 3000 + (r() - 0.5) * 200, -1400 - r() * 900); t.speed = 190 + r() * 40; };
const headSetup = (s, t, r) => { t.position.set((r() - 0.5) * 200, 3000, -2400 - r() * 600); t.quaternion.copy(yawQ(180)); t.speed = 200; };
const SC = {
  tailStraight: { setup: tailSetup, maneuver: false },
  tailEarly:    { setup: tailSetup, maneuver: true, win: [1.6, 2.2] },
  tailMid:      { setup: tailSetup, maneuver: true, win: [0.8, 1.4] },
  tailLate:     { setup: tailSetup, maneuver: true, win: [0.3, 0.7] },
  headIntoMid:  { setup: headSetup, maneuver: true, win: [0.8, 1.4], into: true },
  off25cross:   { setup: (s, t, r) => { const a = (22 + r() * 6) * Math.PI / 180, d = 1400 + r() * 400; t.position.set(Math.sin(a) * d, 3000, -Math.cos(a) * d); t.quaternion.copy(yawQ(90)); t.speed = 220; }, maneuver: false },
  off25brkMid:  { setup: (s, t, r) => { const a = (22 + r() * 6) * Math.PI / 180, d = 1400 + r() * 400; t.position.set(Math.sin(a) * d, 3000, -Math.cos(a) * d); t.quaternion.copy(yawQ(90)); t.speed = 220; }, maneuver: true, win: [0.8, 1.4] },
};
const reach = { life: 8.5, vmax: 760, boostT: 2.6 };
const cfgs = {
  D:  { boost: 2.4, coast: 1.3, seeker: 60, fuse: 11, lag: 0.18, blind: 90, ...reach },
  D2: { boost: 2.4, coast: 1.3, seeker: 60, fuse: 11, lag: 0.16, blind: 70, ...reach },
  D3: { boost: 2.6, coast: 1.4, seeker: 60, fuse: 12, lag: 0.17, blind: 80, ...reach },
};
const N = Number(E.N || 24);
for (const [cn, cfg] of Object.entries(cfgs)) {
  const row = [];
  for (const [sn, scn] of Object.entries(SC)) { let h = 0; for (let i = 0; i < N; i++) if (trial(scn, cfg, rnd)) h++; row.push(`${sn} ${Math.round(100 * h / N)}%`); }
  console.log(cn.padEnd(10), '| player missile vs enemy jet |', row.join('  '));
  // enemy missiles at the player's agility (enemy turn scale), the cases a human uses to dodge
  const cfgE = { ...cfg, scale: Number(E.ENEMY_SCALE || 0.6), tgtPitch: 1, shooterTeam: 'enemy' };
  const rowE = [];
  for (const sn of ['tailStraight', 'tailEarly', 'tailMid', 'tailLate', 'headIntoMid']) { let h = 0; for (let i = 0; i < N; i++) if (trial(SC[sn], cfgE, rnd)) h++; rowE.push(`${sn} ${Math.round(100 * h / N)}%`); }
  console.log(''.padEnd(10), '| enemy missile vs player    |', rowE.join('  '));
}
