// Missile dodge/accuracy harness: scripted geometries, many randomized trials per scenario, hit rates for the game's
// three missile profiles, each applied as the game applies it (js/main.js onMissileLaunch; PLAYER_MISSILE and
// ENEMY_MISSILE_TURN are parsed out of js/main.js, so the numbers are the game's own):
//   A  player-team shots (PLAYER_MISSILE) at a bandit flying straight, a gentle turn (20-45 deg bank, light pull), a
//      scripted break, or flown by the real EnemyBrain (js/ai.js, "AI" rows; skill random in SKILL)
//   B  enemy air launches (the Weapons defaults x ENEMY_MISSILE_TURN) at the player's jet (player handling)
//   C  ground launches (a SAM site: m.groundLaunch, the sam* settings, x ENEMY_MISSILE_TURN) at the player's jet
// The break: bank ~85 deg to a random side and pull full (a level hard turn, the beam for a shot from ahead or below),
// held, begun once the time to impact (range / closing speed) drops under a random value in the scenario's window;
// +flares deploys a burst at the break. vNNN rows: the shooter launches at ~NNN m/s (else 220). Merge rows: the bandit
// 1-2.5 km out, up to 18 deg off the shooter's nose, heading at it +-15 deg.
// usage: node --import ./tools/register.mjs tools/msltest.mjs [filter]       filter: a regexp on scenario names
//   env N (trials per scenario, default 200), SEED, SKILL="lo,hi" (bandit skill range, default 0.45,0.9),
//   W='{"samGMax":300}' (Weapons fields), A / B / C='{"gMax":...}' (per-shot fields merged into that profile),
//   SWEEP=1 (break-time sweep rows for B and C), NOTHREAT=1 (the bandit brain ignores the guns-aspect threat),
//   TRACE=1 (print every trial's flight every 0.1 s: use with N=1), SETTLE=s (AI rows: nose-on time before the launch,
//   default 0.5, the lock time)
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
globalThis.window = globalThis; globalThis.document = { createElement: () => ({ getContext: () => null, style: {} }) };
const { Aircraft } = await import('../js/aircraft.js');
const { Weapons } = await import('../js/weapons.js');
const { EnemyBrain } = await import('../js/ai.js');
const E = process.env;
const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const PLAYER_MISSILE = Function('return ' + src.match(/const PLAYER_MISSILE = (\{[^}]*\})/)[1])();
const ENEMY_MISSILE_TURN = Number(src.match(/const ENEMY_MISSILE_TURN = ([\d.]+)/)[1]);
const json = (s) => (s ? JSON.parse(s) : {});
const WO = json(E.W), PO = { A: { ...PLAYER_MISSILE, ...json(E.A) }, B: json(E.B), C: json(E.C) };
const [SK0, SK1] = (E.SKILL || '0.45,0.9').split(',').map(Number);
const world = { getHeight: () => -100, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(), cloudDensityAt: () => 0 };
const scene = new THREE.Scene();
const V = (x, y, z) => new THREE.Vector3(x, y, z), UP = V(0, 1, 0);
const _a = V(), _b = V(), _c = V();
const yawQ = (deg) => new THREE.Quaternion().setFromAxisAngle(UP, -deg * Math.PI / 180);   // heading deg (0 = -Z)
const headingTo = (from, to) => Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI;

// as js/main.js onMissileLaunch: player-team shots take PLAYER_MISSILE, everyone else's turnScale ENEMY_MISSILE_TURN
function applyProfile(m) {
  if (m.owner && m.owner.team === 'player') Object.assign(m, PO.A);
  else { m.turnScale = ENEMY_MISSILE_TURN; Object.assign(m, m.groundLaunch ? PO.C : PO.B); }
}

let stats = null;
function trial(scn, rnd) {
  let hit = false;
  const w = new Weapons(scene, world, { onHit: (t) => { if (t === tgt) hit = true; }, onMissileLaunch: applyProfile });
  Object.assign(w, WO);
  const P = scn.p;   // profile
  let shooter;
  if (P === 'C') shooter = { isGround: true, team: 'enemy', alive: true, position: V(0, 5, 0), velocity: V(), quaternion: new THREE.Quaternion(), hitRadius: 4 };
  else { shooter = new Aircraft(scene, { team: P === 'A' ? 'player' : 'enemy', position: V(0, 3000, 0), heading: 0 }); shooter.speed = 220; shooter.applyDamage = () => false; }
  const tgt = scn.groundTgt ? { isGround: true, team: 'enemy', alive: true, position: V(), velocity: V(), quaternion: new THREE.Quaternion(), hitRadius: 6, fuseRadius: 5, update() {}, dispose() {} }
    : new Aircraft(scene, { team: P === 'A' ? 'enemy' : 'player', position: V(0, 3000, 0), heading: 0 });
  tgt.applyDamage = () => false;
  scn.setup(shooter, tgt, rnd);
  if (scn.vs && shooter.getForward) shooter.speed = scn.vs[0] + rnd() * (scn.vs[1] - scn.vs[0]);
  if (shooter.getForward) shooter.velocity.copy(shooter.getForward(V())).multiplyScalar(shooter.speed);
  if (!scn.groundTgt) tgt.velocity.copy(tgt.getForward(V())).multiplyScalar(tgt.speed);
  let brain = null;
  if (scn.ai) {
    brain = new EnemyBrain(tgt, { skill: SK0 + rnd() * (SK1 - SK0), worldHalf: 1e6 });
    brain.state = 'pursue'; brain.missileCooldown = 1e9; brain.altGame = false; tgt.holdFire = true;
    if (E.NOTHREAT) brain._threatFrom = () => false;
  }
  const brk = scn.win ? scn.win[0] + rnd() * (scn.win[1] - scn.win[0]) : -1;
  const side = rnd() < 0.5 ? -1 : 1;
  const gBank = 0.35 + rnd() * 0.45, gPull = 0.1 + rnd() * 0.25, gStart = rnd() * 1.2;   // gentle turn: bank 20-45 deg, light pull
  // AI rows: the shooter holds its nose on the bandit for the lock time (0.5 s, js/main.js LOCK_TIME) before the launch,
  // so the bandit's brain has seen the threat for that long
  if (brain) for (let k = 0, n = Math.round(Number(E.SETTLE ?? 0.5) * 60); k < n; k++) {
    brain.update(1 / 60, shooter, world, w, -1); tgt.update(1 / 60);
    if (shooter.update) { shooter.setControls(scn.vs && scn.vs[0] > 300 ? { pitch: 0, roll: 0, yaw: 0, throttleDelta: 1 } : { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 }); shooter.update(1 / 60); }
    if (shooter.quaternion && shooter.getForward) { shooter.quaternion.setFromUnitVectors(V(0, 0, -1), V().subVectors(tgt.position, shooter.position).normalize()); shooter.velocity.copy(shooter.getForward(V())).multiplyScalar(shooter.speed); }
  }
  const m = w.fireMissile(shooter, tgt);
  if (!m) throw new Error('no launch');
  const dt = 1 / 60, list = P === 'C' ? [tgt] : [shooter, tgt];
  let t = 0, broke = false, minD = Infinity;
  const hold = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 1 }, turnCtl = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 }, zero = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 };
  while (t < 12 && m.alive && !hit) {
    _a.subVectors(m.position, tgt.position); const dist = _a.length();
    if (dist < minD) minD = dist;
    const closing = Math.max(1, -_b.subVectors(m.velocity, tgt.velocity).dot(_a) / Math.max(dist, 1));
    const tti = dist / closing;
    if (E.TRACE && Math.round(t * 60) % 6 === 0) console.log(`t ${t.toFixed(2)} d ${dist.toFixed(0)} tti ${tti.toFixed(2)} msp ${m.speed.toFixed(0)} trk ${!!m.target} broke ${broke} mpos ${m.position.toArray().map((v) => v.toFixed(0))} tpos ${tgt.position.toArray().map((v) => v.toFixed(0))} tgtFwdY ${tgt.getForward ? tgt.getForward(_c).y.toFixed(2) : ''}`);
    if (brain) brain.update(dt, shooter, world, w, t);
    else {
      if (brk >= 0 && !broke && tti < brk && m.age > 0.3) { broke = true; if (scn.flares) w.deployFlares(tgt); }
      if (broke) {
        // level hard turn: bank ~85 deg to `side`, pull full once the bank is close
        tgt.getRight(_b); tgt.getUp(_c);
        const bank = Math.atan2(-_b.y, _c.y), err = side * 1.48 - bank;
        turnCtl.roll = THREE.MathUtils.clamp(err * 3, -1, 1);
        turnCtl.pitch = Math.abs(err) < 0.5 ? 1 : 0.4;
        tgt.setControls(turnCtl);
      } else if (scn.turn && t >= gStart) {   // gentle turn: hold 20-45 deg of bank with a light pull
        tgt.getRight(_b); tgt.getUp(_c);
        const bank = Math.atan2(-_b.y, _c.y), err = side * gBank - bank;
        turnCtl.roll = THREE.MathUtils.clamp(err * 3, -1, 1); turnCtl.pitch = gPull;
        tgt.setControls(turnCtl);
      } else if (!scn.groundTgt) tgt.setControls(zero);
    }
    tgt.update(dt);
    if (shooter.update) { shooter.setControls(scn.vs && scn.vs[0] > 300 ? hold : zero); shooter.update(dt); }
    w.update(dt, list, null);
    t += dt;
  }
  stats.minD.push(hit ? 0 : minD);
  if (shooter.dispose) shooter.dispose(); tgt.dispose(); w.dispose();
  return hit;
}

// ---- geometries ------------------------------------------------------------------------------------------------
// C: SAM at the origin; target at 800-2500 m, launched at slant range 3.0-3.9 km (SAM range 4 km)
const samSetup = (aspect, s0 = 3000, s1 = 3900, a0 = 800, a1 = 2500) => (s, t, r) => {
  const alt = a0 + r() * (a1 - a0), slant = s0 + r() * (s1 - s0), hd = Math.sqrt(Math.max(1, slant * slant - alt * alt)), az = r() * Math.PI * 2;
  t.position.set(Math.sin(az) * hd, alt, -Math.cos(az) * hd);
  const toSam = headingTo(t.position, V(0, 0, 0));
  const off = aspect === 'head' ? (r() - 0.5) * 20 : aspect === 'cross' ? 90 * (r() < 0.5 ? -1 : 1) : 180 + (r() - 0.5) * 20;
  if (aspect === 'tail') { const k = 2400 / slant; t.position.x *= k; t.position.z *= k; }   // flying away: launched closer
  t.quaternion.copy(yawQ(toSam + off)); t.speed = 200 + r() * 100;
};
// A / B air: shooter at the origin heading -Z at 220 m/s
const airHead = (lo, hi) => (s, t, r) => { const d = lo + r() * (hi - lo); t.position.set((r() - 0.5) * 150, 3000 + (r() - 0.5) * 150, -d); t.quaternion.copy(yawQ(180 + (r() - 0.5) * 10)); t.speed = 200 + r() * 40; };
const airTail = (lo, hi) => (s, t, r) => { const d = lo + r() * (hi - lo); t.position.set((r() - 0.5) * 150, 3000 + (r() - 0.5) * 150, -d); t.quaternion.copy(yawQ((r() - 0.5) * 20)); t.speed = 190 + r() * 40; };
// merge: the bandit up to 18 deg off the shooter's nose (inside the 22.5 deg lock cone), heading at the shooter +-15 deg
const airMerge = (lo, hi) => (s, t, r) => {
  const d = lo + r() * (hi - lo), th = r() * 18 * Math.PI / 180, ph = r() * Math.PI * 2;
  t.position.set(Math.sin(th) * Math.cos(ph) * d, 3000 + Math.sin(th) * Math.sin(ph) * d, -Math.cos(th) * d);
  t.quaternion.copy(yawQ(headingTo(t.position, s.position) + (r() - 0.5) * 30)); t.speed = 200 + r() * 40;
};
// ground target (A only): a stationary unit 1.2-2.6 km ahead, the shooter at 500-1200 m pointed at it
const groundSetup = (s, t, r) => {
  const d = 1200 + r() * 1400, alt = 500 + r() * 700; t.position.set((r() - 0.5) * 100, 0, -d); s.position.set(0, alt, 0);
  s.quaternion.setFromUnitVectors(V(0, 0, -1), V().subVectors(t.position, s.position).normalize());
};
const airCross = (s, t, r) => { const a = (22 + r() * 6) * Math.PI / 180, d = 1400 + r() * 400; t.position.set(Math.sin(a) * d, 3000, -Math.cos(a) * d); t.quaternion.copy(yawQ(90)); t.speed = 220; };

const GOOD = [0.8, 1.2], EARLY = [2.6, 3.2], LATE = [0.15, 0.3];
const SC = {
  // ---- C: ground launches at the player
  'C head none':          { p: 'C', setup: samSetup('head') },
  'C head brk good':      { p: 'C', setup: samSetup('head'), win: GOOD },
  'C head brk early':     { p: 'C', setup: samSetup('head'), win: EARLY },
  'C head brk late':      { p: 'C', setup: samSetup('head'), win: LATE },
  'C head brk+flares':    { p: 'C', setup: samSetup('head'), win: GOOD, flares: true },
  'C head 1.5-2.5k alt':  { p: 'C', setup: samSetup('head', 3000, 3900, 1500, 2500), win: GOOD },
  'C head 0.8-1.5k alt':  { p: 'C', setup: samSetup('head', 3000, 3900, 800, 1500), win: GOOD },
  'C close none':         { p: 'C', setup: samSetup('head', 1500, 2500, 300, 1500) },
  'C close brk good':     { p: 'C', setup: samSetup('head', 1500, 2500, 300, 1500), win: GOOD },
  'C close brk late':     { p: 'C', setup: samSetup('head', 1500, 2500, 300, 1500), win: LATE },
  'C low brk good':       { p: 'C', setup: samSetup('head', 3000, 3900, 200, 600), win: GOOD },
  'C cross none':         { p: 'C', setup: samSetup('cross') },
  'C cross brk good':     { p: 'C', setup: samSetup('cross'), win: GOOD },
  'C tail none':          { p: 'C', setup: samSetup('tail') },
  'C tail brk good':      { p: 'C', setup: samSetup('tail'), win: GOOD },
  // ---- A: the player's missiles at a bandit
  'A merge straight':     { p: 'A', setup: airMerge(1000, 2500) },
  'A merge gentle':       { p: 'A', setup: airMerge(1000, 2500), turn: true },
  'A merge AI':           { p: 'A', setup: airMerge(1000, 2500), ai: true },
  'A merge brk good':     { p: 'A', setup: airMerge(1000, 2500), win: GOOD },
  'A merge str v250':     { p: 'A', setup: airMerge(1000, 2500), vs: [240, 260] },
  'A merge str v330':     { p: 'A', setup: airMerge(1000, 2500), vs: [320, 340] },
  'A merge str v420':     { p: 'A', setup: airMerge(1000, 2500), vs: [410, 430] },
  'A tail clean':         { p: 'A', setup: airTail(800, 2800) },
  'A tail clean v250':    { p: 'A', setup: airTail(800, 2800), vs: [240, 260] },
  'A tail clean v330':    { p: 'A', setup: airTail(800, 2800), vs: [320, 340] },
  'A tail clean v420':    { p: 'A', setup: airTail(800, 2800), vs: [410, 430] },
  'A ground target':      { p: 'A', setup: groundSetup, groundTgt: true },
  'A merge gentle v250':  { p: 'A', setup: airMerge(1000, 2500), turn: true, vs: [240, 260] },
  'A merge gentle v420':  { p: 'A', setup: airMerge(1000, 2500), turn: true, vs: [410, 430] },
  'A merge AI v250':      { p: 'A', setup: airMerge(1000, 2500), ai: true, vs: [240, 260] },
  'A merge AI v420':      { p: 'A', setup: airMerge(1000, 2500), ai: true, vs: [410, 430] },
  'A merge 1-1.5k str':   { p: 'A', setup: airMerge(1000, 1500) },
  'A merge 1-1.5k AI':    { p: 'A', setup: airMerge(1000, 1500), ai: true },
  'A merge 2-2.5k AI':    { p: 'A', setup: airMerge(2000, 2500), ai: true },
  'A head 1-2.5k AI':     { p: 'A', setup: airHead(1000, 2500), ai: true },
  'A head 1-1.5k AI':     { p: 'A', setup: airHead(1000, 1500), ai: true },
  'A head 1.5-2k AI':     { p: 'A', setup: airHead(1500, 2000), ai: true },
  'A head 2-2.5k AI':     { p: 'A', setup: airHead(2000, 2500), ai: true },
  'A head 1-2.5k none':   { p: 'A', setup: airHead(1000, 2500) },
  'A head brk good':      { p: 'A', setup: airHead(1000, 2500), win: GOOD },
  'A tail 0.6-1.5k AI':   { p: 'A', setup: airTail(600, 1500), ai: true },
  'A tail 1.5-2.5k AI':   { p: 'A', setup: airTail(1500, 2500), ai: true },
  'A tail none':          { p: 'A', setup: airTail(1400, 2300) },
  'A tail gentle turn':   { p: 'A', setup: airTail(1400, 2300), turn: true },
  'A cross25 none':       { p: 'A', setup: airCross },
  'A cross25 brk good':   { p: 'A', setup: airCross, win: GOOD },
  // ---- B: enemy air launches at the player
  'B merge straight':     { p: 'B', setup: airMerge(1000, 2500) },
  'B merge gentle':       { p: 'B', setup: airMerge(1000, 2500), turn: true },
  'B merge brk good':     { p: 'B', setup: airMerge(1000, 2500), win: GOOD },
  'B merge str v250':     { p: 'B', setup: airMerge(1000, 2500), vs: [240, 260] },
  'B merge str v420':     { p: 'B', setup: airMerge(1000, 2500), vs: [410, 430] },
  'B head none':          { p: 'B', setup: airHead(1500, 2500) },
  'B head brk good':      { p: 'B', setup: airHead(1500, 2500), win: GOOD },
  'B head brk early':     { p: 'B', setup: airHead(1500, 2500), win: EARLY },
  'B head brk late':      { p: 'B', setup: airHead(1500, 2500), win: LATE },
  'B tail none':          { p: 'B', setup: airTail(1200, 2000) },
  'B tail brk good':      { p: 'B', setup: airTail(1200, 2000), win: GOOD },
};
if (E.SWEEP) for (const p of ['C', 'B']) for (const b of [0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 2.0, 2.5]) {
  SC[`${p} head sweep ${b.toFixed(1)}`] = { p, setup: p === 'C' ? samSetup('head') : airHead(1500, 2500), win: [b - 0.05, b + 0.05] };
}
const N = Number(E.N || 200), filt = process.argv[2] ? new RegExp(process.argv[2]) : null;
let seed = Number(E.SEED || 12345); const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
console.log(`A ${JSON.stringify(PO.A)}  B ${JSON.stringify(PO.B)}  C ${JSON.stringify(PO.C)}  W ${JSON.stringify(WO)}  enemy turnScale ${ENEMY_MISSILE_TURN}  N ${N}`);
for (const [sn, scn] of Object.entries(SC)) {
  if (filt && !filt.test(sn)) continue;
  stats = { minD: [] }; let h = 0;
  for (let i = 0; i < N; i++) if (trial(scn, rnd)) h++;
  const md = stats.minD.filter((d) => d > 0).sort((a, b) => a - b);
  console.log(`${sn.padEnd(22)} hit ${String(Math.round(100 * h / N)).padStart(3)}%   (misses: median miss distance ${md.length ? md[md.length >> 1].toFixed(0) : '-'} m)`);
}
