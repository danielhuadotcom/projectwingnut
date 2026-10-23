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
import { Profiler } from './profiler.js';
import { PRESETS, TIERS, CHOICES, DynamicResolution, loadChoice, saveChoice, guessTier } from './quality.js';
import { GroundForces, DEFAULT_GROUND_TYPES } from './targets.js';
import { MISSIONS, AIRCRAFT_TYPES, GROUND_TYPES } from './missions.js';
import { Awacs } from './awacs.js';
import { Tunnel } from './tunnel.js';
import { Menu, loadSettings } from './menu.js';
import { TouchControls } from './touch.js';
import { Music } from './music.js';

// Fallback campaign (replaced by js/missions.js data once it exists): PW-style missions made of phases of groups.
const FALLBACK_AIR_TYPES = {
  'SLEET-2': { role: 'interceptor', hp: 35, speedKmh: 2500, roll: 170, pitch: 85, yaw: 10, color: 0x6b7178, accent: 0xc0392b },
  'NV-48': { role: 'fighter', hp: 35, speedKmh: 2500, roll: 210, pitch: 85, yaw: 15, color: 0x5d6670, accent: 0xd8232a },
  'FLURRY-4': { role: 'fighter', hp: 45, speedKmh: 2400, roll: 190, pitch: 92, yaw: 14, color: 0x56606a, accent: 0xb3262e },
};
const FALLBACK_MISSIONS = [
  { id: 1, name: 'Warm-Up Lap', briefing: 'Concord patrols are probing the Skerry coast. Clear the sky over the bay.',
    phases: [ { label: 'Patrol', groups: [ { kind: 'air', type: 'SLEET-2', count: 2, formation: 'pair', position: 'ahead', distance: 4500 } ] },
              { label: 'Reinforcements', groups: [ { kind: 'air', type: 'NV-48', count: 3, formation: 'vee', position: 'left', distance: 5000 } ] } ] },
  { id: 2, name: 'Battery Change', briefing: 'Air defenses guard the shoreline. Knock out the sites, then the escorts.',
    phases: [ { label: 'Air defenses', groups: [ { kind: 'ground', type: 'sam', count: 3, area: 'coastline', distance: 6000 }, { kind: 'ground', type: 'aa', count: 4, area: 'coastline', distance: 6000 }, { kind: 'ground', type: 'tank', count: 4, area: 'base', distance: 6500 } ] },
              { label: 'Escorts', groups: [ { kind: 'air', type: 'NV-48', count: 4, formation: 'vee', position: 'ahead', distance: 5000 } ] } ] },
  { id: 3, name: 'Low Tide', briefing: 'A Corsair flotilla is closing on Lanternport. Sink it.',
    phases: [ { label: 'Flotilla', groups: [ { kind: 'naval', type: 'frigate', count: 2, area: 'fleet', distance: 7000 }, { kind: 'naval', type: 'boat', count: 4, area: 'fleet', distance: 7000 } ] },
              { label: 'Air cover', groups: [ { kind: 'air', type: 'FLURRY-4', count: 4, formation: 'line', position: 'high', distance: 5000 }, { kind: 'air', type: 'SLEET-2', count: 2, formation: 'pair', position: 'right', distance: 5000 } ] } ] },
];

// ---------- tuning ----------
// Arcade weapons: the bandit nearest the crosshair is targeted automatically, locks come quickly inside
// a wide cone, standard missiles are short-ranged and fire from two alternating hardpoints that reload separately.
const LOCK_COS = Math.cos(THREE.MathUtils.degToRad(22.5));   // 45 deg full cone
const LOCK_RANGE = 2800;
const HOLD_COS = Math.cos(THREE.MathUtils.degToRad(70)), HOLD_RANGE = 4500;   // once locked, the lock holds this far
const LOCK_TIME = 0.5;
const HARDPOINTS = 2, HARDPOINT_RELOAD = 5;   // s per hardpoint
const FLARE_RELOAD = 7;                         // s (PW: infinite flares, 7 s reload)
const GUN_LEAD_RANGE = 1200;                    // m (PW shows the lead pipper inside 1200 m of the target)
const RADAR_RANGE = 8000;
const TAP_TIME = 0.25;
const PLAYER_ARMOR = 0.5;      // incoming damage multiplier for the player
const ENEMY_HEALTH = 100;      // two missiles (65 each) kill, as for most fighters in PW; ~25 cannon hits
const MAX_ENEMIES = 6;
// Difficulty: player damage taken, enemy hit points and skill, how many bandits may attack at once (the rest hold
// off), enemy missile agility, and which difficulty-specific mission groups spawn.
const DIFFICULTY = {
  easy:      { armor: 0.35, enemyHp: 0.8,  skill: -0.15, aggressors: 1,        missileTurn: 0.5, groups: [] },
  normal:    { armor: 0.5,  enemyHp: 1.0,  skill: 0,     aggressors: 2,        missileTurn: 0.6, groups: [] },
  hard:      { armor: 0.7,  enemyHp: 1.15, skill: 0.1,   aggressors: 4,        missileTurn: 0.7, groups: ['hard'] },
  mercenary: { armor: 1.0,  enemyHp: 1.3,  skill: 0.2,   aggressors: Infinity, missileTurn: 0.8, groups: ['hard', 'mercenary'] },
};
const ENEMY_MISSILE_TURN = 0.6;  // enemy shots turn at 60% of the player's rate (difficulty adjusts it)
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const PARAMS = new URLSearchParams(location.search);

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _ret = new THREE.Vector3(), _rv = new THREE.Vector3();   // reticle direction scratch
const _q = new THREE.Quaternion();
const yawToward = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z)); // rotation about +Y so that -Z nose points from->to

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
    if (PARAMS.has('scale')) this.renderScale = THREE.MathUtils.clamp(Number(PARAMS.get('scale')) || 1, 0.5, 1);
    if (PARAMS.has('dpr')) this.dpr = THREE.MathUtils.clamp(Number(PARAMS.get('dpr')) || 1, 0.5, 2);
    const msaa = PARAMS.has('msaa') ? Number(PARAMS.get('msaa')) : preset.samples;
    // PostFX renders the scene at renderScale internally (instant to change) and composites at native resolution
    this.post = new PostFX(renderer, this.glHost.clientWidth, this.glHost.clientHeight, this.dpr, { samples: msaa, renderScale: this.renderScale, quality: preset.sub });
    this.input = new Input(window);
    this.hud = new HUD(this.hudHost);
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
    // Campaign: the 21 Galebreak Isles missions (js/missions.js), small fallback campaign otherwise
    this.missions = (MISSIONS && MISSIONS.length) ? MISSIONS : FALLBACK_MISSIONS;
    this.airTypes = Object.assign({}, FALLBACK_AIR_TYPES, AIRCRAFT_TYPES || {});
    this.groundTypes = Object.assign({}, DEFAULT_GROUND_TYPES, GROUND_TYPES || {});
    this.missionIndex = 0; this.mission = this.missions[0]; this.phaseIndex = 0;
    this.combatList = [this.player];
    this.killTimes = [];
    this._onFlak = (pos, hit) => {
      this.weapons.explode(pos, 0.3);
      const p = this.player;
      if (hit && p.alive) {
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
    // Gameplay tuning: missiles must be evadable with a hard break turn (module default of 7 rad/s is nearly unmissable)
    // Dodgeable missiles (calibrated with tools/msltest.mjs): ~60 deg seeker gimbal, airframe response lag and a short
    // blind range at the end, so a hard break ~1 s before impact makes them overshoot while straight-flying targets
    // are always hit. More reach so a 2.8 km lock can catch a fleeing target.
    const W = this.weapons;
    W.missileTurnRateBoost = 2.4; W.missileTurnRateCoast = 1.3; W.missileSeekerCos = Math.cos(THREE.MathUtils.degToRad(60));
    W.missileFuse = 11; W.missileLag = 0.18; W.missileBlindRange = 90;
    W.missileLife = 8.5; W.missileMaxSpeed = 760; W.missileBoostTime = 2.6;
    this.enemyMissileTurn = ENEMY_MISSILE_TURN;
    this.weapons.missileCooldown = 0.2;          // hardpoints pace the player; this only stops double-taps in one frame
    this.applyQuality(this.quality);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); });
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
      const type = this.airTypes['SLEET-2'] || Object.values(this.airTypes)[0];
      const dummy = this.spawnAircraft('SLEET-2', type, P.clone(), 0, 0);
      this.rebuildCombatList();
      dummy.vapor && (dummy.vapor.visible = true);
      this.player.vapor && (this.player.vapor.visible = true);
      const w = this.weapons;
      for (let i = 0; i < 4; i++) w.fireGun(dummy);
      w.fireMissile(dummy, null);
      if (w.deployFlares) w.deployFlares(dummy);
      _v.copy(P).add(new THREE.Vector3(60, 0, -200)); w.explode(_v, 1.5);
      w.terrainImpact(_v.add(new THREE.Vector3(80, 0, 0)));
      w.aircraftDeath(dummy);
      const cam = new THREE.PerspectiveCamera(70, this.camera.aspect, 1, 60000);
      cam.position.copy(P).add(new THREE.Vector3(0, 30, 160)); cam.lookAt(P.x, P.y, P.z - 150);
      cam.updateMatrixWorld();
      // Step the effects through their lifecycle (missile ignition, smoke, flares burning, debris, decay) and render
      // each stage once, so every material/blend/state combination gets its pipeline built now rather than mid-fight.
      const r = this.renderer, prev = r.getRenderTarget();
      for (let step = 0; step < 14; step++) {
        w.update(step === 0 ? 1 / 60 : 0.15, this.combatList, cam);
        if (step === 6) { w.fireMissile(dummy, null); _v.copy(P).add(new THREE.Vector3(-70, 10, -260)); w.explode(_v, 0.7); }
        if (this.post.rtScene) { r.setRenderTarget(this.post.rtScene); r.render(this.scene, cam); }
      }
      r.setRenderTarget(prev);
      dummy.kill();
      for (const m of w.missiles) if (m.owner === dummy) m.alive = false;
      if (this.player.vapor) this.player.vapor.visible = false;
      this.rebuildCombatList();
    } catch (e) { console.warn('effect warm-up skipped', e); }
  }
  resize() {
    const w = this.glHost.clientWidth || 1, h = this.glHost.clientHeight || 1;
    const post = this.post;
    if (post.setRenderScale) {
      // PostFX renders the scene at renderScale internally and composites at native resolution
      this.renderer.setPixelRatio(this.dpr);
      this.renderer.setSize(w, h, false);
      post.setSize(w, h, this.dpr);
      post.setRenderScale(this.renderScale);
    } else {
      const pr = this.dpr * this.renderScale;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
      post.setSize(w, h, pr);
    }
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.hud.resize();
  }
  setRenderScale(s) {
    if (Math.abs(s - this.renderScale) < 1e-3) return;
    this.renderScale = s;
    if (this.post.setRenderScale) this.post.setRenderScale(s); else this.resize();
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
      const fx = { low: [128, 45], medium: [192, 70], high: [256, 90], ultra: [256, 90] }[tier];
      this.weapons.maxPointSize = fx[0]; this.weapons.missileSmokeRate = fx[1];
      if (this.weapons.setQuality) this.weapons.setQuality(p.sub);
    }
    for (const ac of this.allAircraft || []) { if (ac.setEffectsQuality) ac.setEffectsQuality(p.sub); else if (ac.engineFX && ac.engineFX.setQuality) ac.engineFX.setQuality(p.sub); }
    this.dynres.reset();
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
  updateDynamicResolution(dt) {
    if (this.state === 'paused') return;
    const gpu = this.profiler.mode === 'pass' ? this.profiler.lastTotal.pass : 0;
    const r = this.dynres.update(dt, this.renderScale, PRESETS[this.quality], gpu, dt * 1000);
    if (r.tier && this.qualityChoice === 'auto') {
      const i = TIERS.indexOf(this.quality) + r.tier;
      if (i >= 0 && i < TIERS.length) { this.renderScale = r.tier < 0 ? PRESETS[TIERS[i]].scaleMax : PRESETS[TIERS[i]].scaleMin; this.applyQuality(TIERS[i], false, false); }
      return;
    }
    this.setRenderScale(r.scale);
  }
  updateOverlay(dt) {
    const el = this.ui.perf; if (!el || el.hidden) return;
    this._ovT = (this._ovT || 0) + dt; if (this._ovT < 0.25) return; this._ovT = 0;
    const L = this.profiler.live(), g = L.gpu;
    const f = (v) => (v || 0).toFixed(1);
    const c = this.renderer.domElement, sc = this.post.renderScale || this.renderScale;
    const iw = this.post.renderWidth || c.width, ih = this.post.renderHeight || c.height;
    el.textContent =
      `FPS ${L.fps.toFixed(0).padStart(3)}  frame ${f(L.frame)} ms\n` +
      (this.profiler.supported ? `GPU ${f(g.__total)} ms  scene ${f(g.scene)}  bloom ${f(g.bloom)}  comp ${f(g.composite)}\n` : 'GPU timing unavailable in this browser\n') +
      `CPU logic ${f(L.cpu.logic)}  render ${f(L.cpu.render)}  hud ${f(L.cpu.hud)}\n` +
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
    const list = this.missions, n = list.length;
    this.missionIndex = i;
    const M = this.mission = list[((i % n) + n) % n];
    this.resetPlayer();
    this.chase.snap(this.player);
    for (const e of this.enemies) e.kill();
    this.ground.clear();
    for (const m of this.weapons.missiles) m.alive = false;
    this.messages.length = 0;
    this.target = null; this.lockTimer = 0; this.locked = false;
    this.phaseIndex = -1; this.waveTimer = 0; this.missionDoneT = 0; this.killTimes.length = 0;
    this.lowHealthSaid = false;
    this.fireGrace = 0.35;                 // the button that launched the sortie must not also fire a weapon
    this.setState('playing');
    this.message(`MISSION ${M.id}: ${String(M.name).toUpperCase()}`, true, 4.5);
    if (M.briefing) for (const line of String(M.briefing).split(/(?<=[.!?])\s+/).slice(0, 3)) this.message(line, false, 7);
    this.say('sortieStart', 3);
    this.nextPhase();
  }
  /** Spawn the next phase of the current mission, or complete the mission after the last one. */
  nextPhase() {
    const M = this.mission;
    this.phaseIndex++;
    if (this.phaseIndex >= M.phases.length) { this.missionComplete(); return; }
    const P = M.phases[this.phaseIndex];
    let air = 0, ground = 0, naval = 0;
    const allowed = (this.diff || DIFFICULTY.normal).groups;
    for (const g of P.groups) {
      if (g.difficulty && !allowed.includes(g.difficulty)) continue;
      const k = this.spawnGroup(g);
      if (g.kind === 'air') air += k; else if (g.kind === 'naval') naval += k; else ground += k;
    }
    this.rebuildCombatList();
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
  }
  missionComplete() {
    this.missionDoneT = 0.001;
    this.score += 3000 + 1000 * this.missionIndex;
    this.message('MISSION COMPLETE', true, 5.5);
    this.say('missionComplete', 3);
    this.audio.ui('wave');
  }
  rebuildCombatList() {
    const L = this.combatList; L.length = 0;
    for (const a of this.allAircraft) L.push(a);
    for (const t of this.ground.targets) if (t.alive) L.push(t);
  }
  /** Place one mission group relative to the player: air groups in formation, surface groups on suitable terrain. */
  spawnGroup(g) {
    const p = this.player; p.getForward(_fwd);
    const base = Math.atan2(_fwd.x, -_fwd.z);
    const rel = { ahead: 0, high: 0, low: 0, left: -Math.PI / 2, right: Math.PI / 2, behind: Math.PI }[g.position];
    const bearing = base + (rel !== undefined ? rel : (Math.random() - 0.5) * 1.6) + (Math.random() - 0.5) * 0.35;
    const dist = g.distance || (g.kind === 'air' ? 5000 : 7000);
    const cx = THREE.MathUtils.clamp(p.position.x + Math.sin(bearing) * dist, -WORLD_HALF * 0.85, WORLD_HALF * 0.85);
    const cz = THREE.MathUtils.clamp(p.position.z - Math.cos(bearing) * dist, -WORLD_HALF * 0.85, WORLD_HALF * 0.85);
    this._spawnOptional = !!g.optional;
    return g.kind === 'air' ? this.spawnAirGroup(g, cx, cz) : this.spawnSurfaceGroup(g, cx, cz);
  }
  spawnAirGroup(g, cx, cz) {
    const typeName = g.type || 'SLEET-2';
    const type = this.airTypes[typeName] || FALLBACK_AIR_TYPES['SLEET-2'];
    const n = Math.max(1, Math.min(g.count || 1, 8));
    const p = this.player;
    const groundH = Math.max(this.world.getHeight(cx, cz), 0);
    const altOff = g.position === 'high' ? 900 : g.position === 'low' ? -350 : (Math.random() - 0.4) * 600;
    const alt = THREE.MathUtils.clamp(p.position.y + altOff, groundH + 450, 4500);
    _v2.set(cx, alt, cz);
    const heading = yawToward(_v2, p.position);
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
    for (let i = 0; i < n; i++) {
      let lat = 0, back = 0;
      const f = g.formation || 'vee', k = (i + 1) >> 1, side = i % 2 ? -1 : 1;
      if (f === 'line') lat = (i - (n - 1) / 2) * 160;
      else if (f === 'pair') { lat = (i % 2 ? 1 : -1) * 80; back = (i >> 1) * 320; }
      else if (f === 'loose') { lat = (Math.random() - 0.5) * 1200; back = Math.random() * 700; }
      else { lat = k * side * 140; back = k * 120; }
      const x = cx + rx * lat - fx * back, z = cz + rz * lat - fz * back;
      const y = Math.max(alt + (Math.random() - 0.5) * 60, Math.max(this.world.getHeight(x, z), 0) + 350);
      this.spawnAircraft(typeName, type, new THREE.Vector3(x, y, z), heading, i);
    }
    for (const e of this.enemies) e._pending = false;
    return n;
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
    // per-type speed: AI cruise speed relative to a SLEET-2's 1100 km/h (helicopters slow, cruise missiles fast)
    const cruiseKmh = (type.ai && type.ai.kmh && type.ai.kmh[1]) || ((type.speedKmh || 2500) <= 1200 ? type.speedKmh : (type.speedKmh || 2500) * 0.44);
    ac.speedScale = THREE.MathUtils.clamp(cruiseKmh / 1100, 0.3, 1.2);
    ac.mesh.scale.setScalar(/missile/i.test(type.role || '') ? 0.45 : 1);
    ac.health = hp; ac.maxHealth = hp;
    ac.quaternion.setFromAxisAngle(WORLD_UP, heading);
    ac.handling.pitch = THREE.MathUtils.clamp((type.pitch || 85) / 90 * 0.85, 0.55, 1);
    ac.handling.roll = THREE.MathUtils.clamp((type.roll || 180) / 170 * 0.85, 0.55, 1);
    ac.handling.yaw = THREE.MathUtils.clamp((type.yaw || 12) / 14, 0.6, 1.2);
    ac.gunRate = 12;                                     // enemy cannons fire at about half the player's rate
    ac.speed = FLIGHT.CRUISE_SPEED * ac.speedScale; ac.missiles = type.armed === false || type.armed === 'gun' ? 0 : (this.missionIndex < 2 ? 2 : 3); ac.ammo = 9999;
    ac.getForward(_fwd); ac.velocity.copy(_fwd).multiplyScalar(ac.speed);
    const skill = THREE.MathUtils.clamp(0.38 + this.missionIndex * 0.06 + (type.role === 'fighter' ? 0.05 : 0) + (this.skillOffset || 0), 0.2, 0.95);
    ac.brain.skill = skill; ac.brain.state = 'pursue'; ac.brain.stateTime = 0; ac.brain.missileCooldown = 10 + Math.random() * 8;
    ac.brain.missileReload = type.missileReload || 0;   // per-type override (Mainspring: a third of the player's hardpoint reload)
    if (type.missileReload) ac.missiles = 999;
    ac.brain.passive = type.armed === false;
    ac.brain.gunsOnly = type.armed === false ? 'none' : null;
    if (ac.brain.passive) { ac.getForward(ac.brain.transitDir); ac.brain.transitAlt = pos.y; ac.brain.state = 'transit'; }
    ac.name = typeName;
    return ac;
  }
  /**
   * Find a land (or sea) site near (cx, cz): a spiral search out to 9 km, then the nearest qualifying point of a 1 km grid
   * over the map (both bounded; null only if nothing qualifies anywhere). A sea site needs open water 1 km around (room for
   * the group, no inland lakes) and must float def's hull clear of other ships.
   */
  findSite(cx, cz, naval, out, def) {
    const w = this.world, gf = this.ground, lim = WORLD_HALF * 0.9;
    const ok = naval
      ? (x, z) => gf.openWater(x, z, 1000) && (!def || gf.hullClear(def, x, z))
      : (x, z) => { const h = w.getHeight(x, z); return h > 8 && h < 900 && Math.abs(w.getHeight(x + 40, z) - w.getHeight(x - 40, z)) < 50 && Math.abs(w.getHeight(x, z + 40) - w.getHeight(x, z - 40)) < 50; };
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
  spawnSurfaceGroup(g, cx, cz) {
    const typeName = g.type || 'tank';
    const def = this.groundTypes[typeName] || DEFAULT_GROUND_TYPES[typeName] || DEFAULT_GROUND_TYPES.tank;
    const naval = g.kind === 'naval' || !!def.naval;
    const site = this.findSite(cx, cz, naval, _v3, def);
    if (!site) return 0;
    const n = Math.max(1, Math.min(g.count || 1, 24));
    const area = g.area || (naval ? 'fleet' : 'base');
    const dirA = Math.random() * Math.PI * 2;
    // ships need the whole hull afloat in open water, clear of other ships; vehicles need dry land
    const fits = naval ? (x, z, hdg) => this.ground.hullClear(def, x, z, hdg)
                       : (x, z) => { const h = this.world.getHeight(x, z); return h > 3 && h < 1200; };
    let placed = 0;
    for (let i = 0; i < n; i++) {
      let x = site.x, z = site.z, ok = false;
      const hdg = area === 'convoy' || area === 'fleet' ? dirA : Math.random() * Math.PI * 2;
      for (let tries = 0; tries < 8 && !ok; tries++) {
        if (area === 'convoy') { const d = (i - n / 2) * 45; x = site.x + Math.cos(dirA) * d; z = site.z + Math.sin(dirA) * d; }
        else if (area === 'fleet') { const row = Math.floor(i / 3), col = (i % 3) - 1; x = site.x + Math.cos(dirA) * row * 320 + Math.sin(dirA) * col * 260; z = site.z + Math.sin(dirA) * row * 320 - Math.cos(dirA) * col * 260; }
        else { const r = (area === 'scattered' ? 1200 : area === 'base' ? 320 : 600) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2; x = site.x + Math.cos(a) * r; z = site.z + Math.sin(a) * r; }
        if (tries > 0) { x += (Math.random() - 0.5) * 120 * tries; z += (Math.random() - 0.5) * 120 * tries; }
        ok = fits(x, z, hdg);
      }
      if (!ok) {
        // formation slot unusable: the nearest spot that fits around the site (bounded ring search from a random bearing),
        // else leave the unit out rather than strand it on land or in the sea
        const a0 = Math.random() * Math.PI * 2;
        for (let r = 80; !ok && r <= 2400; r += 80) {
          const steps = Math.max(8, Math.round(r / 16));   // ~100 m apart along the ring
          for (let k = 0; k < steps && !ok; k++) {
            const a = a0 + (k / steps) * Math.PI * 2;
            x = site.x + Math.cos(a) * r; z = site.z + Math.sin(a) * r;
            ok = fits(x, z, hdg);
          }
        }
        if (!ok) continue;
      }
      const t = this.ground.spawn(typeName, def, x, z, hdg);
      if (t) {
        t.name = typeName.toUpperCase(); t.optional = this._spawnOptional; placed++;
        const hm = (this.diff && this.diff.enemyHp) || 1; t.maxHealth = t.health = Math.round(def.hp * hm);
      }
    }
    return placed;
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
    this.messages.push({ text, age: 0, duration, big });
    if (this.messages.length > 5) this.messages.shift();
  }

  // ---------- weapon callbacks ----------
  onHit(target, dmg, shooter, kind) {
    if (target === this.player) {
      this.damageFlash = 1; this.post.damage(kind === 'missile' ? 1 : 0.45);
      this.chase.addShake(kind === 'missile' ? 0.9 : 0.25); this.audio.hit();
      if (kind === 'missile') this.message('MISSILE HIT', false, 1.5);
      this.say('playerHit', 2);
      if (!this.lowHealthSaid && target.health < 35) { this.lowHealthSaid = true; this.say('lowHealth', 3); }
    } else if (shooter === this.player) {
      this.hitFlash = 1; this.audio.impact(); this.score += kind === 'gun' ? 10 : 150;
    }
  }
  onKill(target, shooter) {
    if (target === this.player) { this.die('SHOT DOWN', true); return; }
    target.kill();
    if (shooter === this.player) {
      this.kills++;
      const isGround = !!target.isGround;
      if (!isGround && this.audio.wilhelm) {
        const dW = target.position.distanceTo(this.camera.position);
        if (dW < 500 && Math.random() < 0.34) this.audio.wilhelm(dW);
      }
      if (target.naval) { _v.copy(target.position); this.weapons.explode(_v, 2.5); _v.y += 8; this.weapons.explode(_v.addScaledVector(_fwd.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(), 25), 1.8); }
      this.score += isGround ? 300 : 1000;
      this.message(isGround ? 'GROUND TARGET DESTROYED' : 'TARGET DESTROYED', true, 2.2); this.audio.ui('kill');
      const t = this.time; this.killTimes.push(t);
      while (this.killTimes.length && t - this.killTimes[0] > 12) this.killTimes.shift();
      if (this.killTimes.length === 3) this.say('streak', 2); else this.say(isGround ? 'groundKill' : 'kill', 2);
    } else this.message(target.isGround ? 'TARGET DESTROYED' : 'BANDIT DOWN', false, 2);
    if (this.target === target) { this.target = null; this.lockTimer = 0; this.locked = false; }
  }
  onExplosion(pos, size) {
    const d = pos.distanceTo(this.camera.position);
    const k = THREE.MathUtils.clamp(1 - d / 900, 0, 1) * Math.min(1, size);
    if (k > 0) { this.post.flash(k * 0.6); this.chase.addShake(k * 0.8); }
    this.audio.explosion(d * 0.3);
  }
  onMissileLaunch(m) {
    if (m.owner !== this.player) m.turnScale = this.enemyMissileTurn || ENEMY_MISSILE_TURN;
    if (m.owner !== this.player && m.target === this.player) { this.message('MISSILE LAUNCH', false, 2); this.say('missileIncoming', 3); }
  }

  // ---------- main loop ----------
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    let dt = (now - this.last) / 1000; this.last = now;
    if (!(dt > 0)) dt = 0.016; dt = Math.min(dt, 0.05);
    if (document.hidden) return;
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
    }
    this.updateDeviceHints();

    if (this.state === 'playing') this.updateGame(dt);
    else if (this.state === 'title') this.updateTitle(dt);
    else if (this.state === 'dead' || this.state === 'complete') { this.updateDead(dt); }
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

    prof.cpuEnd('logic'); prof.cpuBegin('world');
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
    this.buildFrame(dt);
    if (!this.noHud) this.hud.render(this.frame);
    prof.cpuEnd('hud');
    this.updateTitleStatus();
    if (!this.bench || PARAMS.has('dynres')) this.updateDynamicResolution(dt);
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
    this.weapons.update(dt, this.combatList, this.camera);
    this.audio.setEngine({ throttle: p.throttle, speedFrac: p.speed / FLIGHT.AB_SPEED, afterburner: false, alive: true });
  }
  updateDead(dt) {
    this.deadTimer += dt;
    for (let i = 0; i < this.enemies.length; i++) { const e = this.enemies[i]; if (e.alive) { e.brain.update(dt, this.player, this.world, this.weapons, this.time); e.update(dt); } }
    this.weapons.update(dt, this.combatList, this.camera);
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
    // Attack slots: only the N closest armed bandits press the attack; the rest hold off (no limit on Mercenary)
    this._slotT = (this._slotT || 0) - dt;
    if (this._slotT <= 0) {
      this._slotT = 0.5;
      const maxA = (this.diff || DIFFICULTY.normal).aggressors;
      const armed = this._armed || (this._armed = []); armed.length = 0;
      for (const e of this.enemies) if (e.alive && e.brain && !e.brain.passive) { e._d2 = e.position.distanceToSquared(p.position); armed.push(e); }
      armed.sort((a, b) => a._d2 - b._d2);
      for (let i = 0; i < armed.length; i++) armed[i].brain.aggressor = i < maxA;
    }
    // Enemies
    let aliveEnemies = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]; if (!e.alive) continue;
      e.brain.update(dt, p, world, weapons, this.time);
      e.update(dt);
      const h = Math.max(world.getHeight(e.position.x, e.position.z), 0);
      if (e.position.y < h + 3 * (e.mesh.scale.x || 1) || (this.tunnel && this.tunnel.collide(e.position, 6) === 'wall')) {
        weapons.aircraftDeath(e); e.kill(); this.score += 300; this.message('BANDIT CRASHED', false, 2);
        if (this.target === e) { this.target = null; this.lockTimer = 0; this.locked = false; }
        continue;
      }
      if (!e.optional) aliveEnemies++;
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
    this.ground.update(dt, p, weapons, this._onFlak);
    weapons.update(dt, this.combatList, this.camera);
    // Mission progression: a phase is cleared when no enemy aircraft or ground/naval targets remain
    let surfaceAlive = 0;
    for (const t of this.ground.targets) if (t.alive && !t.optional) surfaceAlive++;
    if (this.missionDoneT > 0) {
      this.missionDoneT += dt;
      if (this.missionDoneT > 4.5) { this.missionDoneT = 0; this.setState('complete'); this.showDebrief(true); }
    } else if (aliveEnemies + surfaceAlive === 0 && p.alive) {
      this.waveTimer += dt;
      const last = this.phaseIndex >= this.mission.phases.length - 1;
      if (this.waveTimer > 0.1 && this.waveTimer - dt <= 0.1 && !last) { this.score += 1000; this.message('AREA CLEAR', true, 2.5); this.say('waveClear', 2); }
      if (this.waveTimer > (last ? 1.2 : 3.5)) { this.waveTimer = 0; this.nextPhase(); }
    } else this.waveTimer = 0;
    // Warnings & audio
    let missileIncoming = false;
    const ms = weapons.missiles;
    for (let i = 0; i < ms.length; i++) { const m = ms[i]; if (m.alive && m.target === p) { missileIncoming = true; break; } }
    this.missileIncoming = missileIncoming && p.alive;
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
    if (!p.alive) { this.deadTimer += dt; if (this.deadTimer > 2.2) { this.setState('dead'); this.showDebrief(false); } }
    this.ageMessages(dt);
  }

  updateTargeting(dt) {
    const p = this.player, input = this.input;
    if (this.target && !this.target.alive) { this.target = null; this.lockTimer = 0; this.locked = false; }
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
      this.inCone = cos > LOCK_COS && d < LOCK_RANGE;
      const holding = this.locked && cos > HOLD_COS && d < HOLD_RANGE;   // hysteresis: an acquired lock is sticky
      this.lockTimer = (this.inCone || holding) ? Math.min(LOCK_TIME, this.lockTimer + dt) : Math.max(0, this.lockTimer - dt * 2.5);
      const was = this.locked; this.locked = this.lockTimer >= LOCK_TIME - 1e-6;
      if (this.locked && !was) { this.audio.ui('select'); this.target._lockedOnce = true; }
    } else { this.lockTimer = 0; this.locked = false; }
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
  bestTarget() {
    const dir = this.reticleDir(_ret);
    let best = null, bs = Infinity;
    for (const e of this.combatList) { if (!e.alive || e === this.player) continue; const sc = this.targetScore(e, dir); if (sc < bs) { bs = sc; best = e; } }
    return best;
  }
  nearestEnemy() { return this.bestTarget(); }
  /**
   * Target button: pick the hostile that appears closest to the reticle on screen, other than the current target.
   * Quick repeated taps (each within 2.5 s of the last) walk outward: each takes the closest one not yet picked in
   * that run. After a pause the next tap starts over from the reticle, so pointing at something and tapping takes it.
   */
  cycleTarget() {
    const now = this.time, dir = this.reticleDir(_ret);
    const walk = this._walk || (this._walk = new Set());
    if (now - (this._walkT ?? -99) > 2.5) walk.clear();
    if (this.target) walk.add(this.target);
    let best = null;
    for (let pass = 0; pass < 2 && !best; pass++) {
      if (pass === 1) { walk.clear(); if (this.target) walk.add(this.target); }   // all visited: wrap to the closest again
      let bd = Infinity;
      for (const e of this.combatList) {
        if (!e.alive || e === this.player || walk.has(e)) continue;
        const a = this.reticleAngle(e, dir);
        if (a < bd) { bd = a; best = e; }
      }
    }
    this._walkT = now;
    if (best) { walk.add(best); this.target = best; this.lockTimer = 0; this.locked = false; this.audio.ui('select'); }
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
    });
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
      case 'perfOverlay': if (this.ui.perf) this.ui.perf.hidden = !v; break;
      case 'invertPitch': this.input.setInvertPitch(!!v); if (this.touch && this.touch.setPitchInverted) this.touch.setPitchInverted(!!v); break;
      case 'touch': if (this.touch) this.touch.setMode(v || 'auto'); break;
      case 'cameraShake': this.chase.shakeScale = v === false ? 0 : 1; break;
      case 'master': this.audio.setMaster(Number(v)); break;
      case 'music': if (this.music && this.music.setVolume) this.music.setVolume(Number(v)); break;
      case 'sfx': if (this.audio.setSfxVolume) this.audio.setSfxVolume(Number(v)); break;
      case 'voice': if (this.awacs.setVolume) this.awacs.setVolume(Number(v)); break;
      case 'difficulty': {
        const d = this.diff = DIFFICULTY[v] || DIFFICULTY.normal;
        this.armor = d.armor; this.skillOffset = d.skill; this.enemyMissileTurn = d.missileTurn;
        break;
      }
      default: break;   // mouseSens, mouseKeys, subtitles are read live
    }
  }
  pauseGame() {
    this.setState('paused'); this.silenceGameAudio();
    this.input.exitPointerLock();
    this.menu.show('pause', { missionIndex: this.missionIndex });
  }
  resumeGame() {
    this.setState('playing'); this.last = performance.now(); this.fireGrace = 0.3;
    if (this.audio.setPaused) this.audio.setPaused(false);
  }
  quitToTitle() {
    for (const e of this.enemies) e.kill();
    this.ground.clear();
    for (const m of this.weapons.missiles) m.alive = false;
    this.messages.length = 0; this.radio = null; this.target = null;
    if (this.awacs.stop) this.awacs.stop();
    if (this.audio.setPaused) this.audio.setPaused(false);
    this.resetPlayer(); this.chase.snap(this.player);
    this.setState('title');
    this.input.exitPointerLock();
  }
  showDebrief(success) {
    const n = this.missions.length, M = this.mission;
    this.input.exitPointerLock();
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
    if (ang < 0.14) {
      pitch = ly * 8 - r.pitch * 0.25;
      yaw = lx * 6 - r.yaw * 0.3;
      const bank = Math.atan2(-_right.y, _up.y);
      roll = -bank * 0.9 + lx * 2.5 - r.roll * 0.08;               // drift the wings level while fine-aiming
    } else if (lz > 0.75) {
      // aim well behind: commit to one turn direction and pull hard until it comes around (no dithering)
      if (!this._behindDir) this._behindDir = lx >= 0 ? 1 : -1;
      const rollErr = Math.atan2(this._behindDir, Math.max(ly, 0.25));
      roll = rollErr * 2.4 - r.roll * 0.12; pitch = 1; yaw = this._behindDir * 0.3;
    } else {
      const rollErr = Math.atan2(lx, ly);                            // roll the aim point overhead...
      roll = rollErr * 2.4 - r.roll * 0.12;
      pitch = Math.max(0, Math.cos(rollErr)) * Math.min(1, ang * 2.6) - r.pitch * 0.08;   // ...then pull
      if (ly < 0 && ang < 0.35 && Math.abs(rollErr) > 2.2) { roll = lx * 3; pitch = ly * 5; }   // slightly below: push
      yaw = lx * 1.2;
    }
    // Arcade safety net: the instructor won't fly you into the ground (manual roll still can)
    const h = Math.max(this.world.getHeight(p.position.x, p.position.z), 0);
    _v2.copy(p.position).addScaledVector(p.velocity, 2.2);
    const h2 = Math.max(this.world.getHeight(_v2.x, _v2.z), 0);
    const nearTunnel = this.tunnel && (this.inTunnel || this.tunnel.closestPathT(p.position) >= 0);
    if (!nearTunnel && (p.position.y - h < 110 || _v2.y - h2 < 70) && p.velocity.y < 40) {
      const bank = Math.atan2(-_right.y, _up.y);
      roll = -bank * 2; pitch = Math.max(pitch, Math.abs(bank) < 1.2 ? 1 : 0.2);
    }
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
    this.ground.clear();
    const p = this.player; p.getForward(_fwd);
    this.spawnAirGroup({ type: 'NV-48', count: 6, formation: 'loose' }, p.position.x + _fwd.x * 3500, p.position.z + _fwd.z * 3500);   // constant workload
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
    const mk = () => ({ x: 0, y: 0, onScreen: false, behind: false, type: 'enemy', hostile: true, distance: 0, isTarget: false });
    return {
      w: 1, h: 1, dt: 0, time: 0, state: 'title',
      player: { speed: 0, altitude: 0, radarAlt: 0, heading: 0, pitch: 0, roll: 0, gLoad: 1, throttle: 0, afterburner: false, health: 100, ammo: 0, missiles: 0, maxMissiles: 8, stall: false },
      velocityVector: { x: 0, y: 0, visible: false },
      target: null,
      _target: { x: 0, y: 0, onScreen: false, behind: false, distance: 0, name: '', health: 1, lock: 0, locked: false, inSeekerCone: false, closure: 0, lead: null, _lead: { x: 0, y: 0 } },
      contacts: [], _contactPool: Array.from({ length: 48 }, mk),
      radar: { range: RADAR_RANGE, blips: [], _pool: Array.from({ length: 48 }, () => ({ dx: 0, dz: 0, type: 'enemy', isTarget: false, relAlt: 0 })) },
      warnings: { missileIncoming: false, pullUp: false, stall: false, overG: false },
      messages: this.messages, score: 0, wave: 0, enemiesRemaining: 0, kills: 0,
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
  buildFrame(dt) {
    const f = this.frame, p = this.player, cam = this.camera;
    f.w = this.hudHost.clientWidth || 1; f.h = this.hudHost.clientHeight || 1; f.dt = dt; f.time = this.time;
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
    // Target
    const t = this.target;
    if (t && t.alive && this.state !== 'title') {
      const T = f._target; this.project(t.position, T);
      _v2.subVectors(t.position, p.position);
      T.distance = _v2.length(); T.name = t.name || 'BANDIT'; T.health = THREE.MathUtils.clamp(t.health / (t.maxHealth || ENEMY_HEALTH), 0, 1);
      T.lock = this.lockTimer / LOCK_TIME; T.locked = this.locked; T.inSeekerCone = this.inCone;
      _v.subVectors(p.velocity, t.velocity); T.closure = _v.dot(_v2) / Math.max(T.distance, 1e-3);
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
    // Contacts & radar
    f.contacts.length = 0; f.radar.blips.length = 0;
    let n = 0, remaining = 0;
    for (const e of this.combatList) {
      if (!e.alive || e === p) continue; remaining++;
      if (n < f._contactPool.length) {
        const c = f._contactPool[n]; this.project(e.position, c); c.type = 'enemy'; c.hostile = true; c.distance = e.position.distanceTo(p.position); c.isTarget = e === t;
        f.contacts.push(c);
        const b = f.radar._pool[n]; b.dx = e.position.x - p.position.x; b.dz = e.position.z - p.position.z; b.type = 'enemy'; b.isTarget = e === t; b.relAlt = e.position.y - p.position.y;
        f.radar.blips.push(b); n++;
      }
    }
    for (const m of this.weapons.missiles) {
      if (!m.alive || m.owner === p || n >= f._contactPool.length) continue;
      const c = f._contactPool[n]; this.project(m.position, c); c.type = 'missile'; c.hostile = m.target === p; c.distance = m.position.distanceTo(p.position); c.isTarget = false;
      f.contacts.push(c);
      const b = f.radar._pool[n]; b.dx = m.position.x - p.position.x; b.dz = m.position.z - p.position.z; b.type = 'missile'; b.isTarget = false; b.relAlt = m.position.y - p.position.y;
      f.radar.blips.push(b); n++;
    }
    f.enemiesRemaining = remaining;
    // Boss health bar: the first live enemy whose type has bars (segments drain one at a time)
    let boss = null;
    if (this.state !== 'title') for (const e of this.enemies) if (e.alive && e.bossBars > 0) { boss = e; break; }
    if (boss) {
      const B = f._boss || (f._boss = { name: '', frac: 1, bars: 1 });
      B.name = boss.name; B.bars = boss.bossBars; B.frac = THREE.MathUtils.clamp(boss.health / (boss.maxHealth || 1), 0, 1);
      f.boss = B;
    } else f.boss = null;
    f.warnings.missileIncoming = !!this.missileIncoming; f.warnings.pullUp = !!this.pullUp; f.warnings.stall = !!this.stall; f.warnings.overG = false;
    f.radio = this.radio;
    f.compact = !!(this.touch && this.touch.active);
    f.messages = this.messages; f.score = this.score; f.wave = this.wave; f.kills = this.kills; f.mission = this.mission ? this.mission.id : 0;
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
