import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
// PROJECT WINGNUT — js/airframes.js
// 1) The shared mesh-part toolkit (Part, loftRings, autoSmooth, paint kinds PK / PK_CLASS, control-surface ids), used by
//    the detailed F-22 in js/aircraft.js and by the airframes below.
// 2) Low-fidelity procedural airframes for every AI aircraft family (MiG-21 delta, Viggen, Phantom, F-16, F-15, Super
//    Hornet, Harrier, Tomcat, MiG-31, MiG-29, Su-27 family, Su-25, the original Orrery Q04/Q10/Q11/Q12, 737 AEW, C-17,
//    B-52, recon drone, floatplane, attack helicopter, cruise missile). They are built for silhouette reading at 2-5 km
//    (planform, tail count and layout, canards, intakes, engine count), not close-up detail: about 100-300 triangles
//    (fighters; ~300-500 for the big ones) each. Same frame and 0.8 scale convention as the F-22: nose -Z, up +Y, right wing +X, origin near the
//    center of mass, real dimensions x 0.8 (the cruise missile is drawn a little larger than life so it stays visible).
// Geometry (position / normal / aSurf / index) is built once per family and cached; js/aircraft.js adds the per-scheme
// vertex colors (acquireScheme) and renders it with the same hull material as the F-22 (one GL program, one draw call).
// The helicopter's rotors and the floatplane's propeller are static translucent halo discs: one extra mesh per
// aircraft with a cached geometry per family and ONE material shared by every aircraft (getHaloMaterial).
// No per-frame work here.
const DEG = Math.PI / 180;

// =============================================================================================
// Mesh-part toolkit. A Part collects positions + per-vertex paint kind + control-surface id + triangles.
// Normals come from autoSmooth() (hard crease above the part's angle threshold, smooth below), and all
// parts are finally concatenated into ONE indexed BufferGeometry.

// Paint kinds (resolved to colors per color scheme) and their material class, which the hull shader maps
// to roughness/metalness: 0 = satin paint (material defaults), 1 = metal, 2 = matte dark, 3 = glossy.
export const PK = { CAMO: 0, EDGE: 1, ACCENT: 2, METAL: 3, DARK: 4, COCKPIT: 5, HELMET: 6, SEAT: 7, NOZZLE_IN: 8, LIP: 9, SLOT: 10, PANEL: 11, GLASS: 12 };
export const PK_CLASS = [0, 0, 0, 1, 2, 2, 3, 2, 2, 0, 2, 0, 3];

// Control-surface ids (0 = rigid). Uniform slot = id - 1.
export const SID = { AIL_L: 1, AIL_R: 2, FLAP_L: 3, FLAP_R: 4, STAB_L: 5, STAB_R: 6, RUD_L: 7, RUD_R: 8 };
export const SID_MIRROR = [0, 2, 1, 4, 3, 6, 5, 8, 7];
export const N_SURF = 8;

export class Part {
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
export function loftRings(part, rings, kindFn, sid = 0, closed = true) {
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
export function capStart(part, base, M) { for (let k = 1; k < M - 1; k++) part.tri(base, base + k + 1, base + k); }
export function capEnd(part, base, M) { for (let k = 1; k < M - 1; k++) part.tri(base, base + k, base + k + 1); }

/** Splits vertices along creases (adjacent face normals > threshold apart) and computes area-weighted normals. */
export function autoSmooth(part) {
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
export function curve(pts) {
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
export function partFromGeometry(geom, kind, smoothDeg = 30, sid = 0) {
  const part = new Part(smoothDeg), pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) part.v(pos.getX(i), pos.getY(i), pos.getZ(i), kind, sid);
  if (geom.index) { const a = geom.index.array; for (let i = 0; i < a.length; i++) part.I.push(a[i]); }
  else for (let i = 0; i < pos.count; i++) part.I.push(i);
  geom.dispose();
  return part;
}

// =============================================================================================
// Airframe builder helpers. Stations / sections are plain arrays (meters, model frame).

/** Cross-section point count actually built: about half the nominal `seg` (12 -> 6, 10 -> 6, 8 -> 4), always even so the
 *  section stays left/right symmetric. Silhouette over roundness: hex fuselages, diamond-section small bodies. */
const lowSeg = (seg) => Math.max(4, 2 * Math.round(seg / 4));

/** Drops interior stations that a straight line between their neighbours already matches within STATION_TOL m (or a
 *  fifth of the section's size if smaller; width, top, bottom and x), greedily, keeping the ends: fewer rings, same
 *  side and top profiles to the eye. */
const STATION_TOL = 0.08;
function thinStations(st) {
  const s = st.slice();
  for (let i = 1; i < s.length - 1;) {
    const a = s[i - 1], b = s[i], c = s[i + 1], t = (b[0] - a[0]) / (c[0] - a[0]);
    const tol = Math.min(STATION_TOL, 0.2 * Math.max(b[1], (b[2] - b[3]) / 2));   // (relative for slim bodies: rails, pods)
    let ok = true;
    for (let j = 1; j < 5 && ok; j++) { const av = a[j] ?? 0, cv = c[j] ?? 0, bv = b[j] ?? 0; if (Math.abs(av + (cv - av) * t - bv) > tol) ok = false; }
    if (ok) s.splice(i, 1); else i++;
  }
  return s;
}

/**
 * Lofted body along Z. st = [[z, halfWidth, topY, bottomY, x?], ...] front to rear; the cross-section is a superellipse
 * (o.n: 2 = ellipse; >= 3 = a plain rectangle) of about half of o.seg points (lowSeg). o.front / o.rear = { kind } add an intake /
 * nozzle: a lip ring of `kind`, capped flat (the old recess fields s, d, inner are ignored). o.kindFn(kind, x, y, z) may repaint
 * vertices. o.mirror adds the x-mirrored copy.
 */
function body(parts, st, o = {}) {
  st = thinStations(st);
  const box = (o.n || 2) >= 3, seg = box ? 4 : lowSeg(o.seg || 12), e = 2 / (o.n || 2), kind = o.kind ?? PK.CAMO;
  const ring = (s, k = 1, dz = 0) => {
    const z = s[0], w = s[1] * k, yc = (s[2] + s[3]) / 2, h = (s[2] - s[3]) / 2 * k, x0 = s[4] ?? o.x ?? 0, r = [];
    if (box) { for (const [a, b] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) r.push([x0 + a * w, yc + b * h, z + dz]); return r; }   // boxy (n >= 3): a plain rectangle
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      r.push([x0 + w * Math.sign(c) * Math.pow(Math.abs(c), e), yc + h * Math.sign(sn) * Math.pow(Math.abs(sn), e), z + dz]);
    }
    return r;
  };
  const rings = [], kinds = [], last = st[st.length - 1];
  // intake / nozzle: a lip ring in its paint, capped flat (no recessed inner ring: invisible at silhouette range)
  if (o.front) { rings.push(ring(st[0])); kinds.push(o.front.kind); }
  for (const s of st) { rings.push(ring(s)); kinds.push(kind); }
  if (o.rear) { rings.push(ring(last)); kinds.push(o.rear.kind); }
  const p = new Part(o.smooth ?? 65);   // (hex sections: smooth across the 60 deg facets, crease the boxy 90s)
  const base = loftRings(p, rings, (i, k, x, y, z) => (o.kindFn ? o.kindFn(kinds[i], x, y, z) : kinds[i]), o.sid || 0);
  const first = o.front ? 1 : st[0][1] > 1e-4, lastOpen = o.rear ? 1 : last[1] > 1e-4;
  if (first) capStart(p, base, seg);
  if (lastOpen) capEnd(p, base + (rings.length - 1) * seg, seg);
  p.orient(true);
  parts.push(p);
  if (o.mirror) parts.push(p.mirrored());
  return p;
}

/** Thin slab (wing, tail, fin, pylon, blade): sections [x, y, zLE, chord, t/c] along the span, chord along +Z, thickness
 *  along o.n (default +Y). 4-point diamond section. o.accent = section index from which the slab is painted ACCENT. */
function wing(parts, secs, o = {}) {
  const n = o.n || [0, 1, 0], kind = o.kind ?? PK.CAMO;
  const strip = (ss, kd) => {
    const p = new Part(o.smooth ?? 30), rings = ss.map(([x, y, z, c, tc]) => {
      const t = 0.5 * tc * c, zm = z + 0.4 * c;
      return [[x, y, z], [x + n[0] * t, y + n[1] * t, zm + n[2] * t], [x, y, z + c]];   // flat bottom, cambered top
    });
    const base = loftRings(p, rings, (i, k) => (k === 0 && o.edge !== false && kd === PK.CAMO ? PK.EDGE : kd), o.sid || 0);
    capStart(p, base, 3); capEnd(p, base + (rings.length - 1) * 3, 3);
    p.orient(true);
    parts.push(p);
    if (o.mirror !== false && ss.some((q) => Math.abs(q[0]) > 1e-4)) parts.push(p.mirrored());   // (centerline fins: once)
  };
  if (o.accent != null && o.accent > 0 && o.accent < secs.length) { strip(secs.slice(0, o.accent + 1), kind); strip(secs.slice(o.accent), PK.ACCENT); }
  else strip(secs, o.accent === 0 ? PK.ACCENT : kind);
}
const lerpSec = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
/** Fin sections: root LE (x, y, z) chord c, `span` m long canted `cant` deg outboard (top toward +x), tip LE z / chord. */
function finSecs(x, y, z, c, span, cant, zt, ct, tc = 0.05) {
  const s = Math.sin(cant * DEG), k = Math.cos(cant * DEG);
  return { secs: [[x, y, z, c, tc], [x + span * s, y + span * k, zt, ct, tc * 0.8]], n: [k, -s, 0] };
}
/** A fin with an accent band over its top `band` fraction (0 = plain, 1 = whole fin). */
function fin(parts, f, band = 0.35, o = {}) {
  const [a, b] = f.secs;
  if (band >= 1) return wing(parts, f.secs, { ...o, n: f.n, accent: 0 });
  if (band <= 0) return wing(parts, f.secs, { ...o, n: f.n });
  wing(parts, [a, lerpSec(a, b, 1 - band), b], { ...o, n: f.n, accent: 1 });
}
/** Engine pod / nacelle along Z centered (x, y): dark recessed intake, metal nozzle. */
function pod(parts, x, y, z0, z1, r, o = {}) {
  const L = z1 - z0, rr = (k) => [y + r * k, y - r * k];
  return body(parts, [[z0, r * 0.88, ...rr(0.88), x], [z0 + L * 0.14, r, ...rr(1), x], [z1 - L * 0.3, r, ...rr(1), x], [z1, r * (o.aft ?? 0.82), ...rr(o.aft ?? 0.82), x]],
    { seg: o.seg || 10, front: o.closed ? null : { kind: PK.DARK, s: 0.7, d: 0.5 * r }, rear: o.noNozzle ? null : { kind: PK.METAL, s: 0.75, d: 0.4 * r }, mirror: o.mirror, kind: o.kind });
}
/** Canopy bubble (glossy dark glass) from stations [z, halfWidth, topY, bottomY]. */
const canopy = (parts, st, o = {}) => body(parts, st, { seg: 10, kind: PK.GLASS, smooth: 65, ...o });

const V = (x, y, z) => new THREE.Vector3(x, y, z);
/** Named empties: guns at (+-gx, gy, gz), wingtips at (+-tx, ty, tz), rails [(-ax,ay,az), (ax,..), (-bx,by,bz), (bx,..)]. */
function empties(g, t, ra, rb) {
  return {
    gunL: V(-g[0], g[1], g[2]), gunR: V(g[0], g[1], g[2]), tipL: V(-t[0], t[1], t[2]), tipR: V(t[0], t[1], t[2]),
    rails: [V(-ra[0], ra[1], ra[2]), V(ra[0], ra[1], ra[2]), V(-rb[0], rb[1], rb[2]), V(rb[0], rb[1], rb[2])],
  };
}
const noz = (x, y, z, hw, hh = hw) => ({ position: V(x, y, z), halfWidth: hw, halfHeight: hh });
const twin = (x, y, z, hw, hh = hw) => [noz(-x, y, z, hw, hh), noz(x, y, z, hw, hh)];

// Glass-roofed dorsal spine from the canopy to the tail, in body paint.
const spine = (parts, st) => body(parts, st, { seg: 10 });

// =============================================================================================
// Airframe definitions. Each returns { parts, local, nozzles, fx, enlarge, contrails, vapor, halos, camo }:
//   fx: 'full' (afterburner) | 'mil' (exhaust glow only, never the burner plume) | 'none' (no AfterburnerFX at all)
//   enlarge: fraction of the enemy larger-than-life enlargement applied (big aircraft are drawn closer to life size)
//   vapor: { hs: wing half-span, z: wing center } for the wing vapor shell, or null (no vapor)
//   halos: [{ c: [x, y, z], r, axis: 'x' | 'y' | 'z' }] translucent rotor / propeller discs
//   camo: false paints the body one flat tone (transports, bombers) instead of the soft two-tone patches
const FIGHTER = { fx: 'full', enlarge: 1, contrails: true, camo: true, halos: null };

function mig21() {
  const P = [];
  body(P, [[-5.75, 0.40, 0.40, -0.40], [-5.2, 0.47, 0.47, -0.47], [-3.5, 0.52, 0.55, -0.50], [-1, 0.55, 0.60, -0.52], [1.5, 0.55, 0.58, -0.52], [4, 0.48, 0.48, -0.48], [5.4, 0.40, 0.40, -0.40]],
    { seg: 12, front: { kind: PK.DARK, s: 0.8, d: 0.35 }, rear: { kind: PK.METAL } });
  body(P, [[-6.3, 0, 0, 0], [-5.75, 0.17, 0.17, -0.17], [-5.3, 0.24, 0.24, -0.24]], { seg: 8, kind: PK.EDGE });                  // shock cone
  canopy(P, [[-3.9, 0, 0.45, 0.30], [-3.3, 0.30, 0.80, 0.30], [-2.4, 0.30, 0.84, 0.30], [-1.9, 0.18, 0.74, 0.40]]);
  spine(P, [[-2.0, 0.20, 0.74, 0.30], [0, 0.20, 0.74, 0.30], [3, 0.12, 0.52, 0.30], [4.2, 0, 0.45, 0.35]]);
  wing(P, [[0.5, -0.10, -1.9, 4.6, 0.05], [2.85, -0.18, 1.72, 0.9, 0.04]]);                        // 57 deg delta
  wing(P, [[0.35, -0.05, 3.6, 1.6, 0.05], [1.6, -0.08, 4.6, 0.7, 0.04]]);
  fin(P, finSecs(0, 0.45, 1.9, 3.1, 1.95, 0, 4.3, 1.1));
  return { ...FIGHTER, parts: P, nozzles: [noz(0, 0, 5.4, 0.34)], vapor: { hs: 2.85, z: 0.8 },
    local: empties([0.32, -0.45, -2.4], [2.85, -0.18, 2.2], [1.4, -0.32, 0.3], [2.1, -0.3, 0.9]) };
}

function viggen() {
  const P = [];
  body(P, [[-6.6, 0, 0, 0], [-5.8, 0.30, 0.30, -0.30], [-4.5, 0.48, 0.50, -0.45], [-3, 0.55, 0.60, -0.50], [0, 0.60, 0.62, -0.55], [3, 0.55, 0.55, -0.50], [5.6, 0.45, 0.45, -0.45], [6.3, 0.42, 0.42, -0.42]],
    { seg: 12, rear: { kind: PK.METAL } });
  body(P, [[-3.6, 0.28, 0.40, -0.35], [-3.0, 0.33, 0.42, -0.40], [1.0, 0.30, 0.35, -0.35], [2.2, 0.05, 0.10, -0.10]], { seg: 8, n: 3.5, x: 0.7, front: { kind: PK.DARK }, mirror: true });
  canopy(P, [[-4.3, 0, 0.45, 0.35], [-3.7, 0.30, 0.85, 0.35], [-2.6, 0.30, 0.88, 0.35], [-1.8, 0.18, 0.75, 0.40]]);
  spine(P, [[-1.9, 0.22, 0.76, 0.3], [2, 0.22, 0.72, 0.3], [5, 0.1, 0.5, 0.3]]);
  wing(P, [[0.65, 0.42, -2.6, 2.4, 0.05], [2.6, 0.42, -0.9, 1.0, 0.04]]);                          // canards (with flaps)
  wing(P, [[0.5, -0.15, -0.2, 6.2, 0.05], [2.1, -0.18, 2.3, 3.6, 0.045], [4.25, -0.22, 4.0, 1.7, 0.04]]);   // double delta
  fin(P, finSecs(0, 0.5, 1.4, 4.1, 2.5, 0, 4.6, 1.3));
  return { ...FIGHTER, parts: P, nozzles: [noz(0, 0, 6.3, 0.36)], vapor: { hs: 4.25, z: 2.6 },
    local: empties([0.5, -0.4, -2.0], [4.25, -0.22, 5.0], [1.4, -0.4, 2.0], [2.6, -0.35, 3.2]) };
}

function phantom() {
  const P = [];
  body(P, [[-7.7, 0, 0, 0], [-7.0, 0.30, 0.30, -0.25], [-5.5, 0.55, 0.55, -0.50], [-3.5, 0.60, 0.75, -0.55], [-1, 0.95, 0.75, -0.65], [2, 0.95, 0.65, -0.60], [4.5, 0.70, 0.62, -0.45], [6.2, 0.35, 0.62, 0.0], [7.6, 0.15, 0.55, 0.28]],
    { seg: 12, n: 2.5 });
  body(P, [[-4.0, 0.30, 0.45, -0.50], [-3.4, 0.36, 0.50, -0.56], [0.5, 0.36, 0.45, -0.50], [1.5, 0.1, 0.2, -0.3]], { seg: 8, n: 4, x: 0.85, front: { kind: PK.DARK }, mirror: true });
  pod(P, 0.5, -0.3, 1.5, 5.0, 0.42, { mirror: true, closed: true });
  canopy(P, [[-4.6, 0, 0.55, 0.45], [-4.0, 0.35, 0.98, 0.45], [-1.5, 0.35, 1.0, 0.45], [-0.5, 0.25, 0.85, 0.5]]);
  wing(P, [[0.9, -0.35, -2.3, 5.4, 0.05], [3.0, -0.35, -0.2, 3.0, 0.045], [4.7, 0.0, 1.5, 1.4, 0.04]]);   // outer panels 12 deg dihedral
  wing(P, [[0.2, 0.40, 5.4, 2.4, 0.05], [2.7, -0.65, 6.9, 1.0, 0.04]]);                             // 23 deg anhedral stabilator
  fin(P, finSecs(0, 0.6, 3.6, 3.8, 2.4, 0, 6.4, 1.4));
  return { ...FIGHTER, parts: P, nozzles: twin(0.5, -0.3, 5.0, 0.36), vapor: { hs: 4.7, z: 0.8 },
    local: empties([0.3, -0.6, -3.0], [4.7, 0.0, 2.2], [0.9, -0.85, -1.5], [0.9, -0.85, 1.0]) };
}

function f16() {
  const P = [];
  body(P, [[-6.2, 0, 0, 0], [-5.6, 0.25, 0.25, -0.20], [-4.4, 0.45, 0.45, -0.35], [-3, 0.55, 0.60, -0.45], [-1, 0.60, 0.55, -0.50], [2, 0.60, 0.50, -0.50], [4.5, 0.50, 0.45, -0.40], [5.6, 0.40, 0.40, -0.40]],
    { seg: 12, rear: { kind: PK.METAL } });
  body(P, [[-2.6, 0.45, -0.35, -0.95], [-2.0, 0.48, -0.35, -1.0], [1.0, 0.42, -0.30, -0.75], [2.5, 0.1, -0.30, -0.45]], { seg: 10, n: 3, front: { kind: PK.DARK } });   // chin intake
  canopy(P, [[-4.4, 0, 0.42, 0.30], [-3.8, 0.32, 0.85, 0.30], [-2.6, 0.33, 0.92, 0.30], [-1.7, 0.20, 0.75, 0.35]]);
  spine(P, [[-1.8, 0.25, 0.72, 0.2], [1.5, 0.30, 0.68, 0.2], [3, 0.2, 0.55, 0.2]]);
  wing(P, [[0.5, -0.02, -3.9, 2.8, 0.03], [1.0, -0.04, -1.6, 0.6, 0.03]], { edge: false });         // LERX
  wing(P, [[0.55, -0.05, -1.4, 3.9, 0.045], [3.8, -0.05, 1.33, 1.1, 0.04]]);
  body(P, [[-0.2, 0, -0.05, -0.05, 3.85], [0.2, 0.07, 0.02, -0.12, 3.85], [2.4, 0.07, 0.02, -0.12, 3.85], [2.7, 0, -0.05, -0.05, 3.85]], { seg: 6, mirror: true });   // tip rails
  wing(P, [[0.4, -0.10, 3.6, 2.0, 0.05], [2.5, -0.25, 4.9, 0.9, 0.04]]);
  fin(P, finSecs(0, 0.45, 2.1, 3.0, 2.35, 0, 4.4, 1.1));
  return { ...FIGHTER, parts: P, nozzles: [noz(0, 0, 5.6, 0.34)], vapor: { hs: 3.8, z: 0.8 },
    local: empties([0.45, 0.35, -2.6], [3.9, -0.05, 1.9], [2.2, -0.35, 0.6], [3.0, -0.3, 1.2]) };
}

function f15(canards = false) {
  const P = [];
  body(P, [[-7.7, 0, 0, 0], [-7.0, 0.30, 0.25, -0.25], [-5.5, 0.55, 0.50, -0.45], [-4, 0.60, 0.70, -0.50], [-2, 0.60, 0.60, -0.45], [1, 0.55, 0.45, -0.40], [4, 0.40, 0.35, -0.30], [5, 0.2, 0.2, -0.2]], { seg: 12 });
  body(P, [[-4.0, 0.45, 0.45, -0.75, 1.0], [-3.4, 0.50, 0.50, -0.80, 1.0], [2, 0.50, 0.45, -0.55, 0.85], [5.5, 0.46, 0.42, -0.46, 0.76], [6.3, 0.42, 0.38, -0.42, 0.75]],
    { seg: 10, n: 3.5, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  canopy(P, [[-5.0, 0, 0.60, 0.45], [-4.4, 0.35, 1.08, 0.45], [-3.0, 0.35, 1.12, 0.45], [-2.0, 0.25, 0.90, 0.5]]);
  spine(P, [[-2.1, 0.35, 0.82, 0.2], [1, 0.40, 0.62, 0.2], [3.5, 0.3, 0.45, 0.1]]);
  wing(P, [[1.3, 0.15, -1.9, 5.6, 0.045], [5.2, 0.12, 2.0, 1.6, 0.04]]);
  wing(P, [[1.2, -0.05, 4.6, 2.4, 0.05], [3.4, -0.05, 6.0, 1.0, 0.04]]);
  fin(P, finSecs(1.0, 0.45, 3.0, 3.0, 2.45, 2, 5.3, 1.2));
  if (canards) wing(P, [[1.35, 0.30, -2.7, 1.7, 0.05], [2.9, 0.30, -1.85, 0.8, 0.04]]);
  return { ...FIGHTER, parts: P, nozzles: twin(0.75, -0.02, 6.3, 0.36), vapor: { hs: 5.2, z: 1.0 },
    local: empties([1.4, 0.3, -1.8], [5.2, 0.12, 2.8], [0.9, -0.95, -2.0], [0.9, -0.85, 1.5]) };
}

function hornet() {
  const P = [];
  body(P, [[-7.3, 0, 0, 0], [-6.7, 0.30, 0.25, -0.25], [-5.2, 0.50, 0.50, -0.42], [-3.5, 0.55, 0.68, -0.48], [-1, 0.75, 0.60, -0.50], [2, 0.70, 0.50, -0.45], [4.5, 0.75, 0.40, -0.40], [6.3, 0.80, 0.35, -0.35]], { seg: 12, n: 3 });
  pod(P, 0.45, -0.05, 3.0, 6.9, 0.40, { mirror: true, closed: true });
  wing(P, [[0.5, 0, -4.6, 4.0, 0.03], [1.4, 0, -1.6, 1.2, 0.03]], { edge: false });                    // big LEX
  body(P, [[-2.3, 0.30, -0.05, -0.60], [-1.8, 0.35, -0.05, -0.65], [2.0, 0.30, -0.05, -0.50], [3.0, 0.1, -0.1, -0.3]], { seg: 8, n: 4, x: 0.85, front: { kind: PK.DARK }, mirror: true });
  canopy(P, [[-5.3, 0, 0.55, 0.45], [-4.7, 0.33, 0.98, 0.45], [-3.2, 0.35, 1.02, 0.45], [-2.2, 0.22, 0.82, 0.5]]);
  spine(P, [[-2.3, 0.3, 0.78, 0.2], [2, 0.3, 0.6, 0.2], [4, 0.2, 0.45, 0.2]]);
  wing(P, [[1.2, 0, -1.4, 4.4, 0.045], [5.45, 0, 0.86, 1.6, 0.04]]);
  wing(P, [[0.9, 0, 4.5, 2.5, 0.05], [3.2, 0, 5.9, 1.2, 0.04]]);
  fin(P, finSecs(0.85, 0.40, 1.9, 3.0, 2.45, 20, 4.0, 1.2));
  return { ...FIGHTER, parts: P, nozzles: twin(0.45, -0.05, 6.9, 0.34), vapor: { hs: 5.45, z: 1.0 },
    local: empties([0.2, 0.45, -6.2], [5.45, 0, 1.9], [2.4, -0.35, 0.6], [3.6, -0.3, 1.1]) };
}

function harrier() {
  const P = [];
  body(P, [[-5.6, 0, 0, 0], [-5.0, 0.25, 0.25, -0.20], [-3.8, 0.45, 0.50, -0.40], [-2.5, 0.60, 0.70, -0.60], [0, 0.75, 0.70, -0.70], [2, 0.60, 0.60, -0.55], [4, 0.35, 0.45, -0.25], [5.7, 0.15, 0.35, 0.05]], { seg: 12 });
  body(P, [[-2.6, 0.35, 0.60, -0.50], [-2.1, 0.42, 0.62, -0.60], [0.0, 0.45, 0.55, -0.60], [1.2, 0.1, 0.2, -0.2]], { seg: 10, n: 2.5, x: 0.72, front: { kind: PK.DARK }, mirror: true });
  for (const z of [-0.7, 0.9]) body(P, [[z, 0.24, -0.15, -0.63, 1.05], [z + 0.6, 0.26, -0.13, -0.65, 1.1], [z + 0.75, 0.22, -0.17, -0.61, 1.1]], { seg: 8, rear: { kind: PK.METAL, d: 0.1 }, mirror: true });   // four swivel nozzles
  canopy(P, [[-3.9, 0, 0.55, 0.45], [-3.3, 0.33, 1.05, 0.45], [-2.2, 0.33, 1.10, 0.45], [-1.4, 0.2, 0.9, 0.5]]);
  spine(P, [[-1.5, 0.3, 0.85, 0.3], [1.5, 0.35, 0.75, 0.3], [3.5, 0.2, 0.55, 0.3]]);
  wing(P, [[0.55, 0.62, -1.0, 3.4, 0.05], [3.7, -0.05, 1.1, 1.1, 0.04]]);                             // shoulder wing, 12 deg anhedral
  wing(P, [[0.25, 0.30, 3.8, 1.6, 0.05], [1.9, -0.05, 4.8, 0.7, 0.04]]);
  fin(P, finSecs(0, 0.55, 2.6, 2.4, 1.65, 0, 4.1, 1.0));
  return { ...FIGHTER, fx: 'mil', parts: P, nozzles: twin(1.1, -0.39, 1.65, 0.2), vapor: { hs: 3.7, z: 0.5 },
    local: empties([0.35, -0.75, -1.6], [3.7, -0.05, 1.7], [1.8, 0.1, 0.0], [2.8, -0.05, 0.6]) };
}

function tomcat() {
  const P = [];
  body(P, [[-7.65, 0, 0, 0], [-7.0, 0.30, 0.25, -0.25], [-5.5, 0.50, 0.50, -0.45], [-4, 0.55, 0.75, -0.50], [-2, 0.60, 0.72, -0.50], [0, 0.5, 0.6, -0.4], [2, 0.3, 0.4, -0.3]], { seg: 12 });
  body(P, [[-3.5, 0.6, 0.3, -0.2], [-2, 1.6, 0.35, -0.25], [1, 2.0, 0.35, -0.25], [4, 1.9, 0.30, -0.20], [6.2, 1.4, 0.2, -0.1]], { seg: 12, n: 3 });   // pancake
  body(P, [[-3.6, 0.45, 0.45, -0.75, 1.4], [-3.0, 0.50, 0.45, -0.75, 1.4], [2, 0.50, 0.40, -0.60, 1.4], [5.8, 0.45, 0.38, -0.45, 1.4], [6.8, 0.40, 0.36, -0.40, 1.4]],
    { seg: 10, n: 3, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  canopy(P, [[-5.0, 0, 0.65, 0.5], [-4.4, 0.35, 1.08, 0.5], [-2.0, 0.35, 1.10, 0.5], [-1.0, 0.25, 0.9, 0.55]]);
  wing(P, [[1.5, 0.1, -3.4, 4.4, 0.04], [2.8, 0.1, -0.8, 1.8, 0.04]], { edge: false });                // glove
  wing(P, [[2.6, 0.12, -1.0, 2.8, 0.05], [6.3, 0.1, 1.6, 1.3, 0.04]]);                                  // swept outer panel
  wing(P, [[1.4, -0.05, 4.6, 2.4, 0.05], [3.9, -0.05, 6.4, 1.0, 0.04]]);
  fin(P, finSecs(1.25, 0.45, 2.6, 3.2, 2.45, 5, 5.3, 1.3));
  return { ...FIGHTER, parts: P, nozzles: twin(1.4, -0.05, 6.8, 0.34), vapor: { hs: 6.3, z: 0.6 },
    local: empties([0.4, -0.4, -4.0], [6.3, 0.1, 2.5], [0.5, -0.5, -1.0], [0.5, -0.5, 2.0]) };
}

function mig31() {
  const P = [];
  body(P, [[-9.1, 0, 0, 0], [-8.3, 0.35, 0.30, -0.30], [-6.5, 0.60, 0.60, -0.50], [-4.5, 0.65, 0.85, -0.55], [-2, 0.60, 0.70, -0.50], [3, 0.50, 0.50, -0.40], [6, 0.40, 0.40, -0.30], [7, 0.2, 0.25, -0.2]], { seg: 12 });
  body(P, [[-4.6, 0.55, 0.55, -0.75, 1.15], [-4.0, 0.60, 0.60, -0.80, 1.15], [3, 0.60, 0.55, -0.65, 1.0], [7.8, 0.55, 0.50, -0.55, 0.85], [9.0, 0.50, 0.45, -0.50, 0.85]],
    { seg: 10, n: 4, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  canopy(P, [[-6.4, 0, 0.6, 0.5], [-5.8, 0.35, 1.05, 0.5], [-3.6, 0.35, 1.08, 0.5], [-2.8, 0.25, 0.9, 0.55]]);
  spine(P, [[-2.9, 0.35, 0.85, 0.2], [2, 0.4, 0.7, 0.2], [6, 0.3, 0.5, 0.2]]);
  wing(P, [[1.6, 0.45, -1.4, 5.2, 0.045], [5.4, 0.40, 1.9, 1.9, 0.04]]);
  wing(P, [[1.4, 0, 6.3, 2.4, 0.05], [3.9, 0, 7.9, 1.0, 0.04]]);
  fin(P, finSecs(1.1, 0.55, 4.0, 3.6, 2.7, 6, 7.0, 1.4));
  return { ...FIGHTER, parts: P, nozzles: twin(0.85, -0.02, 9.0, 0.4), vapor: { hs: 5.4, z: 1.6 },
    local: empties([1.5, -0.4, -2.0], [5.4, 0.4, 2.8], [0.6, -0.65, -1.5], [0.6, -0.65, 2.5]) };
}

function mig29() {
  const P = [];
  body(P, [[-6.9, 0, 0, 0], [-6.3, 0.28, 0.25, -0.22], [-5, 0.45, 0.45, -0.38], [-3.5, 0.50, 0.65, -0.42], [-1.5, 0.55, 0.60, -0.40], [1.5, 0.50, 0.45, -0.30], [4, 0.35, 0.35, -0.20], [5.2, 0.15, 0.2, -0.1]], { seg: 12 });
  body(P, [[-2.2, 0.40, -0.05, -0.90, 1.35], [-1.6, 0.45, 0.0, -0.90, 1.35], [3.0, 0.45, 0.20, -0.55, 1.2], [5.8, 0.42, 0.30, -0.42, 1.05], [6.8, 0.38, 0.28, -0.38, 1.0]],
    { seg: 10, n: 3, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  wing(P, [[0.4, 0.05, -4.8, 3.8, 0.03], [1.6, 0.05, -1.4, 1.0, 0.03]], { edge: false });             // LERX
  canopy(P, [[-4.9, 0, 0.5, 0.4], [-4.3, 0.32, 0.95, 0.4], [-3.0, 0.32, 0.98, 0.4], [-2.0, 0.2, 0.8, 0.45]]);
  spine(P, [[-2.1, 0.28, 0.75, 0.2], [1.5, 0.35, 0.55, 0.2], [4, 0.2, 0.4, 0.1]]);
  wing(P, [[1.6, 0.05, -1.0, 3.9, 0.045], [4.55, 0.05, 1.65, 1.3, 0.04]]);
  wing(P, [[1.3, 0, 4.6, 2.2, 0.05], [3.4, 0, 5.9, 0.9, 0.04]]);
  fin(P, finSecs(1.25, 0.3, 2.6, 2.8, 2.4, 6, 4.6, 1.1));
  return { ...FIGHTER, parts: P, nozzles: twin(1.0, -0.05, 6.8, 0.33), vapor: { hs: 4.55, z: 0.8 },
    local: empties([0.6, 0.15, -2.6], [4.55, 0.05, 2.4], [2.4, -0.25, 0.4], [3.4, -0.2, 1.0]) };
}

function su27(canards = false, twoSeat = false) {
  const P = [];
  body(P, [[-8.75, 0, 0, 0], [-8.0, 0.30, 0.28, -0.25], [-6.2, 0.55, 0.55, -0.45], [-4.5, 0.60, 0.78, -0.50], [-2, 0.65, 0.70, -0.45], [1.5, 0.60, 0.50, -0.35], [4.5, 0.40, 0.40, -0.20], [6.5, 0.35, 0.35, -0.15], [8.6, 0.22, 0.25, -0.05]], { seg: 12 });   // tail stinger
  body(P, [[-3.2, 0.45, -0.05, -1.0, 1.4], [-2.6, 0.50, 0.0, -1.0, 1.4], [3, 0.50, 0.15, -0.60, 1.25], [6.8, 0.45, 0.30, -0.45, 1.1], [7.6, 0.40, 0.28, -0.40, 1.08]],
    { seg: 10, n: 3, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  wing(P, [[0.5, 0.05, -5.6, 4.6, 0.03], [1.7, 0.05, -1.8, 1.2, 0.03]], { edge: false });              // ogival LERX
  if (twoSeat) canopy(P, [[-6.0, 0, 0.6, 0.48], [-5.4, 0.35, 1.08, 0.48], [-3.0, 0.36, 1.14, 0.48], [-2.0, 0.25, 0.92, 0.52]]);
  else canopy(P, [[-6.0, 0, 0.6, 0.48], [-5.4, 0.35, 1.10, 0.48], [-3.9, 0.35, 1.14, 0.48], [-2.8, 0.25, 0.92, 0.52]]);
  spine(P, [[twoSeat ? -2.1 : -2.9, 0.35, 0.88, 0.2], [1.5, 0.45, 0.6, 0.2], [5, 0.3, 0.42, 0.1]]);
  wing(P, [[1.7, 0.05, -1.4, 4.6, 0.045], [5.9, 0.05, 2.4, 1.5, 0.04]]);
  body(P, [[1.6, 0, 0, 0, 5.95], [2.0, 0.07, 0.07, -0.07, 5.95], [4.2, 0.07, 0.07, -0.07, 5.95], [4.5, 0, 0, 0, 5.95]], { seg: 6, mirror: true });   // tip rails
  wing(P, [[1.7, -0.05, 5.8, 2.6, 0.05], [4.1, -0.05, 7.3, 1.1, 0.04]]);
  fin(P, finSecs(1.75, 0.25, 3.6, 3.2, 3.05, 2, 6.1, 1.3));
  if (canards) wing(P, [[0.6, 0.30, -4.7, 1.8, 0.05], [2.4, 0.30, -3.5, 0.7, 0.04]]);
  return { ...FIGHTER, parts: P, nozzles: twin(1.08, -0.06, 7.6, 0.36), vapor: { hs: 5.9, z: 1.2 },
    local: empties([1.1, 0.3, -2.5], [5.95, 0.05, 3.2], [0, -0.75, -1.0], [0, -0.75, 2.0]) };
}

function su25() {
  const P = [];
  body(P, [[-6.2, 0, 0, 0], [-5.7, 0.25, 0.20, -0.25], [-4.5, 0.50, 0.45, -0.50], [-3, 0.60, 0.75, -0.60], [0, 0.60, 0.60, -0.60], [3, 0.45, 0.45, -0.40], [5.5, 0.25, 0.35, -0.10], [6.2, 0.12, 0.30, 0.05]], { seg: 12 });
  pod(P, 0.95, -0.05, -2.2, 4.0, 0.48, { mirror: true });
  canopy(P, [[-4.3, 0, 0.55, 0.45], [-3.8, 0.32, 0.95, 0.45], [-2.9, 0.32, 0.98, 0.45], [-2.2, 0.2, 0.8, 0.5]]);
  spine(P, [[-2.3, 0.3, 0.78, 0.2], [2, 0.3, 0.6, 0.2], [4.5, 0.15, 0.42, 0.2]]);
  wing(P, [[1.3, 0.30, -0.8, 2.9, 0.06], [5.75, 0.10, 0.8, 1.3, 0.05]]);                              // 20 deg shoulder wing
  body(P, [[0.3, 0, 0.1, 0.1, 5.8], [0.7, 0.13, 0.23, -0.03, 5.8], [2.2, 0.13, 0.23, -0.03, 5.8], [2.5, 0, 0.1, 0.1, 5.8]], { seg: 6, mirror: true });   // wingtip airbrake pods
  wing(P, [[0.3, 0.55, 4.2, 1.6, 0.05], [2.3, 0.85, 4.9, 0.9, 0.04]]);
  fin(P, finSecs(0, 0.4, 3.0, 2.6, 2.2, 0, 4.8, 1.2));
  return { ...FIGHTER, fx: 'mil', parts: P, nozzles: twin(0.95, -0.05, 4.0, 0.3), vapor: { hs: 5.75, z: 0.5 },
    local: empties([0.3, -0.6, -4.0], [5.75, 0.1, 1.6], [2.6, 0.0, 0.3], [3.8, 0.0, 0.8]) };
}

// ---- Orrery Works originals ----
function q11() {   // stealth air-dominance: chined diamond-wing body, steep butterfly V-tail, ventral intakes, flat nozzles
  const P = [];
  body(P, [[-8, 0, 0, 0], [-7, 0.45, 0.22, -0.22], [-5, 0.80, 0.55, -0.35], [-3, 1.0, 0.70, -0.40], [0, 1.25, 0.55, -0.45], [3, 1.30, 0.45, -0.40], [6, 1.1, 0.35, -0.30], [7.0, 0.9, 0.30, -0.20]], { seg: 12, n: 3.2 });
  body(P, [[-3.2, 0.42, -0.2, -0.85], [-2.6, 0.45, -0.2, -0.9], [2, 0.40, -0.2, -0.6], [4, 0.1, -0.25, -0.35]], { seg: 8, n: 5, x: 0.65, front: { kind: PK.DARK }, mirror: true });
  body(P, [[5.0, 0.45, 0.22, -0.22, 0.55], [7.5, 0.42, 0.18, -0.18, 0.55]], { seg: 8, n: 5, rear: { kind: PK.METAL, d: 0.25 }, mirror: true });
  canopy(P, [[-5.6, 0, 0.5, 0.4], [-5.0, 0.35, 0.9, 0.4], [-3.6, 0.35, 0.92, 0.4], [-2.6, 0.22, 0.75, 0.45]]);
  wing(P, [[1.1, 0, -2.2, 7.8, 0.035], [6.0, 0, 3.24, 1.3, 0.03]]);
  fin(P, finSecs(0.9, 0.35, 3.6, 3.0, 3.0, 50, 5.6, 1.2), 0.4);
  return { ...FIGHTER, parts: P, nozzles: twin(0.55, 0, 7.5, 0.34, 0.14), vapor: { hs: 6.0, z: 1.6 },
    local: empties([1.2, 0.2, -2.5], [6.0, 0, 4.0], [0.5, -0.9, -0.5], [0.5, -0.9, 1.5]) };
}

function q10() {   // closed-canopy tailless lambda wing: dorsal intake hump instead of a cockpit, small canards, ventral fins
  const P = [];
  body(P, [[-7.5, 0, 0, 0], [-6.5, 0.40, 0.25, -0.20], [-4.5, 0.70, 0.50, -0.30], [-2, 0.90, 0.70, -0.35], [1, 1.0, 0.60, -0.35], [4, 0.9, 0.45, -0.30], [6.5, 0.7, 0.30, -0.20], [7.2, 0.55, 0.22, -0.15]], { seg: 12, n: 3 });
  body(P, [[-2.2, 0.60, 0.95, -0.2], [-1.5, 0.62, 1.0, -0.2], [3.5, 0.5, 0.7, -0.1], [5, 0.2, 0.4, 0]], { seg: 10, n: 3, front: { kind: PK.DARK, s: 0.6 } });
  pod(P, 0.6, 0, 5.0, 7.6, 0.4, { mirror: true, closed: true });
  wing(P, [[0.9, 0, -3.0, 9.5, 0.035], [3.5, 0, 0.72, 3.5, 0.035], [6.5, 0, 3.4, 1.8, 0.03]]);       // lambda: sawtooth trailing edge
  wing(P, [[0.8, 0.15, -4.6, 1.6, 0.05], [2.4, 0.15, -3.6, 0.7, 0.04]], { accent: 0 });
  fin(P, finSecs(1.8, -0.2, 4.0, 2.2, 1.2, 150, 5.4, 0.9), 1);                                        // ventral fins, canted out
  return { ...FIGHTER, parts: P, nozzles: twin(0.6, 0, 7.6, 0.32), vapor: { hs: 6.5, z: 1.8 },
    local: empties([1.0, 0.1, -3.0], [6.5, 0, 4.3], [0.5, -0.45, -0.5], [0.5, -0.45, 2.0]) };
}

function q04() {   // gun duelist: forward-swept wing, canards, one big fin, single engine
  const P = [];
  body(P, [[-7, 0, 0, 0], [-6.2, 0.32, 0.30, -0.25], [-4.5, 0.55, 0.55, -0.42], [-3, 0.62, 0.75, -0.48], [0, 0.68, 0.62, -0.50], [3, 0.62, 0.55, -0.45], [5.5, 0.50, 0.48, -0.45], [6.6, 0.45, 0.42, -0.42]],
    { seg: 12, rear: { kind: PK.METAL } });
  body(P, [[-3.2, 0.30, 0.35, -0.45], [-2.7, 0.34, 0.38, -0.50], [1.5, 0.30, 0.30, -0.40], [2.6, 0.08, 0.1, -0.1]], { seg: 8, n: 3.5, x: 0.8, front: { kind: PK.DARK }, mirror: true });
  canopy(P, [[-4.6, 0, 0.55, 0.45], [-4.0, 0.33, 0.98, 0.45], [-2.8, 0.33, 1.02, 0.45], [-2.0, 0.2, 0.82, 0.5]]);
  spine(P, [[-2.1, 0.3, 0.8, 0.2], [2, 0.35, 0.68, 0.2], [4.5, 0.25, 0.55, 0.2]]);
  wing(P, [[0.7, 0.25, -4.0, 1.8, 0.05], [2.5, 0.25, -3.1, 0.8, 0.04]]);
  wing(P, [[0.7, 0, 1.2, 4.2, 0.045], [5.0, 0, -0.8, 1.4, 0.04]]);                                      // forward-swept 25 deg
  fin(P, finSecs(0, 0.5, 3.2, 3.0, 2.4, 0, 5.6, 1.2), 0.4);
  fin(P, finSecs(0.5, -0.4, 4.0, 1.8, 0.8, 180 - 35, 5.0, 1.0), 0, {});                               // ventral strakes
  return { ...FIGHTER, parts: P, nozzles: [noz(0, 0, 6.6, 0.38)], vapor: { hs: 5.0, z: 1.0 },
    local: empties([0.55, 0.45, -3.4], [5.0, 0, 0.0], [1.8, -0.2, 1.0], [2.8, -0.2, 0.7]) };
}

function q12() {   // the top of the dial: big three-engined double delta, long canards, twin canted fins + ventral fins
  const P = [];
  body(P, [[-10.5, 0, 0, 0], [-9.5, 0.40, 0.32, -0.30], [-7.5, 0.70, 0.65, -0.50], [-5.5, 0.80, 0.90, -0.55], [-2, 1.0, 0.80, -0.55], [2, 1.3, 0.70, -0.55], [6, 1.4, 0.60, -0.50], [8.8, 1.3, 0.55, -0.50], [9.3, 1.2, 0.5, -0.45]], { seg: 12, n: 3 });
  for (const [x, y] of [[-0.85, 0], [0, 0.1], [0.85, 0]]) body(P, [[8.4, 0.42, y + 0.40, y - 0.40, x], [10.2, 0.40, y + 0.38, y - 0.38, x]], { seg: 10, rear: { kind: PK.METAL } });
  body(P, [[-4.8, 0.40, 0.45, -0.60], [-4.2, 0.45, 0.50, -0.65], [2, 0.45, 0.40, -0.55], [4, 0.1, 0.1, -0.2]], { seg: 8, n: 3.5, x: 1.15, front: { kind: PK.DARK }, mirror: true });
  canopy(P, [[-7.2, 0, 0.7, 0.55], [-6.6, 0.38, 1.2, 0.55], [-5.0, 0.38, 1.24, 0.55], [-3.8, 0.25, 1.0, 0.6]]);
  spine(P, [[-3.9, 0.35, 0.98, 0.3], [2, 0.5, 0.85, 0.3], [6, 0.4, 0.7, 0.3]]);
  wing(P, [[0.9, 0.30, -7.2, 2.6, 0.05], [3.4, 0.30, -5.4, 0.9, 0.04]], { accent: 0 });
  wing(P, [[1.2, 0, -3.5, 12.5, 0.035], [3.0, 0, -0.5, 9.0, 0.035], [7.5, 0, 5.7, 2.5, 0.03]]);
  fin(P, finSecs(1.5, 0.5, 5.0, 3.8, 3.4, 25, 8.0, 1.5), 0.45);
  fin(P, finSecs(1.3, -0.45, 6.0, 2.6, 1.6, 150, 7.6, 1.2), 1);
  return { ...FIGHTER, parts: P, nozzles: [noz(-0.85, 0, 10.2, 0.34), noz(0, 0.1, 10.2, 0.34), noz(0.85, 0, 10.2, 0.34)], vapor: { hs: 7.5, z: 3.0 },
    local: empties([1.3, 0.3, -4.0], [7.5, 0, 7.5], [1.0, -0.65, -1.0], [1.0, -0.65, 2.0]) };
}

// ---- support types ----
function aew737() {   // 737 AEW&C: low wing, two underwing turbofans, dorsal "top hat" radar beam
  const P = [];
  body(P, [[-13.4, 0, -0.1, -0.1], [-12.8, 0.8, 0.7, -0.8], [-11.6, 1.35, 1.35, -1.40], [-10, 1.5, 1.5, -1.5], [7, 1.5, 1.5, -1.5], [10, 1.2, 1.5, -0.8], [12.6, 0.45, 1.4, 0.6], [13.4, 0.15, 1.3, 1.0]], { seg: 14 });
  canopy(P, [[-12.7, 0, 0.75, 0.35], [-12.2, 0.85, 1.1, 0.2], [-11.5, 1.12, 1.38, 0.2], [-11.1, 1.0, 1.42, 0.5]], { seg: 10 });
  wing(P, [[1.3, -1.0, -3.5, 6.0, 0.12], [5.0, -0.6, -1.8, 4.0, 0.11], [13.7, 0.3, 2.2, 1.4, 0.10]]);
  pod(P, 4.9, -1.9, -4.8, -1.4, 0.82, { mirror: true, seg: 12 });
  wing(P, [[4.9, -1.2, -3.0, 2.6, 0.1], [4.9, -0.75, -2.4, 2.6, 0.1]], { n: [1, 0, 0], edge: false });
  wing(P, [[0.8, 0.6, 9.2, 3.2, 0.08], [5.7, 1.2, 12.2, 1.2, 0.07]]);
  fin(P, finSecs(0, 1.3, 7.8, 4.6, 5.1, 0, 12.2, 1.8, 0.08), 0.6);
  body(P, [[-1.6, 0.15, 3.65, 2.6], [-1.0, 0.22, 3.95, 2.45], [4.4, 0.22, 3.95, 2.45], [5.0, 0.15, 3.65, 2.6]], { seg: 8, n: 6, kind: PK.PANEL });   // radar beam
  for (const z of [-0.6, 3.2]) wing(P, [[0, 1.3, z, 1.4, 0.15], [0, 2.6, z + 0.2, 1.0, 0.15]], { n: [1, 0, 0], mirror: false, edge: false });
  return { fx: 'none', enlarge: 0.4, contrails: true, camo: false, halos: null, vapor: null, parts: P, nozzles: [],
    local: empties([0.3, -1.4, -10], [13.7, 0.3, 3.0], [0.6, -1.5, -2.0], [0.6, -1.5, 2.0]) };
}

function c17() {   // C-17: fat fuselage, high swept wing, four podded engines, T-tail
  const P = [];
  body(P, [[-21.2, 0, -0.6, -0.6], [-20.4, 1.3, 0.9, -1.5], [-19, 2.3, 2.0, -2.4], [-16.5, 2.75, 2.75, -2.75], [6, 2.75, 2.75, -2.75], [11, 2.3, 2.9, -1.2], [16, 1.2, 3.0, 1.0], [19.5, 0.5, 3.1, 2.3]], { seg: 14 });
  canopy(P, [[-20.7, 0, 0.9, 0.2], [-20.1, 1.35, 1.75, 0.1], [-19.4, 1.55, 2.3, 0.3], [-19.0, 1.4, 2.4, 0.6]], { seg: 10 });
  body(P, [[-6.5, 0, -1.9, -1.9], [-5.5, 0.9, -1.0, -2.9], [5, 0.9, -1.0, -2.9], [6.5, 0, -1.9, -1.9]], { seg: 8, n: 3, x: 2.4, mirror: true });   // gear sponsons
  wing(P, [[2.2, 2.6, -6.0, 9.0, 0.12], [8.0, 2.1, -3.3, 5.8, 0.11], [20.7, 1.0, 2.6, 2.4, 0.10]]);
  wing(P, [[20.7, 1.0, 2.6, 2.4, 0.08], [21.0, 3.2, 4.1, 1.2, 0.06]], { n: [1, 0, 0] });                    // winglets
  for (const [x, y, z] of [[7.2, 0.65, -7.4], [12.5, 0.2, -5.0]]) {
    pod(P, x, y, z, z + 5.0, 0.98, { mirror: true, seg: 12 });
    wing(P, [[x, y + 0.8, z + 1.2, 3.4, 0.1], [x, y + 1.6, z + 2.6, 3.0, 0.1]], { n: [1, 0, 0], edge: false });
  }
  fin(P, finSecs(0, 2.9, 12.3, 7.0, 6.6, 0, 17.0, 4.0, 0.09), 0.4);
  wing(P, [[0.3, 9.4, 16.8, 4.4, 0.08], [9.0, 9.4, 20.5, 1.8, 0.07]]);                                    // T-tail
  return { fx: 'none', enlarge: 0.25, contrails: true, camo: false, halos: null, vapor: null, parts: P, nozzles: [],
    local: empties([1.0, -2.0, -14], [20.9, 1.0, 4.2], [1.2, -2.6, -4.0], [1.2, -2.6, 4.0]) };
}

function b52() {   // B-52: long slab-sided fuselage, shoulder wing swept 35 deg, eight engines in four twin pods, tall fin
  const P = [];
  body(P, [[-19.4, 0, -0.3, -0.3], [-18.8, 0.8, 0.8, -1.1], [-17.5, 1.15, 1.5, -1.5], [-15, 1.2, 1.75, -1.6], [10, 1.15, 1.6, -1.5], [15, 0.9, 1.4, -0.8], [19, 0.5, 1.0, -0.1], [19.4, 0.35, 0.8, 0.1]], { seg: 12, n: 2.8 });
  canopy(P, [[-18.4, 0, 1.0, 0.5], [-17.9, 0.95, 1.55, 0.4], [-17.0, 1.05, 1.85, 0.4], [-16.6, 0.9, 1.85, 0.8]], { seg: 10 });
  wing(P, [[1.1, 1.4, -7.5, 10.0, 0.1], [10, 0.9, -1.27, 5.6, 0.09], [22.5, 0.15, 7.48, 2.4, 0.08]]);
  body(P, [[5.6, 0, 0.35, 0.35, 19.0], [6.4, 0.25, 0.6, 0.1, 19.0], [9.6, 0.25, 0.6, 0.1, 19.0], [10.6, 0, 0.35, 0.35, 19.0]], { seg: 8, mirror: true });   // outrigger tanks
  for (const x of [7.2, 14.5]) {
    const wy = 1.4 - (x - 1.1) * (1.25 / 21.4), wz = -7.5 + (x - 1.1) * 0.7, y = wy - 1.25;
    for (const dx of [-0.58, 0.58]) pod(P, x + dx, y, wz - 3.6, wz + 0.8, 0.55, { mirror: true, seg: 10 });
    wing(P, [[x, y + 0.3, wz - 2.4, 3.6, 0.12], [x, wy, wz - 1.4, 3.6, 0.12]], { n: [1, 0, 0], edge: false });
  }
  fin(P, finSecs(0, 1.4, 10.0, 9.0, 6.0, 0, 16.8, 2.8, 0.08), 1);                                          // red tail
  wing(P, [[0.8, 0.6, 14.0, 4.6, 0.08], [7.9, 0.6, 17.6, 1.8, 0.07]]);
  return { fx: 'none', enlarge: 0.25, contrails: true, camo: false, halos: null, vapor: null, parts: P, nozzles: [],
    local: empties([0.2, 0.6, 19.0], [22.5, 0.15, 8.7], [1.0, -1.7, -3.0], [1.0, -1.7, 3.0]) };
}

function drone() {   // recon drone: bulbous satcom nose, long straight wing, V-tail, dorsal engine
  const P = [];
  body(P, [[-5.5, 0, 0, 0], [-5.0, 0.45, 0.30, -0.40], [-3.5, 0.70, 0.75, -0.60], [-1, 0.70, 0.75, -0.55], [2, 0.55, 0.50, -0.45], [4.5, 0.30, 0.30, -0.25], [5.5, 0.15, 0.15, -0.1]], { seg: 12 });
  body(P, [[-0.6, 0.40, 1.05, 0.2], [0, 0.45, 1.12, 0.2], [3, 0.42, 1.05, 0.25], [4.5, 0.30, 0.90, 0.40]], { seg: 10, front: { kind: PK.DARK }, rear: { kind: PK.METAL } });
  wing(P, [[0.5, 0.30, -0.8, 1.6, 0.1], [12, 0.9, -0.4, 0.55, 0.08]]);
  fin(P, finSecs(0.25, 0.4, 3.6, 1.5, 2.6, 50, 4.6, 0.7, 0.07), 0.3);
  return { fx: 'mil', enlarge: 0.5, contrails: true, camo: false, halos: null, vapor: null, parts: P, nozzles: [noz(0, 0.65, 4.5, 0.22, 0.2)],
    local: empties([0.2, -0.6, -3], [12, 0.9, 0.0], [0.5, -0.7, -1.0], [0.5, -0.7, 1.0]) };
}

function floatplane() {   // fishery-patrol floatplane: prop (halo disc), long greenhouse canopy, low wing, twin floats
  const P = [];
  body(P, [[-4.1, 0.50, 0.45, -0.45], [-3.6, 0.55, 0.55, -0.50], [-2.0, 0.55, 0.75, -0.55], [0, 0.50, 0.70, -0.50], [2.5, 0.30, 0.45, -0.30], [4.4, 0.1, 0.35, 0.05]], { seg: 12 });
  body(P, [[-4.75, 0, 0, 0], [-4.45, 0.18, 0.18, -0.18], [-4.1, 0.24, 0.24, -0.24]], { seg: 8, kind: PK.ACCENT });   // spinner
  canopy(P, [[-2.2, 0, 0.6, 0.5], [-1.7, 0.40, 1.05, 0.5], [0, 0.38, 1.05, 0.5], [1, 0.15, 0.8, 0.55]]);
  wing(P, [[0.5, -0.35, -1.5, 1.9, 0.12], [5.0, -0.05, -1.2, 1.2, 0.1]]);
  body(P, [[-3.6, 0.05, -1.95, -2.1], [-3.0, 0.30, -1.85, -2.45], [-1, 0.35, -1.85, -2.6], [1.5, 0.30, -1.9, -2.45], [2.6, 0.05, -2.1, -2.2]], { seg: 10, x: 1.5, mirror: true });
  for (const z of [-1.6, 0.5]) wing(P, [[1.5, -1.9, z, 0.5, 0.15], [1.0, -0.35, z, 0.5, 0.15]], { n: [1, 0, 0], edge: false });
  wing(P, [[0.2, 0.30, 3.3, 1.0, 0.08], [1.9, 0.30, 3.6, 0.7, 0.07]]);
  fin(P, finSecs(0, 0.35, 2.8, 1.5, 1.35, 0, 3.8, 0.8, 0.08), 0.4);
  return { fx: 'none', enlarge: 1, contrails: true, camo: true, vapor: null, parts: P, nozzles: [], halos: [{ c: [0, 0, -4.5], r: 1.35, axis: 'z' }],
    local: empties([0.3, 0.55, -2.6], [5.0, -0.05, -0.6], [2.0, -0.4, -0.8], [3.0, -0.3, -0.7]) };
}

function helicopter() {   // attack helicopter: stepped tandem cockpits, stub wings with pods, top engines, rotor halo discs
  const P = [];
  body(P, [[-6.3, 0.1, -0.3, -0.5], [-5.8, 0.4, 0.1, -0.75], [-4.5, 0.6, 0.6, -0.9], [-2.5, 0.75, 1.0, -0.95], [0, 0.8, 1.0, -0.9], [1.5, 0.65, 0.8, -0.7], [3, 0.3, 0.45, -0.1], [7.0, 0.18, 0.38, 0.05]], { seg: 12 });
  canopy(P, [[-5.6, 0, 0.1, 0.0], [-5.1, 0.45, 0.6, 0.0], [-4.3, 0.5, 0.75, 0.0], [-4.0, 0.45, 0.7, 0.2]]);
  canopy(P, [[-4.1, 0, 0.6, 0.4], [-3.6, 0.5, 1.1, 0.4], [-2.8, 0.5, 1.2, 0.4], [-2.4, 0.4, 1.05, 0.6]]);
  body(P, [[-1.6, 0.35, 1.35, 0.55], [-1.2, 0.40, 1.40, 0.50], [1.6, 0.38, 1.35, 0.55], [2.2, 0.30, 1.25, 0.65]], { seg: 10, x: 0.75, front: { kind: PK.DARK }, rear: { kind: PK.METAL }, mirror: true });
  body(P, [[-0.9, 0.35, 1.55, 0.9], [-0.6, 0.3, 2.05, 0.9], [0.3, 0.3, 2.05, 0.9], [0.6, 0.35, 1.55, 0.9]], { seg: 8, n: 3 });   // mast fairing
  body(P, [[-0.5, 0, 2.05, 2.05], [-0.3, 0.45, 2.15, 1.95], [0.1, 0.45, 2.15, 1.95], [0.3, 0, 2.05, 2.05]], { seg: 8, kind: PK.DARK });   // hub
  wing(P, [[0.7, -0.1, -0.8, 1.4, 0.12], [2.6, -0.3, -0.6, 1.0, 0.1]]);
  pod(P, 2.2, -0.75, -1.4, 0.6, 0.26, { mirror: true, closed: true, noNozzle: true, aft: 1 });
  body(P, [[-5.4, 0.05, -0.85, -0.95], [-4.8, 0.15, -0.75, -1.1], [-4.4, 0.12, -0.8, -1.0]], { seg: 8, kind: PK.DARK });   // chin gun
  fin(P, finSecs(0, 0.3, 5.6, 1.6, 2.3, 0, 7.0, 1.0, 0.1), 0.35, { mirror: false });
  wing(P, [[0.1, 1.0, 5.9, 0.8, 0.08], [1.4, 1.0, 6.1, 0.6, 0.07]]);
  return { fx: 'none', enlarge: 1, contrails: false, camo: true, vapor: null, parts: P, nozzles: [],
    halos: [{ c: [0, 2.12, -0.1], r: 6.9, axis: 'y' }, { c: [0.32, 2.0, 6.55], r: 1.5, axis: 'x' }],
    local: empties([0.12, -1.0, -5.2], [2.6, -0.3, 0.0], [2.2, -0.75, -1.4], [2.2, -0.75, -1.4]) };
}

function cruise() {   // cruise missile, drawn ~7 m long (a little larger than life): pop-out wings, cruciform tail, ventral scoop
  const P = [];
  body(P, [[-3.5, 0, 0, 0], [-3.2, 0.20, 0.20, -0.20], [-2.7, 0.32, 0.32, -0.32], [2.8, 0.32, 0.32, -0.32], [3.3, 0.22, 0.22, -0.22], [3.5, 0.13, 0.13, -0.13]],
    { seg: 10, kindFn: (k, x, y, z) => (z < -2.75 ? PK.ACCENT : k), rear: { kind: PK.METAL, d: 0.1 } });
  wing(P, [[0.25, -0.05, -0.3, 0.6, 0.06], [1.45, -0.05, 0.0, 0.38, 0.05]]);
  for (let i = 0; i < 4; i++) {
    const f = [];
    fin(f, finSecs(0, 0.28, 2.65, 0.65, 0.5, 0, 3.0, 0.38, 0.06), 0, { mirror: false });
    const m = new THREE.Matrix4().makeRotationZ((45 + 90 * i) * DEG);
    for (const p of f) P.push(p.applyMatrix4(m));
  }
  body(P, [[0.6, 0.15, -0.30, -0.45], [1.0, 0.18, -0.28, -0.50], [2.0, 0.15, -0.30, -0.40]], { seg: 8, front: { kind: PK.DARK } });
  return { fx: 'mil', enlarge: 1, contrails: true, camo: false, halos: null, vapor: null, parts: P, nozzles: [noz(0, 0, 3.5, 0.11)],
    local: empties([0, 0, -3.0], [1.45, -0.05, 0.2], [0, -0.3, 0], [0, -0.3, 0]) };
}

const DEFS = {
  mig21, viggen, phantom, f16, f15: () => f15(false), f15smtd: () => f15(true), hornet, harrier, tomcat, mig31, mig29,
  su27: () => su27(false, false), su30: () => su27(true, true), su37: () => su27(true, false), su25,
  q04, q10, q11, q12, aew737, c17, b52, drone, floatplane, helicopter, cruise,
};
/** Every family id (the F-22 is 'f22', built by js/aircraft.js). */
export const AIRFRAME_IDS = Object.keys(DEFS);
export const hasAirframe = (id) => Object.prototype.hasOwnProperty.call(DEFS, id);

// Aircraft type (js/missions.js AIRCRAFT_TYPES key) -> family. Named variants ('Q07 CHIME', 'NV-18E CUCKOO', 'Q09 TICK'...)
// fly their base type's airframe: a full name is looked up first, then its first word.
const TYPE_AIRFRAME = {
  'SLEET-21': 'mig21', 'GUST-37': 'viggen', 'NV-4': 'phantom', 'NV-16': 'f16', 'NV-15C': 'f15', 'NV-18E': 'hornet', 'EIDER-8B': 'harrier',
  'NV-14': 'tomcat', 'FALLWIND-31': 'mig31', 'FLURRY-29': 'mig29', 'SQUALL-27': 'su27', 'SQUALL-30': 'su30', 'HAILSTONE-25': 'su25',
  Q07: 'su37', Q09: 'f15smtd', Q10: 'q10', Q11: 'q11', Q04: 'q04', Q12: 'q12',
  'KD-480E': 'aew737', 'KD-17': 'c17', 'KD-52': 'b52', 'KD-12U': 'drone', 'SCAUP II': 'floatplane', SCAUP: 'floatplane', 'KD-28H': 'helicopter',
  BODKIN: 'cruise', THUNDERHEAD: 'cruise',
};
/** Airframe family for an aircraft type name ('f22' when unknown). `type.airframe`, if set, wins. */
export function airframeForType(name, type = null) {
  if (type && type.airframe && (type.airframe === 'f22' || hasAirframe(type.airframe))) return type.airframe;
  const n = String(name || '');
  return TYPE_AIRFRAME[n] || TYPE_AIRFRAME[n.split(' ')[0]] || (type && /missile/i.test(type.role || '') ? 'cruise' : 'f22');
}

// =============================================================================================
// Topology cache: one merged, auto-smoothed indexed geometry per family (attributes shared by every color scheme).
const _cache = new Map();
const HALO_RINGS = [[0.10, 0.0], [0.16, 0.10], [0.78, 0.16], [0.93, 0.34], [1.0, 0.0]];   // [radius fraction, alpha]
const HALO_SEG = 12;
function buildHalos(halos) {
  const pos = [], col = [], idx = [], NR = HALO_RINGS.length;
  for (const h of halos) {
    const base = pos.length / 3;
    for (const [f, a] of HALO_RINGS) for (let k = 0; k < HALO_SEG; k++) {
      const t = (k / HALO_SEG) * Math.PI * 2, u = Math.cos(t) * f * h.r, w = Math.sin(t) * f * h.r;
      const [cx, cy, cz] = h.c;
      if (h.axis === 'y') pos.push(cx + u, cy, cz + w); else if (h.axis === 'x') pos.push(cx, cy + u, cz + w); else pos.push(cx + u, cy + w, cz);
      col.push(0.045, 0.047, 0.05, a);
    }
    for (let i = 0; i < NR - 1; i++) for (let k = 0; k < HALO_SEG; k++) {
      const k2 = (k + 1) % HALO_SEG, a = base + i * HALO_SEG + k, b = base + i * HALO_SEG + k2, c = base + (i + 1) * HALO_SEG + k2, d = base + (i + 1) * HALO_SEG + k;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Cached topology of family `id`: { id, vertexCount, triangleCount, position, kind (paint kinds), positionAttr, normalAttr,
 * surfAttr (aSurf: surface id 0 + 16 x material class), indexAttr, sphere, box, surfTemplate (identity hinges), radius
 * (farthest point from the origin, rotor discs included), local (empties), nozzles, fx, enlarge, contrails, vapor, camo,
 * haloGeometry (or null), haloTriangles }.
 */
export function getAirframeTopology(id) {
  let t = _cache.get(id);
  if (t) return t;
  const d = DEFS[id]();
  let nv = 0, ni = 0;
  const sm = d.parts.map((p) => { const s = autoSmooth(p); nv += s.K.length; ni += s.I.length; return s; });
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), kind = new Uint8Array(nv), surf = new Uint8Array(nv);
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0, oi = 0;
  for (const s of sm) {
    position.set(s.P, ov * 3); normal.set(s.N, ov * 3);
    for (let i = 0; i < s.K.length; i++) { kind[ov + i] = s.K[i]; surf[ov + i] = s.S[i] + 16 * PK_CLASS[s.K[i]]; }
    for (let i = 0; i < s.I.length; i++) index[oi + i] = s.I[i] + ov;
    ov += s.K.length; oi += s.I.length;
  }
  const positionAttr = new THREE.BufferAttribute(position, 3);
  const tmp = new THREE.BufferGeometry(); tmp.setAttribute('position', positionAttr);
  tmp.computeBoundingSphere(); tmp.computeBoundingBox();
  let r2 = 0;
  for (let i = 0; i < position.length; i += 3) r2 = Math.max(r2, position[i] * position[i] + position[i + 1] * position[i + 1] + position[i + 2] * position[i + 2]);
  const haloGeometry = d.halos && d.halos.length ? buildHalos(d.halos) : null;
  if (d.halos) for (const h of d.halos) r2 = Math.max(r2, (Math.hypot(...h.c) + h.r) ** 2);
  const surfTemplate = new Float32Array(N_SURF * 8);
  for (let i = 0; i < N_SURF; i++) surfTemplate.set([0, 0, 0, 1, 1, 0, 0, 0], i * 8);
  t = {
    id, vertexCount: nv, triangleCount: ni / 3, position, kind,
    positionAttr, normalAttr: new THREE.BufferAttribute(normal, 3), surfAttr: new THREE.BufferAttribute(surf, 1), indexAttr: new THREE.BufferAttribute(index, 1),
    sphere: tmp.boundingSphere.clone(), box: tmp.boundingBox.clone(), surfTemplate, radius: Math.sqrt(r2),
    local: d.local, nozzles: d.nozzles || [], fx: d.fx || 'full', enlarge: d.enlarge ?? 1, contrails: d.contrails !== false,
    vapor: d.vapor || null, camo: d.camo !== false, haloGeometry, haloTriangles: haloGeometry ? haloGeometry.index.count / 3 : 0,
  };
  tmp.dispose();
  _cache.set(id, t);
  return t;
}
/** Fresh nozzle descriptors of family `id` (AfterburnerFX layout). */
export function getAirframeNozzles(id) {
  return getAirframeTopology(id).nozzles.map((n) => ({ position: n.position.clone(), halfWidth: n.halfWidth, halfHeight: n.halfHeight }));
}

let _haloMat = null;
/** The one translucent material every rotor / propeller halo shares (vertex RGBA, no depth write, both sides). */
export function getHaloMaterial() {
  if (!_haloMat) {
    _haloMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });   // (one pass: a flat disc needs no back-then-front split)
    _haloMat.name = 'rotorHalo';
  }
  return _haloMat;
}
/** Full teardown of the airframe geometry cache. Only call when no airframe mesh is alive. */
export function disposeAirframeCache() {
  for (const t of _cache.values()) if (t.haloGeometry) t.haloGeometry.dispose();
  _cache.clear();
  if (_haloMat) { _haloMat.dispose(); _haloMat = null; }
}
