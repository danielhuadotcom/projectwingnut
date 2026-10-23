// Headless gameplay simulation: real Aircraft, EnemyBrain, Weapons and World terrain, no rendering.
// The player is flown by an EnemyBrain too (a stand-in for a competent human), to measure engagement pacing.
import * as THREE from 'three';
globalThis.window = globalThis; globalThis.document = { createElement: () => ({ getContext: () => null, style: {} }) };
const { World, WORLD_HALF } = await import('../js/world.js');
const { Aircraft, FLIGHT } = await import('../js/aircraft.js');
const { Weapons } = await import('../js/weapons.js');
const { EnemyBrain } = await import('../js/ai.js');
const scene = new THREE.Scene();
let world;
try { world = new World(scene, { capabilities: {}, getContext: () => null }); console.log('real World terrain, gen ms', world.generationTime?.toFixed?.(0)); }
catch (e) { console.log('World failed headless (' + e.message.slice(0, 80) + '), using flat fake'); world = { getHeight: () => 0, sunDirection: new THREE.Vector3(0.3, 0.4, -0.8).normalize(), cloudDensityAt: () => 0 }; }
const stats = { gunHitsOnPlayer: 0, missileHitsOnPlayer: 0, gunHitsByPlayer: 0, missileHitsByPlayer: 0, playerKills: 0, enemyCrashes: 0, enemyLaunches: 0, playerLaunches: 0, playerDeaths: 0, firstKillT: null, deathT: [] };
let player;
const weapons = new Weapons(scene, world, {
  onHit: (t, d, s, kind) => { if (t === player) stats[kind === 'gun' ? 'gunHitsOnPlayer' : 'missileHitsOnPlayer']++; else if (s === player) stats[kind === 'gun' ? 'gunHitsByPlayer' : 'missileHitsByPlayer']++; },
  onKill: (t, s) => { t.kill(); if (t === player) { stats.playerDeaths++; stats.deathT.push(T.toFixed(1)); } else if (s === player) { stats.playerKills++; if (stats.firstKillT === null) stats.firstKillT = T; } },
  onMissileLaunch: (m) => { if (m.owner === player) stats.playerLaunches++; else { stats.enemyLaunches++; m.turnScale = ENEMY_SCALE; } },
});
const E = process.env;
weapons.missileTurnRateBoost = Number(E.MSL_BOOST || 3.2); weapons.missileTurnRateCoast = Number(E.MSL_COAST || 1.6);
if (E.MSL_SEEKER_DEG) weapons.missileSeekerCos = Math.cos(Number(E.MSL_SEEKER_DEG) * Math.PI / 180);
if (E.MSL_FUSE) weapons.missileFuse = Number(E.MSL_FUSE);
const ENEMY_SCALE = Number(E.ENEMY_SCALE || 0.5);
const PLAYER_ARMOR = 0.5;
player = new Aircraft(scene, { team: 'player', position: new THREE.Vector3(0, 800, 0), heading: 0 });
const baseDmg = player.applyDamage.bind(player); player.applyDamage = (a) => baseDmg(a * PLAYER_ARMOR);
player.speed = 230; player.ammo = 2400; player.missiles = 120;
const playerBrain = new EnemyBrain(player, { skill: Number(process.env.PSKILL || 0.75), worldHalf: WORLD_HALF });
playerBrain.pursuitThrottle = 1; playerBrain.missileCooldown = 3;
const enemies = [];
const N = Number(process.env.N || 3), SKILL = Number(process.env.SKILL || 0.45);
for (let i = 0; i < N; i++) {
  const a = (i / N) * Math.PI * 2, d = 4500;
  const pos = new THREE.Vector3(Math.sin(a) * d, 900 + i * 200, -Math.cos(a) * d);
  const e = new Aircraft(scene, { team: 'enemy', position: pos, heading: 0 });
  e.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(pos.x, pos.z));
  e.health = 100; e.speed = 230; e.missiles = 2; e.ammo = 9999;
  e.brain = new EnemyBrain(e, { skill: SKILL, worldHalf: WORLD_HALF }); enemies.push(e);
}
// The player brain targets the nearest enemy: give it a proxy "player" object pointing at that enemy
const all = [player, ...enemies];
let T = 0; const dt = 1 / 60; const DUR = Number(process.env.DUR || 150);
let minAgl = 1e9, nan = false, maxSpeed = 0, minSpeed = 1e9;
for (let step = 0; T < DUR; step++, T += dt) {
  const alive = enemies.filter(e => e.alive);
  if (player.alive && alive.length) {
    alive.sort((a, b) => a.position.distanceToSquared(player.position) - b.position.distanceToSquared(player.position));
    playerBrain.update(dt, alive[0], world, weapons, T);
    if (playerBrain.missileCooldown > 4) playerBrain.missileCooldown = 4;
    player.update(dt);
  }
  for (const e of enemies) if (e.alive) { e.brain.update(dt, player, world, weapons, T); e.update(dt); }
  for (const ac of all) {
    if (!ac.alive) continue;
    const h = Math.max(world.getHeight(ac.position.x, ac.position.z), 0);
    const agl = ac.position.y - h; minAgl = Math.min(minAgl, agl);
    if (!Number.isFinite(ac.position.x + ac.position.y + ac.position.z + ac.speed)) nan = true;
    maxSpeed = Math.max(maxSpeed, ac.speed); minSpeed = Math.min(minSpeed, ac.speed);
    if (agl < 3) { ac.kill(); if (ac === player) { stats.playerDeaths++; stats.deathT.push('crash@' + T.toFixed(1)); } else stats.enemyCrashes++; }
  }
  weapons.update(dt, all, null);
  if (step % (60 * 15) === 0) {
    const ds = alive.map(e => e.position.distanceTo(player.position).toFixed(0)).join(',');
    console.log(`t=${T.toFixed(0).padStart(3)} player hp=${player.health.toFixed(0)} alt=${player.position.y.toFixed(0)} spd=${player.speed.toFixed(0)} | enemies alive=${alive.length} dist=[${ds}] states=[${alive.map(e => e.brain.state).join(',')}]`);
  }
  if (!player.alive || enemies.every(e => !e.alive)) { console.log(`end at t=${T.toFixed(1)}: ${!player.alive ? 'player down' : 'all enemies down'}`); break; }
}
console.log('HITRATE player', stats.playerLaunches ? (stats.missileHitsByPlayer / stats.playerLaunches).toFixed(2) : '-', '(' + stats.missileHitsByPlayer + '/' + stats.playerLaunches + ')', 'enemy', stats.enemyLaunches ? (stats.missileHitsOnPlayer / stats.enemyLaunches).toFixed(2) : '-', '(' + stats.missileHitsOnPlayer + '/' + stats.enemyLaunches + ')');
console.log(JSON.stringify(stats), `minAGL=${minAgl.toFixed(0)} speed=[${minSpeed.toFixed(0)},${maxSpeed.toFixed(0)}] nan=${nan}`);
