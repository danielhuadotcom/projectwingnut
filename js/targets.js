import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { launchAllowed, noteLaunch } from './ai.js';

// Ground and naval targets for missions. Every target is drawn as an instanced box or prism (2 draw calls total) and is
// duck-typed like an Aircraft (position, velocity, quaternion, alive, team, health, applyDamage, hitRadius, isGround),
// so weapons, lock-on, the HUD and the radar treat it like any other contact.
// Allied props (team 'player', js/allies.js) share the meshes in a friendly tint but draw on a budget of their own, so
// they never take an enemy's instance: spawn() returns null only when that unit's own side is full.
// Every unit is drawn larger than life so it reads at range (GROUND_SCALE, NAVAL_SCALE; baked into its instance matrix at
// spawn, no per-frame uploads). GroundTarget.size is that drawn size: hit sphere, line of sight, wreck, and every
// footprint the placement tests use (hullClear, landClear, js/main.js ridgeClear) follow it.
const MAX_PER_SHAPE = 192;        // enemy instances per shape
const ALLY_PER_SHAPE = 32;        // allied instances per shape, on top
const CAPACITY = MAX_PER_SHAPE + ALLY_PER_SHAPE;
const ALLY_TINT = 0x4f6f94, ALLY_TINT_NAVAL = 0x7d94b2;   // allied steel blue (no enemy type is blue)
const WRECK = 0x1c1a18;
const SINK_TIME = 10;             // s for a scripted sinking (sink) to settle under the surface
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _c = new THREE.Color(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1), X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
export const GROUND_SCALE = 1.6, NAVAL_SCALE = 1.3;   // drawn size / life size: land units, ships
/** Drawn-size multiplier of a unit type (def.size is life size). */
export const unitScale = (def) => (def && def.naval ? NAVAL_SCALE : GROUND_SCALE);
// Naval placement: water depth (m) needed under every hull sample (shallower water renders as sand and shoreline foam, so
// a hull over it looks beached), and how far (m) past the drawn bow, stern and beams it must reach (also the least gap
// between two hulls; it grows with the hulls)
const NAVAL_DEPTH = 5, NAVAL_MARGIN = Math.round(30 * NAVAL_SCALE);
// Land placement: least ground height (m) under every corner and edge midpoint of a unit's drawn footprint (ashore, not
// half in the sea), and the least gap (m) between two land units' footprints
const LAND_DRY = 0.5, LAND_GAP = 4;

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
    const k = unitScale(def), s = def.size;
    this.size = [s[0] * k, s[1] * k, s[2] * k];  // drawn size (m): x beam, y height, z length
    // Hit sphere (rounds; centred on the drawn box): its bounding sphere, so a round that visibly hits the unit registers,
    // and never less than the life-size sphere. Missile fuses keep the life-size sphere (fuseRadius, Weapons).
    const life = Math.max(5, 0.45 * Math.max(s[0], s[2]));
    this.hitRadius = Math.max(life, 0.5 * Math.hypot(this.size[0], this.size[1], this.size[2]));
    this.fuseRadius = life;
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

// Line of sight (GroundForces.hasLineOfSight). World.getHeight is bilinear on a heightfield of LOS_N x LOS_N texels over
// ±LOS_HALF m, 43 m apart (mirrors js/world.js HM_N / HM_HALF; losGrid checks them against getHeight before use). Along a
// straight sight line the ground is then a quadratic within each texel cell, so the line is tested exactly, cell by cell:
// no ridge or knife-edge crest can slip between samples, however long the line. Blocks of LOS_B x LOS_B cells that the
// line passes over (above the block's highest texel) are skipped whole. Without that heightfield, or past its edge, the
// terrain is sampled every LOS_FB_DS m instead. The obstacle callback (the tunnel ridge) is a point test, sampled every
// LOS_OB_DS m (its rock is modelled on rings 26 m apart), at most LOS_OB_CAP times per line. Measured (i7-1165G7, Chrome):
// the terrain test ~0.1-0.5 us a line; the obstacle samples cost the rest, ~10 ns each, ~170 ns inside the ridge's box.
const LOS_N = 1024, LOS_HALF = 22000, LOS_STEP = (2 * LOS_HALF) / (LOS_N - 1), LOS_INV = 1 / LOS_STEP;
const LOS_B = 8, LOS_NB = Math.ceil((LOS_N - 1) / LOS_B);
const LOS_LIM = LOS_HALF - 2 * LOS_STEP;       // both ends inside |x|, |z| < LOS_LIM keep the walk on the grid
const LOS_OB_DS = 20, LOS_OB_CAP = 256;
const LOS_FB_DS = LOS_STEP / 2, LOS_FB_CAP = 512;
/** { h: heightfield, top: highest texel under each LOS_B x LOS_B block of cells (NaN until losTop fills it) } for World
 *  `w`, or null when its heightfield is missing or does not reproduce getHeight (hasLineOfSight then samples getHeight). */
function losGrid(w) {
  const H = w && w._height;
  if (!H || H.length !== LOS_N * LOS_N || typeof w.getHeight !== 'function') return null;
  for (let n = 0; n < 16; n++) {                 // bilinear at (fx, fz) = (0.25, 0.75) in cells spread over the map
    const i = 37 + ((n * 389) % 941), j = 41 + ((n * 563) % 937), k = j * LOS_N + i;
    const want = 0.1875 * H[k] + 0.0625 * H[k + 1] + 0.5625 * H[k + LOS_N] + 0.1875 * H[k + LOS_N + 1];
    if (!(Math.abs(w.getHeight(-LOS_HALF + (i + 0.25) * LOS_STEP, -LOS_HALF + (j + 0.75) * LOS_STEP) - want) < 1e-3)) return null;
  }
  return { h: H, top: new Float32Array(LOS_NB * LOS_NB).fill(NaN) };   // block maxima, filled in as lines need them
}
/** Highest texel under block (bi, bj)'s cells: its LOS_B + 1 texels a side, so every cell's four corners. */
function losTop(H, bi, bj) {
  const i0 = bi * LOS_B, j0 = bj * LOS_B, i1 = Math.min(i0 + LOS_B, LOS_N - 1), j1 = Math.min(j0 + LOS_B, LOS_N - 1);
  let m = -Infinity;
  for (let j = j0; j <= j1; j++) for (let k = j * LOS_N + i0, e = j * LOS_N + i1; k <= e; k++) if (H[k] > m) m = H[k];
  return m;
}
/** Exact terrain test of the line u0 + du t, v0 + dv t (grid units), height ay + gy t, over t in [ta, tb]: false if the
 *  ground rises above it anywhere in (0, 1). In each cell the clearance is c + b s + a s^2 (s = t - cell entry). */
function losCells(H, u0, v0, du, dv, ay, gy, ta, tb) {
  const tm = Math.min(ta + 1e-7, 0.5 * (ta + tb));
  let i = Math.floor(u0 + du * tm), j = Math.floor(v0 + dv * tm);
  const si = du > 0 ? 1 : -1, sj = dv > 0 ? 1 : -1, eu = 1 / Math.abs(du), ev = 1 / Math.abs(dv);
  let tu = du !== 0 ? (i + (si > 0 ? 1 : 0) - u0) / du : Infinity, tv = dv !== 0 ? (j + (sj > 0 ? 1 : 0) - v0) / dv : Infinity;
  for (let t = ta; ;) {
    const tn = Math.min(tu, tv, tb);
    if (tn > t) {
      const k = j * LOS_N + i, h00 = H[k], h10 = H[k + 1], h01 = H[k + LOS_N], h11 = H[k + LOS_N + 1];
      const lo = gy > 0 ? ay + gy * t : ay + gy * tn;             // the line's lowest point over this cell
      if (lo < h00 || lo < h10 || lo < h01 || lo < h11) {        // (the ground never rises above a cell's highest corner)
        const fx = u0 + du * t - i, fz = v0 + dv * t - j, d = h00 - h10 - h01 + h11, s = tn - t;
        const c = ay + gy * t - (h00 + (h10 - h00) * fx + (h01 - h00) * fz + d * fx * fz);
        const b = gy - (h10 - h00 + d * fz) * du - (h01 - h00 + d * fx) * dv, a = -d * du * dv;
        if (c < 0 && t > 0) return false;
        if (c + (b + a * s) * s < 0 && tn < 1) return false;
        if (a > 0 && b < 0 && -b < 2 * a * s && c - (b * b) / (4 * a) < 0) return false;   // dips inside the cell
      }
    }
    if (tn >= tb) return true;
    if (tu < tv) { i += si; t = tu; tu += eu; } else { j += sj; t = tv; tv += ev; }
  }
}
/** Terrain part of hasLineOfSight on grid G (losGrid): the line from (ax, ay, az) along (dx, dy, dz), both ends on the
 *  grid. Walks the blocks it crosses; only where it dips below a block's highest texel are that block's cells tested. */
function losTerrain(G, ax, ay, az, dx, dy, dz) {
  const top = G.top, K = LOS_INV / LOS_B;
  const U0 = (ax + LOS_HALF) * K, V0 = (az + LOS_HALF) * K, DU = dx * K, DV = dz * K;
  let bi = Math.floor(U0), bj = Math.floor(V0);
  const si = DU > 0 ? 1 : -1, sj = DV > 0 ? 1 : -1, eu = 1 / Math.abs(DU), ev = 1 / Math.abs(DV);
  let tu = DU !== 0 ? (bi + (si > 0 ? 1 : 0) - U0) / DU : Infinity, tv = DV !== 0 ? (bj + (sj > 0 ? 1 : 0) - V0) / DV : Infinity;
  for (let t = 0; ;) {
    const tn = Math.min(tu, tv, 1);
    if (tn > t) {
      const b = bj * LOS_NB + bi;
      let m = top[b];
      if (m !== m) m = top[b] = losTop(G.h, bi, bj);
      if ((dy > 0 ? ay + dy * t : ay + dy * tn) < m && !losCells(G.h, U0 * LOS_B, V0 * LOS_B, DU * LOS_B, DV * LOS_B, ay, dy, t, tn)) return false;
    }
    if (tn >= 1) return true;
    if (tu < tv) { bi += si; t = tu; tu += eu; } else { bj += sj; t = tv; tv += ev; }
  }
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
    this.obstacle = null;   // optional (point) => true if solid structure (tunnel ridge) blocks that point (sight lines, hulls)
  }
  /** Line of sight from a ground unit to `to`, from 2 m over the unit's roof: terrain tested exactly along the segment
   *  (losTerrain), then the obstacle callback (structures) sampled along it. t needs position plus size (drawn,
   *  GroundTarget) or def.size (probes: js/main.js _losAir). */
  hasLineOfSight(t, to) {
    const h = (t.size || t.def.size)[1];
    const ax = t.position.x, ay = t.position.y + h * 0.5 + 2, az = t.position.z;
    const dx = to.x - ax, dy = to.y - ay, dz = to.z - az;
    if (this._losGrid === undefined) this._losGrid = losGrid(this.world);
    const G = this._losGrid;
    if (G && Math.abs(ax) < LOS_LIM && Math.abs(az) < LOS_LIM && Math.abs(to.x) < LOS_LIM && Math.abs(to.z) < LOS_LIM) {
      if (!losTerrain(G, ax, ay, az, dx, dy, dz)) return false;
    } else {
      const n = Math.min(LOS_FB_CAP, Math.max(2, Math.ceil(Math.hypot(dx, dz) / LOS_FB_DS)));
      for (let i = 1; i < n; i++) { const f = i / n; if (this.world.getHeight(ax + dx * f, az + dz * f) > ay + dy * f) return false; }
    }
    const ob = this.obstacle;
    if (ob) {
      const n = Math.min(LOS_OB_CAP, Math.max(2, Math.ceil(Math.hypot(dx, dy, dz) / LOS_OB_DS)));
      for (let i = 1; i < n; i++) { const f = i / n; if (ob(_v.set(ax + dx * f, ay + dy * f, az + dz * f))) return false; }
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
    const ground = this.world.getHeight(x, z), S = t.size;
    const y = def.naval ? 0.5 : Math.max(ground, 0.5) - 0.3;
    t.position.set(x, y + S[1] * 0.5, z);                  // center of mass for lock-on and fuses
    t.heading = heading;
    t.quaternion.setFromAxisAngle(UP, heading);
    const mesh = this.meshes[shape];
    _s.set(S[0], S[1], S[2]);                              // drawn size, baked into the instance once
    _m.compose(_v.set(x, y, z), t.quaternion, _s);
    mesh.setMatrixAt(slot, _m);
    mesh.setColorAt(slot, _c.set(ally ? (def.naval ? ALLY_TINT_NAVAL : ALLY_TINT) : tintFor(typeName, def)));
    mesh.count = Math.max(mesh.count, slot + 1);
    mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.targets.push(t);
    return t;
  }
  /**
   * Naval placement test: true if def's drawn hull at (x, z) facing `heading` floats. A grid over the hull grown by
   * NAVAL_MARGIN (bow, stern, both beams, centre and corners, samples at most 40 m apart) must all lie NAVAL_DEPTH m under
   * water and clear of solid structure at the waterline and deck height (obstacle: the tunnel ridge, whose sea-side flank
   * reaches over the water), and the grown hull must clear every other ship's drawn hull (wrecks included).
   */
  hullClear(def, x, z, heading = 0) {
    const w = this.world, ob = this.obstacle, k = unitScale(def), top = def.size[1] * k;
    const hl = def.size[2] * k / 2 + NAVAL_MARGIN, hw = def.size[0] * k / 2 + NAVAL_MARGIN;
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = -fz, rz = fx;   // forward (FWD turned by heading), right
    const nu = Math.ceil(hl / 40), nv = Math.ceil(hw / 40);
    for (let i = -nu; i <= nu; i++) {
      for (let j = -nv; j <= nv; j++) {
        const u = hl * i / nu, v = hw * j / nv, px = x + fx * u + rx * v, pz = z + fz * u + rz * v;
        if (w.getHeight(px, pz) > -NAVAL_DEPTH) return false;
        if (ob && (ob(_v.set(px, 1, pz)) || ob(_v.set(px, top, pz)))) return false;
      }
    }
    return this._clearOfUnits(x, z, fx, fz, hl, hw, true);
  }
  /**
   * Land placement test: true if def's drawn footprint at (x, z) facing `heading` stands ashore (every corner and edge
   * midpoint more than LAND_DRY m up) and, grown by LAND_GAP, clears every other land unit's drawn footprint (wrecks and
   * allied props included). The caller tests the centre's own height and the tunnel ridge (js/main.js landFits).
   */
  landClear(def, x, z, heading = 0) {
    const w = this.world, k = unitScale(def), hl = def.size[2] * k / 2, hw = def.size[0] * k / 2;
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = -fz, rz = fx;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if ((i !== 0 || j !== 0) && w.getHeight(x + fx * hl * i + rx * hw * j, z + fz * hl * i + rz * hw * j) <= LAND_DRY) return false;
      }
    }
    return this._clearOfUnits(x, z, fx, fz, hl + LAND_GAP, hw + LAND_GAP, false);
  }
  /** True if the rectangle centred on (x, z) (forward (fx, fz), half-length hl, half-width hw) overlaps no drawn footprint
   *  of the ships (naval) or of the land units (otherwise), wrecks included: a separating-axis test per unit in reach. */
  _clearOfUnits(x, z, fx, fz, hl, hw, naval) {
    const rx = -fz, rz = fx, reachA = Math.hypot(hl, hw);
    for (const o of this.targets) {
      if (o.naval !== naval) continue;
      const dx = o.position.x - x, dz = o.position.z - z, ol = o.size[2] / 2, ow = o.size[0] / 2;
      const reach = reachA + Math.hypot(ol, ow);
      if (dx * dx + dz * dz > reach * reach) continue;
      // separating-axis test: this rectangle vs the unit's drawn footprint
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
    const S = t.size;
    _s.set(S[0] * 0.9, S[1] * 0.25, S[2] * 0.9);
    _m.compose(_v.set(t.position.x, t.position.y - S[1] * 0.5, t.position.z), t.quaternion, _s);
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
      const t = S[i], mesh = this.meshes[t.shape], s = t.size;
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
   * Air defenses: SAM sites fire missiles at the player inside their range, rationed like the bandits' launches (js/ai.js
   * launchAllowed: the difficulty's cap on enemy missiles after the player, 1.5 s since the last launch at them; a held
   * launcher keeps its missile and cooldown and looks again next frame); AA sites throw flak bursts near the player
   * (onFlak(position, hit) lets the game spawn the puff and apply damage). Allied props never fire.
   */
  update(dt, player, weapons, onFlak) {
    if (!player || !player.alive) return;
    for (const t of this.targets) {
      if (!t.alive || !t.def.shoots || t.team === 'player') continue;
      t.cool -= dt;
      if (t.cool > 0) continue;
      const d = t.position.distanceTo(player.position);
      if (d > (t.def.range || 3000)) { t.cool = 0.5; continue; }
      if (t.def.shoots === 'missile' && !launchAllowed(player, weapons)) continue;   // rationed: hold the missile
      // terrain masking: no line of sight, no shot (re-checked shortly)
      if (!this.hasLineOfSight(t, player.position)) { t.cool = 0.4 + Math.random() * 0.3; continue; }
      if (t.def.shoots === 'missile') {
        // aim the launcher at the player (with a little loft) so the missile leaves the rail toward them
        _v.subVectors(player.position, t.position).normalize(); _v.y = Math.max(_v.y, 0.25); _v.normalize();
        t.quaternion.setFromUnitVectors(FWD, _v);
        const m = weapons.fireMissile(t, player);
        if (m) noteLaunch(player, weapons);
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
