import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// Ground and naval targets for missions. Every target is drawn as an instanced box or prism (2 draw calls total) and is
// duck-typed like an Aircraft (position, velocity, quaternion, alive, team, health, applyDamage, hitRadius, isGround),
// so weapons, lock-on, the HUD and the radar treat it like any other contact.
// Allied props (team 'player', js/allies.js) share the meshes in a friendly tint but draw on a budget of their own, so
// they never take an enemy's instance: spawn() returns null only when that unit's own side is full.
const MAX_PER_SHAPE = 192;        // enemy instances per shape
const ALLY_PER_SHAPE = 32;        // allied instances per shape, on top
const CAPACITY = MAX_PER_SHAPE + ALLY_PER_SHAPE;
const ALLY_TINT = 0x4f6f94, ALLY_TINT_NAVAL = 0x7d94b2;   // allied steel blue (no enemy type is blue)
const WRECK = 0x1c1a18;
const SINK_TIME = 10;             // s for a scripted sinking (sink) to settle under the surface
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _c = new THREE.Color(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1), X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
// Naval placement: water depth (m) needed under every hull sample, and how far (m) past bow, stern and beams it must reach
// (shallower water renders as sand and shoreline foam, so a hull over it looks beached)
const NAVAL_DEPTH = 5, NAVAL_MARGIN = 30;

export const DEFAULT_GROUND_TYPES = {
  tank:     { shape: 'box',   size: [4, 2.5, 7],    hp: 30,  shoots: false,     naval: false },
  truck:    { shape: 'box',   size: [3, 3, 8],      hp: 20,  shoots: false,     naval: false },
  sam:      { shape: 'prism', size: [6, 5, 6],      hp: 40,  shoots: 'missile', range: 4000, naval: false },
  aa:       { shape: 'box',   size: [4, 3, 4],      hp: 30,  shoots: 'gun',     range: 1500, naval: false },
  building: { shape: 'box',   size: [20, 14, 20],   hp: 60,  shoots: false,     naval: false },
  radar:    { shape: 'prism', size: [8, 12, 8],     hp: 40,  shoots: false,     naval: false },
  boat:     { shape: 'prism', size: [6, 3, 22],     hp: 40,  shoots: false,     naval: true },
  frigate:  { shape: 'prism', size: [14, 10, 110],  hp: 160, shoots: 'missile', range: 5000, naval: true },
};

// Per-category tint (linear-ish sRGB hex): land units olive/grey, threats reddish, ships naval grey
function tintFor(name, def) {
  if (def.naval) return 0x6f7a86;
  if (def.shoots === 'missile') return 0x8a5a4a;
  if (def.shoots === 'gun') return 0x7a6a48;
  if (name === 'building' || name === 'radar') return 0x8c8c84;
  return 0x5f6b45;
}

function prismGeometry() {
  // Triangular prism, unit size: x in [-0.5, 0.5], y in [0, 1] (ridge on top), z in [-0.5, 0.5]; flat shaded
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 3, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).toNonIndexed();
  g.computeBoundingBox();
  const bb = g.boundingBox; const h = bb.max.y - bb.min.y, w = bb.max.x - bb.min.x;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, 0).scale(1 / w, 1 / h, 1);
  g.computeVertexNormals();
  return g;
}

export class GroundTarget {
  constructor(forces, shape, slot, typeName, def) {
    this.forces = forces; this.shape = shape; this.slot = slot;
    this.type = typeName; this.def = def; this.name = typeName.toUpperCase();
    this.position = new THREE.Vector3(); this.velocity = new THREE.Vector3(); this.quaternion = new THREE.Quaternion();
    this.team = 'enemy'; this.isGround = true; this.naval = !!def.naval;
    this.maxHealth = def.hp; this.health = def.hp; this.alive = true;
    this.hitRadius = Math.max(5, 0.45 * Math.max(def.size[0], def.size[2]));
    this.missiles = 1e9; this.ammo = 1e9; this.speed = 0;
    this.cool = 3 + Math.random() * 6;           // weapon cooldown (s)
    this.heading = 0;
    this.immortal = false;                       // allied props: nothing damages them (set for every target: one shape)
    this.sinkT = -1;                             // s since a scripted sinking began (GroundForces.sink), -1 = none
  }
  applyDamage(amount) {
    if (!this.alive || this.immortal) return false;
    this.health -= amount;
    return this.health <= 0;
  }
  kill() { this.forces.kill(this); }
  getForward(out) { return out.copy(FWD).applyQuaternion(this.quaternion); }
  getUp(out) { return out.copy(UP).applyQuaternion(this.quaternion); }
  getRight(out) { return out.set(1, 0, 0).applyQuaternion(this.quaternion); }
}

export class GroundForces {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.15, name: 'groundTargets' });
    this.meshes = {
      box: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), this.material, CAPACITY),
      prism: new THREE.InstancedMesh(prismGeometry(), this.material, CAPACITY),
    };
    this.used = { box: 0, prism: 0 };              // instance slots handed out (both sides)
    this.enemyCount = { box: 0, prism: 0 };        // units spawned per side, each capped on its own budget
    this.allyCount = { box: 0, prism: 0 };
    this.freeSlots = { box: [], prism: [] };
    for (const k of ['box', 'prism']) {
      const m = this.meshes[k];
      m.name = 'groundTargets:' + k; m.frustumCulled = false; m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < CAPACITY; i++) { m.setMatrixAt(i, ZERO_SCALE); m.setColorAt(i, _c.set(0xffffff)); }
      scene.add(m);
    }
    this.targets = [];
    this.sinking = [];      // targets going down (sink), animated by updateSinking
    this.obstacle = null;   // optional (point) => true if solid structure (tunnel ridge) blocks that point
  }
  /** Line of sight from a ground unit to `to`: terrain (and structures) sampled along the segment. */
  hasLineOfSight(t, to) {
    const ax = t.position.x, ay = t.position.y + t.def.size[1] * 0.5 + 2, az = t.position.z;
    const dx = to.x - ax, dy = to.y - ay, dz = to.z - az;
    const N = 14;
    for (let i = 1; i < N; i++) {
      const f = i / N, x = ax + dx * f, y = ay + dy * f, z = az + dz * f;
      if (this.world.getHeight(x, z) > y) return false;
      if (this.obstacle) { _v.set(x, y, z); if (this.obstacle(_v)) return false; }
    }
    return true;
  }
  /** Place a target on the terrain (or the sea surface for naval types). team 'player' makes an allied prop (immortal,
   *  friendly tint, allied budget). Returns the GroundTarget or null if that side's budget for the shape is full. */
  spawn(typeName, def, x, z, heading = 0, team = 'enemy') {
    const shape = def.shape === 'prism' ? 'prism' : 'box', ally = team === 'player';
    const count = ally ? this.allyCount : this.enemyCount;
    if (count[shape] >= (ally ? ALLY_PER_SHAPE : MAX_PER_SHAPE)) return null;
    const slot = this.freeSlots[shape].length ? this.freeSlots[shape].pop() : (this.used[shape] < CAPACITY ? this.used[shape]++ : -1);
    if (slot < 0) return null;
    count[shape]++;
    const t = new GroundTarget(this, shape, slot, typeName, def);
    if (ally) { t.team = 'player'; t.immortal = true; }
    const ground = this.world.getHeight(x, z);
    const y = def.naval ? 0.5 : Math.max(ground, 0.5) - 0.3;
    t.position.set(x, y + def.size[1] * 0.5, z);           // center of mass for lock-on and fuses
    t.heading = heading;
    t.quaternion.setFromAxisAngle(UP, heading);
    const mesh = this.meshes[shape];
    _s.set(def.size[0], def.size[1], def.size[2]);
    _m.compose(_v.set(x, y, z), t.quaternion, _s);
    mesh.setMatrixAt(slot, _m);
    mesh.setColorAt(slot, _c.set(ally ? (def.naval ? ALLY_TINT_NAVAL : ALLY_TINT) : tintFor(typeName, def)));
    mesh.count = Math.max(mesh.count, slot + 1);
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.targets.push(t);
    return t;
  }
  /**
   * Naval placement test: true if def's hull at (x, z) facing `heading` floats. A grid over the hull grown by NAVAL_MARGIN
   * (bow, stern, both beams, centre and corners, samples at most 40 m apart) must all lie NAVAL_DEPTH m under water, and
   * the grown hull must clear every other ship (wrecks included).
   */
  hullClear(def, x, z, heading = 0) {
    const w = this.world, hl = def.size[2] / 2 + NAVAL_MARGIN, hw = def.size[0] / 2 + NAVAL_MARGIN;
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = -fz, rz = fx;   // forward (FWD turned by heading), right
    const nu = Math.ceil(hl / 40), nv = Math.ceil(hw / 40);
    for (let i = -nu; i <= nu; i++) {
      for (let j = -nv; j <= nv; j++) {
        const u = hl * i / nu, v = hw * j / nv;
        if (w.getHeight(x + fx * u + rx * v, z + fz * u + rz * v) > -NAVAL_DEPTH) return false;
      }
    }
    for (const o of this.targets) {
      if (!o.naval) continue;
      const dx = o.position.x - x, dz = o.position.z - z, ol = o.def.size[2] / 2, ow = o.def.size[0] / 2;
      const reach = Math.hypot(hl, hw) + Math.hypot(ol, ow);
      if (dx * dx + dz * dz > reach * reach) continue;
      // separating-axis test: grown hull vs the other ship's hull
      const gx = -Math.sin(o.heading), gz = -Math.cos(o.heading), sx = -gz, sz = gx;
      let apart = false;
      for (const [ax, az] of [[fx, fz], [rx, rz], [gx, gz], [sx, sz]]) {
        const ra = hl * Math.abs(fx * ax + fz * az) + hw * Math.abs(rx * ax + rz * az);
        const rb = ol * Math.abs(gx * ax + gz * az) + ow * Math.abs(sx * ax + sz * az);
        if (Math.abs(dx * ax + dz * az) > ra + rb) { apart = true; break; }
      }
      if (!apart) return false;
    }
    return true;
  }
  /** True if water at least NAVAL_DEPTH m deep reaches `radius` m around (x, z): the centre and three rings of 12 samples. */
  openWater(x, z, radius) {
    const w = this.world;
    if (w.getHeight(x, z) > -NAVAL_DEPTH) return false;
    for (let k = 1; k <= 3; k++) {
      const r = radius * k / 3;
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        if (w.getHeight(x + Math.cos(a) * r, z + Math.sin(a) * r) > -NAVAL_DEPTH) return false;
      }
    }
    return true;
  }
  kill(t) {
    if (!t.alive) return;
    t.alive = false; t.health = Math.min(t.health, 0);
    const mesh = this.meshes[t.shape];
    // leave a scorched, flattened wreck instead of popping out
    _s.set(t.def.size[0] * 0.9, t.def.size[1] * 0.25, t.def.size[2] * 0.9);
    _m.compose(_v.set(t.position.x, t.position.y - t.def.size[1] * 0.5, t.position.z), t.quaternion, _s);
    mesh.setMatrixAt(t.slot, _m); mesh.setColorAt(t.slot, _c.set(WRECK));
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  /** Scripted sinking (an allied escort lost to a cruise missile): the hull goes dark, lists and settles bow-up under
   *  the surface over SINK_TIME s, then is removed. updateSinking animates it. */
  sink(t) {
    if (!t.alive) return;
    t.alive = false; t.health = Math.min(t.health, 0); t.sinkT = 0;
    this.sinking.push(t);
    const mesh = this.meshes[t.shape];
    mesh.setColorAt(t.slot, _c.set(WRECK)); if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  /** One matrix per sinking hull per frame (bounded by the hulls going down at once); no allocation. */
  updateSinking(dt) {
    const S = this.sinking;
    for (let i = S.length - 1; i >= 0; i--) {
      const t = S[i], mesh = this.meshes[t.shape], s = t.def.size;
      t.sinkT += dt;
      const k = Math.min(1, t.sinkT / SINK_TIME), e = k * k;
      if (k >= 1) { mesh.setMatrixAt(t.slot, ZERO_SCALE); S[i] = S[S.length - 1]; S.pop(); }
      else {
        _q.copy(t.quaternion).multiply(_q2.setFromAxisAngle(X_AXIS, 0.2 * e)).multiply(_q2.setFromAxisAngle(Z_AXIS, 0.3 * k));
        _m.compose(_v.set(t.position.x, 0.5 - e * (s[1] + 0.3 * s[2] + 10), t.position.z), _q, _s.set(s[0], s[1], s[2]));
        mesh.setMatrixAt(t.slot, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  clear() {
    for (const k of ['box', 'prism']) {
      const m = this.meshes[k];
      for (let i = 0; i < this.used[k]; i++) m.setMatrixAt(i, ZERO_SCALE);
      m.count = 0; m.instanceMatrix.needsUpdate = true;
      this.used[k] = 0; this.freeSlots[k].length = 0; this.enemyCount[k] = 0; this.allyCount[k] = 0;
    }
    for (const t of this.targets) t.alive = false;
    this.targets.length = 0; this.sinking.length = 0;
  }
  aliveCount() { let n = 0; for (const t of this.targets) if (t.alive) n++; return n; }
  /**
   * Air defenses: SAM sites fire missiles at the player inside their range; AA sites throw flak bursts near the
   * player (onFlak(position, hit) lets the game spawn the puff and apply damage). Allied props never fire.
   */
  update(dt, player, weapons, onFlak) {
    if (!player || !player.alive) return;
    for (const t of this.targets) {
      if (!t.alive || !t.def.shoots || t.team === 'player') continue;
      t.cool -= dt;
      if (t.cool > 0) continue;
      const d = t.position.distanceTo(player.position);
      if (d > (t.def.range || 3000)) { t.cool = 0.5; continue; }
      // terrain masking: no line of sight, no shot (re-checked shortly)
      if (!this.hasLineOfSight(t, player.position)) { t.cool = 0.4 + Math.random() * 0.3; continue; }
      if (t.def.shoots === 'missile') {
        // aim the launcher at the player (with a little loft) so the missile leaves the rail toward them
        _v.subVectors(player.position, t.position).normalize(); _v.y = Math.max(_v.y, 0.25); _v.normalize();
        t.quaternion.setFromUnitVectors(FWD, _v);
        const m = weapons.fireMissile(t, player);
        t.quaternion.setFromAxisAngle(UP, t.heading);
        t.cool = m ? 9 + Math.random() * 6 : 2;
      } else if (t.def.shoots === 'gun') {
        t.cool = 2.7 + Math.random() * 0.6;   // fires and reloads every ~3 s
        if (onFlak) {
          // burst near the player, closer when slow or flying straight at low altitude
          const miss = 25 + Math.random() * 90 * (0.6 + player.speed / 400);
          _v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(miss).add(player.position);
          onFlak(_v, miss < 45);
        }
      }
    }
  }
  dispose() {
    for (const k of ['box', 'prism']) { const m = this.meshes[k]; m.removeFromParent(); m.geometry.dispose(); m.dispose(); }
    this.material.dispose();
  }
}
