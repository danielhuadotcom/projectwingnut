// js/infinity.js — INFINITY, Project Wingnut's endless mode: a loose analogue of PW's Conquest mode, grown out of the
// first playable demo (free flight over the islands, waves of jets plus ground and naval targets around the player,
// score). Data and arithmetic only: no Three.js and no DOM (localStorage aside, every access guarded), so node can
// import it too (tools/infinity_rounds.mjs prints the generated rounds for review).
//
// DESIGN
//   Run     Endless rounds over the whole map, flown with the squadmates COTTER #2 and RIVET #3 (js/squad.js, immortal
//           as in the campaign; the bandit director splits bandits between them and the player by the ramped
//           playerShare). Each round mixes jets with ground and naval targets (existing unit types) at randomized
//           spots, placed from a per-round seed. "AREA CLEAR" ends a round; a short intermission rearms fully and patches
//           the hull (+35 % of full, capped), then the next round starts. One life: being shot down ends the run, with no
//           retry. The end screen shows rounds cleared, kills, score and the local best. No map, economy or upgrades.
//   Ramp    A smooth function of the round number: smoothstep from round 1 (Easy) to MERC_ROUND (Mercenary) across the
//           rows of the game's DIFFICULTY table. Every numeric field follows it (enemy HP and skill, attacker caps,
//           committed-flight caps, the enemy missile backstop, playerShare, the flak guns firing at once and their aim
//           error: aaGuns 2 > 4 > 6 > 14, aaError 1.6 > 1.0), then holds; player armor (damage taken) and enemy missile
//           agility follow the same curve but top out at the Hard row (TOPS). Past MERC_ROUND only the target count and
//           the mix keep growing.
//   Bounty  Every 5th round adds one named ace with a boss bar (the types with bars, except Q12 MAINSPRING, which stays
//           the campaign's final boss).
//   Ammo    Killing everything in a round needs at most AMMO_SHARE of the full missile load: per unit, hits-to-kill at
//           the round's HP scaling over a HIT_RATE of 0.6, less the squadmates' ~5 % of non-boss air kills (nothing is
//           added for them). Loadout and damage come from the game (FLIGHT.MAX_MISSILES, Weapons.missileDamage), never
//           from constants here. js/missions.js caps: 8 per air group, 16 aircraft per round, 24 per surface group.
//   Score   Points per kill by unit type (durability and threat), times 1 + 0.1 per round after the first. The local
//           best is kept in localStorage; when storage is blocked the run still plays and the best lasts the session.
//
// Usage (js/main.js):
//   const run = new InfinityRun({ difficulty: DIFFICULTY, missileLoad: FLIGHT.MAX_MISSILES, missileDamage: weapons.missileDamage });
//   const plan = run.nextRound();       // { round, seed, groups (mission format), ramp: { diff, skillBase, ... }, ... }
//   run.recordKill('air', 'NV-62');     // the player's kills: returns the points, adds them to run.score
//   run.clearRound();                   // AREA CLEAR: returns INTERMISSION; hull = run.repairedHealth(hull)
//   const end = run.finish('SHOT DOWN'); // saves a new local best: { round, roundsCleared, kills, score, best, newBest }

import { AIRCRAFT_TYPES, GROUND_TYPES } from './missions.js';

// ---- tuning -------------------------------------------------------------------------------------------------------
export const MERC_ROUND = 18;      // the ramp reaches the Mercenary row here (Normal ~round 8, Hard ~round 12)
export const AMMO_SHARE = 0.275;   // most of the full missile load a round may need (half of the 55 % rule set for the old 120-missile load,
                                    // so the doubled 240-missile load is margin, not bigger rounds)
export const BOUNTY_AMMO_SHARE = 0.3;   // ...and a bounty round, whose ace alone takes a good part of it
export const HIT_RATE = 0.6;       // missiles that hit, of those fired
export const SQUAD_SHARE = 0.05;   // squadmates' share of non-boss air kills (js/squad.js KILL_SHARE), taken off the bill
export const BOUNTY_EVERY = 5;     // a bounty ace joins every 5th round
export const CAPS = Object.freeze({ airGroup: 8, airRound: 16, surfaceGroup: 24 });   // js/missions.js header
export const INTERMISSION = Object.freeze({ seconds: 6, repair: 0.35 });             // pause between rounds; hull +35 %
export const WINGMEN = Object.freeze(['2', '3']);   // squadmates every round: COTTER #2 and RIVET #3 (mission.wingmen)
export const BEST_KEY = 'wingnut.infinity.best';
const LEVELS = ['easy', 'normal', 'hard', 'mercenary'];
// DIFFICULTY fields whose ramp tops out below Mercenary: the damage the player takes and enemy missile agility go from
// Easy in round 1 to Hard at MERC_ROUND (same smooth curve, scaled), then hold. Every other numeric field ends at Mercenary.
const TOPS = { armor: 'hard', missileTurn: 'hard' };
// Brain skill as js/main.js spawnAircraft sets it: clamp(0.38 + 0.06 x mission index + fighter bonus + difficulty skill,
// 0.2, 0.95). Infinity's progress term (skillBase) stands in for 0.38 + 0.06 x mission index: 0.38 at round 1, and at
// MERC_ROUND exactly what brings the Mercenary offset to the 0.95 ceiling.
const SKILL_BASE = 0.38, SKILL_MIN = 0.2, SKILL_MAX = 0.95;
// Targets a round asks for: 6 in round 1, about +1.2 a round early on, still growing but slower later (28 in round 30,
// 34 in round 50), and the ammo budget has the last word
const COUNT_START = 6, COUNT_GROWTH = 34, COUNT_SCALE = 28;
const AIR_BUDGET = [0.45, 0.6];            // share of a round's missile budget its aircraft may use (by the round's mix)
const BOUNTY_POINTS = 2500;                // per boss bar

// ---- unit pools ---------------------------------------------------------------------------------------------------
// [type, first round, pick weight]. Left out: Q12 MAINSPRING and the other bosses (bounty only), the named aces Tick,
// Tock and Chime, cruise missiles (they need an allied fleet to fly at), mission props (cargo crate, moored ships), and
// the battleship, carrier and siege crawler: 9-13 missiles each at Mercenary, more than a round's surface budget allows.
const AIR_POOL = [
  ['SLEET-2', 1, 3], ['NV-48', 1, 3], ['NV-11', 1, 2], ['SCAUP II', 1, 1], ['KD-12U', 1, 1],
  ['GUST-5', 2, 2], ['KD-38H', 2, 1], ['EIDER IV', 3, 2], ['KD-260', 3, 1], ['NV-62', 4, 3],
  ['NV-73', 5, 3], ['HAILSTONE-3', 5, 2], ['NV-56N', 6, 2], ['KD-910', 6, 1], ['FLURRY-4', 7, 2],
  ['SQUALL-7', 8, 2], ['KD-480E', 8, 1], ['FALLWIND-6', 9, 2], ['SQUALL-7T', 11, 2], ['Q07', 13, 2],
  ['Q09', 13, 2], ['NV-73 CUCKOO', 14, 1], ['Q11', 15, 2], ['Q09 SHEARPIN', 17, 1], ['Q10', 18, 1],
];
const GROUND_POOL = [
  ['aa', 1, 3], ['tank', 1, 2], ['truck', 1, 1], ['container', 1, 1], ['artillery', 2, 2], ['radar', 2, 1],
  ['oil tank', 2, 1], ['sam', 3, 3], ['comm tower', 3, 1], ['substation', 3, 1], ['bunker', 4, 1],
  ['gun emplacement', 5, 1], ['hangar', 6, 1], ['refinery', 6, 1], ['c-ram', 7, 2], ['l-sam', 9, 2],
  ['railgun', 12, 1], ['extractor', 16, 1],
];
const NAVAL_POOL = [
  ['boat', 1, 3], ['cargo ship', 2, 1], ['frigate', 3, 2], ['spy ship', 4, 1], ['cruiser', 6, 2],
  ['armed cargo', 7, 1], ['railgun frigate', 10, 2],
];
// Most of one type in a round (the campaign's busiest phases as a guide: up to 13 AA guns or SAMs, 10 C-RAMs, 7 L-SAMs,
// 16 patrol boats; the big structures, warships and support aircraft stay rare)
const TYPE_MAX = {
  aa: 14, sam: 12, 'c-ram': 10, 'l-sam': 6, railgun: 4, extractor: 2, hangar: 3, refinery: 4, 'comm tower': 2, substation: 3,
  radar: 4, boat: 16, cruiser: 4, 'railgun frigate': 4, frigate: 4, 'cargo ship': 3, 'armed cargo': 3, 'spy ship': 2,
  'KD-480E': 2, 'KD-910': 3, 'KD-260': 3, 'KD-12U': 3,
};
const FILLERS = [['aa', 3], ['sam', 3], ['c-ram', 2], ['l-sam', 1]];   // cheap land threats that stand in for costly units
const CONVOY = new Set(['tank', 'truck', 'artillery']);
const JETS = new Set(['interceptor', 'fighter', 'strike', 'multirole', 'attacker', 'prototype']);   // a round leads with these
// The mix of a round: shares of its targets in the air, on land and at sea
const MIXES = [
  { name: 'sweep', air: 0.55, ground: 0.3, naval: 0.15 },
  { name: 'coastal', air: 0.45, ground: 0.2, naval: 0.35 },
  { name: 'strike', air: 0.4, ground: 0.45, naval: 0.15 },
  { name: 'combined', air: 0.5, ground: 0.25, naval: 0.25 },
];
const AIR_SPOTS = ['ahead', 'left', 'right', 'high', 'behind', 'low'], SURFACE_SPOTS = ['ahead', 'left', 'right', 'behind'];

/** Every [kind, type] the rounds draw from (the bounty roster aside), in pool order. */
export function poolTypes() {
  return [...AIR_POOL.map(([t]) => ['air', t]), ...GROUND_POOL.map(([t]) => ['ground', t]), ...NAVAL_POOL.map(([t]) => ['naval', t])]
    .filter(([kind, t]) => typeOf(kind, t));
}
/** The bounty roster: types with a boss bar except the campaign's final boss, weakest first. */
export const BOUNTIES = Object.freeze(Object.keys(AIRCRAFT_TYPES)
  .filter((k) => AIRCRAFT_TYPES[k].bars > 0 && k !== 'Q12 MAINSPRING')
  .sort((a, b) => AIRCRAFT_TYPES[a].hp - AIRCRAFT_TYPES[b].hp));

const typeOf = (kind, type) => (kind === 'air' ? AIRCRAFT_TYPES[type] : GROUND_TYPES[type]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, f) => (f <= 0 ? a : f >= 1 ? b : a + (b - a) * f);
const smoothstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

// ---- seeded randomness --------------------------------------------------------------------------------------------
/** Uniform [0, 1) floats from a 32-bit seed (mulberry32): the same sequence for the same seed. */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Two 32-bit values hashed into one (seeds per run and round). */
function mix32(a, b) {
  let h = Math.imul((a >>> 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ (b >>> 0);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return (h ^ (h >>> 16)) >>> 0;
}
function pickWeighted(list, rand, weight) {
  let sum = 0;
  for (const e of list) sum += weight(e);
  let x = rand() * sum;
  for (const e of list) { x -= weight(e); if (x < 0) return e; }
  return list[list.length - 1];
}
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

// ---- ramp ---------------------------------------------------------------------------------------------------------
/** Ramp progress 0..1 for a round: 0 in round 1, 1 from MERC_ROUND on, smoothstep in between. */
export function rampProgress(round) { return smoothstep((Math.max(1, round) - 1) / (MERC_ROUND - 1)); }

/**
 * One row of a DIFFICULTY-shaped table at a continuous level (0 easy, 1 normal, 2 hard, 3 mercenary). Numbers are
 * interpolated between the two neighbouring rows, rounded when every row holds a whole number; a step up to Infinity
 * (no cap) is approached through twice the largest finite value and becomes Infinity only at the upper row. Other
 * values (lists, flags) come from the row at or below. `tops` scales a field's level so that it reaches the named row
 * instead of Mercenary when `level` reaches 3: { armor: 'hard' } puts armor at Hard for level 3, Normal for level 1.5.
 */
export function difficultyAt(table, level, tops = TOPS) {
  if (!table || !LEVELS.every((l) => table[l] && typeof table[l] === 'object')) {
    throw new TypeError('infinity: DIFFICULTY table needs easy, normal, hard and mercenary rows');
  }
  const keys = new Set(); for (const l of LEVELS) for (const k of Object.keys(table[l])) keys.add(k);
  const out = {};
  for (const k of keys) {
    const top = tops && tops[k] ? LEVELS.indexOf(tops[k]) : 3;
    const L = clamp(level, 0, 3) * (top >= 0 ? top : 3) / 3, i = Math.min(2, Math.floor(L)), f = L - i;
    const vals = LEVELS.map((l) => table[l][k]);
    if (!vals.every((v) => typeof v === 'number' && !Number.isNaN(v))) { out[k] = vals[Math.min(3, Math.floor(L))]; continue; }
    const finite = vals.filter(Number.isFinite), whole = finite.every(Number.isInteger);
    let a = vals[i], b = vals[i + 1], v;
    if (a === Infinity) v = Infinity;
    else if (b === Infinity) v = f >= 1 ? Infinity : lerp(a, Math.max(a + 1, 2 * Math.max(...finite)), f);
    else v = lerp(a, b, f);
    out[k] = whole && Number.isFinite(v) ? Math.round(v) : v;
  }
  return out;
}

/**
 * The ramp for a round. diff: a DIFFICULTY row for the game to use as-is (this.diff), with groups [] (generated rounds
 * have no difficulty-tagged groups). skillBase: the progress term of the brain skill (replaces 0.38 + 0.06 x mission
 * index); enemySkill: skillBase + diff.skill, clamped like spawnAircraft (before the per-type fighter bonus).
 */
export function rampAt(round, table) {
  const t = rampProgress(round), level = 3 * t;
  const diff = difficultyAt(table, level);
  diff.groups = [];
  const top = Number(table.mercenary.skill) || 0;
  const skillBase = lerp(SKILL_BASE, SKILL_MAX - top, t);
  const enemySkill = clamp(skillBase + (Number(diff.skill) || 0), SKILL_MIN, SKILL_MAX);
  const label = level >= 3 ? 'MERCENARY' : LEVELS[Math.floor(level)].toUpperCase() + (level % 1 >= 0.5 ? '+' : '');   // e.g. 'HARD+'
  return { round: Math.max(1, round), t, level, label, diff, skillBase, enemySkill };
}

// ---- hits, cost, points -------------------------------------------------------------------------------------------
/** Spawned hit points, as js/main.js sets them: aircraft hp x2 (bosses, with bars, x1), ground and naval hp, all times
 *  the difficulty's enemyHp, rounded. */
export function unitHp(kind, type, hpMul) {
  const t = typeOf(kind, type);
  if (!t) throw new TypeError(`infinity: unknown ${kind} type ${type}`);
  return kind === 'air' ? Math.round((t.hp || 35) * (t.bars ? 1 : 2) * hpMul) : Math.round(t.hp * hpMul);
}
/** Missile hits to destroy one unit of a type at an HP multiplier. */
export function hitsToKill(kind, type, hpMul, missileDamage) { return Math.max(1, Math.ceil(unitHp(kind, type, hpMul) / missileDamage)); }

/** Base points for destroying one unit (before the round multiplier). Aircraft: 1000 for a standard fighter, scaled by
 *  durability (doubled hp over a fighter's 70), 0.8x gun-only, 0.6x unarmed; Cuckoo Flight is worth double; bosses
 *  2500 per bar. Ground and naval: 300 scaled by hp (over an AA gun's 50) and by the reach of their weapons (up to
 *  1.75x at 8 km). Rounded to 50. */
export function unitPoints(kind, type) {
  const t = typeOf(kind, type);
  if (!t) return 0;
  let p;
  if (kind === 'air') {
    if (t.bars > 0) return BOUNTY_POINTS * t.bars;
    const armed = t.armed === false ? 0.6 : t.armed === 'gun' ? 0.8 : 1;
    p = 1000 * (0.6 + 0.4 * ((t.hp || 35) * 2) / 70) * armed * (type === 'NV-73 CUCKOO' ? 2 : 1);
  } else {
    const threat = t.shoots ? 1 + 0.75 * Math.min(t.range || 0, 8000) / 8000 : 1;
    p = 300 * (0.5 + 0.5 * t.hp / 50) * threat;
  }
  return Math.max(50, Math.round(p / 50) * 50);
}
/** Score multiplier of a round: x1 in round 1, +0.1 a round. */
export function roundMultiplier(round) { return 1 + 0.1 * (Math.max(1, round) - 1); }
/** Points for one kill in a round (rounded to 10). */
export function killPoints(kind, type, round) { return Math.round(unitPoints(kind, type) * roundMultiplier(round) / 10) * 10; }

// ---- round generator ----------------------------------------------------------------------------------------------
/** Targets a round asks for before the ammo budget (the bounty comes on top). */
export function targetCount(round) { return Math.round(COUNT_START + COUNT_GROWTH * (1 - Math.exp(-(Math.max(1, round) - 1) / COUNT_SCALE))); }

/** The mix of a round: round 1 is a fighter sweep (the demo opened with jets); then a seeded order per block of four
 *  rounds that never repeats a mix back to back. */
function mixIndex(round, seed) {
  if (round <= 1) return 0;
  const order = (block) => {
    const r = rng32(mix32(seed ^ 0x5EED, block)), p = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const s = p[i]; p[i] = p[j]; p[j] = s; }
    return p;
  };
  const block = Math.floor((round - 1) / 4), k = (round - 1) % 4, p = order(block);
  const prev = k > 0 ? p[k - 1] : block > 0 ? order(block - 1)[3] : 0;
  return p[k] === prev ? p[(k + 1) % 4] : p[k];
}

/**
 * Generate round `round` of a run. opts: { difficulty (DIFFICULTY table), missileLoad, missileDamage, seed (run) }.
 * Returns { round, seed, mix, ramp, bounty, groups, counts, hits, missiles, ammoShare, capMissiles }: groups are
 * js/missions.js groups ({ kind, type, count, formation | area, position, distance }; the bounty's has bounty: true);
 * hits = missile hits to destroy them all; missiles = what the player fires for that at HIT_RATE with the squadmates'
 * share taken off, never above capMissiles (AMMO_SHARE, or BOUNTY_AMMO_SHARE, of missileLoad). The same run seed and
 * round always give the same round; `seed` is the round's own seed, for placement.
 */
export function generateRound(round, opts) {
  const { difficulty, missileLoad, missileDamage } = opts || {};
  if (!(missileLoad > 0) || !(missileDamage > 0)) throw new TypeError('infinity: missileLoad and missileDamage must come from the game');
  round = Math.max(1, Math.floor(round));
  const runSeed = (opts.seed >>> 0) || 1, seed = mix32(runSeed, round), rand = rng32(seed);
  const ramp = rampAt(round, difficulty), hpMul = ramp.diff.enemyHp;
  const unit = new Map();
  const U = (kind, type) => {                // per unit: hits to kill, and the player's missiles for it
    const key = kind + '|' + type;
    let u = unit.get(key);
    if (!u) {
      const hits = hitsToKill(kind, type, hpMul, missileDamage);
      u = { hits, cost: hits * (kind === 'air' && !(AIRCRAFT_TYPES[type].bars > 0) ? 1 - SQUAD_SHARE : 1) / HIT_RATE };
      unit.set(key, u);
    }
    return u;
  };
  const cost = (list) => list.reduce((s, g) => s + g.count * U(g.kind, g.type).cost, 0);
  const total = (list) => list.reduce((s, g) => s + g.count, 0);
  const afford = (c, budget) => Math.min(1, budget / c);                 // types over the per-unit budget come up less
  const unlocked = (pool, kind) => pool.filter(([type, from]) => from <= round && typeOf(kind, type));
  const fresh = ([, from, w]) => w * (from + 4) / (round + 4);           // the newest types come up most, old ones fade
  const mix = MIXES[mixIndex(round, runSeed)];
  const bountyRound = round % BOUNTY_EVERY === 0 && BOUNTIES.length > 0;
  const capM = (bountyRound ? BOUNTY_AMMO_SHARE : AMMO_SHARE) * missileLoad;

  // Bounty: one boss on top of the round (skipped only if an odd loadout couldn't afford it)
  const groups = [];
  let bounty = null;
  if (bountyRound) {
    const type = BOUNTIES[(round / BOUNTY_EVERY - 1) % BOUNTIES.length];
    if (U('air', type).cost <= 0.6 * capM) {
      bounty = type;
      groups.push({ kind: 'air', type, count: 1, formation: 'pair', position: pick(['ahead', 'left', 'right'], rand), distance: 5000, bounty: true });
    }
  }
  const restM = capM - cost(groups);

  // Counts by the round's mix: at least two aircraft, one land and one sea target
  const N = targetCount(round);
  const nAir = clamp(Math.round(N * mix.air), 2, CAPS.airRound - (bounty ? 1 : 0));
  const nNaval = Math.max(1, Math.round(N * mix.naval)), nGround = Math.max(1, N - nAir - nNaval);

  // Aircraft: one to three groups of distinct types, the first of jets with missiles, at most one heavy group (3+ hits a
  // jet, up to 4 of them) and at most one unarmed support group (up to 3, fading out over the rounds). They keep within
  // their share of the budget: one aircraft at a time comes off the costliest group (ties: the biggest).
  const air = [];
  const airCap = restM * clamp(mix.air + 0.05, AIR_BUDGET[0], AIR_BUDGET[1]);
  {
    const pool = unlocked(AIR_POOL, 'air'), k = nAir <= 4 ? 1 : nAir <= 9 ? 2 : 3, per = airCap / nAir;
    const weight = (e) => fresh(e) * afford(U('air', e[0]).cost, per) * (AIRCRAFT_TYPES[e[0]].armed === false ? clamp(1.2 - round / 25, 0.2, 1) : 1);
    const heavy = (type) => U('air', type).hits >= 3;
    const chosen = [];
    let support = false, heavyIn = false;
    for (let g = 0; g < k; g++) {
      const options = pool.filter(([type]) => !chosen.includes(type) && !(heavyIn && heavy(type))
        && (g > 0 ? AIRCRAFT_TYPES[type].armed !== false || !support : JETS.has(AIRCRAFT_TYPES[type].role) && AIRCRAFT_TYPES[type].armed === undefined));
      if (!options.length) break;
      const type = pickWeighted(options, rand, weight)[0];
      chosen.push(type);
      if (AIRCRAFT_TYPES[type].armed === false) support = true;
      if (heavy(type)) heavyIn = true;
    }
    const counts = chosen.map((_, i) => Math.floor(nAir / chosen.length) + (i < nAir % chosen.length ? 1 : 0));
    const mainGroup = Math.max(0, chosen.findIndex((type) => !heavy(type)));   // takes what the limits below leave over
    chosen.forEach((type, i) => {
      const max = Math.min(CAPS.airGroup, TYPE_MAX[type] || CAPS.airGroup, heavy(type) ? 4 : CAPS.airGroup);
      if (counts[i] > max) { const x = counts[i] - max; counts[i] = max; if (i !== mainGroup) counts[mainGroup] = Math.min(CAPS.airGroup, counts[mainGroup] + x); }
    });
    const spots = AIR_SPOTS.slice();
    chosen.forEach((type, i) => {
      const t = AIRCRAFT_TYPES[type], n = counts[i];
      let formation = n >= 3 && rand() < 0.65 ? 'vee' : 'pair', position = null;
      if (t.role === 'helicopter' || t.role === 'floatplane') { formation = 'loose'; position = 'low'; }
      else if (t.role === 'attacker') position = 'low';
      else if (t.role === 'awacs' || t.role === 'drone') { formation = n > 1 ? 'pair' : 'line'; position = 'high'; }
      else if (t.role === 'transport' || t.role === 'bomber') formation = 'line';
      if (!position) position = spots.length ? spots.splice(Math.floor(rand() * spots.length), 1)[0] : pick(AIR_SPOTS, rand);
      const distance = Math.round((position === 'low' ? 4500 + rand() * 1000 : 5000 + rand() * 2500) / 100) * 100;
      if (n > 0) air.push({ kind: 'air', type, count: n, formation, position, distance });
    });
    while (cost(air) > airCap && total(air) > 2) {
      let worst = null;
      for (const g of air) {
        const c = U('air', g.type).cost, w = worst && U('air', worst.type).cost;
        if (!worst || c > w || (c === w && g.count > worst.count)) worst = g;
      }
      if (!--worst.count) air.splice(air.indexOf(worst), 1);
    }
  }
  groups.push(...air);

  // Surface: a land site (air defenses, plus vehicles or structures from 3 targets on, a second kind from 10) and a sea
  // group (patrol boats, plus warships or freighters from 3 targets on). The land groups share a spot, as do the sea
  // groups, in different directions. Shooters crowd out the soft targets as the rounds go by.
  const surface = [];
  const surfaceCap = restM - cost(air), per = surfaceCap / (nGround + nNaval);
  const sites = SURFACE_SPOTS.slice();
  const site = (lo, hi) => ({ position: sites.splice(Math.floor(rand() * sites.length), 1)[0], distance: Math.round((lo + rand() * (hi - lo)) / 100) * 100 });
  const land = site(4000, 5000), sea = site(4000, 5000);   // close to the round start: the fight starts within seconds
  // add(): one group per type, at most TYPE_MAX (and 24) of it in the round; returns how many didn't fit
  const room = (kind, type) => {
    const g = surface.find((x) => x.kind === kind && x.type === type);
    return Math.min(CAPS.surfaceGroup, TYPE_MAX[type] || CAPS.surfaceGroup) - (g ? g.count : 0);
  };
  const add = (kind, type, count, area) => {
    const n = Math.min(Math.max(0, room(kind, type)), count);
    if (n > 0) {
      let g = surface.find((x) => x.kind === kind && x.type === type);
      if (!g) { const at = kind === 'naval' ? sea : land; g = { kind, type, count: 0, area, position: at.position, distance: at.distance }; surface.push(g); }
      g.count += n;
    }
    return Math.max(0, count - n);
  };
  const threat = (e) => fresh(e) * (GROUND_TYPES[e[0]].shoots ? 1 + round / 15 : 1);
  // Cheap threats of a kind (one missile at Mercenary): patrol boats at sea; ashore the site's own AA gun, SAM, C-RAM or
  // L-SAM type while it has room, else one of them picked at random (kept while it has room)
  const fillers = FILLERS.filter(([t]) => GROUND_TYPES[t] && GROUND_POOL.some(([p, from]) => p === t && from <= round));
  let landFiller = null;
  const filler = (kind) => {
    if (kind === 'naval') return 'boat';
    const ad = surface.find((g) => g.kind === 'ground' && room('ground', g.type) > 0 && fillers.some(([t]) => t === g.type));
    if (ad) return ad.type;
    if (!landFiller || room('ground', landFiller) <= 0) {
      const open = fillers.filter(([t]) => room('ground', t) > 0);
      landFiller = open.length ? pickWeighted(open, rand, (e) => e[1])[0] : 'aa';
    }
    return landFiller;
  };
  {
    const pool = unlocked(GROUND_POOL, 'ground');
    const shooters = pool.filter(([t]) => GROUND_TYPES[t].shoots), others = pool.filter(([t]) => !GROUND_TYPES[t].shoots);
    const ad = pickWeighted(shooters, rand, (e) => threat(e) * afford(U('ground', e[0]).cost, per))[0];
    const nAd = nGround < 3 ? nGround : Math.max(1, Math.round(nGround * clamp(0.5 + round / 60, 0.5, 0.8)));
    let left = nGround - nAd + add('ground', ad, nAd, ad === 'aa' && rand() < 0.5 ? 'scattered' : 'base');
    const kinds = left > 0 ? (nGround >= 10 ? 2 : 1) : 0;
    for (let i = 0; i < kinds && left > 0; i++) {
      const options = others.filter(([t]) => !surface.some((g) => g.type === t) && U('ground', t).cost <= 0.3 * surfaceCap);
      if (!options.length) break;
      const type = pickWeighted(options, rand, (e) => fresh(e) * afford(U('ground', e[0]).cost, per))[0];
      const n = i === kinds - 1 ? left : Math.ceil(left / 2);
      left -= n - add('ground', type, n, CONVOY.has(type) ? 'convoy' : 'base');
    }
    if (left > 0) add('ground', filler('ground'), left, 'base');   // whatever the type limits left over
  }
  {
    const ships = unlocked(NAVAL_POOL, 'naval').filter(([t]) => t !== 'boat' && U('naval', t).cost <= 0.35 * surfaceCap);
    let boats = nNaval;
    if (ships.length && (nNaval >= 3 || rand() < 0.3)) {
      const type = pickWeighted(ships, rand, (e) => threat(e) * afford(U('naval', e[0]).cost, 3 * per))[0];
      const n = Math.max(1, Math.round(nNaval / 3));
      boats -= n - add('naval', type, n, 'fleet');
    }
    add('naval', 'boat', boats, 'scattered');
  }
  // Over budget: costly units (2+ hits) become cheap threats of their kind one at a time while their group keeps one;
  // then the biggest group shrinks; then a lone costly unit turns cheap; then extra groups go (one land and one sea
  // group always stay).
  const costliest = (pred) => {
    let w = null;
    for (const g of surface) if (pred(g) && (!w || U(g.kind, g.type).cost > U(w.kind, w.type).cost)) w = g;
    return w;
  };
  const drop = (g) => { if (!--g.count) surface.splice(surface.indexOf(g), 1); };
  const swap = (g) => { if (add(g.kind, filler(g.kind), 1, g.kind === 'naval' ? 'scattered' : 'base')) return false; drop(g); return true; };
  const costly = (x) => U(x.kind, x.type).hits >= 2 && filler(x.kind) !== x.type;
  for (let guard = 0; guard < 500 && cost(surface) > surfaceCap; guard++) {
    let g = costliest((x) => x.count > 1 && costly(x));
    if (g && swap(g)) continue;
    g = null;
    for (const x of surface) if (x.count > 1 && (!g || x.count > g.count)) g = x;
    if (g) { drop(g); continue; }
    g = costliest(costly);
    if (g && swap(g)) continue;
    g = costliest((x) => surface.filter((y) => y.kind === x.kind).length > 1);
    if (!g) break;
    drop(g);
  }
  groups.push(...surface);

  const counts = { air: 0, ground: 0, naval: 0, total: 0 };
  let hits = 0;
  for (const g of groups) { counts[g.kind] += g.count; counts.total += g.count; hits += g.count * U(g.kind, g.type).hits; }
  const missiles = cost(groups);
  return { round, seed, mix: mix.name, ramp, bounty, groups, counts, hits, missiles, ammoShare: missiles / missileLoad, capMissiles: capM };
}

// ---- local best ---------------------------------------------------------------------------------------------------
let sessionBest = null;   // the best of this page session: what loadBest() falls back on when storage is blocked
const whole = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
function cleanBest(o) {
  if (!o || typeof o !== 'object' || !(Number(o.score) > 0)) return null;
  return { score: whole(Number(o.score)), rounds: whole(Number(o.rounds)), kills: whole(Number(o.kills)), at: typeof o.at === 'string' ? o.at.slice(0, 40) : '' };
}
const better = (a, b) => (!a ? b : !b ? a : b.score > a.score ? b : a);
/** The local best run { score, rounds, kills, at }, or null. Never throws: blocked or corrupt storage reads as empty,
 *  and the session's best still counts. */
export function loadBest() {
  let stored = null;
  try { const raw = localStorage.getItem(BEST_KEY); stored = raw ? cleanBest(JSON.parse(raw)) : null; } catch { stored = null; }
  return better(stored, sessionBest);
}
/** Store `rec` as the local best (callers check that it is better). Returns false when storage is unavailable; the
 *  record still lasts the session. Never throws. */
export function saveBest(rec) {
  const r = cleanBest(rec);
  if (!r) return false;
  sessionBest = better(sessionBest, r);
  try { localStorage.setItem(BEST_KEY, JSON.stringify(r)); return true; } catch { return false; }
}

// ---- run state ----------------------------------------------------------------------------------------------------
export class InfinityRun {
  /** @param opts { difficulty: the game's DIFFICULTY table, missileLoad: FLIGHT.MAX_MISSILES, missileDamage:
   *  Weapons.missileDamage, seed (optional, 32-bit; random when absent) } */
  constructor({ difficulty, missileLoad, missileDamage, seed } = {}) {
    if (!(missileLoad > 0) || !(missileDamage > 0)) throw new TypeError('infinity: missileLoad and missileDamage must come from the game');
    rampAt(1, difficulty);   // validates the table
    this.difficulty = difficulty; this.missileLoad = missileLoad; this.missileDamage = missileDamage;
    this.start(seed);
  }
  /** A new run from round 0 (nextRound() starts round 1). */
  start(seed) {
    this.seed = Number.isFinite(seed) ? seed >>> 0 : (Math.random() * 4294967296) >>> 0;
    this.round = 0; this.roundsCleared = 0; this.kills = 0; this.score = 0;
    this.plan = null; this.over = false; this.result = null;
    return this;
  }
  /** Pseudo-mission for code that takes a mission (js/squad.js reads wingmen): both squadmates fly. */
  get mission() { return { id: 0, name: 'Infinity', infinity: true, wingmen: WINGMEN.slice(), phases: [] }; }
  /** The current round's ramp (round 1's before the first round). */
  get ramp() { return this.plan ? this.plan.ramp : rampAt(1, this.difficulty); }
  /** Advance to the next round and generate it. */
  nextRound() {
    this.round++;
    this.plan = generateRound(this.round, { difficulty: this.difficulty, missileLoad: this.missileLoad, missileDamage: this.missileDamage, seed: this.seed });
    return this.plan;
  }
  /** AREA CLEAR: the round counts as cleared. Returns the intermission (seconds, repair share). */
  clearRound() { if (!this.over) this.roundsCleared = Math.max(this.roundsCleared, this.round); return INTERMISSION; }
  /** Hull after the intermission patch: +35 % of full, capped at full. */
  repairedHealth(health, maxHealth = 100) { return Math.min(maxHealth, Math.max(0, health) + INTERMISSION.repair * maxHealth); }
  /** The player destroyed a unit (kind 'air' | 'ground' | 'naval', type key): adds and returns its points. */
  recordKill(kind, type) {
    if (this.over) return 0;
    const pts = killPoints(kind === 'air' ? 'air' : 'ground', type, Math.max(1, this.round));
    this.score += pts; this.kills++;
    return pts;
  }
  /** End the run (shot down, or abandoned): saves a new local best. Idempotent. Returns the end-screen summary
   *  { reason, round, roundsCleared, kills, score, best: { score, rounds, kills, at } | null, newBest, saved }. */
  finish(reason = 'SHOT DOWN') {
    if (this.over) return this.result;
    this.over = true;
    const prev = loadBest(), newBest = this.score > 0 && (!prev || this.score > prev.score);
    const rec = { score: this.score, rounds: this.roundsCleared, kills: this.kills, at: new Date().toISOString() };
    const saved = newBest ? saveBest(rec) : false;
    this.result = { reason, round: this.round, roundsCleared: this.roundsCleared, kills: this.kills, score: this.score,
      best: newBest ? cleanBest(rec) : prev, newBest, saved };
    return this.result;
  }
}
