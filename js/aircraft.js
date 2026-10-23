import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { AfterburnerFX } from './engine_fx.js';
import { NIGHT_FX } from './timeofday.js';
// PROJECT WINGNUT — js/aircraft.js
// Procedural F-22 Raptor likeness (buildJetMesh) + arcade flight model, navigation lights, wingtip contrails and the
// afterburner hookup (Aircraft). Local frame: nose = -Z, up = +Y, right wing = +X; origin = center of mass.
// 0.8 scale: ~15.1 m long, 10.85 m span (published 4.1 m height includes landing gear; the gear-up airframe is ~3.0 m).
//
// Draw calls per visible jet: hull 1 (fuselage, wings, tails AND every control surface) + canopy 1 + nav lights 1 +
// AfterburnerFX (separate module, 1). Control surfaces are animated in the hull's vertex shader (per-vertex surface
// id + per-jet hinge uniforms, Rodrigues rotation of position and normal). The hull topology is built once per
// page and shared by every jet; per color scheme only the vertex-color attribute differs. Materials are per jet
// (own uniforms) but share GL programs. Every part is frustum culled, so off-screen jets cost no draw calls.
// Everything renders in LINEAR HDR (custom shaders output linear radiance; bright emitters > 1 for bloom).

export const AIRCRAFT_RADIUS = 7;            // collision sphere radius (m)
// Enemies are drawn larger than life so they read at range (the player and squadmates stay life size): ENEMY_SCALE up
// close, growing to ENEMY_SCALE_FAR between ENEMY_SCALE_NEAR_M and ENEMY_SCALE_FAR_M from the camera (smoothstep).
// Aircraft.updateDrawScale applies it to the root mesh every frame; see Aircraft.setSize for what follows it.
export const ENEMY_SCALE = 1.35, ENEMY_SCALE_FAR = 1.8, ENEMY_SCALE_NEAR_M = 600, ENEMY_SCALE_FAR_M = 2500;

// Project Wingman-style arcade handling. PW lists rotation rates per aircraft (roll ~170-210, pitch ~85-100,
// yaw ~10-15, "degrees per second"): rates are near-constant across the speed range, weak only near stall, and there
// is no realistic g cap. Speed is spring-loaded: stick centered = cruise, push = boost (afterburner), pull = airbrake.
const RAD_PER_DEG = Math.PI / 180;
export const FLIGHT = {
  ROLL_RATE: 170 * RAD_PER_DEG,  // rad/s
  PITCH_RATE: 90 * RAD_PER_DEG,  // rad/s pulling (nose up)
  PUSH_FACTOR: 0.5,      // pushing (nose down) tops out at half the pull rate (fighters pull ~+9 g, push ~-3 g; PW pushes
                         // noticeably slower than it pulls). Scales only stick-forward, so it stays continuous at center
  YAW_RATE: 14 * RAD_PER_DEG,    // rad/s
  RESPONSE: 0.15,        // s, time constant to reach the commanded rate (PW "Response")
  BRAKE_TURN: 0.25,      // extra pitch authority at full airbrake (tighter turns while braking)
  MIN_SPEED: 60,         // m/s, stall speed (~215 km/h): nose drops, controls go mushy
  BRAKE_SPEED: 70,       // m/s, full airbrake target (just above the stall: braking in a climb stalls you)
  CRUISE_SPEED: 200,     // m/s, throttle stick centered (~720 km/h)
  MAX_SPEED: 330,        // m/s, light boost (kept for HUD/AI references)
  AB_SPEED: 420,         // m/s, full boost (~1510 km/h)
  BOOST_ACCEL: 48,       // m/s^2 max while boosting
  CRUISE_ACCEL: 22,      // m/s^2 max when recovering to cruise
  DRAG_DECEL: 26,        // m/s^2 max when settling down to cruise
  BRAKE_DECEL: 75,       // m/s^2 max with the airbrake out
  GRAVITY_FACTOR: 1.0,   // full gravity along the flight path: climbing bleeds speed, diving builds it
  TURN_BLEED: 7,         // m/s^2 lost at full pull (mild, arcade)
  AB_THRESHOLD: 0.5,     // thrust axis above which the afterburner lights
  CONTRAIL_G: 4.5,       // display-g above which wingtip vortices condense
  CONTRAIL_ALT_MIN: 2000, CONTRAIL_ALT_MAX: 3500,   // "humidity band" altitudes (m)
  MAX_MISSILES: 240,   // four rails: doubled load, as heavy STDM loadouts carry
  AMMO: 2400,
  MAX_DT: 0.05,          // s, per-step clamp (numerical safety)
};

// ---------------------------------------------------------------------------------------------
// Scratch objects (no per-frame allocation in hot paths)
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _vp = new THREE.Vector2();
const _c1 = new THREE.Color();
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Uniform holder for per-frame floats: its own hidden class keeps `value` an unboxed double in V8, so per-frame
 *  writes don't allocate (Three's shared-shape {value} literals turn every double store into a new HeapNumber). */
class FloatUniform { constructor(v = 0.5) { this.value = v; } }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const finite = (v, d = 0) => (Number.isFinite(v) ? v : d);
const DEG = Math.PI / 180;
const TAN42 = Math.tan(42 * DEG), TAN17 = Math.tan(17 * DEG);   // F-22 planform alignment angles

// =============================================================================================
// Mesh-part toolkit. A Part collects positions + per-vertex paint kind + control-surface id + triangles.
// Normals come from autoSmooth() (hard crease above the part's angle threshold, smooth below), and all
// parts are finally concatenated into ONE indexed BufferGeometry.

// Paint kinds (resolved to colors per color scheme) and their material class, which the hull shader maps
// to roughness/metalness: 0 = satin paint (material defaults), 1 = metal, 2 = matte dark, 3 = glossy.
const PK = { CAMO: 0, EDGE: 1, ACCENT: 2, METAL: 3, DARK: 4, COCKPIT: 5, HELMET: 6, SEAT: 7, NOZZLE_IN: 8, LIP: 9, SLOT: 10, PANEL: 11 };
const PK_CLASS = [0, 0, 0, 1, 2, 2, 3, 2, 2, 0, 2, 0];

// Control-surface ids (0 = rigid). Uniform slot = id - 1.
const SID = { AIL_L: 1, AIL_R: 2, FLAP_L: 3, FLAP_R: 4, STAB_L: 5, STAB_R: 6, RUD_L: 7, RUD_R: 8 };
const SID_MIRROR = [0, 2, 1, 4, 3, 6, 5, 8, 7];
const N_SURF = 8;

class Part {
  constructor(smoothDeg = 35) {
    this.P = []; this.K = []; this.S = []; this.I = [];
    this.cosT = Math.cos(smoothDeg * DEG);
  }
  get count() { return this.K.length; }
  v(x, y, z, kind = PK.CAMO, sid = 0) { this.P.push(x, y, z); this.K.push(kind); this.S.push(sid); return this.K.length - 1; }
  tri(a, b, c) { this.I.push(a, b, c); }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  flipAll() { const I = this.I; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } return this; }
  /** Orients every triangle outward (or inward) relative to the vertex centroid via the signed volume. */
  orient(outward = true) {
    const P = this.P, I = this.I, n = this.K.length;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += P[3 * i]; cy += P[3 * i + 1]; cz += P[3 * i + 2]; }
    cx /= n; cy /= n; cz /= n;
    let vol = 0;
    for (let i = 0; i < I.length; i += 3) {
      const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
      const ax = P[a] - cx, ay = P[a + 1] - cy, az = P[a + 2] - cz;
      const bx = P[b] - cx, by = P[b + 1] - cy, bz = P[b + 2] - cz;
      const qx = P[c] - cx, qy = P[c + 1] - cy, qz = P[c + 2] - cz;
      vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    }
    if ((vol < 0) === outward) this.flipAll();
    return this;
  }
  /** Adds a planar quad (a,b,c,d around its edge) whose front face points along (dx,dy,dz). */
  quadFacing(a, b, c, d, dx, dy, dz) {
    const P = this.P;
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    if (nx * dx + ny * dy + nz * dz >= 0) this.quad(a, b, c, d); else this.quad(a, d, c, b);
  }
  applyMatrix4(m) {
    const e = m.elements, P = this.P;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      P[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return this;
  }
  /** Mirror copy across the YZ plane (x -> -x) with winding restored and surface ids swapped L<->R. */
  mirrored() {
    const m = new Part(0); m.cosT = this.cosT;
    for (let i = 0; i < this.P.length; i += 3) m.P.push(-this.P[i], this.P[i + 1], this.P[i + 2]);
    m.K = this.K.slice(); m.S = this.S.map((s) => SID_MIRROR[s] || 0); m.I = this.I.slice();
    return m.flipAll();
  }
}

/** Loft through rings (arrays of [x,y,z], all the same length). kindFn(i, k, x, y, z) -> paint kind. */
function loftRings(part, rings, kindFn, sid = 0, closed = true) {
  const S = rings.length, M = rings[0].length, base = part.count;
  for (let i = 0; i < S; i++) for (let k = 0; k < M; k++) {
    const q = rings[i][k];
    part.v(q[0], q[1], q[2], kindFn(i, k, q[0], q[1], q[2]), sid);
  }
  const K = closed ? M : M - 1;
  for (let i = 0; i < S - 1; i++) for (let k = 0; k < K; k++) {
    const k2 = (k + 1) % M, a = base + i * M + k, b = base + i * M + k2, c = base + (i + 1) * M + k2, d = base + (i + 1) * M + k;
    part.quad(a, b, c, d);
  }
  return base;
}
/** Fan caps for the first/last ring of a loft (winding consistent with loftRings walls). */
function capStart(part, base, M) { for (let k = 1; k < M - 1; k++) part.tri(base, base + k + 1, base + k); }
function capEnd(part, base, M) { for (let k = 1; k < M - 1; k++) part.tri(base, base + k, base + k + 1); }

/** Splits vertices along creases (adjacent face normals > threshold apart) and computes area-weighted normals. */
function autoSmooth(part) {
  const P = part.P, I0 = part.I, cosT = part.cosT, n = part.count;
  const I = [], F = [];
  for (let i = 0; i < I0.length; i += 3) {
    const a = I0[i], b = I0[i + 1], c = I0[i + 2];
    if (a === b || b === c || a === c) continue;
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-10) continue;                       // degenerate: never rasterized, drop it
    I.push(a, b, c); F.push(nx, ny, nz, l);
  }
  const m = I.length / 3;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < I.length; i++) start[I[i] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n), vf = new Int32Array(I.length);
  for (let f = 0; f < m; f++) for (let k = 0; k < 3; k++) { const v = I[3 * f + k]; vf[fill[v]++] = f; }
  const out = { P: [], N: [], K: [], S: [], I: new Array(I.length) };
  const splits = new Array(n);
  for (let f = 0; f < m; f++) {
    const fl = F[4 * f + 3], ux = F[4 * f] / fl, uy = F[4 * f + 1] / fl, uz = F[4 * f + 2] / fl;
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k];
      let sx = 0, sy = 0, sz = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const g = vf[j], gl = F[4 * g + 3];
        if ((ux * F[4 * g] + uy * F[4 * g + 1] + uz * F[4 * g + 2]) / gl >= cosT) { sx += F[4 * g]; sy += F[4 * g + 1]; sz += F[4 * g + 2]; }
      }
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      let list = splits[v]; if (!list) list = splits[v] = [];
      let idx = -1;
      for (let e = 0; e < list.length; e++) { const q = list[e]; if (q[1] * sx + q[2] * sy + q[3] * sz > 0.9995) { idx = q[0]; break; } }
      if (idx < 0) {
        idx = out.K.length;
        out.P.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); out.N.push(sx, sy, sz); out.K.push(part.K[v]); out.S.push(part.S[v]);
        list.push([idx, sx, sy, sz]);
      }
      out.I[3 * f + k] = idx;
    }
  }
  return out;
}

/** Monotone cubic (Fritsch-Carlson) through [[x, y], ...] sorted by x; clamped outside the range. */
function curve(pts) {
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Converts a core BufferGeometry (Box/Sphere...) into a Part with one paint kind. */
function partFromGeometry(geom, kind, smoothDeg = 30, sid = 0) {
  const part = new Part(smoothDeg), pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) part.v(pos.getX(i), pos.getY(i), pos.getZ(i), kind, sid);
  if (geom.index) { const a = geom.index.array; for (let i = 0; i < a.length; i++) part.I.push(a[i]); }
  else for (let i = 0; i < pos.count; i++) part.I.push(i);
  geom.dispose();
  return part;
}

// =============================================================================================
// F-22 layout (meters, 0.8 scale). Model z: nose tip at -7.95, aft-most point (stabilator notch corner) +7.03.
// Planform alignment: wing/stabilator leading edges and the intake lips are swept 42 deg, the trailing edges
// forward 17 deg (TAN42 / TAN17 below), the stabilator notch is parallel to the leading edges.
const CAN = { zF: -5.55, zA: -2.40, topY: 1.12, aftTopY: 0.88, peakT: 0.55, w: 0.48 };
const WING = { x0: 1.20, xTip: 5.425, leX: 1.42, leZ: -2.17, teX: 1.56, teZ: 3.96, y0: -0.10, anhedral: 3.25 * DEG,
  tc0: 0.059, tc1: 0.043, flapIn: 1.62, flapOut: 3.35, ailOut: 5.05, flapH: 0.78, ailH: 0.76 };
const STAB = { x0: 1.10, xKink: 2.20, xTip: 3.45, y: -0.22, le0: 3.87, te0: 6.04, pivotZ: 4.77, tc: 0.045 };
const FIN = { x: 1.02, y: 0.12, cant: 28 * DEG, span: 2.45, le0: 1.95, te0: 5.30, leSweep: 37 * DEG, teSweep: 11 * DEG,
  tc: 0.05, rud0: 0.30, rud1: 1.95, rudH: 0.70, band: 2.23 };
const ENG = { x: 0.64, y: -0.10 };
// exit plane for AfterburnerFX = sawtooth tips (its plume volume must start clear of solid geometry)
const NOZ = { zTip: 6.32, zNotch: 6.13, w: 0.47, h: 0.24, wall: 0.035, exitZ: 6.32 };
const INTAKE = { ui: [0.80, 0.03, -3.63], u: [0.62, -0.12, 0.62 * TAN42], v: [-0.20, -0.70, 0.55], zEnd: -0.2, depth: 1.1, inboard: 0.20, slotZ: -2.45 };
/** Height of the intake's top wall at x (the fuselage chine is pinned onto it, for a clean junction). */
const intakeTopY = (x) => INTAKE.ui[1] + (x - INTAKE.ui[0]) * (INTAKE.u[1] / INTAKE.u[0]);

// chord-fraction stations for lifting surfaces (biconvex section: sharp leading and trailing edges)
const SS_FULL = [0, 0.04, 0.12, 0.24, 0.38, 0.52, 0.66, 0.78, 0.89, 1];
const ssMain = (h) => [0, 0.04, 0.12, 0.24, 0.38, 0.52, 0.66].filter((s) => s < h - 0.04).concat([h]);
const ssSurf = (h) => [h, (h + 1) / 2, 1];
const biconvex = (s) => 4 * s * (1 - s);
const edgeKind = (sec, s) => (s < 0.05 ? PK.EDGE : PK.CAMO);
const surfKind = () => PK.PANEL;                 // hinged surfaces: a shade darker so they read as separate panels

// ---- fuselage: monotone-cubic profiles along z; sections are faceted hexagons with a sharp chine ----------
let _body = null;
function bodyCurves() {
  if (_body) return _body;
  _body = {
    xC: curve([[-7.95, 0.012], [-7.70, 0.125], [-7.30, 0.24], [-6.80, 0.35], [-6.20, 0.445], [-5.60, 0.51], [-5.00, 0.57], [-4.40, 0.62],
      [-3.80, 0.655], [-3.20, 0.68], [-2.60, 0.70], [-2.00, 0.76], [-1.40, 1.00], [-0.80, 1.38], [-0.30, 1.50], [0.50, 1.53], [2.00, 1.53],
      [3.00, 1.46], [3.60, 1.26], [4.20, 0.86], [4.80, 0.46], [5.30, 0.22], [5.80, 0.16], [6.10, 0.12], [6.30, 0.05], [6.38, 0.01]]),
    yC: curve([[-7.95, -0.06], [-6.0, -0.04], [-4.0, -0.02], [-2.6, -0.01], [-1.0, 0.0], [2.0, 0.0], [3.6, 0.0], [4.8, -0.02], [5.6, -0.05], [6.38, -0.05]]),
    yT: curve([[-7.95, -0.04], [-7.70, 0.07], [-7.30, 0.165], [-6.80, 0.265], [-6.20, 0.36], [-5.60, 0.43], [-5.00, 0.48], [-4.40, 0.51],
      [-3.80, 0.53], [-3.20, 0.56], [-2.80, 0.66], [-2.40, 0.86], [-1.60, 0.85], [-0.60, 0.78], [0.50, 0.68], [2.00, 0.58], [3.00, 0.49],
      [3.80, 0.38], [4.50, 0.22], [5.20, 0.06], [5.80, 0.015], [6.20, 0.0], [6.38, -0.02]]),
    yB: curve([[-7.95, -0.08], [-7.70, -0.18], [-7.30, -0.29], [-6.80, -0.39], [-6.20, -0.48], [-5.60, -0.55], [-5.00, -0.61], [-4.00, -0.67],
      [-3.00, -0.71], [-1.00, -0.79], [0.0, -0.86], [2.80, -0.82], [3.60, -0.64], [4.40, -0.40], [5.20, -0.17], [5.80, -0.12], [6.20, -0.10], [6.38, -0.08]]),
    xB: curve([[-7.95, 0.006], [-7.30, 0.11], [-6.20, 0.22], [-5.00, 0.30], [-4.00, 0.35], [-3.00, 0.38], [-2.00, 0.44], [-1.20, 0.66], [-0.50, 1.15],
      [0.0, 1.36], [2.80, 1.36], [3.60, 1.04], [4.20, 0.66], [4.80, 0.33], [5.30, 0.17], [5.80, 0.15], [6.10, 0.11], [6.30, 0.04], [6.38, 0.008]]),
    spineW: curve([[-2.40, 0.30], [-1.00, 0.42], [1.00, 0.50], [3.00, 0.48], [4.20, 0.40]]),
  };
  return _body;
}

/** Canopy half-width along its length t (0 = pointed front, 1 = aft end). */
function canopyW(t) {                       // pointed in plan view (~27 deg half-angle at the tip)
  if (t < 0.45) return CAN.w * (1 - Math.pow(1 - t / 0.45, 1.45));
  if (t < 0.60) return CAN.w;
  return CAN.w - 0.20 * Math.pow((t - 0.60) / 0.40, 1.3);
}
function canopyTop(t, y0) {                  // raked windscreen rising to a crown over the pilot, then fairing into the spine
  if (t < CAN.peakT) { const u = t / CAN.peakT; return y0 + (CAN.topY - y0) * (3 * u - u * u * u) * 0.5; }
  return CAN.topY - (CAN.topY - CAN.aftTopY) * Math.pow((t - CAN.peakT) / (1 - CAN.peakT), 1.5);
}
function bulge(A, B, k) {   // midpoint of AB pushed outward (to the right of A->B) by k * |AB|
  const dx = B[0] - A[0], dy = B[1] - A[1];
  return [(A[0] + B[0]) / 2 - dy * k, (A[1] + B[1]) / 2 + dx * k];
}
/** Right half of the fuselage section at z: top center, spine shoulder, P1b, upper panel, CHINE, lower panel, keel corner, bottom. */
function bodyHalf(z) {
  const B = bodyCurves();
  const xc = B.xC(z), yt = B.yT(z), yb = B.yB(z), xb = Math.min(B.xB(z), xc * 0.98);
  let yc = B.yC(z);
  const wi = smoothstep(-3.95, -3.55, z) * (1 - smoothstep(INTAKE.zEnd - 0.1, INTAKE.zEnd + 0.5, z));
  if (wi > 0) yc = lerp(yc, intakeTopY(xc) + 0.004, wi);       // chine edge runs along the intake's top wall
  const fx = 0.40 * xc, fy = yt - 0.18 * (yt - yc);                          // rounded radome top (forward)
  const ax = Math.min(B.spineW(z), 0.62 * xc), ay = yt - 0.06;               // dorsal spine (aft)
  let b = 0;
  if (z >= CAN.zA) b = 1; else if (z > CAN.zF) b = smoothstep(0.55, 1.0, (z - CAN.zF) / (CAN.zA - CAN.zF));
  const P1 = [lerp(fx, ax, b), lerp(fy, ay, b)], P3 = [xc, yc];
  const P5 = [xb, yb + Math.min(0.04, 0.25 * (yc - yb))];
  const P2 = bulge(P1, P3, 0.06), P4 = bulge(P3, P5, 0.05);
  let tb = 0.5;                                                               // P1b: canopy edge (cockpit deck ends there)
  if (z > CAN.zF && z < CAN.zA) tb = clamp((canopyW((z - CAN.zF) / (CAN.zA - CAN.zF)) + 0.01 - P1[0]) / Math.max(P2[0] - P1[0], 1e-3), 0.12, 0.88);
  const P1b = [lerp(P1[0], P2[0], tb), lerp(P1[1], P2[1], tb)];
  return [[0, yt], P1, P1b, P2, P3, P4, P5, [0, yb]];
}
/** Height of the fuselage upper surface at (x, z) (|x| up to the chine). */
function bodyUpperY(x, z) {
  const h = bodyHalf(z);
  for (let i = 0; i < 4; i++) {
    const a = h[i], b = h[i + 1];
    if (x <= b[0] || i === 3) return lerp(a[1], b[1], clamp((x - a[0]) / Math.max(b[0] - a[0], 1e-6), 0, 1));
  }
  return h[0][1];
}

const BODY_Z = [-7.95, -7.84, -7.65, -7.40, -7.10, -6.75, -6.35, -5.95, -5.55, -5.15, -4.75, -4.35, -3.95, -3.55, -3.15, -2.75, -2.40, -2.05,
  -1.70, -1.35, -1.00, -0.65, -0.30, 0.15, 0.70, 1.30, 1.90, 2.50, 3.00, 3.40, 3.80, 4.20, 4.60, 5.00, 5.40, 5.80, 6.05, 6.22, 6.32, 6.38];

function buildBody() {
  const part = new Part(38);
  const rings = BODY_Z.map((z) => {
    const h = bodyHalf(z), ring = [];
    for (let k = 0; k < 8; k++) ring.push([h[k][0], h[k][1], z]);
    for (let k = 6; k >= 1; k--) ring.push([-h[k][0], h[k][1], z]);
    return ring;   // 14 points: top center, right side down to the keel, left side back up
  });
  loftRings(part, rings, (i, k, x, y, z) => {
    if (z <= CAN.zF + 0.1 || z >= CAN.zA - 0.05 || !(k <= 1 || k >= 13)) return PK.CAMO;
    return Math.abs(x) < canopyW((z - CAN.zF) / (CAN.zA - CAN.zF)) - 0.03 ? PK.COCKPIT : PK.CAMO;   // deck inside the canopy only
  });
  return part.orient(true);
}

/** Lifting-surface panel: sections {x (span, build frame), y, z (leading edge), c (chord, +Z), t (thickness)}, closed. */
function panel(secs, ss, kindFn, sid = 0, smooth = 30) {
  const part = new Part(smooth);
  const last = ss.length - 1, sharedLE = ss[0] <= 0, sharedTE = ss[last] >= 1;
  const ring = [];
  for (let j = 0; j <= last; j++) ring.push([ss[j], 1]);
  for (let j = last; j >= 0; j--) { if ((j === last && sharedTE) || (j === 0 && sharedLE)) continue; ring.push([ss[j], -1]); }
  const rings = secs.map((sec) => ring.map(([s, side]) => [sec.x, sec.y + side * 0.5 * sec.t * biconvex(s), sec.z + s * sec.c]));
  const base = loftRings(part, rings, (i, k) => kindFn(secs[i], ring[k][0]), sid);
  capStart(part, base, ring.length);
  capEnd(part, base + (secs.length - 1) * ring.length, ring.length);
  return part.orient(true);
}
const hingeAt = (sec, h) => new THREE.Vector3(sec.x, sec.y, sec.z + h * sec.c);

function wingSec(x) {
  const W = WING, y = W.y0 - (x - W.x0) * Math.tan(W.anhedral);
  const le = W.leZ + (x - W.leX) * TAN42, te = W.teZ - (x - W.teX) * TAN17, c = te - le;
  return { x, y, z: le, c, t: c * lerp(W.tc0, W.tc1, (x - W.x0) / (W.xTip - W.x0)) };
}
function buildWingR(parts, hR) {
  const W = WING, S = (xs) => xs.map(wingSec);
  const fl = S([W.flapIn, 2.20, 2.78, W.flapOut]), al = S([W.flapOut, 3.92, 4.48, W.ailOut]);
  parts.push(panel(S([W.x0, W.flapIn]), SS_FULL, edgeKind));
  parts.push(panel(fl, ssMain(W.flapH), edgeKind), panel(fl, ssSurf(W.flapH), surfKind, SID.FLAP_R));
  parts.push(panel(al, ssMain(W.ailH), edgeKind), panel(al, ssSurf(W.ailH), surfKind, SID.AIL_R));
  parts.push(panel(S([W.ailOut, 5.25, W.xTip]), SS_FULL, edgeKind));
  hR.flap = { p: hingeAt(fl[0], W.flapH), q: hingeAt(fl[3], W.flapH) };
  hR.ail = { p: hingeAt(al[0], W.ailH), q: hingeAt(al[3], W.ailH) };
}

function stabSec(x) {
  const S = STAB, le = S.le0 + (x - S.x0) * TAN42, teK = S.te0 + (S.xKink - S.x0) * TAN42;
  const te = x <= S.xKink ? S.te0 + (x - S.x0) * TAN42 : teK - (x - S.xKink) * TAN17;   // notch, then forward-swept TE
  return { x, y: S.y, z: le, c: te - le, t: (te - le) * S.tc };
}
function buildStabR(parts, hR) {
  parts.push(panel([STAB.x0, 1.65, STAB.xKink, 2.83, STAB.xTip].map(stabSec), SS_FULL, edgeKind, SID.STAB_R));
  const p = new THREE.Vector3(STAB.x0, STAB.y, STAB.pivotZ);
  hR.stab = { p, q: p.clone().add(X_AXIS) };
}

function finSec(u) {
  const F = FIN, le = F.le0 + u * Math.tan(F.leSweep), te = F.te0 - u * Math.tan(F.teSweep);
  return { x: u, y: 0, z: le, c: te - le, t: (te - le) * F.tc };
}
function finMatrix() {   // build frame (span +X) -> canted 28 deg outboard, root on the nacelle shoulder
  return new THREE.Matrix4().makeTranslation(FIN.x, FIN.y, 0).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2 - FIN.cant));
}
function buildFinR(parts, hR) {
  const F = FIN, M = finMatrix(), S = (us) => us.map(finSec);
  const main = S([F.rud0, 0.85, 1.40, F.rud1]);
  const list = [
    panel(S([0, F.rud0]), SS_FULL, edgeKind),
    panel(main, ssMain(F.rudH), edgeKind),
    panel(main, ssSurf(F.rudH), surfKind, SID.RUD_R),
    panel(S([F.rud1, F.band]), SS_FULL, edgeKind),
    panel(S([F.band, 2.30, F.span]), SS_FULL, () => PK.ACCENT),     // squadron tail band (accent color)
  ];
  for (const p of list) parts.push(p.applyMatrix4(M));
  hR.rud = { p: hingeAt(main[0], F.rudH).applyMatrix4(M), q: hingeAt(main[3], F.rudH).applyMatrix4(M) };
}

/** 24-point rounded rectangle, starting at top center, clockwise seen from behind. */
function rrRing(cx, cy, w, h, r) {
  const pts = [], A = (x, y) => pts.push([cx + x, cy + y]), s = 0.5, c = Math.sqrt(3) / 2;
  A(0, h); A(w * 0.5, h); A(w - r, h); A(w - r + r * s, h - r + r * c); A(w - r + r * c, h - r + r * s);
  A(w, h - r); A(w, 0); A(w, -(h - r)); A(w - r + r * c, -(h - r) - r * s); A(w - r + r * s, -(h - r) - r * c);
  A(w - r, -h); A(w * 0.5, -h); A(0, -h); A(-w * 0.5, -h); A(-(w - r), -h);
  A(-(w - r) - r * s, -(h - r) - r * c); A(-(w - r) - r * c, -(h - r) - r * s);
  A(-w, -(h - r)); A(-w, 0); A(-w, h - r); A(-(w - r) - r * c, h - r + r * s); A(-(w - r) - r * s, h - r + r * c);
  A(-(w - r), h); A(-w * 0.5, h);
  return pts;
}
const NOTCH = new Set([1, 11, 13, 23]);    // ring points that sit in the notches of the sawtooth flap edges

/** Planar fan over a closed ring of [x,y,z], front face along (dx,dy,dz). */
function fanFacing(part, pts, kind, dx, dy, dz) {
  const n = pts.length;
  let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cx += a[0]; cy += a[1]; cz += a[2];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);   // Newell
  }
  const flip = nx * dx + ny * dy + nz * dz < 0;
  const c = part.v(cx / n, cy / n, cz / n, kind), base = part.count;
  for (const p of pts) part.v(p[0], p[1], p[2], kind);
  for (let k = 0; k < n; k++) { const a = base + k, b = base + (k + 1) % n; if (flip) part.tri(c, b, a); else part.tri(c, a, b); }
}

function buildEngineR(parts) {
  const ring3 = (z, w, h, r, zFn) => rrRing(ENG.x, ENG.y, w, h, r).map((p, k) => [p[0], p[1], zFn ? zFn(k) : z]);
  const exitZ = (k) => (NOTCH.has(k) ? NOZ.zNotch : NOZ.zTip);
  const nac = new Part(35);
  loftRings(nac, [ring3(0.60, 0.46, 0.46, 0.22), ring3(1.60, 0.49, 0.49, 0.22), ring3(3.00, 0.50, 0.50, 0.22),
    ring3(4.20, 0.50, 0.495, 0.21), ring3(5.25, 0.49, 0.46, 0.19)], () => PK.CAMO);
  parts.push(nac.orient(true));
  // 2D thrust-vectoring nozzle: flat flaps converge to a wide, short exit with sawtooth trailing edges
  const noz = new Part(35), exitOuter = ring3(0, NOZ.w, NOZ.h, 0.04, exitZ);
  loftRings(noz, [ring3(5.25, 0.49, 0.46, 0.19), ring3(5.60, 0.485, 0.39, 0.14), ring3(5.95, 0.475, 0.29, 0.08),
    ring3(6.10, 0.47, 0.255, 0.045), exitOuter], () => PK.METAL);
  parts.push(noz.orient(true));
  const t = NOZ.wall, exitInner = ring3(0, NOZ.w - t, NOZ.h - t, 0.02, exitZ);
  const inner = new Part(35), deep = ring3(5.62, NOZ.w - 0.03, 0.30, 0.08);
  loftRings(inner, [exitInner, ring3(5.95, NOZ.w - 0.03, 0.25, 0.05), deep], () => PK.NOZZLE_IN);
  parts.push(inner.orient(false));
  const plate = new Part(35);
  fanFacing(plate, deep, PK.NOZZLE_IN, 0, 0, 1);
  parts.push(plate);
  const lip = new Part(35);
  for (let k = 0; k < 24; k++) {
    const k2 = (k + 1) % 24, q = [exitOuter[k], exitOuter[k2], exitInner[k2], exitInner[k]].map((p) => lip.v(p[0], p[1], p[2], PK.METAL));
    lip.quadFacing(q[0], q[1], q[2], q[3], 0, 0, 1);
  }
  parts.push(lip);
}

function buildBoomR(parts) {   // stabilator pivot fairing along the nacelle side
  const bx = 1.17, by = -0.21, part = new Part(30);    // ends at the nozzle exit: the plume volume behind stays clear
  const secs = [[3.78, 0.005, 0.005], [4.22, 0.06, 0.09], [5.50, 0.07, 0.10], [6.02, 0.045, 0.065], [6.26, 0.004, 0.004]];
  loftRings(part, secs.map(([z, dx, dy]) => [[bx, by + dy, z], [bx + dx, by, z], [bx, by - dy, z], [bx - dx, by, z]]), () => PK.CAMO);
  parts.push(part.orient(true));
}

function buildIntakeR(parts) {
  const I = INTAKE, V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const UI = V(I.ui), u = V(I.u), v = V(I.v);
  const UO = UI.clone().add(u), LI = UI.clone().add(v), LO = UO.clone().add(v);
  const TI = UI.clone().addScaledVector(u, -I.inboard / u.x);        // top lip continues inboard over the diverter slot
  // outer shell: top, outer wall, bottom, inner wall (+ underside of the inboard top lip); open aft end hides in the body
  const shell = new Part(30), front = [TI, UO, LO, LI, UI].map((p) => [p.x, p.y, p.z]);
  loftRings(shell, [front, front.map((p) => [p[0], p[1], I.zEnd])], () => PK.CAMO);
  parts.push(shell.orient(true));
  // caret mouth: lip ring, dark duct, dark back wall
  const nm = new THREE.Vector3().crossVectors(u, v).normalize();
  if (nm.z > 0) nm.negate();
  const a = 0.048, b = 0.05;
  const outer = [UI, UO, LO, LI];
  const inner = [UI.clone().addScaledVector(u, a).addScaledVector(v, b), UO.clone().addScaledVector(u, -a).addScaledVector(v, b),
    LO.clone().addScaledVector(u, -a).addScaledVector(v, -b), LI.clone().addScaledVector(u, a).addScaledVector(v, -b)];
  const lip = new Part(30);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4, q = [outer[k], outer[k2], inner[k2], inner[k]].map((p) => lip.v(p.x, p.y, p.z, PK.LIP));
    lip.quadFacing(q[0], q[1], q[2], q[3], nm.x, nm.y, nm.z);
  }
  parts.push(lip);
  const r0 = inner.map((p) => [p.x, p.y, p.z]), r1 = r0.map((p) => [p[0], p[1], p[2] + I.depth]);
  const duct = new Part(30);
  loftRings(duct, [r0, r1], () => PK.DARK);
  parts.push(duct.orient(false));
  const wall = new Part(30);
  fanFacing(wall, r1, PK.DARK, 0, 0, -1);
  parts.push(wall);
  // boundary-layer diverter: closes the slot between the duct and the fuselage side
  const div = new Part(30), z = I.slotZ;
  const d = [[0.60, 0.04, z], [UI.x + 0.015, UI.y, z], [LI.x + 0.015, LI.y - 0.01, z], [0.40, -0.62, z]].map((p) => div.v(p[0], p[1], p[2], PK.SLOT));
  div.quadFacing(d[0], d[1], d[2], d[3], 0, 0, -1);
  parts.push(div);
}

function buildCockpit(parts) {
  const B = bodyCurves(), zc = -3.75, yd = B.yT(zc);
  const helmet = new THREE.SphereGeometry(0.135, 10, 7); helmet.translate(0, yd + 0.33, zc - 0.03);
  const torso = new THREE.BoxGeometry(0.44, 0.24, 0.28); torso.translate(0, yd + 0.10, zc + 0.08);
  const seat = new THREE.BoxGeometry(0.38, 0.46, 0.12); seat.rotateX(-0.17); seat.translate(0, yd + 0.18, zc + 0.31);
  const zp = -4.62, coaming = new THREE.BoxGeometry(0.60, 0.11, 0.36); coaming.translate(0, B.yT(zp) + 0.03, zp);
  parts.push(partFromGeometry(helmet, PK.HELMET, 60), partFromGeometry(torso, PK.SEAT, 30),
    partFromGeometry(seat, PK.SEAT, 30), partFromGeometry(coaming, PK.COCKPIT, 30));
}

/** One-piece frameless bubble canopy (separate mesh: gold-tinted physical material). */
function buildCanopyGeometry() {
  const K = 20, J = 16, P = 2.4, pos = [], idx = [];
  const y0 = bodyCurves().yT(CAN.zF);
  for (let i = 0; i < K; i++) {
    const t = i / (K - 1), z = lerp(CAN.zF, CAN.zA, t), w = Math.max(canopyW(t), 0.012);
    const sill = bodyUpperY(w, z) - 0.03, h = Math.max(canopyTop(t, y0) - sill, 0.012);
    for (let j = 0; j <= J; j++) {
      const phi = Math.PI * j / J, c = Math.cos(phi), s = Math.sin(phi);
      pos.push(w * Math.sign(c) * Math.pow(Math.abs(c), 2 / P), sill + h * Math.pow(s, 2 / P), z);
    }
  }
  for (let i = 0; i < K - 1; i++) for (let j = 0; j < J; j++) {
    const a = i * (J + 1) + j, b = a + 1, c = a + J + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// =============================================================================================
// Shared topology (built once per page): merged hull attributes, hinge table, canopy + light geometry, empties.
let _topo = null;
const mirX = (v) => new THREE.Vector3(-v.x, v.y, v.z);

function getTopology() {
  if (_topo) return _topo;
  const parts = [buildBody()], hR = {}, right = [];
  buildIntakeR(right); buildEngineR(right); buildBoomR(right); buildWingR(right, hR); buildStabR(right, hR); buildFinR(right, hR);
  for (const p of right) parts.push(p, p.mirrored());
  buildCockpit(parts);

  let nv = 0, ni = 0;
  const sm = parts.map((p) => { const s = autoSmooth(p); nv += s.K.length; ni += s.I.length; return s; });
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), kind = new Uint8Array(nv), surf = new Uint8Array(nv);
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0, oi = 0;
  for (const s of sm) {
    position.set(s.P, ov * 3); normal.set(s.N, ov * 3);
    for (let i = 0; i < s.K.length; i++) { kind[ov + i] = s.K[i]; surf[ov + i] = s.S[i] + 16 * PK_CLASS[s.K[i]]; }
    for (let i = 0; i < s.I.length; i++) index[oi + i] = s.I[i] + ov;
    ov += s.K.length; oi += s.I.length;
  }

  // hinge table -> uniform template: per surface vec4(point, cos) + vec4(axis, sin). Wing/stab axes point to +X
  // (positive angle = trailing edge DOWN on both sides); rudder axes point up their fins (positive = trailing edge RIGHT).
  const H = new Array(N_SURF + 1);
  const hinge = (p, q, flip) => ({ point: p.clone(), axis: q.clone().sub(p).normalize().multiplyScalar(flip ? -1 : 1) });
  H[SID.AIL_R] = hinge(hR.ail.p, hR.ail.q, false); H[SID.AIL_L] = hinge(mirX(hR.ail.p), mirX(hR.ail.q), true);
  H[SID.FLAP_R] = hinge(hR.flap.p, hR.flap.q, false); H[SID.FLAP_L] = hinge(mirX(hR.flap.p), mirX(hR.flap.q), true);
  H[SID.STAB_R] = hinge(hR.stab.p, hR.stab.q, false); H[SID.STAB_L] = hinge(mirX(hR.stab.p), mirX(hR.stab.q), true);
  H[SID.RUD_R] = hinge(hR.rud.p, hR.rud.q, false); H[SID.RUD_L] = hinge(mirX(hR.rud.p), mirX(hR.rud.q), false);
  const surfTemplate = new Float32Array(N_SURF * 8);
  for (let id = 1; id <= N_SURF; id++) {
    const o = (id - 1) * 8, h = H[id];
    surfTemplate.set([h.point.x, h.point.y, h.point.z, 1, h.axis.x, h.axis.y, h.axis.z, 0], o);
  }
  const mid = (h, q) => h.point.clone().add(q).multiplyScalar(0.5);

  const positionAttr = new THREE.BufferAttribute(position, 3), normalAttr = new THREE.BufferAttribute(normal, 3);
  const tmp = new THREE.BufferGeometry(); tmp.setAttribute('position', positionAttr);
  tmp.computeBoundingSphere(); tmp.computeBoundingBox();
  const sphere = tmp.boundingSphere.clone(); sphere.radius += 0.4;     // margin for deflected surfaces
  let r2 = 0;                                                           // farthest vertex from the origin (the nose tip)
  for (let i = 0; i < position.length; i += 3) r2 = Math.max(r2, position[i] * position[i] + position[i + 1] * position[i + 1] + position[i + 2] * position[i + 2]);

  // nav lights: red left tip, green right tip, white strobes on the fin tips
  const M = finMatrix(), ft = finSec(FIN.span), finTip = new THREE.Vector3(FIN.span, 0, ft.z + ft.c - 0.06).applyMatrix4(M);
  const yTip = wingSec(5.40).y;
  const L = [[-5.40, yTip, 2.02, 5, 0.25, 0.2, 0, 0.35], [5.40, yTip, 2.02, 0.2, 5, 0.6, 0, 0.35],
    [-finTip.x, finTip.y, finTip.z, 4, 4, 4, 1, 0.24], [finTip.x, finTip.y, finTip.z, 4, 4, 4, 1, 0.24]];
  const lightGeometry = new THREE.BufferGeometry();
  lightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(L.flatMap((l) => l.slice(0, 3)), 3));
  lightGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(L.flatMap((l) => l.slice(3, 6)), 3));
  lightGeometry.setAttribute('aKind', new THREE.Float32BufferAttribute(L.map((l) => l[6]), 1));
  lightGeometry.setAttribute('aSize', new THREE.Float32BufferAttribute(L.map((l) => l[7]), 1));
  lightGeometry.computeBoundingSphere(); lightGeometry.boundingSphere.radius += 1.5;

  const tipY = wingSec(WING.xTip).y;
  _topo = {
    vertexCount: nv, triangleCount: ni / 3, position, kind,
    positionAttr, normalAttr, surfAttr: new THREE.BufferAttribute(surf, 1), indexAttr: new THREE.BufferAttribute(index, 1),
    sphere, box: tmp.boundingBox.clone(), surfTemplate, radius: Math.sqrt(r2),
    canopyGeometry: buildCanopyGeometry(), lightGeometry,
    local: {   // named empties (local frame)
      gunL: new THREE.Vector3(1.12, 0.07, -2.35), gunR: new THREE.Vector3(1.22, 0.06, -2.30),   // M61 port, right wing root
      tipL: new THREE.Vector3(-WING.xTip, tipY, 2.70), tipR: new THREE.Vector3(WING.xTip, tipY, 2.70),
      rails: [new THREE.Vector3(-0.42, -1.0, 0.0), new THREE.Vector3(0.42, -1.0, 0.0),         // main weapons bay
        new THREE.Vector3(-0.20, -1.0, 0.9), new THREE.Vector3(0.20, -1.0, 0.9)],
      aileronL: mid(H[SID.AIL_L], mirX(hR.ail.q)), aileronR: mid(H[SID.AIL_R], hR.ail.q),
      flaperonL: mid(H[SID.FLAP_L], mirX(hR.flap.q)), flaperonR: mid(H[SID.FLAP_R], hR.flap.q),
      elevatorL: H[SID.STAB_L].point.clone(), elevatorR: H[SID.STAB_R].point.clone(),
      rudderL: mid(H[SID.RUD_L], mirX(hR.rud.q)), rudderR: mid(H[SID.RUD_R], hR.rud.q),
    },
  };
  tmp.dispose();
  return _topo;
}

// ---- color schemes: two-tone F-22 greys with soft camouflage patches, resolved into a vertex-color attribute ----
const REF_DARK = 0x5d646c, REF_LIGHT = 0x7c858e, REF_BODY = 0x8d9aa6;   // REF_BODY (the SPEC default bodyColor) -> exact F-22 tones
function srgbOf(hex) { const o = { r: 0, g: 0, b: 0 }; _c1.setHex(hex).getRGB(o, THREE.SRGBColorSpace); return o; }
/** bodyColor scales/tints the reference tones relative to the default (softened so dark schemes stay readable). */
function schemeTone(refHex, bodyHex) {
  const r = srgbOf(refHex), b = srgbOf(bodyHex), d = srgbOf(REF_BODY);
  const k = (x, y) => Math.pow(Math.max(x, 1e-3) / y, 0.7);
  return new THREE.Color().setRGB(clamp(r.r * k(b.r, d.r), 0, 1), clamp(r.g * k(b.g, d.g), 0, 1), clamp(r.b * k(b.b, d.b), 0, 1), THREE.SRGBColorSpace);
}
function hash3(i, j, k) {
  let n = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let u = x - xi, v = y - yi, w = z - zi;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), L(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    L(L(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), L(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v), w);
}
function camoMask(x, y, z) {
  const n = 0.62 * vnoise3(x * 0.55 + 17.3, y * 0.55 + 3.1, z * 0.55) + 0.38 * vnoise3(x * 1.2 + 5.5, y * 1.2, z * 1.2 + 9.2);
  return smoothstep(0.42, 0.58, n);
}
function paintColor(kind, x, y, z, sc, out) {
  switch (kind) {
    case PK.ACCENT: return out.copy(sc.accent);
    case PK.METAL: return out.setRGB(0.075, 0.068, 0.060);
    case PK.DARK: return out.setRGB(0.012, 0.012, 0.013);
    case PK.COCKPIT: return out.setRGB(0.020, 0.021, 0.023);
    case PK.HELMET: return out.setRGB(0.055, 0.056, 0.060);
    case PK.SEAT: return out.setRGB(0.028, 0.030, 0.026);
    case PK.NOZZLE_IN: return out.setRGB(0.022, 0.019, 0.017);
    case PK.SLOT: return out.copy(sc.dark).multiplyScalar(0.35);
    default:
      out.copy(sc.dark).lerp(sc.light, camoMask(x, y, z));
      if (kind === PK.EDGE) out.multiplyScalar(0.70);         // darker leading edges
      else if (kind === PK.LIP) out.multiplyScalar(0.55);     // intake lips
      else if (kind === PK.PANEL) out.multiplyScalar(0.86);   // control surfaces
      return out;
  }
}

const _schemes = new Map();
function acquireScheme(o) {
  const key = [o.bodyColor, o.accentColor, o.canopyColor, o.camoDark, o.camoLight].join('|');
  let s = _schemes.get(key);
  if (!s) {
    const topo = getTopology();
    const sc = {
      dark: o.camoDark != null ? new THREE.Color(o.camoDark) : schemeTone(REF_DARK, o.bodyColor),
      light: o.camoLight != null ? new THREE.Color(o.camoLight) : schemeTone(REF_LIGHT, o.bodyColor),
      accent: new THREE.Color(o.accentColor).multiplyScalar(0.7),
    };
    const n = topo.vertexCount, P = topo.position, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      paintColor(topo.kind[i], P[3 * i], P[3 * i + 1], P[3 * i + 2], sc, _c1);
      col[3 * i] = _c1.r; col[3 * i + 1] = _c1.g; col[3 * i + 2] = _c1.b;
    }
    const g = new THREE.BufferGeometry();     // shares position/normal/aSurf/index with every other scheme
    g.setIndex(topo.indexAttr);
    g.setAttribute('position', topo.positionAttr);
    g.setAttribute('normal', topo.normalAttr);
    g.setAttribute('aSurf', topo.surfAttr);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.boundingSphere = topo.sphere.clone(); g.boundingBox = topo.box.clone();
    const canopyMaterial = new THREE.MeshPhysicalMaterial({   // NO transmission (it would add a full extra scene pass in r170)
      color: o.canopyColor, metalness: 0.7, roughness: 0.08, clearcoat: 1.0, clearcoatRoughness: 0.04,
      transparent: true, opacity: 0.86, envMapIntensity: 1.5,
    });
    canopyMaterial.name = 'jetCanopy';
    s = { key, refs: 0, geometry: g, canopyMaterial };
    _schemes.set(key, s);
  }
  s.refs++;
  return s;
}
function releaseScheme(key) { const s = _schemes.get(key); if (s && s.refs > 0) s.refs--; }

// ---- hull material: MeshStandardMaterial + vertex-shader control surfaces + per-vertex material class -----------
const HULL_VERT_PARS = /* glsl */`
attribute float aSurf;
uniform vec4 uSurf[${N_SURF * 2}];
varying float vCls;
vec3 wnRot(vec3 v, vec3 k, float c, float s) { return v * c + cross(k, v) * s + k * (dot(k, v) * (1.0 - c)); }`;
const HULL_BEGINNORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
float wnSid = mod(aSurf, 16.0);
vCls = floor(aSurf / 16.0 + 0.01);
vec4 wnP = vec4(0.0, 0.0, 0.0, 1.0);
vec4 wnA = vec4(1.0, 0.0, 0.0, 0.0);
if (wnSid > 0.5) {
  int wi = int(wnSid + 0.5) - 1;
  wnP = uSurf[wi * 2];
  wnA = uSurf[wi * 2 + 1];
  objectNormal = wnRot(objectNormal, wnA.xyz, wnP.w, wnA.w);
}`;
const HULL_BEGIN = /* glsl */`
vec3 transformed = vec3( position );
if (wnSid > 0.5) transformed = wnP.xyz + wnRot(transformed - wnP.xyz, wnA.xyz, wnP.w, wnA.w);`;
const HULL_METAL = /* glsl */`
float metalnessFactor = metalness;
if (vCls > 0.5) {
  if (vCls < 1.5) { metalnessFactor = 0.9; roughnessFactor = 0.36; }        // nozzle metal
  else if (vCls < 2.5) { metalnessFactor = 0.0; roughnessFactor = 0.85; }   // matte interiors
  else { metalnessFactor = 0.25; roughnessFactor = 0.22; }                  // glossy (helmet)
}`;
function hullOnBeforeCompile(shader) {
  shader.uniforms.uSurf = this.userData.uSurf;            // per-material (per-jet) uniform object
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + HULL_VERT_PARS)
    .replace('#include <beginnormal_vertex>', HULL_BEGINNORMAL)
    .replace('#include <begin_vertex>', HULL_BEGIN);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vCls;')
    .replace('#include <metalnessmap_fragment>', HULL_METAL);
}
function hullProgramKey() { return 'wingnut-f22-hull-v1'; }
function makeHullMaterial(topo) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.5, roughness: 0.45, envMapIntensity: 1.0 });
  m.name = 'jetHull';
  m.userData.uSurf = { value: topo.surfTemplate.slice() };
  m.onBeforeCompile = hullOnBeforeCompile;               // same function + key for every jet -> one GL program
  m.customProgramCacheKey = hullProgramKey;
  return m;
}

const LIGHT_VERT = /* glsl */`
attribute vec3 aColor;
attribute float aKind;
attribute float aSize;
uniform float uViewportH, uTime;
uniform vec2 uNav;        // time of day (js/timeofday.js NIGHT_FX): x = intensity multiplier, y = minimum size (px)
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float inten = 1.0;
  if (aKind > 0.5) { float ph = fract(uTime * 0.8); inten = 0.08 + step(0.90, ph) + 0.8 * step(0.96, ph); }   // strobe
  float px = aSize * length(modelViewMatrix[0].xyz) * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 1.0);   // m at the drawn scale
  gl_PointSize = clamp(px * sqrt(uNav.x), uNav.y, 160.0);
  vColor = aColor * (inten * uNav.x);
  gl_Position = projectionMatrix * mv;
}`;
const LIGHT_FRAG = /* glsl */`
precision highp float;
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float f = (1.0 - r) * (1.0 - r);
  float core = smoothstep(0.4, 0.0, r);
  gl_FragColor = vec4(vColor * (f * 0.55 + core * 1.1), 1.0);
}`;

/** Local exit-plane descriptors of the two 2D nozzles (fresh objects), as consumed by AfterburnerFX. */
export function getJetNozzles() {
  return [-1, 1].map((s) => ({ position: new THREE.Vector3(s * ENG.x, ENG.y, NOZ.exitZ), halfWidth: NOZ.w - NOZ.wall, halfHeight: NOZ.h - NOZ.wall }));
}

/** Geometry statistics of one jet (shared topology). */
export function getJetStats() {
  const t = getTopology();
  return { hullVertices: t.vertexCount, hullTriangles: t.triangleCount, canopyTriangles: t.canopyGeometry.index.count / 3, schemes: _schemes.size };
}

/**
 * F-22 Raptor likeness. Nose toward -Z, ~15.1 m long, 10.85 m span, origin at the center of mass.
 * bodyColor scales/tints the two-tone grey scheme (the default gives #5d646c / #7c858e; camoDark/camoLight override
 * exactly); accentColor paints the tail bands; canopyColor tints the gold canopy. Geometry is cached and shared.
 * Named children: 'hull', 'canopy', 'lights', 'afterburner' (AfterburnerFX.object3d), empties 'gunL','gunR','tipL','tipR',
 * 'rail0'..'rail3', 'aileronL','aileronR','flaperonL','flaperonR','elevatorL','elevatorR','rudder' (+'rudderL','rudderR').
 * Control surfaces deflect in the vertex shader: write angles with setJetSurfaces(group, ...) (Aircraft does this).
 */
export function buildJetMesh({ bodyColor = 0x8d9aa6, accentColor = 0xff5a1f, canopyColor = 0x6e5422, camoDark = null, camoLight = null,
  fxQuality = 'high' } = {}) {
  const topo = getTopology();
  const scheme = acquireScheme({ bodyColor, accentColor, canopyColor, camoDark, camoLight });
  const group = new THREE.Group();
  group.name = 'jet';
  const fixed = (o) => { o.matrixAutoUpdate = false; o.updateMatrix(); return o; };

  const hullMat = makeHullMaterial(topo);
  const hull = fixed(new THREE.Mesh(scheme.geometry, hullMat));
  hull.name = 'hull';
  group.add(hull);
  const canopy = fixed(new THREE.Mesh(topo.canopyGeometry, scheme.canopyMaterial));
  canopy.name = 'canopy';
  group.add(canopy);

  const lightMat = new THREE.ShaderMaterial({
    vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, uniforms: { uViewportH: new FloatUniform(1080), uTime: new FloatUniform(0.5), uNav: NIGHT_FX.uNav },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  lightMat.name = 'jetLights';
  const lights = fixed(new THREE.Points(topo.lightGeometry, lightMat));
  lights.name = 'lights';
  lights.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    lightMat.uniforms.uViewportH.value = rt ? rt.height : renderer.getDrawingBufferSize(_vp).y;
  };
  group.add(lights);

  let fx = null;
  try {
    fx = new AfterburnerFX({ nozzles: getJetNozzles(), quality: fxQuality });
    group.add(fx.object3d);
  } catch (e) {
    console.warn('aircraft: AfterburnerFX unavailable', e);
    fx = null;
    const o = new THREE.Object3D(); o.name = 'afterburner'; group.add(o);
  }

  const L = topo.local, mk = (name, p, parent = group) => { const o = new THREE.Object3D(); o.name = name; o.position.copy(p); parent.add(fixed(o)); return o; };
  mk('gunL', L.gunL); mk('gunR', L.gunR); mk('tipL', L.tipL); mk('tipR', L.tipR);
  L.rails.forEach((p, i) => mk('rail' + i, p));
  mk('aileronL', L.aileronL); mk('aileronR', L.aileronR); mk('flaperonL', L.flaperonL); mk('flaperonR', L.flaperonR);
  mk('elevatorL', L.elevatorL); mk('elevatorR', L.elevatorR);
  const rud = mk('rudder', new THREE.Vector3(0, L.rudderR.y, L.rudderR.z));
  mk('rudderL', L.rudderL.clone().sub(rud.position), rud); mk('rudderR', L.rudderR.clone().sub(rud.position), rud);

  group.userData.engineFX = fx;
  group.userData.hullMaterial = hullMat;
  group.userData.lightMaterial = lightMat;
  group.userData.surfaceUniforms = hullMat.userData.uSurf.value;   // Float32Array(64): [px,py,pz,cos, ax,ay,az,sin] x 8
  group.userData.schemeKey = scheme.key;
  group.userData.local = L;
  return group;
}

/** Writes control-surface deflections (radians; + = trailing edge down for wing/stab surfaces, right for rudders). */
export function setJetSurfaces(group, a) {
  const u = group.userData.surfaceUniforms;
  if (!u) return;
  setSurf(u, SID.AIL_L, a.aileronL); setSurf(u, SID.AIL_R, a.aileronR); setSurf(u, SID.FLAP_L, a.flaperonL); setSurf(u, SID.FLAP_R, a.flaperonR);
  setSurf(u, SID.STAB_L, a.elevatorL); setSurf(u, SID.STAB_R, a.elevatorR); setSurf(u, SID.RUD_L, a.rudder); setSurf(u, SID.RUD_R, a.rudder);
}
function setSurf(u, id, ang) { const o = (id - 1) * 8; u[o + 3] = Math.cos(ang); u[o + 7] = Math.sin(ang); }

/** Frees one jet's own GPU resources (materials, afterburner). Shared cached geometry stays alive for re-use. */
export function disposeJetMesh(group) {
  const ud = group && group.userData;
  if (!ud || ud.disposed) return;
  ud.disposed = true;
  if (ud.engineFX) ud.engineFX.dispose();
  if (ud.hullMaterial) ud.hullMaterial.dispose();
  if (ud.lightMaterial) ud.lightMaterial.dispose();
  releaseScheme(ud.schemeKey);
  group.removeFromParent();
}

/** Full teardown of the shared jet geometry cache. Only call when no jet built by buildJetMesh is alive. */
export function disposeJetCache() {
  for (const s of _schemes.values()) { s.geometry.dispose(); s.canopyMaterial.dispose(); }
  _schemes.clear();
  if (_topo) { _topo.canopyGeometry.dispose(); _topo.lightGeometry.dispose(); _topo = null; }
}

// =============================================================================================
// Contrail ribbons: both wingtips in ONE dynamic mesh (world space). Ring buffer: per frame only the head slots
// are rewritten and uploaded (one interleaved buffer, 1-2 small sub-ranges). Dead vertices collapse to zero width
// in the vertex shader, so the ring seam and faded tail rasterize nothing. Hidden (zero cost) when not condensing,
// frustum culled via a per-frame bounding sphere when visible.
const TRAIL_N = 120;        // points per ribbon
const TRAIL_EMIT = 0.02;    // s between appended points
const TRAIL_LIFE = 2.3;     // s
const TRAIL_STRIDE = 8;     // floats per vertex: position(3) dir(3) birth(1) strength(1)
const TRAIL_DEAD = -1e9;
let _trailPrewarmed = false;
const noop = () => {};

const TRAIL_VERT = /* glsl */`
attribute vec3 aDir;
attribute float aSide;
attribute float aBirth;
attribute float aStrength;
uniform float uTime, uLife, uScale;
varying float vAlpha;
varying float vU;
#include <fog_pars_vertex>
void main() {
  float age = (uTime - aBirth) / uLife;
  float live = step(age, 0.999) * step(0.001, aStrength);     // dead -> zero width (no rasterization)
  float life = clamp(age, 0.0, 1.0);
  float width = (0.22 + 1.5 * life) * live * uScale;     // uScale: the jet's drawn scale
  vec3 toCam = cameraPosition - position;
  vec3 side = cross(aDir, toCam);
  float l = length(side);
  side = (l > 1e-4) ? side / l : vec3(0.0, 1.0, 0.0);
  vec3 p = position + side * (aSide * width);
  vAlpha = aStrength * (1.0 - life) * (1.0 - life) * live;
  vU = aSide;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const TRAIL_FRAG = /* glsl */`
precision highp float;
varying float vAlpha;
varying float vU;
#include <fog_pars_fragment>
void main() {
  float a = vAlpha * (1.0 - vU * vU);
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(1.25, 1.3, 1.4), a * 0.45);
  #include <fog_fragment>
}`;

class ContrailRibbons {
  constructor(scene) {
    const n = TRAIL_N, verts = 4 * n;          // 2 ribbons x n ring slots x 2 sides
    this.n = n;
    this.data = new Float32Array(verts * TRAIL_STRIDE);
    for (let v = 0; v < verts; v++) this.data[v * TRAIL_STRIDE + 6] = TRAIL_DEAD;
    this.buf = new THREE.InterleavedBuffer(this.data, TRAIL_STRIDE).setUsage(THREE.DynamicDrawUsage);
    this.buf.onUpload(() => { this.full = false; this.advance = 0; });
    const sides = new Float32Array(verts);
    for (let i = 0; i < verts; i += 2) { sides[i] = -1; sides[i + 1] = 1; }
    const idx = new Uint16Array(2 * n * 6);
    let o = 0;
    for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) {     // quads between consecutive slots, ring wraps
      const a = (r * n + i) * 2, b = (r * n + (i + 1) % n) * 2;
      idx[o++] = a; idx[o++] = a + 1; idx[o++] = b; idx[o++] = a + 1; idx[o++] = b + 1; idx[o++] = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buf, 3, 0));
    g.setAttribute('aDir', new THREE.InterleavedBufferAttribute(this.buf, 3, 3));
    g.setAttribute('aBirth', new THREE.InterleavedBufferAttribute(this.buf, 1, 6));
    g.setAttribute('aStrength', new THREE.InterleavedBufferAttribute(this.buf, 1, 7));
    g.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLife: { value: TRAIL_LIFE } }]),
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      forceSinglePass: true,   // r170 otherwise draws transparent DoubleSide materials twice per frame
    });
    this.material.uniforms.uTime = new FloatUniform(0.5);
    this.material.uniforms.uScale = new FloatUniform(1);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'contrails';
    this.mesh.matrixAutoUpdate = false;          // world-space geometry, identity transform
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    this.mesh.raycast = noop;
    this.active = false;
    this.head = 0; this.lastEmit = -1; this.quiet = 1e9;
    this.full = true; this.advance = 0;
    this.ranges = [{ start: 0, count: 0 }, { start: 0, count: 0 }, { start: 0, count: 0 }, { start: 0, count: 0 }];
    this._prewarm = false;
    if (!_trailPrewarmed) {
      // compile the trail program on the first rendered frame (title screen) instead of mid-dogfight:
      // a negative draw count makes Three set up the program and return before issuing any draw call
      _trailPrewarmed = true;
      this._prewarm = true;
      g.setDrawRange(0, -1);
      this.mesh.visible = true; this.mesh.frustumCulled = false;
    }
    // permanent (cheap) callback, so wrappers such as profiler.instrument() stay intact
    this.mesh.onAfterRender = () => {
      if (!this._prewarm) return;
      this._prewarm = false;
      g.setDrawRange(0, Infinity);
      this.mesh.frustumCulled = true;
      this.mesh.visible = this.active;
    };
    scene.add(this.mesh);
  }

  _setVisible(v) {
    this.active = v;
    if (!this._prewarm) this.mesh.visible = v;     // (the prewarm frame restores visibility itself)
  }

  /** Kill both ribbons (no streaks after a respawn/kill) and hide. */
  clear() {
    const d = this.data;
    for (let v = 0, n4 = 4 * this.n; v < n4; v++) { const o = v * TRAIL_STRIDE; d[o + 6] = TRAIL_DEAD; d[o + 7] = 0; }
    this.full = true; this.buf.updateRanges.length = 0; this.buf.needsUpdate = true;
    this.lastEmit = -1; this.quiet = 1e9;
    this._setVisible(false);
  }

  _point(r, slot, x, y, z, birth, strength) {
    const d = this.data, o = (r * this.n + slot) * 2 * TRAIL_STRIDE, o2 = o + TRAIL_STRIDE;
    d[o] = d[o2] = x; d[o + 1] = d[o2 + 1] = y; d[o + 2] = d[o2 + 2] = z;
    d[o + 6] = d[o2 + 6] = birth; d[o + 7] = d[o2 + 7] = strength;
  }

  _dir(r, slot) {   // direction of travel: newer neighbour minus older neighbour
    const n = this.n, d = this.data;
    const newer = slot === this.head ? slot : (slot + 1) % n, older = (slot - 1 + n) % n;
    const a = (r * n + newer) * 2 * TRAIL_STRIDE, b = (r * n + older) * 2 * TRAIL_STRIDE;
    let dx = d[a] - d[b], dy = d[a + 1] - d[b + 1], dz = d[a + 2] - d[b + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-6) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 0; dz = 1; }
    const o = (r * n + slot) * 2 * TRAIL_STRIDE, o2 = o + TRAIL_STRIDE;
    d[o + 3] = d[o2 + 3] = dx; d[o + 4] = d[o2 + 4] = dy; d[o + 5] = d[o2 + 5] = dz;
  }

  _markDirty() {   // upload only the slots touched since the last upload (Three merges adjacent ranges)
    const n = this.n, R = this.buf.updateRanges;
    R.length = 0;
    this.buf.needsUpdate = true;
    if (this.full || this.advance > n - 4) { this.full = true; return; }    // no ranges = whole buffer
    const first = (this.head - 1 - this.advance + 2 * n) % n, count = this.advance + 3;
    let ri = 0;
    for (let r = 0; r < 2; r++) {
      if (first + count <= n) ri = this._range(ri, r, first, count);
      else { ri = this._range(ri, r, first, n - first); ri = this._range(ri, r, 0, first + count - n); }
    }
  }

  _range(ri, r, slot, cnt) {   // preallocated range objects (no per-frame garbage)
    const g = this.ranges[ri], n = this.n;
    g.start = (r * n + slot) * 2 * TRAIL_STRIDE; g.count = cnt * 2 * TRAIL_STRIDE;
    this.buf.updateRanges.push(g);
    return ri + 1;
  }

  _bounds() {
    const d = this.data, step = 2 * TRAIL_STRIDE, end = 2 * this.n * step;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let o = 0; o < end; o += step) {
      if (d[o + 7] <= 0) continue;
      const x = d[o], y = d[o + 1], z = d[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const s = this.geometry.boundingSphere;
    if (x0 === Infinity) { s.radius = 0; return; }       // nothing alive (all vertices collapse to zero area anyway)
    const ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    s.center.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
    s.radius = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez) + 3 * this.material.uniforms.uScale.value;
  }

  /** Ribbon width multiplier: the jet's drawn scale (Aircraft.updateDrawScale). */
  setWidth(s) { this.material.uniforms.uScale.value = s; }

  update(time, dt, tipL, tipR, strength) {
    const n = this.n;
    if (strength > 0.01) {
      this.quiet = 0;
      if (!this.active) {                                  // (re)start: collapse everything onto the tips
        this.clear();
        this.quiet = 0; this.head = 0; this.lastEmit = time;
        this._setVisible(true);
      }
    } else if (this.active) {
      this.quiet += dt;
      if (this.quiet > TRAIL_LIFE + 0.2) { this._setVisible(false); return; }
    }
    if (!this.active) return;
    const emit = time - this.lastEmit >= TRAIL_EMIT;
    if (emit) { this.head = (this.head + 1) % n; this.lastEmit = time; this.advance++; }
    const h = this.head;
    for (let r = 0; r < 2; r++) {
      const t = r ? tipR : tipL;
      this._point(r, h, t.x, t.y, t.z, time, strength);                    // head always fresh
      if (emit) this._point(r, (h + 1) % n, t.x, t.y, t.z, TRAIL_DEAD, 0); // collapsed seam (newest <-> oldest)
      this._dir(r, h); this._dir(r, (h - 1 + n) % n);
    }
    this._markDirty();
    this._bounds();
    this.material.uniforms.uTime.value = time;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Aircraft: arcade flight model + all per-aircraft visuals. Used for the player and every AI jet.
// ---- wing vapor: PW-style condensation blanket over the wings in hard pulls (hidden, zero cost, when idle) -------
const VAPOR_VERT = /* glsl */`
varying vec3 vLocal; varying vec3 vN; varying vec3 vViewDir;
void main() {
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);           // view space; normalMatrix handles the non-uniform dome scale
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const VAPOR_FRAG = /* glsl */`
uniform float uStrength; uniform float uTime;
varying vec3 vLocal; varying vec3 vN; varying vec3 vViewDir;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float facing = abs(dot(normalize(vN), normalize(vViewDir)));
  float body = smoothstep(0.2, 0.95, facing); body *= body;     // soft silhouette, no hard rim
  float base = smoothstep(0.05, 0.6, vLocal.y);                 // melts into the wing surface
  float front = smoothstep(-1.0, -0.3, vLocal.z);               // leading edge fades in
  vec2 q = vec2(vLocal.x * 2.2, vLocal.z * 1.4 - uTime * 6.0);  // streams backward
  float n = vnoise(q) * 0.65 + vnoise(q * 2.3 + 7.1) * 0.35;
  float a = uStrength * body * base * front * (0.25 + 0.75 * n) * 0.7;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.05, 1.08, 1.12), a);
}`;
let _vaporGeo = null;
function makeVapor() {
  if (!_vaporGeo) _vaporGeo = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VAPOR_VERT, fragmentShader: VAPOR_FRAG, name: 'jetVapor',
    uniforms: { uStrength: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, fog: false,
  });
  const m = new THREE.Mesh(_vaporGeo, mat);
  m.name = 'vapor'; m.scale.set(4.6, 1.15, 3.4); m.position.set(0, 0.45, 1.4);
  m.renderOrder = 22; m.visible = false;
  return m;
}

export class Aircraft {
  constructor(scene, { team = 'enemy', bodyColor, accentColor, position = new THREE.Vector3(), heading = 0, fxQuality = 'high' } = {}) {
    this.scene = scene;
    this.team = team;
    const isPlayer = team === 'player';
    this.mesh = buildJetMesh({
      bodyColor: bodyColor !== undefined ? bodyColor : (isPlayer ? 0x8d9aa6 : 0x5b6168),
      accentColor: accentColor !== undefined ? accentColor : (isPlayer ? 0xff5a1f : 0xd21f2d),
      fxQuality,
    });
    this.mesh.name = 'aircraft-' + team;
    this.mesh.userData.aircraft = this;
    this.position = this.mesh.position;
    this.quaternion = this.mesh.quaternion;
    this.velocity = new THREE.Vector3();

    this.speed = FLIGHT.CRUISE_SPEED; this.throttle = 0.6; this.afterburner = false; this.gLoad = 1;
    this.health = 100; this.alive = true; this.stalled = false;
    this.handling = isPlayer ? { pitch: 1, roll: 1, yaw: 1 } : { pitch: 0.8, roll: 0.85, yaw: 1 };
    this.thrust = 0;                                     // spring-loaded thrust axis (-1 brake .. 0 cruise .. +1 boost)
    this.speedScale = 1;                                 // per-type speed multiplier (helicopters, cruise missiles...)
    this.sizeScale = 1;                                  // life-size scale of the type (cruise missiles 0.45; gameplay sizes)
    this.larger = false;                                 // drawn larger than life (enemies; setSize)
    this.visualScale = 1;                                // drawn scale = mesh.scale (updateDrawScale)
    this.hitRadius = 0;                                  // round hit sphere (m) when larger, else 0 = the shooter's gun radius
    this.maxMissiles = FLIGHT.MAX_MISSILES; this.missiles = FLIGHT.MAX_MISSILES; this.ammo = FLIGHT.AMMO;
    this.time = Math.random() * 7;                       // desyncs strobes / exhaust noise between aircraft
    this.controls = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 };
    this._rates = { pitch: 0, roll: 0, yaw: 0 };         // smoothed achieved angular rates (rad/s)
    this._surf = { ail: 0, elev: 0, rud: 0 };            // smoothed control inputs (-1..1)
    /** Current control-surface deflections (radians), see setJetSurfaces() for the sign convention. */
    this.surfaceAngles = { aileronL: 0, aileronR: 0, flaperonL: 0, flaperonR: 0, elevatorL: 0, elevatorR: 0, rudder: 0 };

    const ud = this.mesh.userData, L = ud.local;
    this.engineFX = ud.engineFX;                          // AfterburnerFX instance (or null)
    this._fxParams = { throttle: 0, afterburner: false, speed: 0, time: 0 };
    this._lightTime = ud.lightMaterial.uniforms.uTime;
    this._local = { gunL: L.gunL, gunR: L.gunR, tipL: L.tipL, tipR: L.tipR, rails: L.rails };
    this._muzzles = [new THREE.Vector3(), new THREE.Vector3()];
    this._railPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._tipL = new THREE.Vector3(); this._tipR = new THREE.Vector3();

    this.contrails = new ContrailRibbons(scene);
    this.vapor = makeVapor(); this.mesh.add(this.vapor); this._vaporS = 0;
    scene.add(this.mesh);
    this.reset({ position, heading, health: 100 });
  }

  // ---- controls ------------------------------------------------------------------------------
  setControls({ pitch = 0, roll = 0, yaw = 0, throttleDelta = 0 } = {}) {
    const c = this.controls;
    c.pitch = clamp(finite(pitch), -1, 1);
    c.roll = clamp(finite(roll), -1, 1);
    c.yaw = clamp(finite(yaw), -1, 1);
    c.throttleDelta = clamp(finite(throttleDelta), -1, 1);
  }

  // ---- frame vectors (world space) ------------------------------------------------------------
  getForward(out) { return out.set(0, 0, -1).applyQuaternion(this.quaternion); }
  getUp(out) { return out.set(0, 1, 0).applyQuaternion(this.quaternion); }
  getRight(out) { return out.set(1, 0, 0).applyQuaternion(this.quaternion); }
  /** Compass heading in radians, 0 = -Z, increasing clockwise (toward +X). */
  getHeading() { const f = this.getForward(_v1); let h = Math.atan2(f.x, -f.z); if (h < 0) h += Math.PI * 2; return h; }
  /** Local (model-frame) point -> world at the drawn scale (always current, no matrix update needed; the jet group is a
   *  direct child of the scene), so wingtip emitters, muzzles and rails sit on the airframe as drawn. */
  localToWorld(local, out) { return out.copy(local).multiplyScalar(this.visualScale).applyQuaternion(this.quaternion).add(this.position); }

  /**
   * Airframe size: the type's life-size scale and whether it is drawn larger than life (enemies; the player and the
   * squadmates are not). A larger aircraft's round hit sphere is its drawn airframe at the constant ENEMY_SCALE (Weapons
   * tests max(that, the shooter's gun radius)), so a round that visibly hits it registers.
   */
  setSize(sizeScale = 1, larger = false) {
    this.sizeScale = sizeScale; this.larger = larger;
    this.hitRadius = larger ? getTopology().radius * sizeScale * ENEMY_SCALE : 0;
    this.updateDrawScale(null);
  }
  /**
   * Drawn scale for this frame from the camera position `cam` (null: the near scale): sizeScale, times ENEMY_SCALE ..
   * ENEMY_SCALE_FAR by camera distance when larger. Sets the root mesh's scale, so the hull, canopy, nav lights (sprite
   * size too), afterburner and wing vapor follow it, plus the contrail width; localToWorld (wingtips, muzzles, rails) and
   * Weapons.aircraftDeath / gun-hit effects read visualScale. A few flops and no allocation: call it every frame.
   */
  updateDrawScale(cam) {
    let s = this.sizeScale;
    if (this.larger) s *= cam ? ENEMY_SCALE + (ENEMY_SCALE_FAR - ENEMY_SCALE) * smoothstep(ENEMY_SCALE_NEAR_M, ENEMY_SCALE_FAR_M, this.position.distanceTo(cam)) : ENEMY_SCALE;
    if (s === this.visualScale) return;
    this.visualScale = s;
    this.mesh.scale.setScalar(s);
    this.contrails.setWidth(s);
  }

  getGunMuzzles() {
    this.localToWorld(this._local.gunL, this._muzzles[0]);
    this.localToWorld(this._local.gunR, this._muzzles[1]);
    return this._muzzles;
  }
  getMissileRails() {
    for (let i = 0; i < 4; i++) this.localToWorld(this._local.rails[i], this._railPos[i]);
    return this._railPos;
  }
  /** Forwarded to AfterburnerFX.setQuality ('low' | 'medium' | 'high' | 'ultra'). */
  setEffectsQuality(q) { if (this.engineFX) this.engineFX.setQuality(q); }

  // ---- lifecycle ------------------------------------------------------------------------------
  applyDamage(amount) {
    if (!this.alive) return false;
    this.health -= finite(amount);
    if (this.health <= 0) { this.health = 0; this.kill(); return true; }
    return false;
  }

  kill() {
    this.alive = false;
    this.mesh.visible = false;
    this.afterburner = false;
    this.contrails.clear();
  }

  reset({ position, heading, health = 100 } = {}) {
    if (position) this.position.copy(position);
    if (heading !== undefined) this.quaternion.setFromAxisAngle(Y_AXIS, -finite(heading));
    this.quaternion.normalize();
    this.health = health; this.alive = true; this.stalled = false;
    this.speed = FLIGHT.CRUISE_SPEED; this.throttle = 0.6; this.afterburner = false; this.gLoad = 1; this.thrust = 0;
    this.missiles = this.maxMissiles; this.ammo = FLIGHT.AMMO;
    this._rates.pitch = this._rates.roll = this._rates.yaw = 0;
    this._surf.ail = this._surf.elev = this._surf.rud = 0;
    this.controls.pitch = this.controls.roll = this.controls.yaw = this.controls.throttleDelta = 0;
    this.getForward(this.velocity).multiplyScalar(this.speed);
    this.mesh.visible = true;
    this.contrails.clear();
    this._animate(0);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.contrails.dispose();
    if (this.vapor) { this.vapor.material.dispose(); this.vapor.removeFromParent(); }   // shared vapor geometry stays
    disposeJetMesh(this.mesh);    // per-jet materials + afterburner; shared cached geometry stays
  }

  // ---- per frame ------------------------------------------------------------------------------
  update(dt) {
    dt = finite(dt, 0);
    if (dt <= 0) return;
    if (dt > FLIGHT.MAX_DT) dt = FLIGHT.MAX_DT;
    this.time += dt;
    if (this.alive) this._integrate(dt);
    this._animate(dt);
  }

  _integrate(dt) {
    const c = this.controls, F = FLIGHT, H = this.handling;
    // ---- thrust axis (spring-loaded): 0 = cruise, +1 = full boost, -1 = full airbrake ----
    const t = c.throttleDelta;
    this.thrust = t;
    this.afterburner = t > F.AB_THRESHOLD;
    const throttleTarget = t >= 0 ? 0.6 + 0.4 * t : 0.6 + 0.5 * t;          // engine setting for HUD/audio/FX
    this.throttle += (throttleTarget - this.throttle) * (1 - Math.exp(-dt / 0.25));

    const speed = this.speed;
    const right = this.getRight(_v3);
    // ---- authority: weak only near stall; pitch eases off slightly at the very top of the speed range ----
    const vStall = F.MIN_SPEED * Math.min(1, (this.speedScale || 1) * 1.2);
    const auth = 0.3 + 0.7 * smoothstep(vStall * 0.8, vStall * 2.4, speed);
    const stall = speed < vStall;
    this.stalled = speed < vStall * 1.1;
    const stallK = stall ? 0.45 : 1;
    const hiK = 1 - 0.2 * smoothstep(F.AB_SPEED * 0.8, F.AB_SPEED, speed);
    const brakeK = 1 + F.BRAKE_TURN * Math.max(0, -t);
    const pitchMax = F.PITCH_RATE * H.pitch * auth * hiK * brakeK * stallK;
    const rollMax = F.ROLL_RATE * H.roll * (0.45 + 0.55 * auth) * stallK;
    const yawMax = F.YAW_RATE * H.yaw * auth * stallK;
    const pitchCmd = c.pitch * pitchMax * (c.pitch < 0 ? F.PUSH_FACTOR : 1);
    const rollCmd = c.roll * rollMax + (stall ? Math.min(1, (vStall - speed) / (vStall * 0.4) + 0.35) * 1.1 * Math.sin(this.time * 1.7 + 0.6) : 0);
    // slight turn into the bank so a banked jet drifts around even without pull; a stalled jet wallows
    const depart = stall ? Math.min(1, (vStall - speed) / (vStall * 0.4) + 0.35) : 0;
    const yawCmd = c.yaw * yawMax + (-right.y) * 0.16 * auth + depart * 0.35 * Math.sin(this.time * 2.3);
    const r = this._rates;
    r.pitch += (pitchCmd - r.pitch) * (1 - Math.exp(-dt / F.RESPONSE));
    r.roll += (rollCmd - r.roll) * (1 - Math.exp(-dt / (F.RESPONSE * 0.9)));
    r.yaw += (yawCmd - r.yaw) * (1 - Math.exp(-dt / (F.RESPONSE * 1.4)));

    // rotations in the local frame: pitch about +X (nose up), yaw about -Y (nose right), roll about -Z (right wing down)
    const q = this.quaternion;
    q.multiply(_q1.setFromAxisAngle(X_AXIS, r.pitch * dt));
    q.multiply(_q1.setFromAxisAngle(Y_AXIS, -r.yaw * dt));
    q.multiply(_q1.setFromAxisAngle(Z_AXIS, -r.roll * dt));

    // ---- stall: below stall speed the nose falls toward the ground until speed recovers ----
    const slow = 1 - smoothstep(vStall * 0.8, vStall * 1.15, speed);
    if (slow > 0.001) {
      _v4.set(0, -1, 0).applyQuaternion(_q2.copy(q).invert());      // world down in the local frame
      const ax = _v4.y, ay = -_v4.x;                                  // cross((0,0,-1), down)
      const len = Math.hypot(ax, ay);
      if (len > 1e-4) q.multiply(_q1.setFromAxisAngle(_v4.set(ax / len, ay / len, 0), slow * 0.9 * len * dt));
    }
    q.normalize();
    if (!Number.isFinite(q.x + q.y + q.z + q.w)) q.set(0, 0, 0, 1);

    // ---- speed: settle toward the thrust axis target; gravity along the path; mild bleed when pulling hard ----
    const fwd = this.getForward(_v1);
    const ss = this.speedScale || 1;
    const vTarget = (t >= 0 ? lerp(F.CRUISE_SPEED, F.AB_SPEED, t) : lerp(F.CRUISE_SPEED, F.BRAKE_SPEED, -t)) * ss;
    const dv = vTarget - this.speed;
    // Energy: the engine compensates less the steeper you climb, and drag holds you back less in a dive, so long
    // vertical climbs bleed speed (even on afterburner) and dives build it. The airbrake always bites.
    const climb = Math.max(0, fwd.y), dive = Math.max(0, -fwd.y);
    const accUp = (t > 0.05 ? F.BOOST_ACCEL : F.CRUISE_ACCEL) * (1 - 0.85 * climb);
    const braking = t < -0.05;
    const accDown = braking ? F.BRAKE_DECEL : F.DRAG_DECEL * (1 - 0.9 * dive);
    const acc = dv > 0 ? Math.min(dv * 1.2, accUp) : Math.max(dv * (braking ? 1.4 : 1 - 0.8 * dive), -accDown);
    this.speed += acc * dt;
    this.speed -= 9.81 * fwd.y * dt * F.GRAVITY_FACTOR;
    const pull = Math.abs(r.pitch) / Math.max(F.PITCH_RATE, 1e-3);
    this.speed -= pull * pull * F.TURN_BLEED * dt;
    this.speed = clamp(finite(this.speed, F.CRUISE_SPEED), 20, F.AB_SPEED * 1.15);
    // cosmetic g for the HUD and contrails (arcade: ~9 g at a full pull at cruise speed)
    const up = this.getUp(_v2);
    this.gLoad = up.y + (r.pitch / F.PITCH_RATE) * 7 * clamp(this.speed / 230, 0.25, 1.3);
    if (!Number.isFinite(this.gLoad)) this.gLoad = 1;

    // ---- velocity follows the nose (arcade) ----
    this.velocity.copy(fwd).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);
    if (this.position.y < -5) { this.position.y = -5; if (this.velocity.y < 0) this.velocity.y = 0; }
    const p = this.position;
    if (!Number.isFinite(p.x + p.y + p.z)) p.set(0, 800, 0);
    p.x = clamp(p.x, -1e5, 1e5); p.y = clamp(p.y, -5, 1e5); p.z = clamp(p.z, -1e5, 1e5);
  }

  _animate(dt) {
    const c = this.controls;
    // control surfaces follow the (smoothed) inputs: ailerons + flaperons differential (flaperons droop when slow),
    // stabilators with pitch plus a little roll, rudders with yaw. Deflection happens in the hull vertex shader.
    const s = this._surf, k = dt > 0 ? 1 - Math.exp(-dt / 0.06) : 1;
    s.ail += (c.roll - s.ail) * k; s.elev += (c.pitch - s.elev) * k; s.rud += (c.yaw - s.rud) * k;
    const a = this.surfaceAngles, droop = 0.22 * (1 - smoothstep(85, 150, this.speed));
    a.aileronL = s.ail * 0.38; a.aileronR = -s.ail * 0.38;
    a.flaperonL = s.ail * 0.22 + droop; a.flaperonR = -s.ail * 0.22 + droop;
    a.elevatorL = -s.elev * 0.32 + s.ail * 0.10; a.elevatorR = -s.elev * 0.32 - s.ail * 0.10;
    a.rudder = s.rud * 0.42;
    // speed brake (F-22 style): both ailerons up and both flaperons down while the airbrake is out
    const brk = this.alive ? Math.max(0, -(this.thrust || 0)) : 0;
    this._brk = (this._brk || 0) + (brk - (this._brk || 0)) * (dt > 0 ? 1 - Math.exp(-dt / 0.15) : 1);
    if (this._brk > 0.01) { a.aileronL -= this._brk * 0.5; a.aileronR -= this._brk * 0.5; a.flaperonL += this._brk * 0.45; a.flaperonR += this._brk * 0.45; }
    setJetSurfaces(this.mesh, a);
    // exhaust (AfterburnerFX) + strobes
    const fp = this._fxParams;
    fp.throttle = this.alive ? this.throttle : 0; fp.afterburner = this.alive && this.afterburner;
    fp.speed = this.speed; fp.time = this.time;
    if (this.engineFX) this.engineFX.update(dt, fp);
    this._lightTime.value = this.time;
    // contrails: condensation from high-g wingtip vortices or the humid altitude band (free when not condensing)
    let strength = 0;
    if (this.alive) {
      const alt = this.position.y, F = FLIGHT;
      const gPart = smoothstep(F.CONTRAIL_G, F.CONTRAIL_G + 2.5, Math.abs(this.gLoad));
      const hum = smoothstep(F.CONTRAIL_ALT_MIN, F.CONTRAIL_ALT_MIN + 300, alt) * (1 - smoothstep(F.CONTRAIL_ALT_MAX - 300, F.CONTRAIL_ALT_MAX, alt));
      strength = clamp(gPart + hum * 0.75, 0, 1) * smoothstep(70, 130, this.speed);
    }
    // wing vapor fades in with hard pulls at speed
    const vT = this.alive ? smoothstep(4.6, 7.6, this.gLoad) * smoothstep(110, 190, this.speed) : 0;
    if (dt > 0) this._vaporS += (vT - this._vaporS) * (1 - Math.exp(-dt / (vT > this._vaporS ? 0.12 : 0.35)));
    const vOn = this._vaporS > 0.01;
    this.vapor.visible = vOn;
    if (vOn) { const vu = this.vapor.material.uniforms; vu.uStrength.value = this._vaporS; vu.uTime.value = this.time % 1000; }
    if (dt > 0 && (strength > 0.01 || this.contrails.active)) {
      this.localToWorld(this._local.tipL, this._tipL); this.localToWorld(this._local.tipR, this._tipR);
      this.contrails.update(this.time, dt, this._tipL, this._tipR, strength);
    }
  }
}
