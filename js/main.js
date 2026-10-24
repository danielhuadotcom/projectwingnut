import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { World, WORLD_HALF } from './world.js';
import { PostFX } from './post.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { AudioFX } from './audio.js';
import { Aircraft, AIRCRAFT_RADIUS, FLIGHT } from './aircraft.js';
import { Weapons } from './weapons.js';
import { ChaseCamera } from './camera.js';
import { EnemyBrain } from './ai.js';
import { Squadron } from './squad.js';
import { AlliedForces } from './allies.js';
import { Profiler } from './profiler.js';
import { PRESETS, TIERS, CHOICES, DynamicResolution, StepDown, loadChoice, saveChoice, guessTier } from './quality.js';
import { GroundForces, DEFAULT_GROUND_TYPES, unitScale } from './targets.js';
import { MISSIONS, AIRCRAFT_TYPES, GROUND_TYPES } from './missions.js';
import { Awacs } from './awacs.js';
import { Tunnel } from './tunnel.js';
import { Menu, loadSettings } from './menu.js';
import { fullscreenSupported, onFullscreenChange } from './fullscreen.js';
import { TouchControls } from './touch.js';
import { Music } from './music.js';
import { Flights, SLOTS as FLIGHT_SLOTS, mulberry32, isHolding, orbitRadius, HOLD_MAX, SCRAMBLE_MAX } from './flights.js';
import { InfinityRun, timeForRound } from './infinity.js';
import { applyTimeOfDay, prewarmTimeOfDay, timePreset } from './timeofday.js';
import { Glassfall } from './glassfall.js';

// Fallback campaign (replaced by js/missions.js data once it exists): PW-style missions made of phases of groups.
const FALLBACK_AIR_TYPES = {
  'SLEET-21': { role: 'interceptor', hp: 35, speedKmh: 2500, roll: 170, pitch: 85, yaw: 10, color: 0x6b7178, accent: 0xc0392b },
  'NV-16': { role: 'fighter', hp: 35, speedKmh: 2500, roll: 210, pitch: 85, yaw: 15, color: 0x5d6670, accent: 0xd8232a },
  'FLURRY-29': { role: 'fighter', hp: 45, speedKmh: 2400, roll: 190, pitch: 92, yaw: 14, color: 0x56606a, accent: 0xb3262e },
};
const FALLBACK_MISSIONS = [
  { id: 1, name: 'Warm-Up Lap', briefing: 'Concord patrols are probing the Skerry coast. Clear the sky over the bay.',
    phases: [ { label: 'Patrol', groups: [ { kind: 'air', type: 'SLEET-21', count: 2, formation: 'pair', position: 'ahead', distance: 4500 } ] },
              { label: 'Reinforcements', groups: [ { kind: 'air', type: 'NV-16', count: 3, formation: 'vee', position: 'left', distance: 5000 } ] } ] },
  { id: 2, name: 'Battery Change', briefing: 'Air defenses guard the shoreline. Knock out the sites, then the escorts.',
    phases: [ { label: 'Air defenses', groups: [ { kind: 'ground', type: 'sam', count: 3, area: 'coastline', distance: 6000 }, { kind: 'ground', type: 'aa', count: 4, area: 'coastline', distance: 6000 }, { kind: 'ground', type: 'tank', count: 4, area: 'base', distance: 6500 } ] },
              { label: 'Escorts', groups: [ { kind: 'air', type: 'NV-16', count: 4, formation: 'vee', position: 'ahead', distance: 5000 } ] } ] },
  { id: 3, name: 'Low Tide', briefing: 'A Corsair flotilla is closing on Lanternport. Sink it.',
    phases: [ { label: 'Flotilla', groups: [ { kind: 'naval', type: 'frigate', count: 2, area: 'fleet', distance: 7000 }, { kind: 'naval', type: 'boat', count: 4, area: 'fleet', distance: 7000 } ] },
              { label: 'Air cover', groups: [ { kind: 'air', type: 'FLURRY-29', count: 4, formation: 'line', position: 'high', distance: 5000 }, { kind: 'air', type: 'SLEET-21', count: 2, formation: 'pair', position: 'right', distance: 5000 } ] } ] },
];

// ---------- tuning ----------
// Arcade weapons: the bandit nearest the crosshair is targeted automatically, locks come quickly inside
// a wide cone, standard missiles are short-ranged and fire from two alternating hardpoints that reload separately.
const LOCK_COS = Math.cos(THREE.MathUtils.degToRad(22.5));   // 45 deg full cone
const CYCLE_BORE = 40;      // deg: while any hostile is on screen within this of the reticle, the target button cycles among those
const CYCLE_INSET = 0.05;   // NDC: "on screen" means projected at least this far inside the viewport edges
const LOS_PERIOD = 0.1;     // s: line of sight to a lockable target is re-checked at ~10 Hz (and at once for a new target)
const LOCK_RANGE = 2800;
const HOLD_COS = Math.cos(THREE.MathUtils.degToRad(70)), HOLD_RANGE = 4500;   // once locked, the lock holds this far
const LOCK_TIME = 0.5;
const HARDPOINTS = 4, HARDPOINT_RELOAD = 5;   // four standard-missile hardpoints (stands in for PW special-weapon slots), s per hardpoint
const FLARE_RELOAD = 7;                         // s (PW: infinite flares, 7 s reload)
const GUN_LEAD_RANGE = 1200;                    // m (PW shows the lead pipper inside 1200 m of the target)
const RADAR_RANGE = 8000;
const TAP_TIME = 0.25;
const PLAYER_ARMOR = 0.5;      // incoming damage multiplier for the player
const ENEMY_HEALTH = 100;      // two missiles (65 each) kill, as for most fighters in PW; ~25 cannon hits
const MAX_ENEMIES = 6;
// Difficulty: player damage taken, enemy hit points and skill, how many bandits may attack at once (the rest hold
// off; the same cap applies to the bandits hunting each squadmate, whose extras keep pursuing with weapons held), which
// difficulty-specific mission groups spawn, and the player's share of the armed bandits while
// squadmates fly (the rest go after the squadmates; js/squad.js). Bandit flights (js/flights.js): flightCap = most
// flights the commit timer lets be committed at once, stagger = s between its releases (a phase's own stagger, in
// Normal seconds, scales by the same ratio), playerMissiles = most enemy missiles after the player at once (a bandit
// holds its shot beyond that, or within 1.5 s of the last launch at the same target: EnemyBrain.canLaunchAt). Flak
// (js/targets.js, header: Flak): aaGuns = most AA guns firing at the player at once (the nearest in sight; the others
// throw an occasional harmless barrage), aaError = their aim error (x the bursts' spread; 1 = the old aim). Missiles fly
// the same on every difficulty (ENEMY_MISSILE_TURN, PLAYER_MISSILE): harder ones only put more of them in the air.
const DIFFICULTY = {
  easy:      { armor: 0.35, enemyHp: 0.8,  skill: -0.15, aggressors: 1,        groups: [],                      playerShare: 0.3, flightCap: 1, stagger: 30, playerMissiles: 1, aaGuns: 2,  aaError: 1.6 },
  normal:    { armor: 0.5,  enemyHp: 1.0,  skill: 0,     aggressors: 2,        groups: [],                      playerShare: 0.4, flightCap: 2, stagger: 20, playerMissiles: 2, aaGuns: 4,  aaError: 1.3 },
  hard:      { armor: 0.7,  enemyHp: 1.15, skill: 0.1,   aggressors: 4,        groups: ['hard'],                playerShare: 0.5, flightCap: 2, stagger: 15, playerMissiles: 3, aaGuns: 6,  aaError: 1.1 },
  mercenary: { armor: 1.0,  enemyHp: 1.3,  skill: 0.2,   aggressors: Infinity, groups: ['hard', 'mercenary'], playerShare: 0.6, flightCap: 3, stagger: 10, playerMissiles: 4, aaGuns: 14, aaError: 1.0 },
};
const ENEMY_MISSILE_TURN = 0.6;  // enemy shots: turn-limit scale, the same on every difficulty (harder ones only fire more)
// Player-team missiles (the player's and the squadmates'): a lock means the target is reachable. Faster and longer-legged
// than the global (enemy, dodgeable) profile: from the 2.8 km lock range they run down a bandit fleeing straight at full
// speed in ~6 s. turnScale 1.3 keeps the old turn radius at the higher speed (1000 / 760 m/s), so close crossing shots
// don't get worse; a 13 m fuse (enemy missiles are cut to 11 m to stay dodgeable). With the pursuit-style guidance
// (js/weapons.js _guide) tail chases (an evading bandit included), gentle turns and head-ons inside ~1.5 km connect,
// while high crossing angles and long shots at a hard turner or an evading bandit mostly miss; aces and bosses beat
// good shots with a post-stall Cobra that breaks the lock of every missile close to impact (js/ai.js COBRA_*). blindTime: on a tail-aspect launch inside 1.8 km the seeker's blind
// range is at most 0.05 s of closure (15-25 m) instead of the flat 90 m, which in a close tail chase (a missile still
// accelerating, closing at 250-450 m/s) left 0.2-0.35 s unguided: long enough for an ordinary evasive turn to slip the
// 13 m fuse. Crossing, head-on and long shots keep 90 m (js/weapons.js fireMissile). Per-shot values on the Missile,
// set in onMissileLaunch.
const PLAYER_MISSILE = { maxSpeed: 1000, boostTime: 2.4, drag: 0.7e-4, life: 8.5, turnScale: 1.3, fuse: 13, blindTime: 0.05 };
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const PARAMS = new URLSearchParams(location.search);

const AIR_SLACK = 6000;    // m: a later phase's air groups, or a wave entering mid-phase, re-centre on a player this far
                           //   from the phase's anchor (else the authored, identical layout)
const START_BACK = 2500;   // m: the player starts this far behind the sortie frame (missions[].startBack overrides)
const RIDGE_MARGIN = 20;   // m of clear ground kept between a land unit's footprint and the tunnel ridge's rock
// Allied story units (missions[].allies; js/allies.js): placement
const ALLY_SITE_GAP = 600;      // m: an allied group's site stays this clear of live enemy units,
const ALLY_UNIT_GAP = 220;      //   each allied vehicle this clear,
const ALLY_SEA_GAP = 400;       //   each allied ship this clear (hullClear also keeps hulls apart)
const ALLY_SPACING = 18;        // m between allied vehicles
const REGIMENT_R = 300;         // m: an allied land group spreads this far around its site
const ALLY_UNIT_MAX = 20;       // units per entry of an allied group
const ZONE_SITE_MARGIN = 500, ZONE_UNIT_MARGIN = 150;   // m that enemy group sites / units keep outside an allied group's circle
// Allied fleet: escort stations [right, ahead] (m) in the flagship's frame (a second ring further out beyond eight)
const FLEET_SLOTS = [[430, 260], [-430, 260], [430, -320], [-430, -320], [0, -640], [0, 660], [780, -20], [-780, -20]];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _fit = new THREE.Vector3();   // ringFit result
const _ret = new THREE.Vector3(), _rv = new THREE.Vector3();   // reticle direction scratch
const _ndc = new THREE.Vector3();                                // on-screen test scratch
// An aircraft as a GroundForces.hasLineOfSight unit: its sight line starts at the centre (y + height / 2 + 2 = y). The
// height is read from the unit's drawn size (GroundTarget.size; def.size, the life size, before units were scaled up)
const _losAir = { position: new THREE.Vector3(), size: [0, -4, 0], def: { size: [0, -4, 0] } };
const _q = new THREE.Quaternion();
const yawToward = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z)); // rotation about +Y so that -Z nose points from->to
const byDistance = (a, b) => a._d2 - b._d2;   // sort by squared distance to the player / squadmate (set beforehand)
// AI cruise speed of an aircraft type relative to a SLEET-21's 1100 km/h (helicopters slow, cruise missiles fast)
const cruiseScale = (type) => {
  const kmh = (type.ai && type.ai.kmh && type.ai.kmh[1]) || ((type.speedKmh || 2500) <= 1200 ? type.speedKmh : (type.speedKmh || 2500) * 0.44);
  return THREE.MathUtils.clamp(kmh / 1100, 0.3, 1.2);
};
const _site = new THREE.Vector3(), _st = new THREE.Vector3();   // air group placement scratch (spawnGroup, spawnAirGroup)
// A hostile's class (INFINITY's kill tally), and its model radius (m) at its drawn size, which sizes its hud.js marker
// so the brackets frame the model from any angle: ground units and ships by the bounding sphere of their drawn box
// (GroundTarget.size), aircraft by the airframe (nose tip ~7.95 m from its centre) times this frame's drawn scale
// (Aircraft.visualScale, updated before buildFrame)
const hudKind = (e) => (e.isGround ? (e.naval ? 'naval' : 'ground') : 'air');
const hudRadius = (e) => { if (!e.isGround) return 8 * (e.visualScale || 1); const S = e.size || e.def.size; return 0.5 * Math.hypot(S[0], S[1], S[2]); };
// HUD contact slots (screen markers and radar blips): the largest phase (66 hostiles, M6 phase 1 on Mercenary) plus
// missiles in flight; buildFrame fills them in priority order should a phase ever outgrow them
const HUD_CONTACTS = 96;
const HUD_THREATS = 8;        // incoming-missile edge arcs (js/hud.js _drawThreats)
const THREAT_FADE = 0.3;      // s: an arc fades out this long after its missile stops guiding on the player (flares, lost track)

class Game {
  constructor(root) {
    this.root = root;
    this.glHost = root.querySelector('#gl');
    this.hudHost = root.querySelector('#hud');
    this.ui = {
      title: root.querySelector('#title'), pause: root.querySelector('#pause'), dead: root.querySelector('#dead'),
      loading: root.querySelector('#loading'), err: root.querySelector('#err'), padstatus: root.querySelector('#padstatus'),
      perf: root.querySelector('#perf'),
      deadTitle: root.querySelector('#deadTitle'), deadStats: root.querySelector('#deadStats'), cta: root.querySelector('#cta'),
    };
    this.state = 'title';
    this.time = 0; this.last = performance.now();
    this.score = 0; this.wave = 0; this.kills = 0;
    this.infinity = null; this.infT = -1;   // INFINITY run (js/infinity.js) while one is on; intermission countdown (s)
    this.messages = [];
    this.enemies = []; this.brains = [];
    this.target = null; this.lockTimer = 0; this.locked = false; this.inCone = false;
    this.tbDownTime = -1; this.padlockEngaged = false;
    this.hitFlash = 0; this.damageFlash = 0;
    this.waveTimer = 0; this.deadTimer = 0; this.bootAt = performance.now();
    this.renderScale = 1; this.frameEma = 16; this.perfTimer = 0;
    this.sunScreen = { x: 0.5, y: 0.5, visible: false };
    // War Thunder-style mouse aim (default without a gamepad): aim heading/pitch, free-look offsets
    this.aimHeading = 0; this.aimPitch = 0; this.lookYaw = 0; this.lookPitch = 0;
    this.aimDir = new THREE.Vector3(0, 0, -1); this._qInv = new THREE.Quaternion();
    this.aimUp = new THREE.Vector3(0, 1, 0); this._lookDir = new THREE.Vector3(0, 0, -1); this._aimQ = new THREE.Quaternion();
    this._ovRoll = 0; this._ovPitch = 0; this._behindDir = 0;
    this._aimPush = false; this._rollSide = 0; this._aimLx = 0; this._aimTrim = 0; this._aimPI = 0; this._levelSide = 0;
    // Player settings (the settings menu replaces this object when it lands)
    this.settings = loadSettings();   // persisted player settings (menu module); the menu edits this object in place
    this.frame = this.makeFrame();
    this.init();
  }

  init() {
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = true;
    // Graphics quality: saved choice (or ?q= for benchmarks), 'auto' picks a starting tier from the GPU name
    const gl0 = renderer.getContext(); const dri = gl0.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dri ? String(gl0.getParameter(dri.UNMASKED_RENDERER_WEBGL)) : '';
    this.qualityChoice = CHOICES.includes(PARAMS.get('q')) ? PARAMS.get('q') : (CHOICES.includes(this.settings.quality) ? this.settings.quality : 'auto');
    this.quality = this.qualityChoice === 'auto' ? guessTier(this.gpuName) : this.qualityChoice;
    this.dynres = new DynamicResolution({ targetMs: 12.5 });
    this.stepDown = new StepDown();        // Auto: one tier down when frames stay slow at the lowest resolution (never up)
    const preset = PRESETS[this.quality];
    this.dpr = Math.min(window.devicePixelRatio || 1, preset.dprCap);
    this.renderScale = preset.scaleMax;
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(this.glHost.clientWidth, this.glHost.clientHeight, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    this.glHost.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, this.glHost.clientWidth / Math.max(1, this.glHost.clientHeight), 1, 60000);
    this.camera.position.set(0, 820, 40);
    this.world = new World(this.scene, renderer);
    // The genre-staple tunnel: a rock ridge on the coast north of spawn with a lit bore through it
    try { this.tunnel = new Tunnel(this.scene, this.world); } catch (e) { console.warn('tunnel unavailable', e); this.tunnel = null; }
    this.inTunnel = false;
    if (PARAMS.has('scale')) this.renderScale = THREE.MathUtils.clamp(Number(PARAMS.get('scale')) || 1, 0.45, 1);
    if (PARAMS.has('dpr')) this.dpr = THREE.MathUtils.clamp(Number(PARAMS.get('dpr')) || 1, 0.5, 2);
    const msaa = PARAMS.has('msaa') ? Number(PARAMS.get('msaa')) : preset.samples;
    // PostFX renders the scene at renderScale internally (instant to change) and composites at native resolution
    this.post = new PostFX(renderer, this.glHost.clientWidth, this.glHost.clientHeight, this.dpr, { samples: msaa, renderScale: this.renderScale, quality: preset.sub });
    this.input = new Input(window);
    this.hud = new HUD(this.hudHost);
    this._hudW = 1; this._hudH = 1;          // HUD host size in CSS px, cached by resize() (buildFrame never reads layout)
    try { if (typeof ResizeObserver === 'function') (this._hudRO = new ResizeObserver(() => this.cacheHudSize())).observe(this.hudHost); } catch (e) { /* resize() keeps it */ }
    this.audio = new AudioFX();
    // Soundtrack ("Ceiling Unlimited"): decoded once after unlock, loops seamlessly
    this.music = new Music(this.audio, { volume: this.settings.music ?? 0.7 });
    this.music.setMuffled(true);   // title screen: muffled until the first sortie
    // AWACS Claude: pre-generated radio lines, decoded once after the first user gesture unlocks audio
    this.radio = null;   // current radio subtitle { speaker, text, age, duration }
    this.awacs = new Awacs(this.audio, { onSubtitle: (text, secs) => { if (this.settings.subtitles !== false) this.radio = { speaker: 'AWACS CLAUDE', text, age: 0, duration: Math.max(2.6, (secs || 2) + 0.9) }; } });
    this.chase = new ChaseCamera(this.camera);

    this.player = new Aircraft(this.scene, { team: 'player', accentColor: 0xff6a1a, position: new THREE.Vector3(0, 800, 0), heading: 0, fxQuality: PRESETS[this.quality].sub });
    const baseDamage = this.player.applyDamage.bind(this.player);
    this.armor = PLAYER_ARMOR; this.skillOffset = 0;
    this.player.applyDamage = (amount) => baseDamage(amount * this.armor);
    this.player.name = 'WINGNUT';
    this.allAircraft = [this.player];

    this.weapons = new Weapons(this.scene, this.world, {
      onHit: (target, dmg, shooter, kind) => this.onHit(target, dmg, shooter, kind),
      onKill: (target, shooter) => this.onKill(target, shooter),
      onExplosion: (pos, size) => this.onExplosion(pos, size),
      onMissileLaunch: (m) => this.onMissileLaunch(m),
      onDecoy: (m, flare, ac) => { if (ac === this.player) this.missileDecoyed = true; },
    });

    // Ground and naval targets (instanced boxes/prisms), campaign data, combined combat list for weapons and radar
    this.ground = new GroundForces(this.scene, this.world);
    if (this.tunnel) { const tn = this.tunnel; this.ground.obstacle = (pt) => tn.collide(pt, 1) === 'wall'; }
    // Allied story units (immortal props in a friendly tint; js/allies.js): cosmetic flak, cruise missiles leaking onto
    // the fleet. Idle (no per-frame work) in missions without allies
    this.allied = new AlliedForces({ ground: this.ground, weapons: this.weapons, onLeak: (ac, sunk, missed) => this.onLeak(ac, sunk, missed) });
    // Campaign: the 21 Galebreak Isles missions (js/missions.js), small fallback campaign otherwise
    this.missions = (MISSIONS && MISSIONS.length) ? MISSIONS : FALLBACK_MISSIONS;
    this.airTypes = Object.assign({}, FALLBACK_AIR_TYPES, AIRCRAFT_TYPES || {});
    this.groundTypes = Object.assign({}, DEFAULT_GROUND_TYPES, GROUND_TYPES || {});
    this.missionIndex = 0; this.mission = this.missions[0]; this.phaseIndex = 0;
    this.combatList = [this.player];
    this.hostiles = [];                    // combatList minus the player: all the player's team can hit
    this._nAir = 0;                        // hostiles[0, _nAir) are aircraft (rebuildCombatList)
    this.enemyTargets = [this.player];     // the player and the flying squadmates: all that enemy fire is tested against
    this.teamTargets = { player: this.hostiles, enemy: this.enemyTargets };   // per-team target lists (no friendly fire)
    this.killTimes = [];
    this._onFlak = (pos, hit) => {
      this.weapons.flakPuff(pos);
      const p = this.player;
      if (hit && p.alive && !p.immortal) {   // (immortal once the mission is complete)
        this.damageFlash = Math.max(this.damageFlash, 0.5); this.post.damage(0.3); this.chase.addShake(0.2);
        if (p.applyDamage(6)) { this.weapons.aircraftDeath(p); this.die('SHOT DOWN BY FLAK', true); }
      }
    };
    // Profiler (GPU timer queries + CPU sections); idle unless bench mode or the perf overlay turns it on
    this.profiler = new Profiler(renderer);
    this.post.profiler = this.profiler;
    const w = this.world;
    for (const [obj, label] of [[w.sky, 'sky'], [w.terrain, 'terrain'], [w.water, 'water'], [w.clouds, 'clouds'], [w.puffs, 'cloudPuffs']]) if (obj) this.profiler.instrument(obj, label);
    this.profiler.instrument(this.player.mesh, 'jets');
    for (const name of (PARAMS.get('hide') || '').split(',')) if (name && w[name]) w[name].visible = false;
    this.noHud = PARAMS.has('nohud'); this.hideJets = PARAMS.has('hidejets');
    this._hidden = (PARAMS.get('hide') || '').split(',').map((n) => w[n]).filter(Boolean);
    if (this.player.contrails && this.player.contrails.mesh) this.profiler.instrument(this.player.contrails.mesh, 'contrails');
    for (const m of Object.values(this.ground.meshes)) this.profiler.instrument(m, 'ground');
    for (const o of this.scene.children) if (!o.userData.__prof) this.profiler.instrument(o, 'fx:' + (o.name || o.type));
    if (!PARAMS.has('bench')) this.profiler.setMode('pass');
    this.bench = PARAMS.has('bench') ? { dur: Number(PARAMS.get('dur') || 16), warm: Number(PARAMS.get('warm') || 4), t: 0, boomT: 0, mslT: 0, modeT: 0, done: false } : null;
    this.syncProfilerCpu();
    // Squadmates COTTER and RIVET (js/squad.js), parked until a mission calls them up. Left out of benchmarks so runs stay
    // comparable (?bench=1&wingmen=1 adds them, to measure what they cost).
    this.squad = !this.bench || PARAMS.has('wingmen')
      ? new Squadron(this.scene, { world: this.world, tunnel: this.tunnel, profiler: this.profiler, fxQuality: PRESETS[this.quality].sub, worldHalf: WORLD_HALF })
      : null;
    this.allies = this.squad ? this.squad.allies : [];   // squadmates flying this mission (isAlly, team 'player', callsign)
    // The Glassfall story events (js/glassfall.js: M15 phase 2, M20's ending): pooled blasts and the untargetable Q12,
    // built before the shader precompile. The Q12's team 'glass' tests an empty target list
    this.glassfall = new Glassfall(this, { fxQuality: PRESETS[this.quality].sub, worldHalf: WORLD_HALF });
    this.teamTargets.glass = [];
    if (this.squad) {
      for (const a of Object.values(this.squad.members)) this.allAircraft.push(a);
      this.weapons.damageFilter = (target, dmg, shooter, kind, m) => this.squad.damage(target, dmg, shooter, kind, m);
    }
    // Gameplay tuning: missiles must be evadable with a hard break turn (module default of 7 rad/s is nearly unmissable)
    // Dodgeable missiles (calibrated with tools/msltest.mjs): ~60 deg seeker gimbal, airframe response lag and a short
    // blind range at the end, so a hard break ~1 s before impact makes them overshoot while straight-flying targets
    // are always hit. More reach so a 2.8 km lock can catch a fleeing target.
    const W = this.weapons;
    W.missileTurnRateBoost = 2.4; W.missileTurnRateCoast = 1.3; W.missileSeekerCos = Math.cos(THREE.MathUtils.degToRad(60));
    W.missileFuse = 11; W.missileLag = 0.18; W.missileBlindRange = 90;
    W.missileLife = 8.5; W.missileMaxSpeed = 760; W.missileBoostTime = 2.6;
    this.weapons.missileCooldown = 0.2;          // hardpoints pace the player; this only stops double-taps in one frame
    this.applyQuality(this.quality);
    window.addEventListener('resize', () => this.resize());
    // Fullscreen (js/fullscreen.js; Settings › Graphics, key U): entering and leaving fire resize. Check the size on the
    // change event too, and a frame later, for browsers that report the change before the new size applies (only on a
    // real change: renderer.setSize clears the canvas even at the same size)
    const refit = () => { if (this.glHost.clientWidth !== this.post.width || this.glHost.clientHeight !== this.post.height) this.resize(); };
    onFullscreenChange(() => { refit(); requestAnimationFrame(refit); });
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); this.tabHidden(document.hidden); });
    const gesture = () => { this.audio.unlock(); this.awacs.preload(); this.music.play(); };
    // capture phase: menu panels stop propagation of their clicks, but audio must still unlock on the first gesture
    window.addEventListener('pointerdown', () => {
      gesture();
      // lock the pointer on the game container (locking the WebGL canvas itself dropped the context in some browsers)
      if (this.state === 'playing' && this.isMouseMode() && !(this.menu && this.menu.open)) this.input.requestPointerLock(this.root);
    }, { passive: true, capture: true });
    window.addEventListener('keydown', gesture);
    this.resetPlayer();
    this.chase.snap(this.player);
    this.resize();
    prewarmTimeOfDay(this.world, { bake: !this.bench });   // night ground lights before the precompile; idle-time preset bakes
    if (!PARAMS.has('noprecompile')) this.precompileShaders();
    if (!this.bench && !PARAMS.has('nowarm')) this.warmUpEffects();
    renderer.domElement.addEventListener('webglcontextlost', () => console.warn('WebGL context lost at t=' + this.time.toFixed(2) + ' (' + this.state + ')'), false);
    renderer.domElement.addEventListener('webglcontextrestored', () => { this.profiler.restore(); if (this.world.restoreGPU) this.world.restoreGPU(); this.drawCalls = 0; }, false);
    this.createMenuAndTouch();
    if (this.ui.loading) this.ui.loading.hidden = true;
    if (this.bench) this.startBench(); else this.menu.show('title');
    requestAnimationFrame((t) => this.loop(t));
  }

  /** Compile every material up front (parallel where KHR_parallel_shader_compile exists) so the first missile,
   *  explosion or debris doesn't hitch mid-fight. Hidden pooled objects are made visible just for the traversal. */
  precompileShaders() {
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try {
      const t0 = performance.now();
      // Compile against the HDR scene target the game actually draws into: program keys include the output color
      // space of the current render target, so compiling for the canvas would recompile everything on first use.
      const prevRT = this.renderer.getRenderTarget();
      if (this.post && this.post.rtScene) this.renderer.setRenderTarget(this.post.rtScene);
      const pr = this.renderer.compileAsync ? this.renderer.compileAsync(this.scene, this.camera) : null;
      this.renderer.setRenderTarget(prevRT);
      if (this.weapons.precompile) this.weapons.precompile(this.renderer, this.camera, this.post.rtScene || null);
      if (pr && pr.then) pr.then(() => { this.shaderCompileMs = performance.now() - t0; }).catch(() => {});
    } catch (e) { console.warn('shader precompile skipped', e); }
    for (const o of hidden) o.visible = false;
  }
  /**
   * Some drivers (e.g. ANGLE on D3D12) build pipeline state on the first real draw of each material even after the
   * shader is compiled, so effects that stay hidden until combat (tracers, missiles, smoke, explosions, debris,
   * flares, enemy jets, wing vapor) would hitch the first time they appear. Spawn one of everything far above the
   * map with a dummy bandit and render a single frame of it through a warm-up camera into the real scene target.
   */
  warmUpEffects() {
    try {
      const P = new THREE.Vector3(0, 9000, -4000);
      const type = this.airTypes['SLEET-21'] || Object.values(this.airTypes)[0];
      const dummy = this.spawnAircraft('SLEET-21', type, P.clone(), 0, 0);
      this.rebuildCombatList();
      if (!dummy.fxLite) { dummy.vapor && (dummy.vapor.visible = true); this.player.vapor && (this.player.vapor.visible = true); }   // (off on 'verylow')
      const w = this.weapons;
      for (let i = 0; i < 4; i++) w.fireGun(dummy);
      w.fireMissile(dummy, null);
      if (w.deployFlares) w.deployFlares(dummy);
      _v.copy(P).add(new THREE.Vector3(60, 0, -200)); w.explode(_v, 1.5);
      if (w.flakPuff) w.flakPuff(_v2.copy(P).add(new THREE.Vector3(-60, 20, -220)), false);
      w.terrainImpact(_v.add(new THREE.Vector3(80, 0, 0)));
      w.aircraftDeath(dummy);
      const cam = new THREE.PerspectiveCamera(70, this.camera.aspect, 1, 60000);
      cam.position.copy(P).add(new THREE.Vector3(0, 30, 160)); cam.lookAt(P.x, P.y, P.z - 150);
      cam.updateMatrixWorld();
      // Step the effects through their lifecycle (missile ignition, smoke, flares burning, debris, decay) and render
      // each stage once, so every material/blend/state combination gets its pipeline built now rather than mid-fight.
      const r = this.renderer, prev = r.getRenderTarget();
      // the Glassfall's blast materials and the night lights (settlements, unit lights) stay hidden until mid-mission too
      // (an INFINITY round turning dark showed the unit lights for the first time: a 0.2-1.2 s first-use stall)
      const extras = [this.world.groundLights, this.ground.lights].filter(Boolean), was = extras.map((o) => o.visible);
      this.glassfall.warmUp(true, _v2.copy(P).add(new THREE.Vector3(0, 0, -320)));
      for (const o of extras) o.visible = true;
      for (let step = 0; step < 14; step++) {
        w.update(step === 0 ? 1 / 60 : 0.15, this.combatList, cam);
        if (step === 6) { w.fireMissile(dummy, null); _v.copy(P).add(new THREE.Vector3(-70, 10, -260)); w.explode(_v, 0.7); }
        if (this.post.rtScene) { r.setRenderTarget(this.post.rtScene); r.render(this.scene, cam); }
      }
      // and one pass with frustum culling off, so what the warm-up camera can't see draws once too: the tunnel's three
      // materials otherwise stalled ~1 s each (first use) the first time the ridge came into view, title orbit included
      const culled = [];
      this.scene.traverse((o) => { if (o.frustumCulled && o.visible && (o.isMesh || o.isPoints || o.isLine)) { culled.push(o); o.frustumCulled = false; } });
      if (this.post.rtScene) { r.setRenderTarget(this.post.rtScene); r.render(this.scene, cam); }
      for (const o of culled) o.frustumCulled = true;
      r.setRenderTarget(prev);
      this.glassfall.warmUp(false);
      extras.forEach((o, i) => { o.visible = was[i]; });
      dummy.kill();
      for (const m of w.missiles) if (m.owner === dummy) m.alive = false;
      if (this.player.vapor) this.player.vapor.visible = false;
      this.rebuildCombatList();
    } catch (e) { console.warn('effect warm-up skipped', e); }
  }
  resize() {
    // devicePixelRatio follows browser zoom and the monitor: re-read it on every resize (the HUD reads it every frame)
    this._dprSeen = window.devicePixelRatio || 1;
    if (!PARAMS.has('dpr')) this.dpr = Math.min(this._dprSeen, PRESETS[this.quality].dprCap);
    const w = this.glHost.clientWidth || 1, h = this.glHost.clientHeight || 1;
    const post = this.post;
    if (post.setRenderScale) {
      // PostFX renders the scene at renderScale internally and composites at native resolution
      // canvasScale < 1 ('verylow'): the drawing buffer itself is smaller (the browser compositor stretches the canvas;
      // the HUD is its own layer and stays sharp), so the composite pass also runs at the reduced size
      const cs = this.canvasScale();
      this.renderer.setPixelRatio(this.dpr * cs);
      this.renderer.setSize(w, h, false);
      post.setSize(w, h, this.dpr * cs);
      post.setRenderScale(this.renderScale / cs);
    } else {
      const pr = this.dpr * this.renderScale;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
      post.setSize(w, h, pr);
    }
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.hud.resize();
    this.cacheHudSize();
  }
  /** Drawing-buffer scale of the current preset (PRESETS[].canvasScale, default 1): PostFX's render scale is relative to it. */
  canvasScale() { return PRESETS[this.quality].canvasScale || 1; }
  /** HUD host size (CSS px) for buildFrame's projections, read here on resize instead of every frame. */
  cacheHudSize() { this._hudW = this.hudHost.clientWidth || 1; this._hudH = this.hudHost.clientHeight || 1; }
  setRenderScale(s) {
    if (Math.abs(s - this.renderScale) < 1e-3) return;
    this.renderScale = s;
    if (this.post.setRenderScale) this.post.setRenderScale(s / this.canvasScale()); else this.resize();
  }
  /** Apply a quality tier to every subsystem that supports it. */
  applyQuality(tier, announce = false, allowSamples = true) {
    if (!PRESETS[tier]) return;
    this.quality = tier;
    const p = PRESETS[tier];
    if (!PARAMS.has('dpr')) this.dpr = Math.min(window.devicePixelRatio || 1, p.dprCap);
    if (!PARAMS.has('scale')) this.renderScale = Math.min(p.scaleMax, Math.max(p.scaleMin, this.renderScale));
    // Changing the MSAA sample count rebuilds every scene pipeline on first draw (multi-second stalls on some
    // drivers), so automatic tier steps keep the current count; only explicit menu choices change it.
    if (this.post.setSamples && allowSamples) this.post.setSamples(PARAMS.has('msaa') ? Number(PARAMS.get('msaa')) : p.samples);
    if (this.post.setQuality) this.post.setQuality(p.sub);
    if (this.world.setQuality) this.world.setQuality(p.sub);
    if (this.weapons) {
      // Particle overdraw is the FX cost on integrated GPUs: cap sprite size and trail density on lower tiers
      const fx = { verylow: [72, 30], low: [128, 45], medium: [192, 70], high: [256, 90], ultra: [256, 90] }[tier];
      this.weapons.maxPointSize = fx[0]; this.weapons.missileSmokeRate = fx[1];
      if (this.weapons.setQuality) this.weapons.setQuality(p.sub);
    }
    for (const ac of this.allAircraft || []) { if (ac.setEffectsQuality) ac.setEffectsQuality(p.sub); else if (ac.engineFX && ac.engineFX.setQuality) ac.engineFX.setQuality(p.sub); }
    this.dynres.reset(); this.stepDown.reset();
    if (this.hud) this.applyHudBudget();
    this.resize();
    this.updateGraphicsLabel();
    if (announce) this.message('GRAPHICS ' + (this.qualityChoice === 'auto' ? 'AUTO · ' : '') + p.label, false, 1.6);
  }
  cycleQuality(dir) {
    const i = CHOICES.indexOf(this.qualityChoice);
    this.qualityChoice = CHOICES[(i + dir + CHOICES.length) % CHOICES.length];
    saveChoice(this.qualityChoice);
    const tier = this.qualityChoice === 'auto' ? guessTier(this.gpuName) : this.qualityChoice;
    this.renderScale = PRESETS[tier].scaleMax;
    this.applyQuality(tier, true);
    this.audio.ui('select');
  }
  updateGraphicsLabel() {
    const txt = (this.qualityChoice === 'auto' ? 'AUTO · ' : '') + PRESETS[this.quality].label;
    if (this.menu && this.menu.setQualityLabel) this.menu.setQualityLabel(txt);
  }
  /** Dynamic resolution every frame; with Graphics on Auto, during a sortie, the step-down (js/quality.js StepDown):
   *  frames still slow (p75 > 28 ms for 4 s) with the render scale at the tier's floor drop one tier, announced on the
   *  HUD. Never up (only the Settings choice raises it), never below the lowest tier; re-armed by every mission/round load.
   *  rawMs: the unclamped frame interval. */
  updateDynamicResolution(dt, rawMs = dt * 1000) {
    if (this.state === 'paused') return;
    const prof = this.profiler, gpu = prof.mode === 'pass' ? prof.lastTotal.pass : 0;
    const fresh = prof.gpuSeq !== this._gpuSeq; this._gpuSeq = prof.gpuSeq;   // (GPU totals arrive every few frames)
    const P = PRESETS[this.quality];
    const r = this.dynres.update(dt, this.renderScale, P, gpu, dt * 1000, fresh);
    this.setRenderScale(r.scale);
    if (this.qualityChoice !== 'auto' || this.state !== 'playing') return;
    const i = TIERS.indexOf(this.quality);
    if (i <= 0) return;
    if (this.stepDown.update(dt, rawMs, this.renderScale <= P.scaleMin + 1e-3)) {
      const next = TIERS[i - 1];
      this.renderScale = PRESETS[next].scaleMax;
      this.applyQuality(next, true, false);          // (resets both controllers; keeps the MSAA count: no pipeline rebuild)
      this.stepDowns = (this.stepDowns || 0) + 1;
    }
  }
  /** CPU section timings are read only by the perf overlay and benchmarks: record them only then. */
  syncProfilerCpu() {
    this.profiler.cpuOn = !!this.bench || !!(this.ui.perf && !this.ui.perf.hidden);
    // GPU timer queries cost ~1 ms of main-thread time per pass timed (js/profiler.js): normal play times one whole
    // frame in four (dynamic resolution's input), the overlay one pass a frame round-robin, benchmarks every pass
    this.profiler.setPassPlan(this.bench ? 'all' : this.profiler.cpuOn ? 'rr' : 'single', this.bench || this.profiler.cpuOn ? 1 : 4);
    if (this.hud) this.hud.prof = this.profiler.cpuOn ? (this.hud.prof || {}) : null;   // per-group HUD times for the overlay
  }
  /** HUD cost control: a HUD that keeps costing > 6 ms per frame in flight (software Canvas2D: Firefox for Android; Chrome's
   *  accelerated canvas measured 0.2 ms on the same tablet) switches to budget mode for the rest of the session: a 0.75x
   *  backing store, the pitch ladder and radar scope blitted from cached images, no HUD damage gradient (PostFX's red
   *  pulse remains). ?hudres=0.5..1, ?hudcache=0|1 and ?hudsprites=0|1 (sprite-cached labels) force each part. build / draw: buildFrame and HUD.render ms this frame. */
  updateHudBudget(dt, build, draw) {
    const k = 1 - Math.exp(-dt * 2);
    this.hudBuildMs = (this.hudBuildMs || 0) + (build - (this.hudBuildMs || 0)) * k;
    this.hudDrawMs = (this.hudDrawMs || 0) + (draw - (this.hudDrawMs || 0)) * k;
    if (this.state !== 'playing' || this.hudSlow) return;
    this._hudSlowT = this.hudDrawMs > 6 ? (this._hudSlowT || 0) + dt : 0;
    if (this._hudSlowT > 3) { this.hudSlow = true; this.applyHudBudget(); }
  }
  applyHudBudget() {
    const slow = !!this.hudSlow;
    const res = PARAMS.has('hudres') ? Number(PARAMS.get('hudres')) : slow ? 0.75 : 1;
    const sprites = PARAMS.has('hudsprites') ? PARAMS.get('hudsprites') !== '0' : false;   // (no gain measured in Firefox)
    const cache = PARAMS.has('hudcache') ? PARAMS.get('hudcache') !== '0' : slow;
    if (this.hud.setBudget) this.hud.setBudget(res, sprites, cache);
  }
  updateOverlay(dt) {
    const el = this.ui.perf; if (!el || el.hidden) return;
    this._ovT = (this._ovT || 0) + dt; if (this._ovT < 0.25) return; this._ovT = 0;
    const L = this.profiler.live(), g = L.gpu;
    const H = this.hud && this.hud.prof ? Object.assign({ k: this.hud.k }, this.hud.prof) : null;
    const f = (v) => (v || 0).toFixed(1);
    const c = this.renderer.domElement, sc = this.renderScale;
    const iw = this.post.renderWidth || c.width, ih = this.post.renderHeight || c.height;
    el.textContent =
      `FPS ${L.fps.toFixed(0).padStart(3)}  frame ${f(L.frame)} ms\n` +
      (this.profiler.supported ? `GPU ${f(g.__total)} ms  scene ${f(g.scene)}  bloom ${f(g.bloom)}  comp ${f(g.composite)}\n` : 'GPU timing unavailable in this browser\n') +
      `CPU logic ${f(L.cpu.logic)}  render ${f(L.cpu.render)}  hud ${f(L.cpu.hud)} (build ${f(this.hudBuildMs)} draw ${f(this.hudDrawMs)})\n` +
      (H ? `HUD ${H.k.toFixed(2)}x${this.hud.cacheLayers ? ' cached' : ''}${this.hud.spriteText ? ' sprites' : ''}${this.hudSlow ? ' (slow: budget)' : ''}  clear ${f(H.clear)} att ${f(H.attitude)} hdg ${f(H.heading)} tapes ${f(H.tapes)} gauges ${f(H.gauges)} radar ${f(H.radar)} marks ${f(H.markers)} text ${f(H.text)}\n` : '') +
      `RES ${iw}x${ih} (${sc.toFixed(2)})  MSAA ${this.post.activeSamples ?? '?'}x  ${(this.qualityChoice === 'auto' ? 'AUTO ' : '') + PRESETS[this.quality].label}\n` +
      `draws ${this.drawCalls}  tris ${(this.triangles / 1000).toFixed(0)}k\n${this.gpuName.replace(/^ANGLE \(|\)$/g, '').slice(0, 60)}`;
  }

  // ---------- flow ----------
  resetPlayer() {
    const p = this.player;
    p.reset({ position: new THREE.Vector3(0, 800, 0), heading: 0, health: 100 });
    p.quaternion.identity();
    p.speed = 230; p.throttle = 0.72;
    p.velocity.set(0, 0, -p.speed);
    p.ammo = FLIGHT.AMMO; p.maxMissiles = FLIGHT.MAX_MISSILES; p.missiles = FLIGHT.MAX_MISSILES;
    p.immortal = false;                    // (missionComplete sets it)
    p.missileCap = (this.diff || DIFFICULTY.normal).playerMissiles; p._missileAt = undefined; p._inboundCount = 0;   // (EnemyBrain.canLaunchAt)
    this.inTunnel = false;                 // respawned in the open: no stale tunnel state (radio calls, camera clamp)
    this.hardpoints = new Array(HARDPOINTS).fill(0); this.flareT = 0;
    this.syncAim();
  }
  /** Start the campaign from mission 1, or retry the current mission. */
  startMission(retry = false) {
    this.audio.unlock();
    this.audio.ui('start');
    if (!retry) { this.missionIndex = 0; this.score = 0; this.kills = 0; }
    this.loadMission(this.missionIndex);
  }
  setState(s) {
    this.state = s;
    const u = this.ui;   // overlays are optional (the menu module may own these screens)
    if (u.title) u.title.hidden = s !== 'title';
    if (u.pause) u.pause.hidden = s !== 'paused';
    if (u.dead) u.dead.hidden = s !== 'dead';
    if (this.touch) this.touch.setVisible(s === 'playing' ? true : s === 'paused' ? 'paused' : false);
    if (this.music) this.music.setMuffled(s !== 'playing');
  }
  /** Load mission i (wraps around the campaign): reset and fully rearm the player, clear the field, spawn phase 1. */
  loadMission(i) {
    this.leaveInfinity();                  // (a campaign sortie after an INFINITY run: the difficulty setting is back)
    const list = this.missions, n = list.length;
    this.missionIndex = i;
    const M = this.mission = list[((i % n) + n) % n];
    this.glassfall.reset();                // no Glassfall event running (js/glassfall.js)
    this.applyTime(M.time, M.red ? 1 : 0); // lighting preset (js/timeofday.js; red: its Glassfall variant), before anything spawns
    this.glassfall.prepare(M);             // a Glassfall mission: its red end state's environment map, rendered now
    this.resetPlayer();
    this.setSortieFrame();                 // the frame every phase of the mission is placed in (spawnGroup)
    this._nextAnchor = null;               // (nextPhase: later phases are anchored where the previous one's targets stood)
    // a quiet lead-in: the player starts mission.startBack m behind the sortie frame (default START_BACK); the layout
    // stays where the frame puts it
    { const p = this.player, F = this.sortieFrame, back = M.startBack ?? START_BACK, w = this.world;
      const x = F.x - Math.sin(F.bearing) * back, z = F.z + Math.cos(F.bearing) * back;
      let y = F.y;   // over the terrain along the first 3 km of the heading, and out of the tunnel ridge
      for (let d = 0; d <= 3000; d += 250) y = Math.max(y, w.getHeight(x + Math.sin(F.bearing) * d, z - Math.cos(F.bearing) * d) + 450);
      p.position.set(x, this.clearSpawnY(x, y, z), z); }
    if (this.flights) this.flights.clear();
    (this._pending || (this._pending = [])).length = 0; this._sites = {};
    this.chase.snap(this.player);
    if (this.squad) this.squad.spawn(M, this.player);   // squadmates in mission.wingmen form up on the player
    this._slotT = 0;                                       // hand out attack slots on the first frame
    for (const e of this.enemies) e.kill();
    this.ground.clear(); this.allied.clear();
    for (const m of this.weapons.missiles) m.alive = false;
    this.messages.length = 0;
    this.target = null; this.lockTimer = 0; this.locked = false;
    this.phaseIndex = -1; this.waveTimer = 0; this.missionDoneT = 0; this.killTimes.length = 0;
    this.lowHealthSaid = false;
    this.fireGrace = 0.35;                 // the button that launched the sortie must not also fire a weapon
    if (this.audio.setPaused) this.audio.setPaused(false);   // e.g. a restart from the pause menu
    this.setState('playing');
    this.message(`MISSION ${M.id}: ${String(M.name).toUpperCase()}`, true, 4.5);
    if (M.briefing) for (const line of String(M.briefing).split(/(?<=[.!?])\s+/).slice(0, 3)) this.message(line, false, 7);
    this.say('sortieStart', 3);
    this.nextPhase();
    this.stepDown.reset();                 // the step-down judges this sortie afresh, after its load and bakes
  }
  /** Lighting preset `name` (js/timeofday.js; ?tod=<name> overrides it): values only, rebuilds the sky, shadow and
   *  environment only when the preset changes. */
  applyTime(name, glass = 0, env = true) {
    const want = PARAMS.has('tod') ? PARAMS.get('tod') : this.bench ? 'day' : name;   // benchmarks stay comparable: day
    if (this.bench) glass = 0;
    if (want === this.timeOfDay && glass === this.todGlass && this._todApplied) { if (env === true) this.world.refreshEnvironment(); return; }
    this.timeOfDay = applyTimeOfDay(want, { world: this.world, post: this.post, weapons: this.weapons }, glass, env);
    this.todGlass = glass;                 // 0..1 toward the red Glassfall variant (js/glassfall.js steps it)
    this.bloomBase = this.post.bloomStrength;   // the preset's bloom (the Glassfall's bloom pulse adds to it)
    this._todApplied = true;
  }
  /** Spawn the next phase of the current mission, or complete the mission after the last one. */
  nextPhase() {
    const M = this.mission;
    this.phaseIndex++;
    if (this.phaseIndex >= M.phases.length) {
      // M20: clearing the last phase starts the Glassfall ending in place of the completion (it completes the mission)
      if (M.glassfall === 'mainspring' && !this.glassfall.played) { this.glassfall.startMainspring(); return; }
      this.missionComplete(); return;
    }
    const P = M.phases[this.phaseIndex];
    let air = 0, ground = 0, naval = 0;
    const allowed = (this.diff || DIFFICULTY.normal).groups;
    const spawns = (g) => !g.difficulty || allowed.includes(g.difficulty);
    // every air group of a phase with a boss flies with the boss: committed at once (spawnAirGroup)
    this._bossPhase = P.groups.some((g) => g.kind === 'air' && spawns(g) && (this.airTypes[g.type] || {}).bars > 0);
    const Q = this._pending || (this._pending = []); Q.length = 0;
    // the phase's anchor (the frame's origin): the sortie start, then where the previous phase's targets stood, so a
    // phase is laid out around where the fight is, the same way on every attempt
    const F = this.sortieFrame || this.setSortieFrame();
    if (this._nextAnchor) { F.x = this._nextAnchor.x; F.z = this._nextAnchor.z; }
    // air groups go around the anchor too, unless a later phase finds the player more than AIR_SLACK from it: then
    // around the player (time to engagement; surface groups and the layout's shape stay as authored)
    const pp = this.player.position;
    this._airFrame = this.phaseIndex > 0 && Math.hypot(pp.x - F.x, pp.z - F.z) > AIR_SLACK ? { x: pp.x, y: F.y, z: pp.z, bearing: F.bearing } : null;
    this.seeded(this.placementSeed(-1), () => this.spawnAllies(false));   // allied units first: enemy groups keep clear
    this._line = null; this._lineGroups = P.groups.filter((g) => g.area === 'line' && spawns(g)).length;   // (spawnSurfaceGroup)
    const place = (pass) => P.groups.forEach((g, gi) => {   // pass 1: groups placed from others (near)
      if (!spawns(g) || !!g.near !== (pass === 1)) return;
      if (g.after > 0) { Q.push({ g, gi, at: this.time + g.after, site: null }); return; }   // enters later (spawnPending)
      const k = this.spawnGroup(g, gi);
      if (g.kind === 'air') air += k; else if (g.kind === 'naval') naval += k; else ground += k;
    });
    place(0);
    // where this phase's surface units stand, by type: the sites of air groups `near` them, now or in a later phase
    const S = this._sites || (this._sites = {});
    for (const g of P.groups) if (g.kind !== 'air' && spawns(g) && !(g.after > 0)) { const c = this.enemyCentroid(g.type, _v3); if (c) S[g.type] = { x: c.x, z: c.z }; }
    place(1);
    for (const q of Q) if (q.g.near && S[q.g.near]) q.site = S[q.g.near];   // a delayed group's site is fixed now
    let ax = 0, az = 0, an = 0;   // the next phase's anchor: the centre of this phase's required surface sites, if any
    for (const g of P.groups) if (g.kind !== 'air' && spawns(g) && !g.optional && !(g.after > 0) && S[g.type]) { ax += S[g.type].x; az += S[g.type].z; an++; }
    if (an) this._nextAnchor = { x: ax / an, z: az / an };
    this._fight = an ? this._nextAnchor : { x: F.x, z: F.z };   // where this phase's fight is (spawnPending, fleetApproach)
    this.seeded(this.placementSeed(-2), () => this.spawnAllies(true));    // allied units placed beside this phase's enemies
    if (this.flights) this.flights.restart(this.time);
    this._phaseLive = false;               // (updateGame: a phase that opens empty waits for its delayed groups)
    this.rebuildCombatList();
    this.directBandits();                  // the new bandits take whichever hunting role is short
    this._slotT = 0;                       // and attack slots (who may fire) are handed out on the next frame
    if (this.squad) this.squad.newWave();  // squadmates pick a bandit within a second
    this.wave = this.phaseIndex + 1;
    if (this.phaseIndex > 0) {
      // ammo refresh between phases (missiles, cannon, flares); hull carries over within a mission
      const pl = this.player; pl.missiles = pl.maxMissiles; pl.ammo = FLIGHT.AMMO; this.flareT = 0;
      this.message((P.label || 'New contacts').toUpperCase(), true, 3);
      if (air) this.say('newContacts', 2);
      this.audio.ui('wave');
    }
    if (ground) this.say('groundTargets'); else if (naval) this.say('navalTargets');
    const parts = [];
    if (air) parts.push(`${air} AIR`); if (ground) parts.push(`${ground} GROUND`); if (naval) parts.push(`${naval} NAVAL`);
    if (parts.length) this.message(parts.join(' · ') + ' TARGETS', false, 4);
    if (P.glassfall) this.glassfall.startSalvos(P.glassfall);   // M15: the Thunderhead salvos (js/glassfall.js)
  }
  missionComplete() {
    this.missionDoneT = 0.001;
    this.player.immortal = true;           // nothing can shoot the player down from here on (Weapons: immortals take no hits)
    this.score += 3000 + 1000 * this.missionIndex;
    this.message('MISSION COMPLETE', true, 5.5);
    this.say('missionComplete', 3);
    this.audio.ui('wave');
  }
  // ---------- INFINITY (js/infinity.js): endless rounds, one life, both squadmates ----------
  /** A new run from round 1. A run still going ends first (it counts toward the local best). The run's ramp stands in
   *  for the difficulty setting until it ends (leaveInfinity). ?infseed=N fixes the run seed. */
  startInfinity() {
    if (this.infinity && !this.infinity.over) this.infinity.finish('ABANDONED');
    const seed = PARAMS.has('infseed') ? Number(PARAMS.get('infseed')) : undefined;
    this.glassfall.reset();
    const run = this.infinity = new InfinityRun({ difficulty: DIFFICULTY, missileLoad: FLIGHT.MAX_MISSILES, missileDamage: this.weapons.missileDamage, seed });
    this.mission = run.mission;            // { name: 'Infinity', wingmen: ['2', '3'], phases: [] }: both squadmates fly
    this.score = 0; this.kills = 0;
    this.applyRamp(run.ramp);
    this.resetPlayer();
    if (this.flights) this.flights.clear();
    (this._pending || (this._pending = [])).length = 0; this._sites = {};
    this.chase.snap(this.player);
    if (this.squad) this.squad.spawn(run.mission, this.player);
    this._slotT = 0;
    for (const e of this.enemies) e.kill();
    this.ground.clear(); this.allied.clear();
    for (const m of this.weapons.missiles) m.alive = false;
    this.messages.length = 0;
    this.target = null; this.lockTimer = 0; this.locked = false;
    this.waveTimer = 0; this.missionDoneT = 0; this.killTimes.length = 0; this.infT = -1;
    this.lowHealthSaid = false;
    this.fireGrace = 0.35;                 // the button that started the run must not also fire a weapon
    if (this.audio.setPaused) this.audio.setPaused(false);
    this.setState('playing');
    this.message('INFINITY', true, 4);
    this.say('sortieStart', 3);
    this.nextRound();
  }
  /** The next round of the run: its ramp becomes the difficulty; its aircraft hold at generic flight stations around the
   *  player (spawnGenerated) and its land and sea groups are placed from the player's position and heading as the round
   *  starts (spawnGroup), every draw from the round's seed. */
  nextRound() {
    const plan = this.infinity.nextRound();
    this.applyTime(plan.time, 0, 'defer'); // INFINITY rotates the lighting every few rounds (js/infinity.js timeForRound); the
                                           // environment map follows two frames later (World.setLighting)
    this.applyRamp(plan.ramp);
    this.infT = -1; this.waveTimer = 0;
    this.wave = plan.round; this.phaseIndex = plan.round - 1;
    this.setSortieFrame();
    this.fitSurfaceSpots(plan.groups);
    this._bossPhase = false;
    let ground = 0, naval = 0;
    const air = [];
    plan.groups.forEach((g, gi) => {
      if (g.kind === 'air') { air.push(g); return; }
      const k = this.spawnGroup(g, gi);
      if (g.kind === 'naval') naval += k; else ground += k;
    });
    const nAir = this.spawnGenerated(air, plan.seed);   // also rebuilds the lists, directs bandits, wakes the squadmates
    if (!nAir) { this.rebuildCombatList(); this.directBandits(); this._slotT = 0; if (this.squad) this.squad.newWave(); }
    this.message(`ROUND ${plan.round}`, true, 3.5);
    if (plan.bounty) this.message(`BOUNTY · ${plan.bounty}`, true, 4.5);
    const parts = [];
    if (nAir) parts.push(`${nAir} AIR`); if (ground) parts.push(`${ground} GROUND`); if (naval) parts.push(`${naval} NAVAL`);
    if (parts.length) this.message(parts.join(' · ') + ' TARGETS', false, 4);
    if (plan.round > 1) { if (nAir) this.say('newContacts', 2); this.audio.ui('wave'); }
    this.stepDown.reset();                 // (each round's spawns and lighting swap: a fresh grace period)
    if (ground) this.say('groundTargets'); else if (naval) this.say('navalTargets');
  }
  /** INFINITY: the round's land spot and its sea spot each on the first side (the planned one first) whose terrain at
   *  the planned distance suits it (dry land, open sea), so surface groups start ~4-5 km out rather than wherever the
   *  site search has to go. Every land group keeps the one land spot, every sea group the one sea spot. */
  fitSurfaceSpots(groups) {
    const F = this.sortieFrame, deg = { ahead: 0, right: 90, behind: 180, left: 270 }, order = ['ahead', 'right', 'behind', 'left'];
    for (const naval of [false, true]) {
      const G = groups.filter((g) => g.kind !== 'air' && (g.kind === 'naval') === naval);
      if (!G.length) continue;
      const d = G[0].distance || 4500, i0 = Math.max(0, order.indexOf(G[0].position));
      for (let k = 0; k < 4; k++) {
        const side = order[(i0 + k) % 4], b = F.bearing + deg[side] * Math.PI / 180;
        const h = this.world.getHeight(F.x + Math.sin(b) * d, F.z - Math.cos(b) * d);
        if (naval ? h < -5 : h > 5) { for (const g of G) g.position = side; break; }
      }
    }
  }
  /** Round flow (updateGame, in place of the campaign's phases): AREA CLEAR once nothing hostile is left (`left` = live
   *  enemy aircraft and surface units), a full rearm and a hull patch, then the next round after the intermission. */
  updateRounds(dt, left) {
    const run = this.infinity, p = this.player;
    if (!p.alive || run.over) return;
    if (this.infT >= 0) {
      this.infT -= dt;
      // the next round's lighting, while nothing is flying: its shadow and sky bakes (if idle time hasn't done them) and,
      // mid-intermission, its environment map (World.prepareEnvVariant), so the round change only swaps cached data
      const P = this._nextTod;
      if (P) { this.world.bakeTick(2); if (this.infT < 3) { this.world.prepareEnvVariant(P); this._nextTod = null; } }
      if (this.infT < 0) this.nextRound();
      return;
    }
    if (left > 0) { this.waveTimer = 0; return; }
    this.waveTimer += dt;
    if (this.waveTimer <= 0.1) return;
    this.waveTimer = 0;
    const I = run.clearRound();
    p.missiles = p.maxMissiles; p.ammo = FLIGHT.AMMO; this.flareT = 0; this.hardpoints.fill(0);   // full rearm
    p.health = run.repairedHealth(p.health, 100);                                               // hull +35 %, capped
    if (p.health >= 35) this.lowHealthSaid = false;
    this.infT = I.seconds;
    { const name = PARAMS.has('tod') ? PARAMS.get('tod') : this.bench ? 'day' : timeForRound(run.round + 1, run.seed);
      this._nextTod = name !== this.timeOfDay ? timePreset(name) : null;
      if (this._nextTod) this.world.queueLighting(this._nextTod.sun, true); }
    this.message('AREA CLEAR', true, 2.5);
    this.message(`REARMED · HULL ${Math.round(p.health)}%`, false, 3.5);
    this.say('waveClear', 2); this.audio.ui('wave');
  }
  /** A round's ramp (js/infinity.js rampAt) as the difficulty: the fields applySetting('difficulty') sets. */
  applyRamp(R) {
    const d = this.diff = R.diff;
    this.armor = d.armor; this.skillOffset = d.skill;
    if (this.player) this.player.missileCap = d.playerMissiles;
  }
  /** Out of INFINITY (campaign sortie, quit to title): a run still going ends (it counts toward the local best), and the
   *  difficulty setting applies again. */
  leaveInfinity(reason = 'ABANDONED') {
    const run = this.infinity;
    if (!run) return;
    if (!run.over) run.finish(reason);
    this.infinity = null; this.infT = -1;
    this.applySetting('difficulty', this.settings.difficulty);
  }
  /** Rebuilt when units spawn or die, never per frame. combatList: the player and every live hostile (what the player
   *  can target, what the HUD lists). hostiles: the same minus the player, all that the player's team (player,
   *  squadmates) is tested against; its first _nAir entries are the enemy aircraft (all that allied flak looks at).
   *  enemyTargets: the player and the flying squadmates, all that enemy rounds, missiles and SAMs are tested against
   *  (bandits never hit each other; squadmates are immortal: a round stops at one with a visible hit, a missile airbursts). */
  rebuildCombatList() {
    const L = this.combatList, H = this.hostiles, E = this.enemyTargets; L.length = 0; H.length = 0; E.length = 0;
    for (const a of this.allAircraft) { if (a === this.player) L.push(a); else if (a.alive && a.team !== 'player') { L.push(a); H.push(a); } }
    this._nAir = H.length;
    for (const t of this.ground.targets) if (t.alive && t.team !== 'player') { L.push(t); H.push(t); }
    E.push(this.player);
    for (let i = 0; i < this.allies.length; i++) if (this.allies[i].alive) E.push(this.allies[i]);
    this.combatDirty = false;
  }
  /**
   * Bandit director (about every 1 s, and right after a phase spawns). Of the N live armed bandits, D = min(N, max(1,
   * ceil(share x N))) should hunt the player (share per difficulty; all N when no squadmate flies), the rest a squadmate.
   * New spawns, and a bandit whose squadmate target is gone, take the role that is short at once, nearest the player
   * first. Otherwise at most one role change per tick, only while the player-hunter count H is outside D +- 1 (exactly D
   * when N <= 3), and never for a bandit that changed role in the last 10 s: the squadmate-hunter nearest the player
   * breaks off to come for the player, or the player-hunter farthest away leaves for the squadmate with fewer hunters.
   * Bosses always hunt the player. Nothing else changes a bandit's target. Bandits of holding flights (js/flights.js)
   * don't count: they get a role when their flight commits.
   */
  directBandits() {
    const p = this.player, A = this.allies, now = this.time;
    if (!p.alive) return;
    const pend = this._pend || (this._pend = []); pend.length = 0;
    let N = 0, H = 0, near = null, far = null, nearD = Infinity, farD = -1;
    for (let i = 0; i < A.length; i++) A[i]._hunters = 0;
    for (const e of this.enemies) {
      const b = e.brain;
      if (!e.alive || !b || b.passive || isHolding(e)) continue;   // holding flights stay out until they commit
      N++;
      const d2 = e._d2 = e.position.distanceToSquared(p.position);
      if (!b.role || (b.role === 'squad' && !(b.target && b.target.alive))) { pend.push(e); continue; }
      const free = now - b.roleSince >= 10;
      if (b.role === 'player') { H++; if (free && !(e.bossBars > 0) && d2 > farD) { farD = d2; far = e; } }
      else { b.target._hunters++; if (free && d2 < nearD) { nearD = d2; near = e; } }
    }
    const D = A.length ? Math.min(N, Math.max(1, Math.ceil((this.diff || DIFFICULTY.normal).playerShare * N))) : N;
    if (pend.length) {
      pend.sort(byDistance);
      for (const e of pend) { const hunt = H < D || e.bossBars > 0; this.setRole(e, hunt, true); if (hunt || !A.length) H++; }
      return;
    }
    if (N <= 3 ? H === D : H >= D - 1 && H <= D + 1) return;
    if (H < D) { if (near) this.setRole(near, true, false); }
    else if (far) this.setRole(far, false, false);
  }
  /** Role setter for directBandits: hunt the player, or the squadmate with fewer hunters (its _hunters count). */
  setRole(e, hunt, isNew) {
    const b = e.brain, A = this.allies;
    b.roleSince = this.time;
    if (hunt || !A.length) {
      b.role = 'player'; b.target = this.player; b.threat = null;
      if (!isNew) b.aggressor = false;     // breaking off to come for the player: it waits for an attack slot
    } else {
      const a = A.length > 1 && A[1]._hunters < A[0]._hunters ? A[1] : A[0];
      a._hunters++;
      b.role = 'squad'; b.target = a; b.threat = this.player; b.aggressor = true;   // the player's guns still scare it
    }
  }
  /**
   * Place one mission group: air groups by their task (spawnAirGroup), surface groups on suitable terrain. Campaign
   * placement is fixed per mission: positions are taken in the sortie frame (this.sortieFrame: where and which way the
   * sortie started), not from wherever the player has flown since, and every random draw comes from a stream seeded by
   * mission, phase and the group's index gi in its phase (placementSeed), so each attempt and retry lays the mission out
   * the same way. `position` is a side ('ahead' = the frame's heading, i.e. north) or a bearing in degrees. An air group
   * with a surface type as `near` is placed from where that type's units stand (this phase's, else the latest earlier
   * phase's: this._sites; `site` for a delayed group), `distance` m (default 0) toward its `position`.
   */
  spawnGroup(g, gi = 0, site = null) {
    const rand = mulberry32(this.placementSeed(gi)), F = this.sortieFrame || this.setSortieFrame();
    const rel = typeof g.position === 'number' ? g.position * Math.PI / 180   // a bearing (deg) in the sortie frame
      : { ahead: 0, high: 0, low: 0, left: -Math.PI / 2, right: Math.PI / 2, behind: Math.PI }[g.position];
    const bearing = F.bearing + (rel !== undefined ? rel : (rand() - 0.5) * 1.6) + (rand() - 0.5) * 0.35;
    const anchor = g.kind === 'air' && g.near && !this.airTypes[g.near] ? site || (this._sites && this._sites[g.near]) || this.enemyCentroid(g.near, _site) : null;
    const A = g.kind === 'air' && this._airFrame ? this._airFrame : F;
    const ox = anchor ? anchor.x : A.x, oz = anchor ? anchor.z : A.z;
    const dist = anchor ? g.distance || 0 : g.distance || (g.kind === 'air' ? 5000 : 7000);
    let cx = THREE.MathUtils.clamp(ox + Math.sin(bearing) * dist, -WORLD_HALF * 0.85, WORLD_HALF * 0.85);
    let cz = THREE.MathUtils.clamp(oz - Math.cos(bearing) * dist, -WORLD_HALF * 0.85, WORLD_HALF * 0.85);
    // target 'fleet': past the frame origin from the allied fleet, flying at it (js/allies.js leakers)
    const atFleet = g.target === 'fleet' && g.kind === 'air' && this.allied && this.allied.ships.length > 0;
    if (atFleet) { this.fleetApproach(g, dist, _v2, rand); cx = _v2.x; cz = _v2.z; }
    this._spawnOptional = !!g.optional; this._spawnAtFleet = atFleet;
    const n = g.kind === 'air' ? this.spawnAirGroup(g, cx, cz, rand) : this.seeded(rand() * 4294967296, () => this.spawnSurfaceGroup(g, cx, cz));
    this._spawnAtFleet = false;
    return n;
  }
  /** Sortie frame: where and which way the sortie starts (the player's pose at mission load). Campaign groups are
   *  placed in it (spawnGroup), so their layout never depends on where the player has flown since. */
  setSortieFrame() {
    const p = this.player; p.getForward(_fwd);
    this._airFrame = null;
    return (this.sortieFrame = { x: p.position.x, y: p.position.y, z: p.position.z, bearing: Math.atan2(_fwd.x, -_fwd.z) });
  }
  /** Seed of a campaign placement stream: fixed per mission, phase and group index gi (allies use negative ones). */
  placementSeed(gi) {
    if (this.infinity && this.infinity.plan) return this.infinity.plan.seed ^ Math.imul(gi + 101, 83492791);   // INFINITY: per round
    const n = this.missions.length, mi = ((this.missionIndex % n) + n) % n;
    return Math.imul(mi + 1, 73856093) ^ Math.imul(this.phaseIndex + 1, 19349663) ^ Math.imul(gi + 101, 83492791);
  }
  /** fn() with Math.random drawing from a stream seeded with `seed`, for placement code that calls Math.random itself
   *  (surface sites and unit offsets, allied groups); the real generator is back afterwards for everything else. */
  seeded(seed, fn) {
    const real = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = real; }
  }
  /** Delayed groups (groups[].after): spawn the ones that are due, or all of them once the field is otherwise clear. */
  spawnPending(all) {
    const Q = this._pending;
    let n = 0, air = 0;
    for (let i = 0; i < Q.length; i++) {
      const q = Q[i];
      if (!all && this.time < q.at) continue;
      Q.splice(i--, 1);
      // a wave entering while the player is far from the phase's anchor enters around the player (time to engagement)
      const F = this.sortieFrame, C = this._fight || F, pp = this.player.position;
      if (q.g.kind === 'air' && F && Math.hypot(pp.x - C.x, pp.z - C.z) > AIR_SLACK) this._airFrame = { x: pp.x, y: F.y, z: pp.z, bearing: F.bearing };
      const k = this.spawnGroup(q.g, q.gi, q.site);
      n += k; if (q.g.kind === 'air') air += k;
    }
    if (!n) return;
    this.rebuildCombatList(); this.directBandits(); this._slotT = 0;
    if (this.squad) this.squad.newWave();
    if (air) { this.message('NEW CONTACTS', false, 3); this.say('newContacts', 2); }
  }
  /**
   * Spawn point for an air group with target 'fleet': `dist` m from the sortie frame's origin (where the sortie began)
   * on the far side from the allied fleet (swung ~23 deg to the group's 'left' / 'right'), so it flies past there to
   * reach the fleet. Takes the least swung of 16 bearings that stays on the map and is no nearer the fleet than
   * max(dist, the origin's own distance); failing that (the origin near a map edge with the fleet inland of it), the
   * least swung on the map at least dist from the fleet (at least dist / cruise speed of flight: 7 km at a Bodkin's
   * 182 m/s = 38 s), else the bearing on the map farthest from the fleet. Writes out (x, z).
   */
  fleetApproach(g, dist, out, rand = Math.random) {
    const O = this.sortieFrame || this.setSortieFrame(), F = this.allied.fleetCenter, lim = WORLD_HALF * 0.85, pp = this.player.position;
    // past the sortie frame's origin, or past the player when they are far from the phase's fight (time to engagement)
    const C = this._fight || O, p = Math.hypot(pp.x - C.x, pp.z - C.z) > AIR_SLACK ? _v.set(pp.x, 0, pp.z) : _v.set(O.x, 0, O.z);
    let ux = p.x - F.x, uz = p.z - F.z;
    const d = Math.hypot(ux, uz);
    if (d < 300) { ux = Math.cos(O.bearing); uz = Math.sin(O.bearing); }   // over the fleet: from the frame's right
    const pref = Math.atan2(uz, ux) + (g.position === 'right' ? 0.4 : g.position === 'left' ? -0.4 : 0) + (rand() - 0.5) * 0.3;
    let tier = 4, far = -1;   // 1: past the origin, 2: >= dist from the fleet, 3: on the map, farthest from it, 4: clamped
    for (let k = 0; k < 16 && tier > 1; k++) {
      const a = pref + (k & 1 ? 1 : -1) * ((k + 1) >> 1) * (Math.PI / 8);   // 0, +22.5, -22.5, +45 ... 180 deg
      let x = p.x + Math.cos(a) * dist, z = p.z + Math.sin(a) * dist;
      const onMap = Math.abs(x) <= lim && Math.abs(z) <= lim;
      if (!onMap) { x = THREE.MathUtils.clamp(x, -lim, lim); z = THREE.MathUtils.clamp(z, -lim, lim); }
      const f = Math.hypot(x - F.x, z - F.z);
      const t = !onMap ? 4 : f >= Math.max(dist, d) ? 1 : f >= dist ? 2 : 3;
      if (t < tier || (t === tier && t >= 3 && f > far)) { tier = t; far = f; out.set(x, 0, z); }   // tiers 1-2: least swung wins
    }
    return out;
  }
  /**
   * Air group of g.count (at most 8) around (cx, cz), flown by its task:
   *   bosses (types with bars): as before, in formation; every other group in a boss's phase engages with it;
   *   unarmed types: transit straight (a target 'fleet' group runs at the allied fleet), or with task 'patrol' hold an
   *     orbit for good (an AWACS on station), or with 'scramble' climb out as below, then transit;
   *   armed types split into flights (pairs; flight: 4 for named aces; a leftover single flies alone):
   *     'engage'   flights spread across the approach ~1.8 km apart, committed at once;
   *     'patrol'   (default) each flight orbits its own station: the first over (cx, cz), the rest ~2.6 km around it;
   *     'escort'   flights hold station beside the group of type `near` that entered with them, and commit with it;
   *     'scramble' flights appear low over (cx, cz) in a line on a takeoff heading and climb out, then commit.
   * Headings and formations are taken in the sortie frame and every random draw comes from rand (the group's seeded
   * placement stream), so the layout is the same on every attempt. Stations keep their orbits on the map, clear of the
   * tunnel ridge and above the terrain under them; spawn points stay on the map, over the terrain and out of the ridge.
   */
  spawnAirGroup(g, cx, cz, rand = Math.random) {
    const typeName = g.type || 'SLEET-21';
    const type = this.airTypes[typeName] || FALLBACK_AIR_TYPES['SLEET-21'];
    const n = Math.max(1, Math.min(g.count || 1, 8));
    const O = this._airFrame || this.sortieFrame || this.setSortieFrame();
    const groundH = Math.max(this.world.getHeight(cx, cz), 0);
    const altOff = g.position === 'high' ? 900 : g.position === 'low' ? -350 : (rand() - 0.4) * 600;
    const alt = THREE.MathUtils.clamp(O.y + altOff, groundH + 450, 4500);
    _v2.set(cx, alt, cz);
    const heading = Math.abs(cx - O.x) + Math.abs(cz - O.z) > 1 ? yawToward(_v2, _v.set(O.x, alt, O.z)) : O.bearing;
    let task = type.bars > 0 ? 'boss' : this._bossPhase ? 'engage' : g.task || 'patrol';
    if (type.armed === false) task = (g.task === 'patrol' || g.task === 'scramble') && !this._spawnAtFleet ? g.task : 'transit';
    if (task === 'boss' || task === 'transit') {
      const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
      for (let i = 0; i < n; i++) {
        let lat = 0, back = 0;
        const f = g.formation || 'vee', k = (i + 1) >> 1, side = i % 2 ? -1 : 1;
        if (f === 'line') lat = (i - (n - 1) / 2) * 160;
        else if (f === 'pair') { lat = (i % 2 ? 1 : -1) * 80; back = (i >> 1) * 320; }
        else if (f === 'loose') { lat = (rand() - 0.5) * 1200; back = rand() * 700; }
        else { lat = k * side * 140; back = k * 120; }
        const x = cx + rx * lat - fx * back, z = cz + rz * lat - fz * back;
        const y = this.clearSpawnY(x, Math.max(alt + (rand() - 0.5) * 60, Math.max(this.world.getHeight(x, z), 0) + 350), z);
        this.spawnAircraft(typeName, type, new THREE.Vector3(x, y, z), heading, i);
      }
      for (const e of this.enemies) e._pending = false;
      return n;
    }
    const FL = this.flights || (this.flights = new Flights(this.world, this.tunnel, WORLD_HALF));
    const size = Math.max(1, Math.min(g.flight || 2, 4)), k = Math.ceil(n / size);
    const R = orbitRadius(FLIGHT.CRUISE_SPEED * cruiseScale(type));
    const charges = task === 'escort' ? this.escortCharges(g.near) : null;
    if (task === 'escort' && !charges) task = 'patrol';   // nothing to escort (its group didn't spawn): hold an orbit
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
    const a0 = rand() * Math.PI * 2, runway = rand() * Math.PI * 2, escorts = charges ? [] : null;
    // time to engagement: a patrol's centre within HOLD_MAX - 500 m of the anchor (its flights within HOLD_MAX), a
    // scramble within SCRAMBLE_MAX (the end of the base nearest the fight)
    const near = (x, z, lim) => { const d = Math.hypot(x - O.x, z - O.z); return d > lim ? _v.set(O.x + (x - O.x) * lim / d, 0, O.z + (z - O.z) * lim / d) : _v.set(x, 0, z); };
    if (task === 'patrol' || task === 'scramble') { near(cx, cz, task === 'patrol' ? HOLD_MAX - 500 : SCRAMBLE_MAX); cx = _v.x; cz = _v.z; }
    for (let j = 0, i0 = 0; j < k; j++, i0 += size) {
      const m = Math.min(size, n - i0), side = rand() < 0.5 ? 1 : -1;
      let x = cx, z = cz, y = alt, h = heading, Fl;
      if (task === 'engage') {
        const lat = (j - (k - 1) / 2) * 1800 + (rand() - 0.5) * 400, back = (j & 1) * 700 + rand() * 300;
        x += rx * lat - fx * back; z += rz * lat - fz * back; y += (rand() - 0.5) * 200;
        Fl = this.spawnFlight(typeName, type, m, x, y, z, h, side, 'engage');
      } else if (task === 'escort') {
        const C = charges[0], o = _v3.set(side * (800 + 350 * (j >> 1)), 250 + 120 * j, 300 + 350 * j);
        h = Math.atan2(-C.velocity.x, -C.velocity.z);
        const hx = -Math.sin(h), hz = -Math.cos(h);
        x = C.position.x - hz * o.x - hx * o.z; z = C.position.z + hx * o.x - hz * o.z; y = C.position.y + o.y;
        Fl = this.spawnFlight(typeName, type, m, x, y, z, h, side, 'escort');
        Fl.offset.copy(o); Fl.charges = charges; escorts.push(Fl);
      } else if (task === 'scramble') {
        const along = j * 500, lat = (j & 1 ? 1 : -1) * 150;
        FL.fitStation(_st, x + Math.sin(runway) * along + Math.cos(runway) * lat, z - Math.cos(runway) * along + Math.sin(runway) * lat, 600);
        Fl = this.spawnFlight(typeName, type, m, _st.x, Math.max(this.world.getHeight(_st.x, _st.z), 0) + 130, _st.z, runway, side, 'climb');
        for (const ac of Fl.members) { ac.speed *= 0.65; ac.velocity.multiplyScalar(0.65); ac.brain.transitAlt = alt; }   // just off the ground (unarmed: then transit at alt)
      } else {
        if (j > 0) { const a = a0 + (j - 1) * 2 * Math.PI / Math.max(1, k - 1), r = 2200 + (rand() - 0.5) * 600; x += Math.cos(a) * r; z += Math.sin(a) * r; }
        near(x, z, HOLD_MAX);
        FL.fitStation(_st, _v.x, _v.z, R);
        const sy = FL.orbitAlt(_st.x, _st.z, R, alt + (rand() - 0.5) * 300), th = rand() * Math.PI * 2, dir = rand() < 0.5 ? 1 : -1;
        // the lead starts on its orbit, heading along it (EnemyBrain._hold: tangent (-u.z, u.x) * dir)
        const ux = Math.cos(th), uz = Math.sin(th);
        Fl = this.spawnFlight(typeName, type, m, _st.x + ux * R, sy, _st.z + uz * R, Math.atan2(uz * dir, -ux * dir), side, 'orbit');
        Fl.station.set(_st.x, sy, _st.z); Fl.radius = R; Fl.dir = dir;
      }
    }
    if (escorts) for (const c of charges) c.escorts = escorts;
    for (const e of this.enemies) e._pending = false;
    return n;
  }
  /** Spawn members 0..m of a flight (spawnAircraft each): the lead at (x, y, z) on `heading`, the others on their
   *  formation slots (js/flights.js SLOTS, mirrored by side); every spawn point on the map, 350 m over the terrain
   *  (100 m for a scramble) and out of the tunnel ridge; an 'engage' (inbound) flight near top speed, afterburner lit.
   *  Registers the flight (Flights.add) and returns it. */
  spawnFlight(typeName, type, m, x, y, z, heading, side, mode) {
    const M = this._fm || (this._fm = []), lim = WORLD_HALF * 0.88, floor = mode === 'climb' ? 100 : 350;
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
    M.length = 0;
    for (let i = 0; i < m; i++) {
      const s = FLIGHT_SLOTS[i], lat = s[0] * side, back = s[2];
      const sx = THREE.MathUtils.clamp(x + rx * lat - fx * back, -lim, lim), sz = THREE.MathUtils.clamp(z + rz * lat - fz * back, -lim, lim);
      const sy = this.clearSpawnY(sx, Math.max(y + s[1], Math.max(this.world.getHeight(sx, sz), 0) + floor), sz);
      const ac = this.spawnAircraft(typeName, type, new THREE.Vector3(sx, sy, sz), heading, i);
      if (mode === 'engage') { ac.speed = FLIGHT.AB_SPEED * ac.speedScale * 0.95; ac.velocity.setLength(ac.speed); ac.throttle = 1; }   // inbound near top speed
      M.push(ac);
    }
    return this.flights.add(M, m, mode, this.time, side);
  }
  /** Spawn altitude y at (x, z), raised until a jet there is clear of the tunnel ridge's rock. */
  clearSpawnY(x, y, z) {
    if (this.tunnel) for (let t = 0; t < 40 && this.tunnel.collide(_v.set(x, y, z), 60) === 'wall'; t++) y += 40;
    return y;
  }
  /** The aircraft an escort group guards: the live ones of type `near` that entered this same frame (their group is
   *  in the same phase, placed before it). Null when there are none. */
  escortCharges(near) {
    let out = null;
    for (const e of this.enemies) if (e.alive && e.name === near && e.bornAt === this.time) (out || (out = [])).push(e);
    return out;
  }
  /**
   * Generated air groups (Infinity mode): the generic placement, kept apart from the campaign's authored layout. Each
   * group { type, count, flight? } splits into flights that hold at stations 2.5-4.5 km from the player
   * (Flights.genericStations: spread in bearing, preferably 2.5 km apart, orbits on the map, clear of the tunnel ridge and
   * above the terrain) and commit by the campaign's rules (contact, attack, the commit timer under the difficulty's cap
   * and stagger). When nothing else is out there, the first flight sits nearer and goes first. Every random draw comes
   * from `seed`, so a seed and player pose give one layout. Returns the number of aircraft placed.
   */
  spawnGenerated(groups, seed) {
    const rand = mulberry32(seed), p = this.player;
    const FL = this.flights || (this.flights = new Flights(this.world, this.tunnel, WORLD_HALF));
    const taken = [], st = [];
    for (const F of FL.list) if (F.live && F.loiter && F.mode === 'orbit') taken.push(F.station);
    let first = FL.committedCount() === 0 && taken.length === 0, placed = 0;
    this._spawnOptional = false; this._spawnAtFleet = false;
    for (const g of groups) {
      const typeName = g.type, type = this.airTypes[typeName];
      if (!type) continue;
      const n = Math.max(1, Math.min(g.count || 1, 8)), size = Math.max(1, Math.min(g.flight || 2, 4)), k = Math.ceil(n / size);
      const R = orbitRadius(FLIGHT.CRUISE_SPEED * cruiseScale(type));
      while (st.length < k) st.push(new THREE.Vector3());
      FL.genericStations(st, k, p.position.x, p.position.z, p.position.y, NaN, R, rand, taken, first);
      first = false;
      for (let j = 0, i0 = 0; j < k; j++, i0 += size) {
        const S = st[j], m = Math.min(size, n - i0), th = rand() * Math.PI * 2, dir = rand() < 0.5 ? 1 : -1, side = rand() < 0.5 ? 1 : -1;
        const ux = Math.cos(th), uz = Math.sin(th);
        const Fl = this.spawnFlight(typeName, type, m, S.x + ux * R, S.y, S.z + uz * R, Math.atan2(uz * dir, -ux * dir), side, type.bars > 0 ? 'engage' : 'orbit');
        Fl.station.copy(S); Fl.radius = R; Fl.dir = dir;
        taken.push(Fl.station); placed += m;
      }
    }
    for (const e of this.enemies) e._pending = false;
    if (placed) { this.rebuildCombatList(); this.directBandits(); this._slotT = 0; if (this.squad) this.squad.newWave(); FL.restart(this.time); }
    return placed;
  }
  spawnAircraft(typeName, type, pos, heading, idx) {
    const colorKey = (type.color ?? 0x4a4f58) + ':' + (type.accent ?? 0xd8232a);
    let ac = this.enemies.find((e) => !e.alive && !e._pending && e._colorKey === colorKey);
    if (!ac) {
      ac = new Aircraft(this.scene, { team: 'enemy', bodyColor: type.color ?? 0x4a4f58, accentColor: type.accent ?? 0xd8232a, position: pos, heading, fxQuality: PRESETS[this.quality].sub });
      ac._colorKey = colorKey;
      ac.brain = new EnemyBrain(ac, { skill: 0.5, worldHalf: WORLD_HALF });
      if (this.tunnel) { const tn = this.tunnel; ac.brain.obstacle = (pt) => tn.collide(pt, 40) === 'wall'; }
      if (this.profiler) { this.profiler.instrument(ac.mesh, 'jets'); if (ac.contrails && ac.contrails.mesh) this.profiler.instrument(ac.contrails.mesh, 'contrails'); }
      this.enemies.push(ac); this.brains.push(ac.brain); this.allAircraft.push(ac);
    }
    ac._pending = true; ac._lockedOnce = false;
    // x2: two 65-damage missiles down most fighters; bosses (types with bars) skip it so they aren't missile sponges
    const hp = Math.round((type.hp || 35) * (type.bars ? 1 : 2.0) * ((this.diff && this.diff.enemyHp) || 1));
    ac.bossBars = type.bars || 0;
    ac.reset({ position: pos, heading, health: hp });
    ac.optional = !!this._spawnOptional;
    ac.speedScale = cruiseScale(type);   // per-type speed (helicopters slow, cruise missiles fast)
    ac.setSize(/missile/i.test(type.role || '') ? 0.45 : 1, true);   // cruise missiles are small; drawn larger than life (loop)
    ac.health = hp; ac.maxHealth = hp;
    ac.quaternion.setFromAxisAngle(WORLD_UP, heading);
    ac.handling.pitch = THREE.MathUtils.clamp((type.pitch || 85) / 90 * 0.85, 0.55, 1);
    ac.handling.roll = THREE.MathUtils.clamp((type.roll || 180) / 170 * 0.85, 0.55, 1);
    ac.handling.yaw = THREE.MathUtils.clamp((type.yaw || 12) / 14, 0.6, 1.2);
    ac.gunRate = 12;                                     // enemy cannons fire at about half the player's rate
    const R = this.infinity ? this.infinity.ramp : null;   // INFINITY: the round's ramp stands in for the mission index
    ac.speed = FLIGHT.CRUISE_SPEED * ac.speedScale; ac.missiles = type.armed === false || type.armed === 'gun' ? 0 : 999; ac.ammo = 1e9;   // missiles unlimited: cooldowns and the in-flight caps pace them
    ac.getForward(_fwd); ac.velocity.copy(_fwd).multiplyScalar(ac.speed);
    const skill = THREE.MathUtils.clamp((R ? R.skillBase : 0.38 + this.missionIndex * 0.06) + (type.role === 'fighter' ? 0.05 : 0) + (this.skillOffset || 0), 0.2, 0.95);
    ac.brain.skill = skill; ac.brain.state = 'pursue'; ac.brain.stateTime = 0; ac.brain.missileCooldown = 10 + Math.random() * 8;
    ac.brain.target = null; ac.brain.role = null; ac.brain.threat = null;   // pooled: the bandit director assigns a role
    ac.brain.flight = null; ac.escorts = null; ac.bornAt = this.time;      // pooled: spawnFlight / escorts set these
    ac.brain.missileReload = type.missileReload || 0;   // per-type override (Mainspring: a third of the player's hardpoint reload)
    if (type.missileReload) ac.missiles = 999;
    ac.brain.passive = type.armed === false;
    ac.brain.evasive = false; ac.brain.lockedOn = false; ac._glass = false;   // pooled: the Glassfall tags its Thunderheads
    ac.brain.gunsOnly = type.armed === false ? 'none' : null;
    if (ac.brain.passive) { ac.getForward(ac.brain.transitDir); ac.brain.transitAlt = pos.y; ac.brain.state = 'transit'; }
    ac.brain.setTransitGoal(null);                       // pooled: a leaker's goal must not carry over
    ac.holdFire = false;                                 // pooled: attack slots (updateGame) decide who may fire
    ac.name = typeName;
    if (this._spawnAtFleet) this.allied.addLeaker(ac);   // flies at the allied fleet instead (js/allies.js)
    return ac;
  }
  /**
   * Find a land (or sea) site near (cx, cz): a spiral search out to 9 km, then the nearest qualifying point of a 1 km grid
   * over the map (both bounded; null only if nothing qualifies anywhere). A sea site needs open water 1 km around (room for
   * the group, no inland lakes) and must float def's hull clear of other ships. Optional `extra` (x, z) => bool adds a
   * test: allied groups keep clear of enemy units, enemy groups clear of allied ones.
   */
  findSite(cx, cz, naval, out, def, extra = null) {
    const w = this.world, lim = WORLD_HALF * 0.9;
    const base = (x, z) => this.siteFits(naval, def, x, z);
    const ok = extra ? (x, z) => extra(x, z) && base(x, z) : base;
    for (let r = 0; r <= 9000; r += 300) {
      const steps = r === 0 ? 1 : Math.max(6, Math.round(r / 250));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2 + r * 0.001;
        const x = THREE.MathUtils.clamp(cx + Math.cos(a) * r, -lim, lim);
        const z = THREE.MathUtils.clamp(cz + Math.sin(a) * r, -lim, lim);
        if (ok(x, z)) return out.set(x, w.getHeight(x, z), z);
      }
    }
    let best = Infinity;
    for (let x = -lim; x <= lim; x += 1000) {
      for (let z = -lim; z <= lim; z += 1000) {
        const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
        if (d < best && ok(x, z)) { best = d; out.set(x, w.getHeight(x, z), z); }
      }
    }
    return best < Infinity ? out : null;
  }
  /** findSite's test for a group site: open water 1 km around and def's hull clear at sea; flat land between 8 and 900 m,
   *  60 m clear of the tunnel ridge, ashore. */
  siteFits(naval, def, x, z) {
    const w = this.world, gf = this.ground;
    if (naval) return gf.openWater(x, z, 1000) && (!def || gf.hullClear(def, x, z));
    const h = w.getHeight(x, z);
    return h > 8 && h < 900 && Math.abs(w.getHeight(x + 40, z) - w.getHeight(x - 40, z)) < 50 && Math.abs(w.getHeight(x, z + 40) - w.getHeight(x, z - 40)) < 50 && this.ridgeClear(def, x, z, 60);
  }
  /**
   * Land placement test against the tunnel ridge (a separate mesh over the heightfield, so the terrain tests miss it):
   * false if ridge rock touches def's (drawn) footprint at (x, z) or within `margin` m of it, or if rock / the bore covers
   * the unit (a point over its roof). The rock test in collide() is vertical (below the rock surface = wall), so the
   * clearance ring is sampled explicitly, just above the terrain where the ridge's foot surfaces, and the body sphere
   * sits low enough to wrap a tall unit's base (a comm tower is 80 m tall drawn).
   */
  ridgeClear(def, x, z, margin = RIDGE_MARGIN) {
    const tn = this.tunnel;
    if (!tn) return true;
    const d = def && def.size ? def : DEFAULT_GROUND_TYPES.tank, k = unitScale(d);   // the drawn size (js/targets.js)
    const sx = d.size[0] * k, sy = d.size[1] * k, sz = d.size[2] * k;
    const g = Math.max(this.world.getHeight(x, z), 0.5), half = 0.5 * Math.hypot(sx, sz), yc = g + Math.min(sy, 2 * half) * 0.5;
    if (tn.collide(_v.set(x, yc, z), half + 2) === 'wall') return false;           // body in the rock or a bore wall
    if (tn.isInside(_v.set(x, g + 2, z))) return false;                              // in the bore
    if (tn.collide(_v.set(x, g + sy + 25, z), 2) === 'wall') return false;         // roof covered by ridge rock
    const R = half + margin, n = Math.max(8, Math.ceil(2 * Math.PI * R / 25));
    for (let i = 0; i < n; i++) {                                                    // clearance ring off the outer faces,
      const a = i * 2 * Math.PI / n, px = x + Math.cos(a) * R, pz = z + Math.sin(a) * R;   // samples <= 25 m apart
      if (tn.collide(_v.set(px, Math.max(this.world.getHeight(px, pz), 0.5) + 1, pz), 2) === 'wall') return false;
    }
    return true;
  }
  /** Land unit placement test: dry ground below 1200 m under def's whole drawn footprint (facing hdg), clear of the other
   *  land units (GroundForces.landClear) and of the tunnel ridge. */
  landFits(def, x, z, hdg = 0) { const h = this.world.getHeight(x, z); return h > 3 && h < 1200 && this.ground.landClear(def, x, z, hdg) && this.ridgeClear(def, x, z); }
  /** Bounded ring search around (cx, cz) for a spot where fits(x, z, hdg) holds: rings 80 m apart out to 2.4 km, points
   *  ~100 m apart along each, from a random bearing. Writes it to out and returns true; false if nothing fits. */
  ringFit(cx, cz, hdg, fits, out) {
    const a0 = Math.random() * Math.PI * 2;
    for (let r = 80; r <= 2400; r += 80) {
      const steps = Math.max(8, Math.round(r / 16));   // ~100 m apart along the ring
      for (let k = 0; k < steps; k++) {
        const a = a0 + (k / steps) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (fits(x, z, hdg)) { out.set(x, 0, z); return true; }
      }
    }
    return false;
  }
  spawnSurfaceGroup(g, cx, cz) {
    const typeName = g.type || 'tank';
    const def = this.groundTypes[typeName] || DEFAULT_GROUND_TYPES[typeName] || DEFAULT_GROUND_TYPES.tank;
    const naval = g.kind === 'naval' || !!def.naval;
    // enemy units keep clear of allied groups (AlliedForces zones; no extra test while there are none)
    const AZ = this.allied && this.allied.nZones > 0 ? this.allied : null;
    const site = this.findSite(cx, cz, naval, _v3, def, AZ ? (x, z) => AZ.clearOf(x, z, ZONE_SITE_MARGIN) : null);
    if (!site) return 0;
    const n = Math.max(1, Math.min(g.count || 1, 24));
    const area = g.area || (naval ? 'fleet' : 'base');
    const dirA = Math.random() * Math.PI * 2;
    // ships need the whole hull afloat in open water, clear of other ships; vehicles need dry land under the whole
    // footprint, clear of other vehicles (all at their drawn size)
    const fits = naval ? (x, z, hdg) => this.ground.hullClear(def, x, z, hdg) && (AZ === null || AZ.clearOf(x, z, ZONE_UNIT_MARGIN))
                       : (x, z, hdg) => this.landFits(def, x, z, hdg) && (AZ === null || AZ.clearOf(x, z, ZONE_UNIT_MARGIN));
    let placed = 0;
    for (let i = 0; i < n; i++) {
      let x = site.x, z = site.z, ok = false;
      const hdg = area === 'convoy' || area === 'fleet' ? dirA : Math.random() * Math.PI * 2;
      for (let tries = 0; tries < 8 && !ok; tries++) {
        if (area === 'convoy') { const d = (i - n / 2) * 45; x = site.x + Math.cos(dirA) * d; z = site.z + Math.sin(dirA) * d; }
        else if (area === 'fleet') { const row = Math.floor(i / 3), col = (i % 3) - 1; x = site.x + Math.cos(dirA) * row * 320 + Math.sin(dirA) * col * 260; z = site.z + Math.sin(dirA) * row * 320 - Math.cos(dirA) * col * 260; }
        else if (area === 'line') {
          // one staggered line ahead along the sortie heading for all of a phase's 'line' groups, their units taking
          // turns: 900 m apart, 250 m either side, from the first line group's site
          const L = this._line || (this._line = { x: site.x, z: site.z, groups: 0, n: Math.max(1, this._lineGroups || 1) });
          if (i === 0 && tries === 0) L.k = L.groups++;
          const b = this.sortieFrame ? this.sortieFrame.bearing : 0, j = i * L.n + L.k, d = j * 900, lat = (j % 2 ? 1 : -1) * 250;
          x = L.x + Math.sin(b) * d + Math.cos(b) * lat; z = L.z - Math.cos(b) * d + Math.sin(b) * lat;
        } else { const r = (area === 'scattered' ? 1200 : area === 'base' ? 320 : 600) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2; x = site.x + Math.cos(a) * r; z = site.z + Math.sin(a) * r; }
        if (tries > 0) { x += (Math.random() - 0.5) * 120 * tries; z += (Math.random() - 0.5) * 120 * tries; }
        ok = fits(x, z, hdg);
      }
      if (!ok) {
        // formation slot unusable: the nearest spot that fits around the site, else leave the unit out rather than
        // strand it on land or in the sea
        if (!this.ringFit(site.x, site.z, hdg, fits, _fit)) continue;
        x = _fit.x; z = _fit.z;
      }
      const t = this.ground.spawn(typeName, def, x, z, hdg);
      if (t) {
        t.name = typeName.toUpperCase(); t.optional = this._spawnOptional; placed++;
        const hm = (this.diff && this.diff.enemyHp) || 1; t.maxHealth = t.health = Math.round(def.hp * hm);
      }
    }
    return placed;
  }
  // ---------- allied story units (missions[].allies; js/allies.js) ----------
  /**
   * Spawn the allied groups that join with the current phase: before its enemy groups (after = false; those then keep
   * clear of them) or after them (allies[].after, e.g. beside the enemy armor of type `near`). Same validated placement
   * as enemy groups: findSite for the site (open water and a clear hull at sea; flat dry land clear of the tunnel ridge
   * ashore), hullClear / landFits (ridgeClear) for every unit. Allied sites keep ALLY_SITE_GAP from live enemy units,
   * vehicles ALLY_UNIT_GAP and ships ALLY_SEA_GAP. Placement only (spawn time), never per frame.
   */
  spawnAllies(after) {
    const list = this.mission && this.mission.allies;
    if (!Array.isArray(list) || !this.allied) return 0;
    let n = 0;
    for (const a of list) if ((a.phase || 0) === this.phaseIndex && !!a.after === after) n += this.spawnAllyGroup(a);
    if (n) this.allied.commit();
    return n;
  }
  spawnAllyGroup(a) {
    const units = Array.isArray(a.units) ? a.units : [], AL = this.allied;
    const lead = units.length ? this.groundTypes[units[0].type] : null;
    if (!lead) return 0;
    const naval = a.kind === 'naval', p = this.sortieFrame || this.setSortieFrame(), lim = WORLD_HALF * 0.85;   // the sortie frame (spawnGroup)
    const dist = a.distance || (a.near ? 1000 : 3500);
    const clearOfEnemy = (x, z) => this.enemyClear(x, z, ALLY_SITE_GAP);
    let cx, cz, site = null;
    const anchor = a.near ? this.enemyCentroid(a.near, _v2) : null;
    if (anchor) {
      // next to the live enemy units of type `near` (the unit they have pinned down): rings from `dist` to dist + 1.8 km
      // around them, each swept from the far side (seen from the start point) toward the near side
      const d = Math.hypot(anchor.x - p.x, anchor.z - p.z) || 1, ux = (anchor.x - p.x) / d, uz = (anchor.z - p.z) / d, a0 = Math.atan2(uz, ux);
      cx = anchor.x + ux * dist; cz = anchor.z + uz * dist;
      for (let r = dist; !site && r <= dist + 1800; r += 300) {
        const steps = Math.max(8, Math.round(2 * Math.PI * r / 250));   // ~250 m apart
        for (let j = 0; j < steps && !site; j++) {
          const an = a0 + (j & 1 ? 1 : -1) * ((j + 1) >> 1) * (2 * Math.PI / steps);
          const x = anchor.x + Math.cos(an) * r, z = anchor.z + Math.sin(an) * r;
          if (Math.abs(x) <= lim && Math.abs(z) <= lim && clearOfEnemy(x, z) && this.siteFits(naval, lead, x, z)) site = _v3.set(x, 0, z);
        }
      }
    } else {
      const b = p.bearing + ({ left: -Math.PI / 2, right: Math.PI / 2, behind: Math.PI }[a.position] || 0);
      cx = p.x + Math.sin(b) * dist; cz = p.z - Math.cos(b) * dist;
    }
    cx = THREE.MathUtils.clamp(cx, -lim, lim); cz = THREE.MathUtils.clamp(cz, -lim, lim);
    if (!site) site = this.findSite(cx, cz, naval, _v3, lead, clearOfEnemy);
    if (!site) return 0;
    const sx = site.x, sz = site.z, hdg = Math.random() * Math.PI * 2;
    const fx = -Math.sin(hdg), fz = -Math.cos(hdg), rx = -fz, rz = fx;   // the fleet's ahead and right
    AL.beginGroup();
    let placed = 0, k = 0;
    for (const u of units) {
      const def = this.groundTypes[u.type];
      if (!def || !!def.naval !== naval) continue;
      const gap = naval ? ALLY_SEA_GAP : ALLY_UNIT_GAP;
      const fits = naval ? (x, z, h) => this.ground.hullClear(def, x, z, h) && this.enemyClear(x, z, gap)
                         : (x, z, h) => this.landFits(def, x, z, h) && this.enemyClear(x, z, gap) && AL.spacingOk(x, z, ALLY_SPACING);
      const n = Math.max(1, Math.min(u.count || 1, ALLY_UNIT_MAX));
      for (let i = 0; i < n; i++, k++) {
        // station: the flagship on the site, escorts on FLEET_SLOTS around her (all on the fleet's heading); vehicles
        // scattered within REGIMENT_R of the site, each on its own heading
        let px = sx, pz = sz;
        if (naval && k > 0) {
          const S = FLEET_SLOTS[(k - 1) % FLEET_SLOTS.length], ring = 1 + Math.floor((k - 1) / FLEET_SLOTS.length);
          px += (rx * S[0] + fx * S[1]) * ring; pz += (rz * S[0] + fz * S[1]) * ring;
        }
        const h = naval ? hdg : Math.random() * Math.PI * 2;
        let x = px, z = pz, ok = false;
        for (let tries = 0; tries < 8 && !ok; tries++) {
          if (naval) { x = px; z = pz; }
          else { const r = REGIMENT_R * Math.sqrt(Math.random()), an = Math.random() * Math.PI * 2; x = sx + Math.cos(an) * r; z = sz + Math.sin(an) * r; }
          if (tries > 0) { x += (Math.random() - 0.5) * 120 * tries; z += (Math.random() - 0.5) * 120 * tries; }
          ok = fits(x, z, h);
        }
        if (!ok) { if (!this.ringFit(px, pz, h, fits, _fit)) continue; x = _fit.x; z = _fit.z; }
        const t = this.ground.spawn(u.type, def, x, z, h, 'player');
        if (!t) break;                                     // the allied instance budget is spent
        if (naval && placed === 0 && a.name) t.name = String(a.name).toUpperCase();   // the flagship carries the group's name
        AL.addUnit(t, !!u.escort); placed++;
      }
    }
    AL.endGroup();
    return placed;
  }
  /** True if no live enemy surface unit stands within r m of (x, z). Placement only. */
  enemyClear(x, z, r) {
    const T = this.ground.targets, r2 = r * r;
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      if (!t.alive || t.team === 'player') continue;
      const dx = t.position.x - x, dz = t.position.z - z;
      if (dx * dx + dz * dz < r2) return false;
    }
    return true;
  }
  /** Centroid (into out) of the live enemy surface units of `type`, or null if there are none. */
  enemyCentroid(type, out) {
    let n = 0, x = 0, z = 0;
    for (const t of this.ground.targets) if (t.alive && t.team !== 'player' && t.type === type) { x += t.position.x; z += t.position.z; n++; }
    return n ? out.set(x / n, 0, z / n) : null;
  }
  /** AWACS radio line (wired to js/awacs.js when present). */
  say(key, priority = 1, cooldown) {
    if (!this.awacs) return;
    const urgent = key === 'missileIncoming' || key === 'pullUp' || key === 'playerDown' || key === 'tunnelCrash';
    this.awacs.say(key, cooldown !== undefined ? { priority: urgent ? 4 : priority, cooldown } : { priority: urgent ? 4 : priority });
  }
  die(reason, fxDone = false) {
    if (!this.player.alive) return;
    if (!fxDone) this.weapons.aircraftDeath(this.player);
    this.player.kill();
    this.chase.addShake(1.2);
    this.post.flash(0.8); this.post.damage(1);
    this.audio.ui('dead');
    this.deadTimer = 0; this.deadReason = reason;
    this.say('playerDown', 3);
    this.audio.lockTone('none'); this.audio.missileWarning(false); this.audio.pullUpWarning(false);
  }
  message(text, big = false, duration = 2.5) {
    // a repeat of a message still on screen refreshes it and shows a count instead of stacking another line
    const live = this.messages.find((m) => m.base === text && m.big === big && m.age < m.duration);
    if (live) { live.count++; live.text = `${text} ×${live.count}`; live.age = 0; live.duration = Math.max(live.duration, duration); return; }
    this.messages.push({ text, base: text, count: 1, age: 0, duration, big });
    if (this.messages.length > 5) this.messages.shift();
  }

  // ---------- weapon callbacks ----------
  onHit(target, dmg, shooter, kind) {
    if (this.flights && target.brain) this.flights.attacked(target, this.time);   // a holding flight hit: it commits
    if (target === this.player) {
      this.damageFlash = 1; this.post.damage(kind === 'missile' ? 1 : 0.45);
      this.chase.addShake(kind === 'missile' ? 0.9 : 0.25); this.audio.hit();
      if (kind === 'missile') this.message('MISSILE HIT', false, 1.5);
      this.say('playerHit', 2);
      if (!this.lowHealthSaid && target.health < 35) { this.lowHealthSaid = true; this.say('lowHealth', 3); }
    } else if (shooter === this.player) {
      this.hitFlash = 1; this.audio.impact(); if (!this.infinity) this.score += kind === 'gun' ? 10 : 150;   // (INFINITY scores kills only)
    }
  }
  onKill(target, shooter) {
    if (target === this.player) { this.die('SHOT DOWN', true); return; }
    target.kill();
    this.combatDirty = true;                               // target lists drop it after this frame's weapons step
    if (this.squad) this.squad.onKill(target, shooter);   // the squadmates' kill budget (they score nothing for the player)
    if (shooter === this.player) {
      this.kills++;
      const isGround = !!target.isGround;
      if (!isGround && this.audio.wilhelm) {
        const dW = target.position.distanceTo(this.camera.position);
        if (dW < 500 && Math.random() < 0.34) this.audio.wilhelm(dW);
      }
      if (target.naval) { _v.copy(target.position); this.weapons.explode(_v, 2.5); _v.y += 8; this.weapons.explode(_v.addScaledVector(_fwd.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(), 25), 1.8); }
      if (this.infinity) { this.infinity.recordKill(hudKind(target), isGround ? target.type : target.name); this.score = this.infinity.score; }
      else this.score += isGround ? 300 : 1000;
      this.message(isGround ? 'GROUND TARGET DESTROYED' : 'TARGET DESTROYED', true, 2.2); this.audio.ui('kill');
      const t = this.time; this.killTimes.push(t);
      while (this.killTimes.length && t - this.killTimes[0] > 12) this.killTimes.shift();
      if (this.killTimes.length === 3) this.say('streak', 2); else this.say(isGround ? 'groundKill' : 'kill', 2);
    } else this.message(target.isGround ? 'TARGET DESTROYED' : 'BANDIT DOWN', false, 2);
    if (this.target === target) { this.target = null; this.lockTimer = 0; this.locked = false; }
  }
  /** AlliedForces leak (js/allies.js): a cruise missile reached the allied fleet and is consumed. Resolved for the phase,
   *  with no score or kill credit. sunk = the escort it sank, or null (a harmless hit on the flagship); missed = it
   *  splashed into the sea short of the hulls (no callout). */
  onLeak(ac, sunk, missed = false) {
    ac.kill(); this.combatDirty = true;
    if (this.target === ac) { this.target = null; this.lockTimer = 0; this.locked = false; }
    if (!missed) this.message(sunk ? 'ESCORT LOST' : `${this.allied.flagName || 'FLAGSHIP'} HIT`, false, 2.5);
  }
  onExplosion(pos, size) {
    const d = pos.distanceTo(this.camera.position);
    const k = THREE.MathUtils.clamp(1 - d / 900, 0, 1) * Math.min(1, size);
    if (k > 0) { this.post.flash(k * 0.6); this.chase.addShake(k * 0.8); }
    this.audio.explosion(d * 0.3);
  }
  onMissileLaunch(m) {
    if (m.owner && m.owner.team === 'player') {   // the player's and the squadmates' shots: the fast profile
      const P = PLAYER_MISSILE;
      m.maxSpeed = P.maxSpeed; m.boostTime = P.boostTime; m.drag = P.drag; m.life = P.life; m.turnScale = P.turnScale; m.fuse = P.fuse; m.blindTime = P.blindTime;
    }
    if (this.flights && m.target && m.target.brain && m.owner && m.owner.team === 'player') this.flights.attacked(m.target, this.time);
    if (this.squad && this.squad.onMissileLaunch(m, this.weapons)) return;   // a squadmate's shot: lethal or a dud
    if (m.owner !== this.player) m.turnScale = ENEMY_MISSILE_TURN;
    if (m.owner !== this.player && m.target === this.player) { this.message('MISSILE LAUNCH', false, 2); this.say('missileIncoming', 3); }
  }

  // ---------- main loop ----------
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const rawMs = now - this.last;
    let dt = rawMs / 1000; this.last = now;
    if (!(dt > 0)) dt = 0.016; dt = Math.min(dt, 0.05);
    if (document.hidden) return;
    if ((window.devicePixelRatio || 1) !== this._dprSeen) this.resize();   // zoom / another monitor without a resize event
    this.time += dt;
    const prof = this.profiler; prof.cpuBegin('logic');
    const input = this.input; input.update(dt);
    const titleReady = performance.now() - this.bootAt > 600;
    if (input.anyPressed) { this.audio.unlock(); this.awacs.preload(); this.music.play(); }
    this.awacs.update(dt);
    this.music.duck(!!this.awacs.speaking);

    // Global state input: the menu module owns title/pause/debrief/settings navigation
    if (this.menu && this.menu.open) this.menu.update(dt, input);
    else if (this.state === 'playing' && input.pausePressed) this.pauseGame();
    if (input.overlayToggled && this.ui.perf && !(this.menu && this.menu.open)) {
      this.ui.perf.hidden = !this.ui.perf.hidden; this.settings.perfOverlay = !this.ui.perf.hidden;
      if (this.menu.setSetting) this.menu.setSetting('perfOverlay', this.settings.perfOverlay);
      this.syncProfilerCpu();
    }
    this.updateDeviceHints();

    if (this.state === 'playing') this.updateGame(dt);
    else if (this.state === 'title') this.updateTitle(dt);
    else if (this.state === 'dead') this.updateDead(dt);
    else if (this.state === 'complete') this.updateComplete(dt);
    // paused: freeze simulation, keep rendering

    if (this.state === 'playing' && this.player.alive) this.updateAim(dt);
    else if (this.state !== 'paused' && this.input.pointerLocked) this.input.exitPointerLock();
    if (this.state === 'paused' && this.input.pointerLocked) this.input.exitPointerLock();
    // Camera
    let camMode = 'chase';
    if (this.state === 'title') camMode = 'orbit';
    else if (!this.player.alive) camMode = 'wreck';
    else if (input.lookBack) camMode = 'rear';
    else if (this.padlockEngaged && this.target && this.target.alive) camMode = 'padlock';
    else if (this.isMouseMode() && (this.state === 'playing' || this.state === 'paused')) camMode = 'mouseaim';
    this.chase.update(dt, this.player, this.target, camMode, this.time);
    if (this.tunnel && this.inTunnel && this.tunnel.constrain) this.tunnel.constrain(this.camera.position, 4);
    this.camMode = camMode;
    // enemies are drawn larger than life, more so far from the camera (Aircraft.updateDrawScale: a few flops each)
    for (let i = 0; i < this.enemies.length; i++) { const e = this.enemies[i]; if (e.alive) e.updateDrawScale(this.camera.position); }

    prof.cpuEnd('logic');
    // Paused: the simulation is frozen, so half a second after pausing the view behind the pause menu is redrawn at
    // 15 Hz instead of every display frame (menus and input still run every frame): no full-rate GPU and CPU drawing
    // while nobody is flying (phones heat up and drain in a pause menu otherwise). The canvas keeps the last frame.
    let draw = true;
    if (this.state === 'paused' && !this.bench) {
      this._pausedT = (this._pausedT || 0) + dt; this._pauseDrawT = (this._pauseDrawT || 0) + dt;
      if (this._pausedT > 0.5 && this._pauseDrawT < 1 / 15) draw = false; else this._pauseDrawT = 0;
    } else this._pausedT = 0;
    if (draw) {
      prof.cpuBegin('world');
      this.world.update(dt, this.camera, this.time);
      if (this._hidden) for (const o of this._hidden) o.visible = false;
      if (this.hideJets) for (const ac of this.allAircraft) ac.mesh.visible = false;
      prof.cpuEnd('world');
      // Sun screen position for lens effects
      this.camera.updateMatrixWorld();
      _v.copy(this.camera.position).addScaledVector(this.world.sunDirection, 20000).project(this.camera);
      const sunVisible = _v.z < 1 && Math.abs(_v.x) < 1.4 && Math.abs(_v.y) < 1.4;
      this.post.setSunScreenPos(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, sunVisible);
      prof.cpuBegin('render');
      this.post.render(this.scene, this.camera, dt);
      prof.cpuEnd('render'); prof.cpuBegin('hud');
      const h0 = performance.now();
      this.buildFrame(dt);
      const h1 = performance.now();
      if (!this.noHud) this.hud.render(this.frame);
      prof.cpuEnd('hud');
      this.updateHudBudget(dt, h1 - h0, performance.now() - h1);
    }
    this.updateTitleStatus();
    if ((!this.bench && !PARAMS.has('scale')) || PARAMS.has('dynres')) this.updateDynamicResolution(dt, rawMs);   // (?scale= pins it)
    this.updateOverlay(dt);
    this.drawCalls = this.renderer.info.render.calls; this.triangles = this.renderer.info.render.triangles;
    prof.frameEnd(dt * 1000);
    if (this.bench) this.updateBench(dt);
  }

  updateTitle(dt) {
    // Autopilot: hold altitude and wings level while the camera orbits
    const p = this.player;
    p.getUp(_up); p.getRight(_right);
    const bank = Math.atan2(-_right.y, _up.y);
    p.setControls({ pitch: THREE.MathUtils.clamp((800 - p.position.y) * 0.002 - p.velocity.y * 0.01, -0.4, 0.4), roll: THREE.MathUtils.clamp(-bank * 2, -0.5, 0.5), yaw: 0, throttleDelta: 0 });
    p.update(dt);
    if (Math.abs(p.position.x) > 6000 || Math.abs(p.position.z) > 6000) { this.resetPlayer(); this.chase.snap(p); }
    this.weapons.update(dt, this.combatList, this.camera, this.teamTargets);
    this.audio.setEngine({ throttle: p.throttle, speedFrac: p.speed / FLIGHT.AB_SPEED, afterburner: false, alive: true });
  }
  updateDead(dt) {
    this.deadTimer += dt;
    for (let i = 0; i < this.enemies.length; i++) { const e = this.enemies[i]; if (e.alive) { e.brain.update(dt, this.player, this.world, this.weapons, this.time); e.update(dt); } }
    const alliedOn = this.allied.active;
    if (this.squad || alliedOn) {
      this.profiler.cpuBegin('allies');
      if (this.squad) this.squad.update(dt, this.player, this.enemies, this.weapons, this.time);
      if (alliedOn) this.allied.update(dt, this.time, this.camera.position, this.player, this.hostiles, this._nAir);
      this.profiler.cpuEnd('allies');
    }
    this.weapons.update(dt, this.combatList, this.camera, this.teamTargets);
    this.glassfall.update(dt, false);      // blasts keep fading (the event itself waits: the player is down or done)
    if (this.combatDirty) this.rebuildCombatList();
    this.audio.setEngine({ throttle: 0, speedFrac: 0, afterburner: false, alive: false });
    this.ageMessages(dt);
  }
  /** Mission complete (the debrief is up): the world behind it is frozen like the pause, so nothing simulates: bandits,
   *  squadmates (and their contrails / engine effects, updated with the airframe), allied story units, rounds and
   *  effects in flight, the Glassfall and its Q12 all hold where they were when the debrief opened. Only the HUD
   *  messages age and the engine sound idles. */
  updateComplete(dt) {
    this.audio.setEngine({ throttle: 0, speedFrac: 0, afterburner: false, alive: false });
    this.ageMessages(dt);
  }
  ageMessages(dt) {
    if (this.radio) { this.radio.age += dt; if (this.radio.age > this.radio.duration) this.radio = null; }
    for (let i = this.messages.length - 1; i >= 0; i--) { const m = this.messages[i]; m.age += dt; if (m.age > m.duration) this.messages.splice(i, 1); }
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4); this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
  }

  updateGame(dt) {
    const p = this.player, input = this.input, world = this.world, weapons = this.weapons;
    // Player
    if (p.alive) {
      if (this.bench) this.benchAutopilot(dt);
      else if (this.isMouseMode()) this.mouseAimControl(dt);
      else p.setControls({ pitch: input.pitch, roll: input.roll, yaw: input.yaw, throttleDelta: input.throttleDelta });
      p.update(dt);
      const h = Math.max(world.getHeight(p.position.x, p.position.z), 0);
      if (p.position.y < h + 2.5) { p.position.y = h + 2.5; if (!this.bench) this.die(h > 0.5 ? 'TERRAIN IMPACT' : 'HIT THE WATER'); }
      if (this.tunnel && p.alive) {
        const inside = this.tunnel.isInside(p.position);
        if (inside && !this.inTunnel) this.say('tunnelEnter', 3, 20);
        else if (!inside && this.inTunnel && p.alive) this.say('tunnelExit', 3, 20);
        this.inTunnel = inside;
        if (!inside && this.tunnel.closestPathT(p.position) >= 0) {
          p.getForward(_fwd);
          for (const en of this.tunnel.entrances) { _v.subVectors(en.position, p.position); if (_v.length() < 1500 && _v.dot(_fwd) > 0.8 * _v.length()) { this.say('tunnelApproach', 2, 45); break; } }
        }
        if (!this.bench && this.tunnel.collide(p.position, 6) === 'wall') { this.die(inside ? 'HIT THE TUNNEL WALL' : 'FLEW INTO THE RIDGE'); this.say('tunnelCrash', 4); }
      }
      // Soft boundary: nudge back toward the arena
      if (Math.abs(p.position.x) > WORLD_HALF || Math.abs(p.position.z) > WORLD_HALF) {
        if (!this.boundaryWarned || this.time - this.boundaryWarned > 4) { this.message('RETURN TO THE COMBAT AREA', false, 3); this.boundaryWarned = this.time; this.say('outOfBounds', 2, 15); }
      }
    }
    // Bandit flights (3 Hz, js/flights.js): holding flights commit on contact, when attacked, or when the commit timer
    // releases one (the difficulty's cap and stagger; a phase may set its own stagger); delayed groups enter when due
    if (this.flights) {
      const d = this.diff || DIFFICULTY.normal, P = this.mission.phases[this.phaseIndex];
      this.flights.update(dt, this.time, p, this.allies, d.flightCap, ((P && P.stagger) || 20) * d.stagger / 20);
      if (this.flights.dirty) { this.flights.dirty = false; this._dirT = 0; this._slotT = 0; }   // roles and slots next
    }
    if (this._pending && this._pending.length) this.spawnPending(false);
    // Bandit director (~1 s): how many bandits hunt the player and how many a squadmate (directBandits)
    this._dirT = (this._dirT || 0) - dt;
    if (this._dirT <= 0) { this._dirT = 1; this.profiler.cpuBegin('allies'); this.directBandits(); this.profiler.cpuEnd('allies'); }
    // Attack slots (every 0.5 s): only the N closest bandits hunting the player press the attack, the rest hold off (no
    // limit on Mercenary). The same N per squadmate: its N closest hunters may fire at it, the others keep pursuing it
    // (they still draw bandits off the player) with weapons held (holdFire: Weapons refuses their rounds and missiles)
    this._slotT = (this._slotT || 0) - dt;
    if (this._slotT <= 0) {
      this._slotT = 0.5;
      const maxA = (this.diff || DIFFICULTY.normal).aggressors;
      const armed = this._armed || (this._armed = []), sq = this._sqArmed || (this._sqArmed = []); armed.length = 0; sq.length = 0;
      for (const e of this.enemies) {
        if (!e.alive || !e.brain || e.brain.passive || isHolding(e)) continue;   // holding flights take no slot
        const t = e.brain.target;
        if (t && t !== p) { e._d2 = e.position.distanceToSquared(t.position); sq.push(e); }   // hunting a squadmate
        else { e._d2 = e.position.distanceToSquared(p.position); armed.push(e); }
      }
      armed.sort(byDistance);
      for (let i = 0; i < armed.length; i++) { armed[i].brain.aggressor = i < maxA; armed[i].holdFire = false; }
      if (sq.length) {
        sq.sort(byDistance);
        for (let i = 0; i < this.allies.length; i++) this.allies[i]._slots = 0;
        for (let i = 0; i < sq.length; i++) { const e = sq[i], t = e.brain.target; e.brain.aggressor = true; t._slots = (t._slots || 0) + 1; e.holdFire = t._slots > maxA; }
      }
    }
    // Enemies
    let aliveEnemies = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]; if (!e.alive) continue;
      e.brain.update(dt, e.brain.target || p, world, weapons, this.time);
      e.update(dt);
      const h = Math.max(world.getHeight(e.position.x, e.position.z), 0);
      if (e.position.y < h + 3 * e.sizeScale || (this.tunnel && this.tunnel.collide(e.position, 6) === 'wall')) {   // (life size)
        if (this.allied.leakers.length > 0 && this.allied.crashLeak(e)) continue;   // a leaker that hit the sea at the fleet: a leak
        if (e._glass && this.glassfall.crash(e)) continue;                          // a Thunderhead down in the city: a strike
        weapons.aircraftDeath(e); e.kill(); this.combatDirty = true; if (!this.infinity) this.score += 300; this.message('BANDIT CRASHED', false, 2);
        if (this.target === e) { this.target = null; this.lockTimer = 0; this.locked = false; }
        continue;
      }
      if (!e.optional && e.team !== 'player') aliveEnemies++;
    }
    // Squadmates and allied units (after the bandits, so they react to this frame's positions)
    const alliedOn = this.allied.active;
    if (this.squad || alliedOn) {
      this.profiler.cpuBegin('allies');
      if (this.squad) this.squad.update(dt, p, this.enemies, weapons, this.time);
      if (alliedOn) this.allied.update(dt, this.time, this.camera.position, p, this.hostiles, this._nAir);   // flak, leakers, sinking
      this.profiler.cpuEnd('allies');
    }
    // Targeting, lock, camera button semantics
    this.updateTargeting(dt);
    // "Check six": an armed bandit sitting behind the player within 900 m
    this._sixT = (this._sixT || 0) - dt;
    if (p.alive && this._sixT <= 0) {
      this._sixT = 1;
      p.getForward(_fwd);
      for (const e of this.enemies) {
        if (!e.alive || (e.brain && e.brain.passive)) continue;
        _v.subVectors(e.position, p.position); const d = _v.length();
        if (d < 900 && _v.dot(_fwd) < -0.6 * d) { this.say('checkSix', 2, 14); break; }
      }
    }
    // Weapons (ignored briefly after launch so the start button doesn't fire)
    if (this.fireGrace > 0) this.fireGrace -= dt;
    if (p.alive && !(this.fireGrace > 0)) {
      if (input.gun) {
        if (p.ammo > 0) { const rounds = weapons.fireGun(p); for (let i = 0; i < rounds; i++) this.audio.gunFire(); }
        else if (input.gunPressed) this.message('GUNS EMPTY', false, 1.2);
      }
      if (input.missilePressed) {
        if (p.missiles <= 0) this.message('MISSILES EXPENDED', false, 1.2);
        else {
          const hp = this.hardpoints.findIndex((t) => t <= 0);
          if (hp >= 0) {
            const m = weapons.fireMissile(p, this.locked ? this.target : null);
            if (m) { this.hardpoints[hp] = HARDPOINT_RELOAD; this.audio.missileLaunch(); this.chase.addShake(0.15); }
          }
        }
      }
      if (input.flaresPressed && this.flareT <= 0) {
        const spoofed = weapons.deployFlares ? weapons.deployFlares(p) : 0;
        if (spoofed > 0) { this.message('MISSILE DEFEATED', false, 1.6); this.say('missileDefeated', 2); }
        this.flareT = FLARE_RELOAD;
        if (this.audio.flare) this.audio.flare();
      }
    }
    if (this.missileDecoyed) { this.missileDecoyed = false; if (!(this._decoyMsgT > this.time)) { this._decoyMsgT = this.time + 2; this.message('MISSILE DEFEATED', false, 1.6); this.say('missileDefeated', 2); } }
    for (let i = 0; i < this.hardpoints.length; i++) if (this.hardpoints[i] > 0) this.hardpoints[i] = Math.max(0, this.hardpoints[i] - dt);
    if (this.flareT > 0) this.flareT = Math.max(0, this.flareT - dt);
    this.ground.update(dt, p, weapons, this._onFlak, this.diff || DIFFICULTY.normal);   // flak: the difficulty's aaGuns, aaError
    weapons.update(dt, this.combatList, this.camera, this.teamTargets);
    // The Glassfall (js/glassfall.js): strikes, salvos, the Q12, detonations; it completes the mission itself
    this.profiler.cpuBegin('glassfall'); this.glassfall.update(dt, p.alive); this.profiler.cpuEnd('glassfall');
    if (this.combatDirty) this.rebuildCombatList();   // a unit died this frame: drop it from the target lists
    // Mission progression: a phase is cleared when no enemy aircraft or ground/naval targets remain (friendlies don't count)
    let surfaceAlive = 0;
    for (const t of this.ground.targets) if (t.alive && !t.optional && t.team !== 'player') surfaceAlive++;
    if (this.missionDoneT > 0) {
      this.missionDoneT += dt;
      if (this.missionDoneT > 4.5) { this.missionDoneT = 0; this.setState('complete'); this.showDebrief(true); }
    } else if (this.glassfall.active) {
      // a Glassfall event runs: no phase clears (its Thunderheads are optional); it calls missionComplete when it ends
    } else if (this.infinity) {
      this.updateRounds(dt, aliveEnemies + surfaceAlive);   // INFINITY: rounds, not phases
    } else if (aliveEnemies + surfaceAlive === 0 && p.alive && this._pending && this._pending.length) {
      if (this._phaseLive) this.spawnPending(true);   // the phase's field was cleared before a delayed group was due: it enters now
    } else if (aliveEnemies + surfaceAlive === 0 && p.alive) {
      this.waveTimer += dt;
      const last = this.phaseIndex >= this.mission.phases.length - 1;
      if (this.waveTimer > 0.1 && this.waveTimer - dt <= 0.1 && !last) { this.score += 1000; this.message('AREA CLEAR', true, 2.5); this.say('waveClear', 2); }
      if (this.waveTimer > (last ? 1.2 : 3.5)) { this.waveTimer = 0; this.nextPhase(); }
    } else { this.waveTimer = 0; this._phaseLive = true; }
    // Warnings & audio
    let inbound = 0;
    const ms = weapons.missiles;
    for (let i = 0; i < ms.length; i++) { const m = ms[i]; if (m.alive && m.target === p) inbound++; }
    p._inboundCount = inbound;             // enemy missiles after the player: bandits hold launches at the cap (canLaunchAt)
    this.missileIncoming = inbound > 0 && p.alive;
    let pullUp = false;
    if (p.alive) {
      _v.copy(p.position).addScaledVector(p.velocity, 2.2);
      const hAhead = Math.max(world.getHeight(_v.x, _v.z), 0);
      pullUp = p.velocity.y < -5 && _v.y < hAhead + 60 && !this.inTunnel;
    }
    if (pullUp && !this.pullUp) this.say('pullUp');
    this.pullUp = pullUp;
    this.stall = p.alive && p.speed < FLIGHT.MIN_SPEED * 1.12;
    this.audio.missileWarning(this.missileIncoming);
    this.audio.pullUpWarning(pullUp);
    this.audio.lockTone(!p.alive || !this.target ? 'none' : this.locked ? 'locked' : this.inCone ? 'seeking' : 'none');
    this.audio.setEngine({ throttle: p.throttle, speedFrac: THREE.MathUtils.clamp(p.speed / FLIGHT.AB_SPEED, 0, 1), afterburner: p.afterburner, alive: p.alive });
    if (this.state === 'complete') this.stopWarnings();   // just entered the debrief: no tones left running behind it
    // (a crash after mission complete doesn't turn it into a failure: the countdown above still ends on the debrief)
    else if (!p.alive && !(this.missionDoneT > 0)) { this.deadTimer += dt; if (this.deadTimer > 2.2) { this.setState('dead'); this.showDebrief(false); } }
    this.ageMessages(dt);
  }

  updateTargeting(dt) {
    const p = this.player, input = this.input;
    if (this.target && (!this.target.alive || this.target.untargetable)) { this.target = null; this.lockTimer = 0; this.locked = false; }
    if (!this.target) { this.target = this.bestTarget(); this.lockTimer = 0; }
    // RB: tap = next target, hold = padlock
    if (input.targetPressed) { this.tbDownTime = this.time; this.padlockEngaged = false; }
    if (input.targetButton && !this.padlockEngaged && this.tbDownTime >= 0 && this.time - this.tbDownTime >= TAP_TIME && this.target) this.padlockEngaged = true;
    if (input.targetReleased) {
      if (!this.padlockEngaged && this.tbDownTime >= 0) { this.cycleTarget(); this.manualTargetT = 4; }
      this.padlockEngaged = false; this.tbDownTime = -1;
    }
    if (!input.targetButton) this.padlockEngaged = false;
    // Automatic re-targeting (like PW): if the current target drifts far off the nose while another bandit sits near
    // the crosshair, switch to it. A manual pick is respected for a few seconds; padlock never switches.
    if (this.manualTargetT > 0) this.manualTargetT -= dt;
    this.retargetT = (this.retargetT || 0) - dt;
    // A target you've locked stays your target until it dies or you press the target button
    if (p.alive && this.target && !this.target._lockedOnce && !this.padlockEngaged && !(this.manualTargetT > 0) && this.retargetT <= 0) {
      this.retargetT = 0.25;
      const best = this.bestTarget();
      if (best && best !== this.target) {
        const cur = this.reticleAngle(this.target), alt = this.reticleAngle(best);
        if ((cur > 40 && alt < 25) || (cur > 25 && alt < 12)) { this.target = best; this.lockTimer = 0; this.locked = false; }
      }
    }
    // Lock
    this.inCone = false;
    if (this.target && p.alive) {
      p.getForward(_fwd);
      _v.subVectors(this.target.position, p.position);
      const d = _v.length();
      const cos = _v.dot(_fwd) / Math.max(d, 1e-3);
      let inCone = cos > LOCK_COS && d < LOCK_RANGE;
      let holding = this.locked && cos > HOLD_COS && d < HOLD_RANGE;   // hysteresis: an acquired lock is sticky
      // Terrain or the tunnel ridge in the way counts as leaving the cone: the lock neither builds nor holds
      if ((inCone || holding) && !this.targetInSight()) inCone = holding = false;
      this.inCone = inCone;
      this.lockTimer = (inCone || holding) ? Math.min(LOCK_TIME, this.lockTimer + dt) : Math.max(0, this.lockTimer - dt * 2.5);
      const was = this.locked; this.locked = this.lockTimer >= LOCK_TIME - 1e-6;
      if (this.locked && !was) { this.audio.ui('select'); this.target._lockedOnce = true; }
    } else { this.lockTimer = 0; this.locked = false; }
    // An evasive brain (the Glassfall's Thunderheads) weaves while the player holds or builds a lock on it
    const lk = this.target && this.target.alive && this.target.brain && (this.locked || this.lockTimer > 0.25) ? this.target.brain : null;
    if (this._lockBrain && this._lockBrain !== lk) this._lockBrain.lockedOn = false;
    if (lk) lk.lockedOn = true;
    this._lockBrain = lk;
  }
  /** Line of sight to the current target, cached: re-checked every LOS_PERIOD and at once when the target changes.
   *  updateTargeting asks only while the target is otherwise lockable. */
  targetInSight() {
    const t = this.target, now = this.time;
    if (t !== this._losTarget || now >= this._losDue) { this._losTarget = t; this._losDue = now + LOS_PERIOD; this._losClear = this.lineOfSight(t); }
    return this._losClear;
  }
  /** Line of sight from the player to `e` past terrain and the tunnel ridge: GroundForces.hasLineOfSight with its tunnel
   *  obstacle callback. Free when both ends are above the highest terrain (World's height range) and the ridge's
   *  bounding sphere, where nothing can be in the way. */
  lineOfSight(e) {
    const p = this.player;
    let top = this._losTop;
    if (top === undefined) {
      const U = this.world.uniforms, tn = this.tunnel;
      top = this._losTop = Math.max(U && U.uCullCfg ? U.uCullCfg.value.z : Infinity, tn ? tn.center.y + tn.radius + 1 : -Infinity);
    }
    if (e.position.y > top && p.position.y > top) return true;
    if (e.isGround) return this.ground.hasLineOfSight(e, p.position);
    _losAir.position.copy(e.position);
    return this.ground.hasLineOfSight(_losAir, p.position);
  }
  /** Unit direction from the camera to the reticle you steer with: the aim circle in mouse aim, the gun cross
   *  otherwise, and the view center while looking back, padlocked or free-looking. */
  reticleDir(out) {
    const cam = this.camera, p = this.player, mode = this.camMode;
    if (!p.alive || (mode !== 'chase' && mode !== 'mouseaim') || (mode === 'mouseaim' && this.input.freeLook)) return out.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (mode === 'mouseaim') out.copy(p.position).addScaledVector(this.aimDir, 2000);
    else {
      const t = this.target && this.target.alive ? this.target : null;
      const range = t ? THREE.MathUtils.clamp(t.position.distanceTo(p.position), 300, 1500) : 1000;   // same point as the HUD gun cross
      p.getForward(_rv); this.gunOrigin(out).addScaledVector(_rv, range);
    }
    return out.sub(cam.position).normalize();
  }
  /** Degrees between the reticle and `e` as seen from the camera: how far apart they appear on screen. Pass `dir`
   *  (a reticleDir result) when scoring many targets. */
  reticleAngle(e, dir = this.reticleDir(_ret)) {
    _v2.subVectors(e.position, this.camera.position);
    const d = Math.max(_v2.length(), 1e-3);
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(_v2.dot(dir) / d, -1, 1)));
  }
  /** Degrees between the player's nose and the direction to `e`. */
  angleOff(e) {
    const p = this.player; p.getForward(_fwd);
    _v2.subVectors(e.position, p.position);
    const d = Math.max(_v2.length(), 1e-3);
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(_v2.dot(_fwd) / d, -1, 1)));
  }
  /** Auto-target score: closeness to the reticle plus a distance penalty (2 km ~ 10 deg). Lower is better. */
  targetScore(e, dir) { return this.reticleAngle(e, dir) + e.position.distanceTo(this.player.position) / 200; }
  /** Best-scoring hostile, taken from the cycle-eligible ones (on screen, near the reticle) whenever there are any. */
  bestTarget() {
    const dir = this.reticleDir(_ret);
    let best = null, bs = Infinity, bestE = null, bsE = Infinity;
    // friendlies (the player's team: squadmates, allied units) are never targets
    for (const e of this.combatList) {
      if (!e.alive || e === this.player || e.team === this.player.team) continue;
      const sc = this.targetScore(e, dir);
      if (sc < bs) { bs = sc; best = e; }
      if (sc < bsE && this.cycleEligible(e, dir)) { bsE = sc; bestE = e; }
    }
    return bestE || best;
  }
  nearestEnemy() { return this.bestTarget(); }
  /**
   * Target button: pick the hostile that appears closest to the reticle on screen, other than the current target.
   * Quick repeated taps (each within 2.5 s of the last) walk outward: each takes the closest one not yet picked in
   * that run. After a pause the next tap starts over from the reticle, so pointing at something and tapping takes it.
   * While any hostile is eligible (cycleEligible: on screen within CYCLE_BORE of the reticle) the walk stays among the
   * eligible ones and wraps there, so it never jumps to a target behind you, off screen or far off the reticle; when the
   * current target is the only eligible one it stays. With none eligible it walks every hostile, so off-screen targets
   * can still be found. Eligibility is a projection per hostile, run only on a press.
   */
  cycleTarget() {
    const now = this.time, dir = this.reticleDir(_ret);
    const walk = this._walk || (this._walk = new Set());
    if (now - (this._walkT ?? -99) > 2.5) walk.clear();
    if (this.target) walk.add(this.target);
    let best = null;
    for (let pass = 0; pass < 2 && !best; pass++) {
      if (pass === 1) { walk.clear(); if (this.target) walk.add(this.target); }   // all visited: wrap to the closest again
      let bd = Infinity, bdE = Infinity, bestE = null, anyE = false;
      for (const e of this.combatList) {
        if (!e.alive || e === this.player || e.team === this.player.team) continue;
        const a = this.reticleAngle(e, dir), ok = a <= CYCLE_BORE && this.onScreen(e);
        if (ok) anyE = true;
        if (walk.has(e)) continue;
        if (a < bd) { bd = a; best = e; }
        if (ok && a < bdE) { bdE = a; bestE = e; }
      }
      if (anyE) best = bestE;   // eligible hostiles exist (the current target may be one): pick only among them
    }
    this._walkT = now;
    if (best) { walk.add(best); this.target = best; this.lockTimer = 0; this.locked = false; this.audio.ui('select'); }
  }
  /** Cycle eligibility: on screen and within CYCLE_BORE degrees of the reticle direction `dir` (a reticleDir result). */
  cycleEligible(e, dir) { return this.reticleAngle(e, dir) <= CYCLE_BORE && this.onScreen(e); }
  /** True when `e` projects in front of the current camera and inside the viewport, CYCLE_INSET in from the edges.
   *  (No range limit: hud.js brackets every on-screen contact, at any distance.) */
  onScreen(e) {
    _ndc.copy(e.position).project(this.camera);
    return _ndc.z < 1 && Math.abs(_ndc.x) < 1 - CYCLE_INSET && Math.abs(_ndc.y) < 1 - CYCLE_INSET;
  }
  showDead() {
    if (this.ui.deadTitle) this.ui.deadTitle.textContent = this.deadReason || 'SHOT DOWN';
    if (this.ui.deadStats) this.ui.deadStats.textContent = `SCORE ${this.score.toLocaleString()}   ·   MISSION ${this.mission ? this.mission.id : 1}   ·   KILLS ${this.kills}`;
  }
  updateTitleStatus() {
    if (!this.menu || !this.menu.open) return;
    const i = this.input; let s, ok = false;
    if (this.touch && this.touch.active) { s = 'Touch controls: sticks and buttons appear in flight.'; ok = true; }
    else if (i.gamepadBlocked) s = 'Gamepad blocked by this frame. Open the artifact in its own tab, or use mouse aim.';
    else if (i.gamepadConnected) { s = `Controller ready: ${i.gamepadName || 'gamepad'}`; ok = true; }
    else s = 'No controller detected: press a button on it, or fly with mouse aim.';
    if (s !== this._lastStatus) { this._lastStatus = s; this.menu.setControllerStatus(s, ok); }
  }

  // ---------- menus, settings, touch ----------
  createMenuAndTouch() {
    const unlock = () => { this.audio.unlock(); this.awacs.preload(); this.music.play(); };
    this.touch = new TouchControls(this.root, { onAnyTouch: unlock });
    this.input.touch = this.touch;
    this.menu = new Menu(this.root.querySelector('#ui'), {
      settings: this.settings, missions: this.missions,
      onStart: (i) => { unlock(); this.score = 0; this.kills = 0; this.audio.ui('start'); this.loadMission(i); this.fireGrace = 0.5; },
      onResume: () => this.resumeGame(),
      onRestart: () => { this.startMission(true); this.fireGrace = 0.5; },
      onNext: () => { this.loadMission(this.missionIndex + 1); this.fireGrace = 0.5; },
      onQuit: () => this.quitToTitle(),
      onSetting: (key, value) => this.applySetting(key, value),
      onSound: (kind) => { unlock(); if (kind === 'select' || kind === 'back') this.audio.ui('select'); },
      onInfinity: () => { unlock(); this.audio.ui('start'); this.startInfinity(); this.fireGrace = 0.5; },
    });
    // U toggles fullscreen inside its keydown handler (browsers grant it only to a user activation); off where the browser
    // has no fullscreen. A refusal in flight shows on the HUD (in the menus the Fullscreen row shows a note).
    if (fullscreenSupported()) this.input.onFullscreenKey = () => this.menu.toggleFullscreen().then((ok) => { if (!ok && !this.menu.open) this.message('FULLSCREEN REFUSED', false, 2); });
    // apply every persisted setting once (quality was applied during init)
    for (const k of Object.keys(this.settings)) if (k !== 'quality') this.applySetting(k, this.settings[k]);
    this.updateGraphicsLabel();
  }
  applySetting(key, v) {
    switch (key) {
      case 'quality': {
        this.qualityChoice = CHOICES.includes(v) ? v : 'auto';
        const tier = this.qualityChoice === 'auto' ? guessTier(this.gpuName) : this.qualityChoice;
        this.renderScale = PRESETS[tier].scaleMax;
        this.applyQuality(tier, false, true);
        break;
      }
      case 'perfOverlay': if (this.ui.perf) this.ui.perf.hidden = !v; this.syncProfilerCpu(); break;
      case 'invertPitch': this.input.setInvertPitch(!!v); if (this.touch && this.touch.setPitchInverted) this.touch.setPitchInverted(!!v); break;
      case 'touch': if (this.touch) this.touch.setMode(v || 'auto'); break;
      case 'expoPitch': case 'expoRoll': case 'expoYaw': if (this.input.setExpo) this.input.setExpo(key.slice(4).toLowerCase(), v); break;
      case 'cameraShake': this.chase.shakeScale = v === false ? 0 : 1; break;
      case 'screenFlash': this.post.flashEnabled = v === true; break;   // white PostFX flash (explosions, flak, shot down)
      case 'master': this.audio.setMaster(Number(v)); break;
      case 'music': if (this.music && this.music.setVolume) this.music.setVolume(Number(v)); break;
      case 'sfx': if (this.audio.setSfxVolume) this.audio.setSfxVolume(Number(v)); break;
      case 'voice': if (this.awacs.setVolume) this.awacs.setVolume(Number(v)); break;
      case 'difficulty': {
        if (this.infinity) break;          // a run follows its own ramp; the setting applies again when it ends (leaveInfinity)
        const d = this.diff = DIFFICULTY[v] || DIFFICULTY.normal;
        this.armor = d.armor; this.skillOffset = d.skill;
        if (this.player) this.player.missileCap = d.playerMissiles;   // enemy missiles after the player at once
        break;
      }
      default: break;   // mouseSens, mouseKeys, subtitles are read live
    }
  }
  pauseGame() {
    this.setState('paused'); this.silenceGameAudio();
    this.input.exitPointerLock();
    this.menu.show('pause', this.infinity ? { mode: 'infinity', round: this.infinity.round } : { missionIndex: this.missionIndex });
  }
  resumeGame() {
    this.setState('playing'); this.last = performance.now(); this.fireGrace = 0.3;
    if (this.audio.setPaused) this.audio.setPaused(false);
  }
  quitToTitle() {
    this.leaveInfinity();
    this.glassfall.reset();
    for (const e of this.enemies) e.kill();
    if (this.squad) this.squad.hide();
    this.ground.clear(); this.allied.clear();
    this.rebuildCombatList();
    for (const m of this.weapons.missiles) m.alive = false;
    this.messages.length = 0; this.radio = null; this.target = null;
    if (this.awacs.stop) this.awacs.stop();
    this.stopWarnings();                   // only the flight loop switches warning / lock tones off otherwise
    if (this.audio.setPaused) this.audio.setPaused(false);
    this.resetPlayer(); this.chase.snap(this.player);
    this.setState('title');
    this.input.exitPointerLock();
    if (this.menu.refreshBest) this.menu.refreshBest();   // the title's INFINITY line, now that a run may have ended
  }
  showDebrief(success) {
    const n = this.missions.length, M = this.mission;
    this.input.exitPointerLock();
    if (this.infinity) {                   // INFINITY: one life, so the run is over: rounds cleared, kills, score, local best
      const r = this.infinity.finish(this.deadReason || 'SHOT DOWN');
      this.menu.show('debrief', { mode: 'infinity', title: r.reason, round: r.round, roundsCleared: r.roundsCleared, kills: r.kills, score: r.score, best: r.best, newBest: r.newBest });
      return;
    }
    this.menu.show('debrief', {
      title: success ? 'MISSION COMPLETE' : (this.deadReason || 'SHOT DOWN'),
      stats: [['MISSION', `${M.id} · ${String(M.name).toUpperCase()}`], ['SCORE', this.score.toLocaleString()], ['KILLS', String(this.kills)]],
      canNext: success && this.missionIndex < n - 1, success, missionIndex: this.missionIndex,
    });
  }
  updateDeviceHints() {
    const dev = this.touch && this.touch.active ? 'touch' : this.input.usingGamepad ? 'pad' : 'kb';
    if (dev !== this._dev) { this._dev = dev; if (this.menu.setDevice) this.menu.setDevice(dev); }
  }
  /** World position the cannon fires from (mean of the muzzle points). */
  gunOrigin(out) {
    const m = this.player.getGunMuzzles ? this.player.getGunMuzzles() : null;
    if (m && m.length) { out.copy(m[0]); for (let i = 1; i < m.length; i++) out.add(m[i]); return out.multiplyScalar(1 / m.length); }
    return out.copy(this.player.position);
  }
  /** Pause: no engine, tones or warnings (AudioFX.setPaused does a fast fade when available). */
  silenceGameAudio() {
    if (this.awacs && this.awacs.stop) this.awacs.stop();
    const a = this.audio;
    if (a.setPaused) { a.setPaused(true); return; }
    a.setEngine({ throttle: 0, speedFrac: 0, afterburner: false, alive: false });
    a.lockTone('none'); a.missileWarning(false); a.pullUpWarning(false);
  }
  /** Warning and lock tones (and the HUD warnings) off: leaving the flight loop for the title or the debrief. */
  stopWarnings() {
    const a = this.audio;
    a.lockTone('none'); a.missileWarning(false); a.pullUpWarning(false);
    this.missileIncoming = false; this.pullUp = false; this.stall = false;
  }
  /** Hidden tab: the loop stops, so game audio goes quiet the way pause silences it, and the music with it. Back in
   *  view both return, except that game audio stays paused while the game is paused. */
  tabHidden(hidden) {
    if (hidden) this.silenceGameAudio();
    else if (this.state !== 'paused' && this.audio.setPaused) this.audio.setPaused(false);
    if (this.music.setVolume) this.music.setVolume(hidden ? 0 : Number(this.settings.music ?? 0.7));
  }
  // ---------- War Thunder-style mouse aim ----------
  isMouseMode() { return !this.input.usingGamepad && !(this.touch && this.touch.active) && !this.bench; }
  syncAim() {
    const p = this.player; if (!p) return;
    p.getForward(_fwd);
    this.aimHeading = Math.atan2(_fwd.x, -_fwd.z);
    this.aimPitch = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));
    this.lookYaw = 0; this.lookPitch = 0;
    this.aimDir.copy(_fwd); this.aimUp.set(0, 1, 0); this._lookDir.copy(_fwd);
    this._ovRoll = 0; this._ovPitch = 0; this._behindDir = 0;
    this._aimPush = false; this._rollSide = 0; this._aimLx = 0; this._aimTrim = 0; this._aimPI = 0; this._levelSide = 0;
  }
  /** Mouse moves the aim (or the camera alone while free look is held); the jet is flown toward the aim. */
  updateAim(dt) {
    const i = this.input;
    if (!this.isMouseMode()) { if (this._wasGamepad !== true) this._wasGamepad = true; return; }
    if (this._wasGamepad) { this._wasGamepad = false; this.syncAim(); }
    const sens = 0.0021 * (this.settings.mouseSens || 1) * (this.camera.fov / 66);
    const up = this.aimUp;
    if (i.freeLook) {
      this.lookYaw -= i.mouseMoveX * sens;
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - i.mouseMoveY * sens, -1.3, 1.3);
    } else {
      // Full-sphere aim (War Thunder style): rotate the aim vector about the camera's up and right axes
      if (i.mouseMoveX) this.aimDir.applyQuaternion(this._aimQ.setFromAxisAngle(up, -i.mouseMoveX * sens));
      if (i.mouseMoveY) {
        _v3.crossVectors(this.aimDir, up); const l = _v3.length();
        if (l > 1e-4) this.aimDir.applyQuaternion(this._aimQ.setFromAxisAngle(_v3.multiplyScalar(1 / l), -i.mouseMoveY * sens));
      }
      this.aimDir.normalize();
      const k = Math.exp(-dt * 7); this.lookYaw *= k; this.lookPitch *= k;   // free look springs back
    }
    // Camera up: world up unless aiming near vertical, where it holds its last orientation (no flip over the top)
    if (Math.abs(this.aimDir.y) < 0.9) up.lerp(WORLD_UP, 1 - Math.exp(-dt * 5));
    up.addScaledVector(this.aimDir, -up.dot(this.aimDir));
    if (up.lengthSq() < 1e-6) up.copy(WORLD_UP); up.normalize();
    this.aimHeading = Math.atan2(this.aimDir.x, -this.aimDir.z);
    this.aimPitch = Math.asin(THREE.MathUtils.clamp(this.aimDir.y, -1, 1));
    // view direction = aim + free-look offsets
    const ld = this._lookDir.copy(this.aimDir);
    if (this.lookYaw || this.lookPitch) {
      ld.applyQuaternion(this._aimQ.setFromAxisAngle(up, this.lookYaw));
      _v3.crossVectors(ld, up); if (_v3.lengthSq() > 1e-8) ld.applyQuaternion(this._aimQ.setFromAxisAngle(_v3.normalize(), this.lookPitch));
    }
    this.chase.lookDir.copy(ld);
    this.chase.mouseUp = up;
  }
  /** Flight instructor: bank-to-turn toward the aim with damped fine corrections; keyboard overrides roll/yaw/thrust. */
  mouseAimControl(dt) {
    const p = this.player, kb = this.input.kb || { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    const r = p._rates || { pitch: 0, roll: 0, yaw: 0 };
    _v.copy(this.aimDir).applyQuaternion(this._qInv.copy(p.quaternion).invert());   // aim in the jet's frame
    const lx = _v.x, ly = _v.y, lz = _v.z;
    const ang = Math.acos(THREE.MathUtils.clamp(-lz, -1, 1));
    p.getUp(_up); p.getRight(_right);
    let pitch, roll, yaw;
    // Push or pull, decided in the jet's own frame with hysteresis: an aim point within ~50 deg of straight below the
    // canopy floor (up to ~97 deg off the nose) is pushed onto rather than rolled inverted for, so a dive arrives
    // upright and steady (a nose-down attitude alone doesn't count); it takes a clear move away (past ~108 deg, or off
    // to the side) to switch back. Pushing 60 deg is faster than the old half-roll-and-pull (1.45 s vs 1.72 s).
    const pullErr = Math.atan2(lx, ly);
    if (this._aimPush) { if (ang > 1.88 || Math.abs(pullErr) < 1.8 || lz > 0.75) this._aimPush = false; }
    else if (ly < 0 && ang < 1.7 && Math.abs(pullErr) > 2.2) this._aimPush = true;
    if (lz > 0.75) {
      // aim well behind: commit to one turn direction and pull hard until it comes around (no dithering)
      if (!this._behindDir) this._behindDir = lx >= 0 ? 1 : -1;
      const rollErr = Math.atan2(this._behindDir, Math.max(ly, 0.25));
      roll = rollErr * 2.4 - r.roll * 0.12; pitch = 1; yaw = this._behindDir * 0.3;
    } else {
      // Fine aim: pitch and rudder straight onto the aim with the wings drifting level (fading out near vertical). Lateral
      // error banks the jet only through a filtered, dead-banded copy, so aim jitter and a jinking target's twitches go to
      // rudder and pitch instead of see-sawing the ailerons. Integral trims, active only once the nose is settled near the
      // aim, take up a steady offset (a target in a gentle turn) with a held bank and pitch rate.
      const bank = Math.atan2(-_right.y, _up.y);
      const lxF = this._aimLx += (lx - this._aimLx) * (1 - Math.exp(-dt / 0.15));
      const lxB = Math.sign(lxF) * Math.max(0, Math.abs(lxF) - 0.008);
      const settled = (1 - THREE.MathUtils.smoothstep(ang, 0.03, 0.06)) * (1 - THREE.MathUtils.smoothstep(Math.abs(r.pitch) + Math.abs(r.yaw), 0.08, 0.25));
      const keep = settled + (1 - settled) * Math.exp(-dt / 0.2);
      this._aimTrim = THREE.MathUtils.clamp(this._aimTrim * keep + lxF * 4 * dt * settled, -0.6, 0.6);
      this._aimPI = THREE.MathUtils.clamp(this._aimPI * keep + ly * 2 * dt * settled, -0.4, 0.4);
      // Wings-level drift, inverted included (a roll-and-pull into a dive arrives upside down and rolls upright again), fading
      // out only near vertical where "level" means nothing. Near +-180 deg it commits to one direction (no dithering).
      const cosPitch = Math.sqrt(Math.max(0, 1 - (_up.z * _right.x - _up.x * _right.z) ** 2));   // forward = up x right; |fwd.y|
      let lvl = bank - this._aimTrim;
      if (Math.abs(bank) > 2.8) { if (!this._levelSide) this._levelSide = Math.sign(bank) || 1; lvl = this._levelSide * Math.abs(bank) - this._aimTrim; }
      else this._levelSide = 0;
      const fRoll = -lvl * 0.9 * THREE.MathUtils.smoothstep(cosPitch, 0.1, 0.35) + lxB * 2.5 - r.roll * 0.08;
      const fPitch = ly * 8 + this._aimPI - r.pitch * 0.25, fYaw = lx * 6 - r.yaw * 0.3;
      let bRoll, bPitch;
      if (this._aimPush) {
        const rollErr = Math.atan2(lx, -ly);                         // roll the aim straight below, then push
        bRoll = rollErr * 2.4 - r.roll * 0.12;
        bPitch = -Math.max(0, Math.cos(rollErr)) * Math.min(1, ang * 5) - r.pitch * 0.08;
        this._rollSide = 0;
      } else {
        // roll the aim overhead, then pull; near straight below, commit to one roll direction so the target doesn't flip
        // between +180 and -180 deg as the aim wanders across the jet's centreline
        let rollErr = pullErr;
        if (Math.abs(rollErr) > 2.5) {
          if (!this._rollSide) this._rollSide = Math.sign(rollErr) || 1;
          if (Math.sign(rollErr) !== this._rollSide) rollErr += this._rollSide * 2 * Math.PI;
        } else this._rollSide = 0;
        bRoll = rollErr * 2.4 - r.roll * 0.12;
        bPitch = Math.max(0, Math.cos(rollErr)) * Math.min(1, ang * 2.6) - r.pitch * 0.08;
      }
      // blend fine -> big over 7-14 deg instead of switching at one angle, so a wandering aim doesn't flip the roll command
      const w = THREE.MathUtils.smoothstep(ang, 0.12, 0.25);
      roll = fRoll + (bRoll - fRoll) * w;
      pitch = fPitch + (bPitch - fPitch) * w;
      yaw = fYaw + (lx * 1.2 - fYaw) * w;
    }
    // The jet pushes at only PUSH_FACTOR of its pull rate: scale push commands to match, so small downward corrections are
    // as crisp as upward ones (a hard push still tops out at the jet's limit; well below the nose it rolls and pulls)
    if (pitch < 0) pitch /= FLIGHT.PUSH_FACTOR;
    // No ground-avoidance override: the jet goes where the aim points, so the player can dive steeply on a ground
    // target (and fly into the ground if they insist). The old arcade safety net rolled level and pulled up whenever the
    // flight path came within ~2.2 s of terrain, which made strafing dives impossible.
    if (lz <= 0.75) this._behindDir = 0;
    // Keyboard overrides replace the instructor on that axis with a short hand-off (0.05 s in, 0.1 s back out).
    // Simple preset: W/S boost/airbrake, Shift hard pull. Advanced: W/S pitch, Shift boost, H airbrake.
    const simple = this.settings.mouseKeys !== 'advanced';
    const manualPitch = simple ? (kb.throttle > 0.05 ? kb.throttle : 0) : kb.pitch;
    const thrust = simple ? THREE.MathUtils.clamp(-kb.pitch + Math.min(kb.throttle, 0), -1, 1) : kb.throttle;
    const rollOn = Math.abs(kb.roll) > 0.05, pitchOn = Math.abs(manualPitch) > 0.05;
    this._ovRoll += ((rollOn ? 1 : 0) - this._ovRoll) * (1 - Math.exp(-dt / (rollOn ? 0.05 : 0.1)));
    this._ovPitch += ((pitchOn ? 1 : 0) - this._ovPitch) * (1 - Math.exp(-dt / (pitchOn ? 0.05 : 0.1)));
    roll += (kb.roll - roll) * this._ovRoll;
    pitch += (manualPitch - pitch) * this._ovPitch;
    yaw += kb.yaw;                                                    // Q/E rudder
    p.setControls({ pitch: THREE.MathUtils.clamp(pitch, -1, 1), roll: THREE.MathUtils.clamp(roll, -1, 1), yaw: THREE.MathUtils.clamp(yaw, -1, 1), throttleDelta: thrust });
  }

  // ---------- benchmark mode (?bench=1&dur=16&warm=4) ----------
  startBench() {
    this.startMission();
    for (const e of this.enemies) e.kill();
    this.ground.clear(); this.allied.clear();
    const p = this.player; p.getForward(_fwd);
    this.spawnAirGroup({ type: 'NV-16', count: 6, formation: 'loose', task: 'engage' }, p.position.x + _fwd.x * 3500, p.position.z + _fwd.z * 3500);   // constant workload
    this.rebuildCombatList();
    const immortal = () => false;
    for (const ac of this.allAircraft) ac.applyDamage = immortal;
    this.missionDoneT = 0;
    this.player.ammo = 1e9; this.player.missiles = 1e9;
    console.log('BENCH_START ' + JSON.stringify({ w: this.glHost.clientWidth, h: this.glHost.clientHeight, dpr: this.dpr, scale: this.renderScale, timerQueries: this.profiler.supported }));
  }
  benchAutopilot(dt) {
    // Gentle S-turns holding ~700 m (or 400 m above terrain ahead), steady 85% throttle, cannon always firing
    const p = this.player;
    p.getUp(_up); p.getRight(_right); p.getForward(_fwd);
    const bank = Math.atan2(-_right.y, _up.y);
    const wantBank = Math.sin(this.time * 0.5) * 0.45;
    _v.copy(p.position).addScaledVector(_fwd, 1500);
    const floor = Math.max(this.world.getHeight(_v.x, _v.z), this.world.getHeight(p.position.x, p.position.z), 0) + 400;
    const wantAlt = Math.max(700, floor);
    const pitch = THREE.MathUtils.clamp((wantAlt - p.position.y) * 0.004 - p.velocity.y * 0.02, -0.5, 0.6) + Math.abs(Math.sin(bank)) * 0.25;
    p.setControls({ pitch, roll: THREE.MathUtils.clamp((wantBank - bank) * 2.5, -1, 1), yaw: 0, throttleDelta: 0.3 });
    p.ammo = 1e9; this.weapons.fireGun(p);
  }
  updateBench(dt) {
    const b = this.bench; if (b.done) return;
    b.t += dt;
    const prof = this.profiler;
    if (b.t < b.warm) { prof.setMode('off'); return; }
    if (!b.started) { b.started = true; prof.reset(); b.modeT = 0; }
    b.modeT += dt;
    prof.setMode(Math.floor(b.modeT / 2) % 2 === 0 ? 'pass' : 'object');
    // Fixed effects cadence: a missile every 2.5 s, an explosion 350 m ahead every 2 s
    b.mslT += dt; b.boomT += dt;
    if (b.mslT > 2.5 && this.state === 'playing') { b.mslT = 0; this.weapons.fireMissile(this.player, this.target || this.nearestEnemy()); }
    if (b.boomT > 2) { b.boomT = 0; this.player.getForward(_fwd); _v.copy(this.player.position).addScaledVector(_fwd, 350); this.weapons.explode(_v, 1.5); }
    if (b.t >= b.warm + b.dur) {
      b.done = true; prof.setMode('off');
      const sum = prof.summary();
      const gl = this.renderer.getContext(); const ri = gl.getExtension('WEBGL_debug_renderer_info');
      sum.renderer = ri ? gl.getParameter(ri.UNMASKED_RENDERER_WEBGL) : 'unknown';
      sum.css = [this.glHost.clientWidth, this.glHost.clientHeight];
      const cv = this.renderer.domElement;
      sum.internal = [this.post.renderWidth || cv.width, this.post.renderHeight || cv.height];
      sum.msaa = this.post.activeSamples; sum.scale = this.renderScale; sum.dpr = this.dpr;
      sum.drawCalls = this.drawCalls; sum.triangles = this.triangles;
      sum.enemies = this.enemies.filter((e) => e.alive).length; sum.state = this.state;
      sum.quality = this.quality; sum.qualityChoice = this.qualityChoice;
      console.log('BENCH_RESULT ' + JSON.stringify(sum));
    }
  }

  // ---------- HUD frame ----------
  makeFrame() {
    const mk = () => ({ x: 0, y: 0, onScreen: false, behind: false, type: 'enemy', hostile: true, distance: 0, isTarget: false, r: 0 });
    return {
      w: 1, h: 1, dt: 0, time: 0, state: 'title',
      player: { speed: 0, altitude: 0, radarAlt: 0, heading: 0, pitch: 0, roll: 0, gLoad: 1, throttle: 0, afterburner: false, health: 100, ammo: 0, missiles: 0, maxMissiles: 8, stall: false },
      velocityVector: { x: 0, y: 0, visible: false },
      target: null,
      _target: { x: 0, y: 0, onScreen: false, behind: false, distance: 0, name: '', health: 1, lock: 0, locked: false, inSeekerCone: false, closure: 0, lead: null, _lead: { x: 0, y: 0 }, r: 0 },
      contacts: [], _contactPool: Array.from({ length: HUD_CONTACTS }, mk),
      radar: { range: RADAR_RANGE, blips: [], _pool: Array.from({ length: HUD_CONTACTS }, () => ({ dx: 0, dz: 0, type: 'enemy', isTarget: false, relAlt: 0 })) },
      warnings: { missileIncoming: false, pullUp: false, stall: false, overG: false },
      messages: this.messages, score: 0, wave: 0, round: 0, enemiesRemaining: 0, kills: 0,
      padlock: false, lookBack: false,
      input: { gamepadConnected: false, gamepadName: null, gamepadBlocked: false, usingGamepad: false },
      hitFlash: 0, damageFlash: 0,
    };
  }
  project(pos, out) {
    _v.copy(pos).project(this.camera);
    const w = this.frame.w, h = this.frame.h;
    out.behind = _v.z > 1;
    let sx = (_v.x * 0.5 + 0.5) * w, sy = (1 - (_v.y * 0.5 + 0.5)) * h;
    if (out.behind) { sx = w - sx; sy = h - sy; }
    out.x = sx; out.y = sy;
    out.onScreen = !out.behind && _v.x > -1 && _v.x < 1 && _v.y > -1 && _v.y < 1;
    return out;
  }
  /** HUD contact slot i and its radar blip for hostile e: screen position from the probe S (projected already) or
   *  projected here, and the projected model radius r (px; pxm: px per metre at 1 m) that sizes its marker. */
  hudContact(i, e, S, pxm) {
    const f = this.frame, p = this.player, c = f._contactPool[i], b = f.radar._pool[i];
    if (S) { c.x = S.x; c.y = S.y; c.onScreen = S.onScreen; c.behind = S.behind; } else this.project(e.position, c);
    c.type = 'enemy'; c.hostile = true; c.distance = e.position.distanceTo(p.position); c.isTarget = e === this.target;
    c.r = hudRadius(e) * pxm / Math.max(1, e.position.distanceTo(this.camera.position));
    b.dx = e.position.x - p.position.x; b.dz = e.position.z - p.position.z; b.type = 'enemy'; b.isTarget = c.isTarget; b.relAlt = e.position.y - p.position.y;
  }
  /** Incoming-missile edge arcs (f.threats): a slot per enemy missile guiding on the player, keyed by the missile, with
   *  its screen angle in the camera frame (behind the camera leans to the bottom edge: "on your six"), its time to impact
   *  (as EnemyBrain._scanMissiles) and a fade that runs out over THREAT_FADE s once it stops guiding on us. No allocation. */
  hudThreats(dt) {
    const f = this.frame, p = this.player, cam = this.camera;
    const TP = f._threatPool || (f._threatPool = Array.from({ length: HUD_THREATS }, () => ({ m: null, ang: -Math.PI / 2, tti: 9, fade: 0, seen: false })));
    const th = f.threats || (f.threats = []);
    th.length = 0;
    if (this.state === 'title' || !p.alive) { for (const s of TP) { s.m = null; s.fade = 0; } return; }
    for (const s of TP) s.seen = false;
    const e = cam.matrixWorld.elements;   // camera basis: right (0,1,2), up (4,5,6), back (8,9,10)
    const ms = this.weapons.missiles;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]; if (!m.alive || m.target !== p) continue;
      let s = null;
      for (const q of TP) if (q.m === m) { s = q; break; }
      if (!s) { for (const q of TP) if (!q.m) { s = q; s.m = m; s.ang = -Math.PI / 2; break; } }
      if (!s) continue;                   // (more than HUD_THREATS inbound: the rest share the arcs already drawn)
      _v.subVectors(m.position, p.position); const d = Math.max(_v.length(), 1);
      const vc = Math.max(50, -(_v.x * (m.velocity.x - p.velocity.x) + _v.y * (m.velocity.y - p.velocity.y) + _v.z * (m.velocity.z - p.velocity.z)) / d);
      s.tti = d / vc;
      const x = (_v.x * e[0] + _v.y * e[1] + _v.z * e[2]) / d, y = (_v.x * e[4] + _v.y * e[5] + _v.z * e[6]) / d;
      const z = -(_v.x * e[8] + _v.y * e[9] + _v.z * e[10]) / d;   // + ahead of the camera
      const sy = y + 0.6 * Math.min(0, z);                            // behind: pulled toward the bottom edge
      if (x * x + sy * sy > 4e-4) s.ang = Math.atan2(-sy, x);         // (dead ahead: keep the last angle)
      s.seen = true; s.fade = 1;
    }
    for (const s of TP) {
      if (!s.m) continue;
      if (!s.seen) { s.fade -= dt / THREAT_FADE; if (s.fade <= 0) { s.fade = 0; s.m = null; continue; } }
      th.push(s);
    }
  }
  buildFrame(dt) {
    const f = this.frame, p = this.player, cam = this.camera;
    f.w = this._hudW; f.h = this._hudH; f.dt = dt; f.time = this.time;
    f.state = this.state === 'playing' && !p.alive ? 'dead' : this.state;
    p.getForward(_fwd); p.getUp(_up); p.getRight(_right);
    const pl = f.player;
    pl.speed = p.speed; pl.altitude = p.position.y; pl.radarAlt = p.position.y - Math.max(this.world.getHeight(p.position.x, p.position.z), 0);
    pl.heading = (THREE.MathUtils.radToDeg(Math.atan2(_fwd.x, -_fwd.z)) + 360) % 360;
    pl.pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1)));
    pl.roll = THREE.MathUtils.radToDeg(Math.atan2(-_right.y, _up.y));
    pl.gLoad = p.gLoad; pl.throttle = p.throttle; pl.afterburner = p.afterburner; pl.airbrake = (p.thrust || 0) < -0.3; pl.health = Math.max(0, p.health);
    pl.ammo = p.ammo; pl.missiles = p.missiles; pl.maxMissiles = p.maxMissiles || 8; pl.stall = !!this.stall;
    if (!pl.hardpoints) pl.hardpoints = new Array(HARDPOINTS).fill(1);
    const hps = this.hardpoints || [];
    for (let i = 0; i < HARDPOINTS; i++) pl.hardpoints[i] = hps[i] > 0 ? 1 - hps[i] / HARDPOINT_RELOAD : 1;
    pl.flareReady = !(this.flareT > 0); pl.flareCooldown = this.flareT > 0 ? 1 - this.flareT / FLARE_RELOAD : 1; pl.flareReload = FLARE_RELOAD;
    // Gun cross: where the rounds go, projected from the gun along the nose at the target's range (or 1 km)
    f.velocityVector.visible = false;
    {
      const G = f._gunCross || (f._gunCross = { x: 0, y: 0, visible: true, onScreen: true, behind: false });
      const tgt = this.target && this.target.alive ? this.target : null;
      const range = tgt ? THREE.MathUtils.clamp(tgt.position.distanceTo(p.position), 300, 1500) : 1000;
      p.getForward(_fwd); this.gunOrigin(_v3);
      _v2.copy(_v3).addScaledVector(_fwd, range); this.project(_v2, G);
      G.visible = G.onScreen && this.camMode !== 'rear' && p.alive;
      f.gunCross = G;
    }
    // Target. Every hostile marker also gets the projected radius r (px, from px per metre at 1 m: pxm) of its model
    const t = this.target;
    const pxm = f.h * 0.5 * (cam.zoom || 1) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    if (t && t.alive && this.state !== 'title') {
      const T = f._target; this.project(t.position, T);
      _v2.subVectors(t.position, p.position);
      T.distance = _v2.length(); T.name = t.name || 'BANDIT'; T.health = THREE.MathUtils.clamp(t.health / (t.maxHealth || ENEMY_HEALTH), 0, 1);
      // lock progress only while it can build (in the cone and in sight) or holds: a blocked target shows none
      T.lock = this.inCone || this.locked ? this.lockTimer / LOCK_TIME : 0; T.locked = this.locked; T.inSeekerCone = this.inCone;
      _v.subVectors(p.velocity, t.velocity); T.closure = _v.dot(_v2) / Math.max(T.distance, 1e-3);
      T.r = hudRadius(t) * pxm / Math.max(1, t.position.distanceTo(cam.position));
      // Gun lead (within 1.2 km, target ahead): solve from the gun muzzle. Rounds inherit our velocity and drop
      // slightly, so the launch direction is toward T + (vT - vP)*tof, lifted by the drop; refine twice.
      p.getForward(_fwd);
      const gun = this.gunOrigin(_v3);
      _v2.subVectors(t.position, gun);
      const gd = _v2.length();
      if (gd < GUN_LEAD_RANGE && _v2.dot(_fwd) > gd * 0.4) {
        let tof = gd / 950;
        for (let it = 0; it < 2; it++) {
          _v.copy(t.position).addScaledVector(t.velocity, tof).addScaledVector(p.velocity, -tof);
          tof = _v.distanceTo(gun) / 950;
        }
        _v.y += 0.5 * 9.81 * 0.3 * tof * tof;                    // bullet drop (weapons apply 0.3 g)
        _v.sub(gun).normalize();
        T.leadHot = _v.dot(_fwd) > Math.cos(Math.atan2(14, gd));  // gun line within the hit radius of the lead
        _v.multiplyScalar(gd).add(gun);
        this.project(_v, T._lead);
        // smooth the marker on screen (target jitter + camera shake)
        const sm = T._leadS || (T._leadS = { x: T._lead.x, y: T._lead.y, t: 0 });
        const k = this.time - sm.t > 0.3 ? 1 : 1 - Math.exp(-dt / 0.06);
        sm.x += (T._lead.x - sm.x) * k; sm.y += (T._lead.y - sm.y) * k; sm.t = this.time;
        T._lead.x = sm.x; T._lead.y = sm.y;
        T.lead = T._lead.onScreen ? T._lead : null;
      } else { T.lead = null; T.leadHot = false; }
      f.target = T;
    } else f.target = null;
    // Contacts & radar: a slot (HUD_CONTACTS) per hostile and hostile missile. Should they ever run out, the selected
    // target goes first, then hostiles on screen (the nearest kept), then the rest, then missiles.
    f.contacts.length = 0; f.radar.blips.length = 0;
    const CP = f._contactPool, cap = CP.length, OL = f._offList || (f._offList = []);
    const S = f._probe || (f._probe = { x: 0, y: 0, onScreen: false, behind: false });
    const tFirst = !!t && t.alive && t !== p && t.team !== 'player';
    let n = 0, no = 0, remaining = 0;
    if (tFirst) this.hudContact(n++, t, null, pxm);
    for (const e of this.combatList) {
      if (!e.alive || e === p || e.team === 'player') continue; remaining++;   // friendlies are listed below
      if (e === t && tFirst) continue;
      this.project(e.position, S);
      if (!S.onScreen) { OL[no++] = e; continue; }
      if (n < cap) { this.hudContact(n++, e, S, pxm); continue; }
      let far = -1, fd = e.position.distanceTo(p.position);   // full of on-screen hostiles: replace the farthest
      for (let i = tFirst ? 1 : 0; i < cap; i++) if (CP[i].distance > fd) { fd = CP[i].distance; far = i; }
      if (far >= 0) this.hudContact(far, e, S, pxm);
    }
    for (let i = 0; i < no; i++) { if (n < cap) this.hudContact(n++, OL[i], null, pxm); OL[i] = null; }
    for (const m of this.weapons.missiles) {
      if (!m.alive || m.owner === p || (m.owner && m.owner.team === 'player') || n >= cap) continue;
      const c = CP[n]; this.project(m.position, c); c.type = 'missile'; c.hostile = m.target === p; c.distance = m.position.distanceTo(p.position); c.isTarget = false;
      c.r = 0;
      const b = f.radar._pool[n]; b.dx = m.position.x - p.position.x; b.dz = m.position.z - p.position.z; b.type = 'missile'; b.isTarget = false; b.relAlt = m.position.y - p.position.y;
      n++;
    }
    for (let i = 0; i < n; i++) { f.contacts.push(CP[i]); f.radar.blips.push(f.radar._pool[i]); }
    f.enemiesRemaining = remaining;
    // Friendlies: screen markers for live squadmates (this.allies) and friendly radar contacts for squadmates and allied
    // ground/naval units (AlliedForces.radar, built when they spawn). Pools are made once; nothing here allocates per frame.
    const AP = f._allyPool || (f._allyPool = Array.from({ length: 8 }, () => ({ name: '', callsign: '', x: 0, y: 0, onScreen: false, behind: false, distance: 0 })));
    const FP = f.radar._friendlyPool || (f.radar._friendlyPool = Array.from({ length: 32 }, () => ({ dx: 0, dz: 0, relAlt: 0, type: 'air' })));
    const fa = f.allies || (f.allies = []), fr = f.radar.friendly || (f.radar.friendly = []);
    fa.length = 0; fr.length = 0;
    if (this.state !== 'title') {
      const al = this.allies;
      if (al) for (let i = 0; i < al.length; i++) {
        const a = al[i];
        if (!a || !a.alive || !a.position || a === p) continue;
        if (fa.length < AP.length) {
          const c = AP[fa.length]; this.project(a.position, c);
          c.name = c.callsign = a.callsign || a.name || 'ALLY'; c.distance = p.position.distanceTo(a.position);
          fa.push(c);
        }
        if (fr.length < FP.length) {
          const b = FP[fr.length]; b.dx = a.position.x - p.position.x; b.dz = a.position.z - p.position.z; b.relAlt = a.position.y - p.position.y; b.type = 'air';
          fr.push(b);
        }
      }
      const AR = this.allied.radar;
      for (let i = 0; i < AR.length && fr.length < FP.length; i++) {
        const g = AR[i];
        if (!g.alive) continue;
        const b = FP[fr.length]; b.dx = g.position.x - p.position.x; b.dz = g.position.z - p.position.z; b.relAlt = g.position.y - p.position.y; b.type = g.naval ? 'naval' : 'ground';
        fr.push(b);
      }
    }
    // Boss health bar: the first live enemy whose type has bars (segments drain one at a time)
    let boss = null;
    if (this.state !== 'title') for (const e of this.enemies) if (e.alive && e.bossBars > 0) { boss = e; break; }
    if (boss) {
      const B = f._boss || (f._boss = { name: '', frac: 1, bars: 1 });
      B.name = boss.name; B.bars = boss.bossBars; B.frac = THREE.MathUtils.clamp(boss.health / (boss.maxHealth || 1), 0, 1);
      f.boss = B;
    } else f.boss = null;
    this.hudThreats(dt); f.threatGlass = this.todGlass || 0;   // (the red Glassfall sky: the arcs run stronger)
    f.warnings.missileIncoming = !!this.missileIncoming; f.warnings.pullUp = !!this.pullUp; f.warnings.stall = !!this.stall; f.warnings.overG = false;
    f.radio = this.radio;
    f.compact = !!(this.touch && this.touch.active);
    // Touch button rectangles, so HUD labels can avoid them. getRects() reads layout: refresh it when the size or the
    // controls' visibility changes, and once a second, never every frame.
    if (f.compact && this.touch.getRects) {
      const tk = f.w * 8192 + f.h + (this.touch.visible ? 0.5 : 0) + (this.touch.paused ? 0.25 : 0);
      if (tk !== f._touchKey || this.time - f._touchT > 1) { f._touchKey = tk; f._touchT = this.time; f.touchRects = this.touch.getRects(); }
    } else { f.touchRects = null; f._touchKey = -1; }
    f.messages = this.messages; f.score = this.score; f.wave = this.wave; f.kills = this.kills; f.mission = this.mission ? this.mission.id : 0;
    f.round = this.infinity ? this.infinity.round : 0;   // INFINITY: the HUD shows ROUND n in place of PHASE n
    f.padlock = this.camMode === 'padlock'; f.lookBack = this.camMode === 'rear';
    if (this.camMode === 'mouseaim' && p.alive) {
      const M = f._mouseAim || (f._mouseAim = { aimX: 0, aimY: 0, aimVisible: true, noseX: 0, noseY: 0, noseVisible: true, _a: {}, _n: {} });
      _v2.copy(p.position).addScaledVector(this.aimDir, 2000); this.project(_v2, M._a);
      p.getForward(_fwd); _v2.copy(p.position).addScaledVector(_fwd, 2000); this.project(_v2, M._n);
      M.aimX = M._a.x; M.aimY = M._a.y; M.aimVisible = M._a.onScreen; M.noseX = M._n.x; M.noseY = M._n.y; M.noseVisible = M._n.onScreen;
      f.mouseAim = M;
    } else f.mouseAim = null;
    const i = this.input; f.input.gamepadConnected = i.gamepadConnected; f.input.gamepadName = i.gamepadName; f.input.gamepadBlocked = i.gamepadBlocked; f.input.usingGamepad = i.usingGamepad; f.input.pointerLocked = i.pointerLocked;
    f.hitFlash = this.hitFlash; f.damageFlash = this.damageFlash;
  }
}

function showError(msg) {
  const el = document.querySelector('#err'); if (!el) return;
  el.hidden = false; el.textContent = 'Something broke: ' + msg;
  const l = document.querySelector('#loading'); if (l) l.hidden = true;   // (null-safe)
}
window.addEventListener('error', (e) => showError(e.message || String(e.error || e)));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason && e.reason.message || e.reason)));

function start() {
  try { window.__wingnut = new Game(document.querySelector('#game')); }
  catch (e) { console.error(e); showError(e && e.message || String(e)); }
}
const hot = window.claude && window.claude.hot;
if (hot && typeof hot.ready === 'function') hot.ready(() => start()); else start();
