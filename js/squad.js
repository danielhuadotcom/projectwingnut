import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { Aircraft } from './aircraft.js';
import { WingmanBrain } from './ai.js';

// The player's squadmates: two immortal AI wingmen of the Loose Screws, COTTER (number 2) and RIVET (number 3). They fly
// loose formation, peel off to engage bandits hunting the player (drawing their fire), defeat the one missile at a time
// the enemy may send their way with flares, and land only ~5 % of the air kills. (Which bandits hunt the player and
// which hunt a squadmate is decided by the game's bandit director, js/main.js directBandits.)
//
// Squadmate targets: each squadmate picks a bandit on its own 3 s timer, or on its next tick after its target dies (at
// most once per frame): within 6 km of the player and never a boss, bandits hunting the player first, nearest to the
// player first; number 2 takes the nearest, number 3 the second nearest. Nothing else changes a squadmate's target.
//
// Team API (HUD, allied ground forces): a squadmate is an Aircraft with isAlly = true, immortal = true, team = 'player'
// and callsign 'COTTER' | 'RIVET'. `allies` lists the ones flying the current mission (Game.allies is this array; parked
// squadmates are hidden with alive = false). Shooters on team 'player' only test the game's hostile list (no friendly
// fire). Squadmates sit in the enemy team's target list but take no damage: a bandit round that reaches one stops with
// a visible hit, a missile airbursts harmlessly. The AI keeps at most missileCap missiles after a target that sets it,
// and only the difficulty's attack-slot count of a squadmate's hunters (the nearest) fire at it; the rest keep pursuing
// with weapons held (Game attack slots). Missions choose squadmates with missions[].wingmen: ['2', '3'] when absent,
// ['2'] or ['3'] for one, [] for solo.

export const WINGMEN = {
  '2': { callsign: 'COTTER', side: 1 },    // flies right of the lead
  '3': { callsign: 'RIVET', side: -1 },    // flies left of the lead
};
export const DEFAULT_WINGMEN = ['2', '3'];
const PAINT = { bodyColor: 0x7e94ae, accentColor: 0xff6a1a };   // squadron orange over a steel-blue grey no enemy flies
const KILL_SHARE = 0.05;       // squadmates land about this share of a mission's air kills
const KILL_SLACK = 0.6;        // a squadmate kill is allowed once the running share has this much room
const GUN_DAMAGE = 0.5;        // squadmate cannon damage multiplier (and it only finishes a bandit within the budget)
const MISSILE_GAP = 15;        // s between enemy launches at one squadmate (and never more than one after it)
const PICK_EVERY = 3;          // s between a squadmate's target picks
const LEASH2 = 6000 * 6000;    // squadmates only engage bandits within 6 km of the player
const _v = new THREE.Vector3();

export class Squadron {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { world (getHeight), tunnel (optional, collide()), profiler (optional), fxQuality, worldHalf }
   */
  constructor(scene, { world, tunnel = null, profiler = null, fxQuality = 'high', worldHalf = 20000 } = {}) {
    this.world = world; this.tunnel = tunnel;
    this.members = {};       // number -> Aircraft, created once and reused every mission
    this.allies = [];        // squadmates flying the current mission (array identity is stable)
    this.airKills = 0; this.allyKills = 0;   // this mission's air kills: by anyone, and by squadmates
    this.stats = { launches: 0, lethal: 0, duds: 0, clamps: 0, picks: 0 };
    this._rank = [null, null, null, null];
    for (const num of Object.keys(WINGMEN)) {
      const def = WINGMEN[num];
      const ac = new Aircraft(scene, { team: 'player', bodyColor: PAINT.bodyColor, accentColor: PAINT.accentColor, fxQuality });
      ac.mesh.name = 'aircraft-ally-' + def.callsign.toLowerCase();
      ac.isAlly = true; ac.immortal = true; ac.number = num; ac.callsign = def.callsign; ac.name = def.callsign;
      ac.applyDamage = () => false;                 // immortal: nothing hurts it
      ac.missileCap = 1; ac.missileGap = MISSILE_GAP;   // enemy missile rationing (EnemyBrain.canLaunchAt)
      ac.gunRate = 12; ac.gunHitRadius = 6;         // bandit-like cannon (the player's rounds get a 16 m sphere)
      ac.handling.pitch = 0.92; ac.handling.roll = 0.92;
      const b = ac.brain = new WingmanBrain(ac, { skill: 0.75, worldHalf });
      b.side = def.side;
      if (tunnel) b.obstacle = (pt) => tunnel.collide(pt, 60) === 'wall';
      if (profiler) { profiler.instrument(ac.mesh, 'allies'); if (ac.contrails && ac.contrails.mesh) profiler.instrument(ac.contrails.mesh, 'contrails'); }
      ac.kill();                                    // parked (hidden) until a mission calls it up
      this.members[num] = ac;
    }
  }

  /** Mission start: the squadmates in mission.wingmen take their formation slots on `lead`, at its speed and heading. */
  spawn(mission, lead) {
    this.hide();
    this.airKills = 0; this.allyKills = 0;
    const list = mission && Array.isArray(mission.wingmen) ? mission.wingmen : DEFAULT_WINGMEN;
    const floor = Math.max(this.world.getHeight(lead.position.x, lead.position.z), 0);
    for (const num of list) {
      const ac = this.members[num];
      if (!ac || this.allies.includes(ac)) continue;
      const b = ac.brain;
      b.reset(); b.lead = lead;
      b.slotPosition(_v, floor);
      ac.reset({ position: _v, health: 100 });
      ac.quaternion.copy(lead.quaternion);
      ac.speed = lead.speed; ac.throttle = lead.throttle; ac.velocity.copy(lead.velocity);
      ac.missiles = 999; ac.ammo = 1e6; ac._missileAt = undefined; ac._inboundCount = 0;
      this.allies.push(ac);
    }
    for (const ac of this.allies) ac.brain.mates = this.allies;   // collision avoidance between squadmates
    this.newWave();
  }

  /** Park every squadmate (title screen, solo missions). */
  hide() {
    for (const num in this.members) { const ac = this.members[num]; if (ac.alive) ac.kill(); ac.brain.target = null; }
    this.allies.length = 0;
  }

  /** New wave: squadmates pick a bandit within the next second (staggered) instead of waiting out their pick timer. */
  newWave() {
    for (let i = 0; i < this.allies.length; i++) this.allies[i].brain.pickT = 0.3 + 0.5 * i;
  }

  /** Fly the squadmates one step (after the bandits). Each picks its bandit on its own timer, or on the next tick after
   *  its target dies; the ground clamp is a last resort (squadmates can't crash). */
  update(dt, p, enemies, weapons, time) {
    const A = this.allies;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      if (!a.alive) continue;
      const b = a.brain;
      b.pickT -= dt;
      if (b.pickT <= 0 || (b.target && !b.target.alive)) { b.pickT = PICK_EVERY; this._pick(a, i, p, enemies); }
      b.update(dt, b.target, this.world, weapons, time);
      a.update(dt);
      this._keepAloft(a);
    }
  }

  /** Target pick for the squadmate at index k (0 = number 2, 1 = number 3 when both fly): within 6 km of the player and
   *  never a boss, bandits hunting the player first, then the others, nearest to the player first; entry k of that
   *  ranking (or the last one when there are fewer). No bandit to take: formation (a wide cover position while bandits
   *  remain, e.g. a boss duel). One O(bandits) pass, no allocation. */
  _pick(a, k, p, enemies) {
    this.stats.picks++;
    let h1 = null, h2 = null, o1 = null, o2 = null, any = false;
    let hd1 = Infinity, hd2 = Infinity, od1 = Infinity, od2 = Infinity;
    if (p.alive) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.alive) continue;
        any = true;
        if (e.bossBars > 0) continue;
        const d = e.position.distanceToSquared(p.position);
        if (d > LEASH2) continue;
        if (e.brain && !e.brain.passive && e.brain.target === p) {
          if (d < hd1) { h2 = h1; hd2 = hd1; h1 = e; hd1 = d; } else if (d < hd2) { h2 = e; hd2 = d; }
        } else if (d < od1) { o2 = o1; od2 = od1; o1 = e; od1 = d; } else if (d < od2) { o2 = e; od2 = d; }
      }
    }
    const R = this._rank; let n = 0;
    if (h1) R[n++] = h1;
    if (h2) R[n++] = h2;
    if (o1) R[n++] = o1;
    if (o2) R[n++] = o2;
    const best = n ? R[k < n ? k : n - 1] : null;
    a.brain.target = best; a.brain.standoff = !best && any;
  }

  _keepAloft(a) {
    const p = a.position, h = Math.max(this.world.getHeight(p.x, p.z), 0);
    if (p.y < h + 30) { p.y = h + 30; this.stats.clamps++; }
    const tn = this.tunnel;
    if (tn) for (let i = 0; i < 20 && tn.collide(p, 8) === 'wall'; i++) { p.y += 15; this.stats.clamps++; }
  }

  // ---- kill budget -------------------------------------------------------------------------------
  /** Room for one more squadmate kill (plus `pending` lethal shots in the air): their share of the air kills stays ~5 %. */
  killAllowed(pending = 0) {
    const others = this.airKills - this.allyKills;
    return this.allyKills + pending + 1 <= others * KILL_SHARE / (1 - KILL_SHARE) + KILL_SLACK;
  }
  /** Weapons onMissileLaunch hook; true when it handled a squadmate's missile. Decided at launch: a lethal shot kills
   *  outright if it connects (a squadmate never visibly hits without a kill); otherwise it is a dud that homes on a point
   *  35-65 m beside the bandit with a little less agility, streaks past and never hits anything. */
  onMissileLaunch(m, weapons) {
    if (!m.owner || !m.owner.isAlly) return false;
    this.stats.launches++;
    let pending = 0;
    const ms = weapons.missiles;
    for (let i = 0; i < ms.length; i++) { const o = ms[i]; if (o !== m && o.alive && o.lethal) pending++; }
    const T = m.target;
    // turn scales relative to the player-team missile profile the game already gave this shot (Game.onMissileLaunch)
    if (T && !T.isGround && !(T.bossBars > 0) && this.killAllowed(pending)) { m.lethal = true; m.turnScale *= 1.2; this.stats.lethal++; }
    else { m.dud = true; m.missBy = 35 + Math.random() * 30; m.missSide = Math.random() < 0.5 ? -1 : 1; m.turnScale *= 0.75; this.stats.duds++; }
    return true;
  }
  /** Weapons damageFilter hook: a lethal squadmate missile finishes its victim; squadmate cannon rounds do light damage
   *  and only finish a bandit when the budget has room. Everyone else's damage passes through unchanged. */
  damage(target, dmg, shooter, kind, missile) {
    if (!shooter || !shooter.isAlly) return dmg;
    if (kind === 'missile') return missile && missile.lethal && !target.isGround && !(target.bossBars > 0) ? Math.max(dmg, target.health + 1) : dmg;
    dmg *= GUN_DAMAGE;
    return dmg >= target.health && !this.killAllowed() ? Math.max(0, target.health - 1) : dmg;
  }
  /** Weapons onKill hook: count this mission's air kills (by anyone, and by squadmates). */
  onKill(target, shooter) {
    if (target.isGround || target.team === 'player') return;
    this.airKills++;
    if (shooter && shooter.isAlly) this.allyKills++;
  }
}
