#!/usr/bin/env node
// Prints the INFINITY rounds that js/infinity.js generates, so the ramp and the ammo rule can be reviewed.
// usage: node tools/infinity_rounds.mjs [--rounds 1-30] [--seed 1] [--points] [--json] [--check]
//   --rounds A-B  rounds to print (default 1-30)      --seed N  run seed (default 1; the same seed gives the same run)
//   --points      also print the unit points table     --json    the rounds as JSON instead of the table
//   --check       verify the invariants (ammo cap, unit caps, bounty, ramp end points, determinism, local-best storage
//                 with and without a working localStorage) over many seeds and rounds; exits 1 on a failure
// The numbers come from the game itself: FLIGHT.MAX_MISSILES (js/aircraft.js), the missileDamage of a fresh Weapons
// (js/weapons.js), and the DIFFICULTY table parsed out of js/main.js. It also checks that js/main.js still sets hit points
// the way js/infinity.js assumes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
// The game modules import Three.js from the CDN; map that URL to the local npm package (as tools/cdn-loader.mjs does)
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/';
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve: (spec, ctx, next) => next(spec.startsWith(CDN) ? 'three' : spec, ctx) });
} else nodeModule.register('./cdn-loader.mjs', import.meta.url);

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const [r0, r1] = String(opt('--rounds', '1-30')).split('-').map((v) => Math.max(1, Number(v) || 1));
const runSeed = Number(opt('--seed', '1')) >>> 0;

const I = await import('../js/infinity.js');
const { FLIGHT } = await import('../js/aircraft.js');
const THREE = await import('three');
const { Weapons } = await import('../js/weapons.js');
const missileLoad = FLIGHT.MAX_MISSILES;
const missileDamage = new Weapons(new THREE.Scene(), { getHeight: () => 0 }, {}).missileDamage;

// DIFFICULTY from js/main.js: the object literal after `const DIFFICULTY =`, evaluated on its own
const mainSrc = readFileSync(root + 'js/main.js', 'utf8');
function difficultyTable(src) {
  const at = src.indexOf('const DIFFICULTY = {');
  if (at < 0) throw new Error('js/main.js: const DIFFICULTY not found');
  const a = src.indexOf('{', at);
  let depth = 0, b = a;
  for (; b < src.length; b++) { if (src[b] === '{') depth++; else if (src[b] === '}' && --depth === 0) break; }
  return Function(`"use strict"; return (${src.slice(a, b + 1)});`)();
}
const DIFFICULTY = difficultyTable(mainSrc);
const rules = [
  ['aircraft hp x2 (bosses x1) x enemyHp', /\(type\.hp \|\| 35\) \* \(type\.bars \? 1 : 2(\.0)?\) \* \(\(this\.diff && this\.diff\.enemyHp\) \|\| 1\)/],
  ['surface hp x enemyHp', /Math\.round\(def\.hp \* hm\)/],
  ['skill = clamp(0.38 + 0.06 x mission + ..., 0.2, 0.95)', /0\.38 \+ this\.missionIndex \* 0\.06[^;]*0\.2, 0\.95\)/],
].map(([name, re]) => [name, re.test(mainSrc)]);

const runOpts = { difficulty: DIFFICULTY, missileLoad, missileDamage, seed: runSeed };
const fmt = (v, d = 2) => (v === Infinity ? '∞' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));
const pct = (v) => `${Math.round(v * 100)}%`;
const SHORT = { aggressors: 'atk', playerShare: 'share', flightCap: 'flt', stagger: 'stag', playerMissiles: 'pmsl', armor: 'armor' };
const LEVELS = ['easy', 'normal', 'hard', 'mercenary'];
const numeric = Object.keys(DIFFICULTY.normal).filter((k) => typeof DIFFICULTY.easy[k] === 'number');
// fields whose ramp ends on a lower row than Mercenary (js/infinity.js TOPS): { field: row }
const tops = Object.fromEntries(numeric.map((k) => [k, LEVELS.find((l) => I.difficultyAt(DIFFICULTY, 3)[k] === DIFFICULTY[l][k] && DIFFICULTY[l][k] !== DIFFICULTY.mercenary[k])]).filter(([, l]) => l));
const ramped = numeric.filter((k) => k !== 'enemyHp' && k !== 'skill');

function composition(R) {
  const part = (kind) => R.groups.filter((g) => g.kind === kind).map((g) => `${g.bounty ? 'BOUNTY ' : ''}${g.type} x${g.count}`).join(', ') || '-';
  return `${R.mix.padEnd(8)}  air: ${part('air')}  ·  land: ${part('ground')}  ·  sea: ${part('naval')}`;
}

function printTable() {
  console.log(`INFINITY rounds ${r0}-${r1} · run seed ${runSeed}`);
  console.log(`loadout    ${missileLoad} missiles x ${missileDamage} damage (FLIGHT.MAX_MISSILES, js/aircraft.js; Weapons.missileDamage, js/weapons.js)`);
  console.log(`ammo rule  hits x (1 - ${I.SQUAD_SHARE} squadmate share, non-boss air) / ${I.HIT_RATE} hit rate <= ${pct(I.AMMO_SHARE)} of ${missileLoad} = ` +
    `${I.AMMO_SHARE * missileLoad} missiles (bounty rounds ${pct(I.BOUNTY_AMMO_SHARE)} = ${I.BOUNTY_AMMO_SHARE * missileLoad})`);
  console.log(`ramp       smoothstep over js/main.js DIFFICULTY: Easy at round 1, Mercenary from round ${I.MERC_ROUND}; topping out lower: ` +
    (Object.entries(tops).map(([k, l]) => `${k} at ${l[0].toUpperCase() + l.slice(1)} (${fmt(DIFFICULTY[l][k])})`).join(', ') || 'none') +
    `; skill = absolute brain skill (before the fighter bonus)`);
  console.log(`caps       ${I.CAPS.airGroup} per air group, ${I.CAPS.airRound} aircraft per round, ${I.CAPS.surfaceGroup} per surface group · ` +
    `bounty every ${I.BOUNTY_EVERY}th round: ${I.BOUNTIES.join(', ')} · squadmates every round: COTTER #2, RIVET #3`);
  console.log(`main.js    ${rules.map(([n, ok]) => `${n} ${ok ? 'ok' : 'NOT FOUND (re-check js/infinity.js unitHp / rampAt)'}`).join(' · ')}`);
  console.log('');
  const head = ['rnd', 'level', '', 'hp', 'skill', ...ramped.map((k) => SHORT[k] || k)];
  console.log(head[0].padStart(3) + ' ' + head[1].padStart(5) + ' ' + ''.padEnd(9) + head.slice(3).map((h) => h.padStart(Math.max(5, h.length))).join(' ') +
    ' | air gnd nav all | hits  missiles  load | score x');
  for (let r = r0; r <= r1; r++) {
    const R = I.generateRound(r, runOpts), P = R.ramp, d = P.diff;
    const vals = [d.enemyHp, P.enemySkill, ...ramped.map((k) => d[k])];
    const cols = head.slice(3).map((h, i) => fmt(vals[i]).padStart(Math.max(5, h.length))).join(' ');
    const c = R.counts;
    console.log(String(r).padStart(3) + ' ' + P.level.toFixed(2).padStart(5) + ' ' + P.label.padEnd(9) + cols + ' | ' +
      [c.air, c.ground, c.naval, c.total].map((v) => String(v).padStart(3)).join(' ') + ' | ' + String(R.hits).padStart(4) + ' ' +
      R.missiles.toFixed(1).padStart(9) + ' ' + pct(R.ammoShare).padStart(5) + ' | x' + I.roundMultiplier(r).toFixed(1));
    console.log('      ' + composition(R));
  }
}

function printPoints() {
  console.log('\nunit points (before the round multiplier) and missile hits to kill at Easy / Normal / Mercenary HP');
  const row = (label, kind, type) => `${label.padEnd(6)} ${type.padEnd(16)} ${String(I.unitPoints(kind, type)).padStart(5)}   hits ` +
    [DIFFICULTY.easy, DIFFICULTY.normal, DIFFICULTY.mercenary].map((d) => I.hitsToKill(kind, type, d.enemyHp, missileDamage)).join(' / ');
  for (const [kind, type] of I.poolTypes()) console.log(row(kind, kind, type));
  for (const b of I.BOUNTIES) console.log(row('bounty', 'air', b));
}

// ---- --check -------------------------------------------------------------------------------------------------------
function check() {
  let n = 0, fails = 0;
  const ok = (cond, what) => { n++; if (!cond) { fails++; if (fails <= 30) console.log('CHECK FAIL ' + what); } };
  const known = new Set(I.poolTypes().map(([k, t]) => k + '|' + t));
  for (let seed = 1; seed <= 40; seed++) {
    for (let r = 1; r <= 120; r++) {
      const R = I.generateRound(r, { ...runOpts, seed });
      const tag = `seed ${seed} round ${r}`;
      ok(R.missiles <= R.capMissiles + 1e-9, `${tag}: ${R.missiles.toFixed(1)} missiles over the cap ${R.capMissiles}`);
      ok(R.capMissiles === (r % I.BOUNTY_EVERY === 0 ? I.BOUNTY_AMMO_SHARE : I.AMMO_SHARE) * missileLoad, `${tag}: cap`);
      ok(R.counts.air >= 2 && R.counts.ground >= 1 && R.counts.naval >= 1, `${tag}: needs air, land and sea targets ${JSON.stringify(R.counts)}`);
      ok(R.counts.air <= I.CAPS.airRound, `${tag}: ${R.counts.air} aircraft`);
      ok((R.bounty !== null) === (r % I.BOUNTY_EVERY === 0), `${tag}: bounty ${R.bounty}`);
      const types = new Set();
      for (const g of R.groups) {
        ok(Number.isInteger(g.count) && g.count >= 1, `${tag}: ${g.type} count ${g.count}`);
        ok(g.count <= (g.kind === 'air' ? I.CAPS.airGroup : I.CAPS.surfaceGroup), `${tag}: ${g.type} x${g.count} over the group cap`);
        ok(g.type !== 'Q12 MAINSPRING', `${tag}: Mainspring`);
        ok(g.bounty ? I.BOUNTIES.includes(g.type) : known.has(g.kind + '|' + g.type), `${tag}: ${g.kind} ${g.type} not in the pools`);
        ok(!types.has(g.kind + '|' + g.type), `${tag}: two ${g.type} groups`);
        types.add(g.kind + '|' + g.type);
        ok(g.kind === 'air' ? !!(g.formation && g.position && g.distance) : !!(g.area && g.position && g.distance), `${tag}: ${g.type} placement fields`);
      }
      if (seed === 1 && r <= 30) ok(JSON.stringify(R) === JSON.stringify(I.generateRound(r, { ...runOpts, seed })), `${tag}: not deterministic`);
    }
  }
  // ramp end points: Easy row in round 1, Mercenary (or the field's top row) from MERC_ROUND on, groups empty
  const first = I.rampAt(1, DIFFICULTY).diff, top = I.rampAt(I.MERC_ROUND, DIFFICULTY).diff, late = I.rampAt(500, DIFFICULTY).diff;
  for (const k of Object.keys(DIFFICULTY.easy)) {
    if (k === 'groups') { ok(first.groups.length === 0 && late.groups.length === 0, 'ramp: generated rounds have no difficulty groups'); continue; }
    const end = DIFFICULTY[tops[k] || 'mercenary'][k];
    ok(first[k] === DIFFICULTY.easy[k], `ramp: ${k} starts at Easy (${first[k]} vs ${DIFFICULTY.easy[k]})`);
    ok(top[k] === end && late[k] === end, `ramp: ${k} reaches ${tops[k] || 'mercenary'} (${top[k]} vs ${end})`);
  }
  ok(tops.armor === 'hard' && Object.keys(tops).length === 1, `ramp: only armor tops out at Hard ${JSON.stringify(tops)}`);
  ok(!('missileTurn' in DIFFICULTY.normal), 'ramp: missiles fly the same on every difficulty (no missileTurn field)');
  for (let r = 2; r <= 40; r++) {
    const a = I.rampAt(r - 1, DIFFICULTY).diff, b = I.rampAt(r, DIFFICULTY).diff;
    ok(b.armor >= a.armor && b.enemyHp >= a.enemyHp, `ramp: armor / enemyHp fall at round ${r}`);
  }
  ok(I.rampAt(1, DIFFICULTY).enemySkill === Math.max(0.2, 0.38 + DIFFICULTY.easy.skill), 'ramp: skill starts at the campaign opener on Easy');
  ok(Math.abs(I.rampAt(I.MERC_ROUND, DIFFICULTY).enemySkill - 0.95) < 1e-9, 'ramp: skill reaches the 0.95 ceiling');
  for (let r = 2; r <= 40; r++) ok(I.rampProgress(r) >= I.rampProgress(r - 1), `ramp: progress falls at round ${r}`);
  // points
  for (const [kind, type] of I.poolTypes()) ok(I.unitPoints(kind, type) >= 50 && I.killPoints(kind, type, 30) > I.killPoints(kind, type, 1), `points: ${type}`);
  ok(I.roundMultiplier(1) === 1 && Math.abs(I.roundMultiplier(11) - 2) < 1e-9, 'points: round multiplier');
  ok(I.hitsToKill('ground', 'aa', 1.3, missileDamage) === Math.ceil(Math.round(50 * 1.3) / missileDamage), 'hits: AA gun at Mercenary');
  // local best: no storage (node), storage that throws, working storage
  const run = new I.InfinityRun({ difficulty: DIFFICULTY, missileLoad, missileDamage, seed: 7 });
  ok(I.loadBest() === null, 'best: empty without storage');
  run.nextRound(); run.recordKill('air', 'NV-15C'); run.recordKill('ground', 'aa'); run.clearRound(); run.nextRound();
  ok(run.score === I.killPoints('air', 'NV-15C', 1) + I.killPoints('ground', 'aa', 1) && run.kills === 2 && run.roundsCleared === 1, 'run: score, kills, rounds');
  ok(run.repairedHealth(50) === 85 && run.repairedHealth(90) === 100, 'run: hull +35 %, capped');
  const end = run.finish('SHOT DOWN');
  ok(end.newBest && end.saved === false && end.best.score === run.score && I.loadBest().score === run.score, 'best: lasts the session without storage');
  ok(run.finish('again') === end && run.recordKill('air', 'NV-15C') === 0, 'run: finish is final');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  globalThis.localStorage = throwing;
  let threw = false;
  try {
    const r2 = new I.InfinityRun({ difficulty: DIFFICULTY, missileLoad, missileDamage, seed: 8 });
    r2.nextRound(); for (let i = 0; i < 40; i++) r2.recordKill('air', 'Q07');
    const e2 = r2.finish();
    ok(e2.newBest && !e2.saved && I.loadBest().score === r2.score, 'best: storage that throws keeps the session best');
  } catch (e) { threw = true; }
  ok(!threw, 'best: storage that throws never throws');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  threw = false;
  try { I.loadBest(); I.saveBest({ score: 5, rounds: 1, kills: 1 }); } catch { threw = true; }
  ok(!threw, 'best: a localStorage getter that throws never throws');
  const mem = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) } });
  const r3 = new I.InfinityRun({ difficulty: DIFFICULTY, missileLoad, missileDamage, seed: 9 });
  r3.nextRound(); for (let i = 0; i < 80; i++) r3.recordKill('air', 'Q07');
  const e3 = r3.finish();
  ok(e3.newBest && e3.saved && JSON.parse(mem.get(I.BEST_KEY)).score === r3.score && I.loadBest().score === r3.score, 'best: saved to storage');
  mem.set(I.BEST_KEY, '{not json');
  ok(I.loadBest().score === r3.score, 'best: corrupt storage falls back on the session best');
  delete globalThis.localStorage;
  for (const [name, found] of rules) ok(found, `main.js rule: ${name}`);
  console.log(fails ? `CHECK FAIL ${fails}/${n}` : `CHECK OK ${n} assertions (40 seeds x 120 rounds, ramp, points, local best)`);
  return fails === 0;
}

if (args.includes('--check')) process.exit(check() ? 0 : 1);
if (args.includes('--json')) console.log(JSON.stringify(Array.from({ length: r1 - r0 + 1 }, (_, i) => I.generateRound(r0 + i, runOpts)), null, 1));
else { printTable(); if (args.includes('--points')) printPoints(); }
