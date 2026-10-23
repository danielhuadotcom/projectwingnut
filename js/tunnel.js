import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// PROJECT WINGNUT — js/tunnel.js
// The genre-staple "random ass tunnel": a 2.7 km rock ridge on the coast north of the spawn with a lit bore through it.
//
// The terrain is a 43 m/texel heightfield drawn as a GPU clipmap and cannot represent an overhang, so the tunnel is its
// own structure sitting on the terrain (location picked offline by scanning World.getHeight: a strip of coastal lowland
// 4.0-6.6 km north of the spawn, sea to the west, hills rising to the east; the terrain under the bore is <= 13 m, so the
// bore floor clears it everywhere and the heightfield needs no edits). Three meshes / draw calls:
//   exterior  the ridge: cross-section rings swept along a CatmullRomCurve3, displaced with CPU noise at build time, its
//             base sunk below the terrain so the flanks meet the ground (and the sea) naturally, plus two rocky portal
//             faces with a raised rim around each opening. Shaded with the terrain's own material/lighting model and
//             aerial perspective through the World's shared uniforms (sky LUT, sun, haze, cloud shadows, detail/biome
//             textures), so it reads as part of the landscape; per-vertex cavity AO and sun visibility (the ridge's own
//             cast shadows) are baked on the CPU.
//   interior  the bore (superellipse arch over a flat floor), dark rock lit by light rings every 40 m: emissive bands
//             (> 1, so bloom picks them up) plus analytic light pools on the walls, a dashed centre line, floor-edge
//             lights, daylight spill and direct sun at the portals, dark haze inside. All fixtures are analytic in the
//             fragment shader, box-filtered with fwidth so they don't alias in the distance: no extra geometry, no lights.
//   lights    additive billboards: lamps on both portal rims and sequenced approach strobes leading into each portal.
// ~21k triangles, no dynamic lights, no per-frame allocations (the only per-frame work is a camera hook in onBeforeRender
// that sets the inside/outside haze blend and draw order). Collision and inside tests are analytic: closest point on the
// sampled path, local frame, superellipse cross-section test, per-ring lateral height table of the ridge (~0.3-1 us).
// Measured on an integrated laptop GPU, 1080p, 4x MSAA (scene pass, tunnel shown vs. hidden): +0.3 ms with the ridge in view,
// -0.8 ms with the camera inside the bore (it hides terrain + sky), 0 when off-screen (frustum culled).
//
// API / integration (main.js):
//   const tunnel = new Tunnel(scene, world);          // after new World(); ~60-90 ms; adds 3 meshes to the scene
//   tunnel.collide(pos, radius = 6)                    // 'wall' | null: bore walls, portal faces, rock mass. Call every
//                                                      // frame for the player (and enemies) next to the terrain test;
//                                                      // 'wall' = crash (e.g. die('HIT THE TUNNEL WALL'))
//   tunnel.isInside(pos)                               // in the bore: AWACS enter/exit lines, HUD tag, and suppress the
//                                                      // terrain-based PULL UP warning while true
//   tunnel.closestPathT(pos)                           // 0..1 along the bore when in or near it (within 400 m of a
//                                                      // portal, 160 m of the axis), else -1: "approaching" callouts
//   tunnel.constrain(cameraPos, margin)                // when the player isInside(), keeps the chase camera in the bore
//   tunnel.entrances                                   // [{ name, position, direction }]: bore centre at each opening,
//                                                      // direction points into the bore (AI / waypoints / HUD markers)
//   tunnel.pointAt(t, out), tunnel.tangentAt(t, out)   // bore centre line / direction at fraction t
//   tunnel.dispose()

// ============================================================================
// LAYOUT / TUNABLES
// ============================================================================
// Path control points (world XZ), south portal first. Bore floor heights are derived from the terrain at build time.
const PATH_XZ = [[1585, -3700], [1520, -4300], [1480, -5000], [1580, -5700], [1780, -6350]];
const BORE_A = 36;            // bore half-width (m): 72 m wide
const BORE_B = 23;            // bore half-height (m): 46 m floor to crown
const BORE_N_UP = 2.4;        // superellipse exponent of the upper half (arch)
const BORE_N_LO = 5.0;        // lower half (flat floor with rounded corners)
const FLARE = 0.2;            // portal flare: bore scaled +20% at the openings (around the floor centre)
const FLARE_LEN = 80;         // m over which the flare blends out
const FLOOR_CLEAR = 9;        // min clearance between the terrain under the bore and its floor (m)
const FLOOR_MIN = 12;         // min floor height ASL (keeps the sea surface well below the floor)
const SAMPLE_DS = 5;          // path sample spacing for collision / projection tables (m)
const RING_DS_EXT = 26;       // exterior ring spacing (m)
const RING_DS_INT = 24;       // interior ring spacing (m)
const EXT_K = 60;             // exterior profile points per ring (denser toward the crest)
const T_EDGE = 1.2;           // profile parameter range [-T_EDGE, T_EDGE]; |t| > 1 is buried below the terrain
const INT_B = 32;             // interior outline segments per ring
const BASE_SINK = 28;         // ridge base sunk this far below the terrain (m)
const ROCK_MIN = 30;          // min rock thickness above the bore crown near the portals (m)
const CAP_RINGS = 7;          // rings across each portal face (spaced quadratically: dense at the rim)
const CAP_BOTTOM = 8;         // buried closure points under each portal face
const RIM_H = 7;              // portal rim protrusion (m) ...
const RIM_W = 7;              // ... peaking this far from the opening edge (m)
const CAP_INSET = 0.6;        // portal face overlaps the bore edge by this much (hides cracks)
const LEAN_SLOPE = 0.25;      // portal faces lean back above the crown ...
const LEAN_MAX = 14;          // ... up to this much (m) (< RING_DS_EXT, so the first ring never folds)
const H_END = 26;             // ridge height above the bore crown at the portals (m): the portal face
const NOSE = 260;             // length of the ridge's descending nose at each end (m)
const LIGHT_DS = 40;          // light ring spacing (m)
const LIGHT_0 = 20;           // first light ring this far inside each portal (m)
const XW = 700, DX = 10;      // lateral extent / resolution of the per-ring collision height table (m)
const NX = Math.round((2 * XW) / DX) + 1;

// Mirrors of world.js constants used by the shared-uniform shading (tiling detail texture cells, biome texture span,
// cloud tile). They only affect texture scales; if world.js changes them the ridge still renders, slightly off-scale.
const DETAIL_CELLS = 64;
const BIOME_SPAN = 44000;
const CLOUD_TILE = 41600;

// ============================================================================
// SMALL MATH + NOISE (CPU, build time only)
// ============================================================================
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));
const flareK = (s, L) => 1 + FLARE * (1 - smoothstep(0, FLARE_LEN, Math.min(s, L - s)));

// Improved Perlin noise (3D), seeded permutation; ~[-1, 1].
const PERM = new Uint8Array(512);
(function seed() {
  let s = 90210;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    const j = (s >>> 0) % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();
// Perlin's 16 gradient directions (12 cube edges, 4 repeated), as lookup tables
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1]);
const grad3 = (h, x, y, z) => { h &= 15; return GX[h] * x + GY[h] * y + GZ[h] * z; };
function noise3(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  x -= X; y -= Y; z -= Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = x * x * x * (x * (x * 6 - 15) + 10), v = y * y * y * (y * (y * 6 - 15) + 10), w = z * z * z * (z * (z * 6 - 15) + 10);
  const A = PERM[xi] + yi, AA = PERM[A] + zi, AB = PERM[A + 1] + zi;
  const B = PERM[xi + 1] + yi, BA = PERM[B] + zi, BB = PERM[B + 1] + zi;
  const l1 = grad3(PERM[AA], x, y, z) + u * (grad3(PERM[BA], x - 1, y, z) - grad3(PERM[AA], x, y, z));
  const l2 = grad3(PERM[AB], x, y - 1, z) + u * (grad3(PERM[BB], x - 1, y - 1, z) - grad3(PERM[AB], x, y - 1, z));
  const l3 = grad3(PERM[AA + 1], x, y, z - 1) + u * (grad3(PERM[BA + 1], x - 1, y, z - 1) - grad3(PERM[AA + 1], x, y, z - 1));
  const l4 = grad3(PERM[AB + 1], x, y - 1, z - 1) + u * (grad3(PERM[BB + 1], x - 1, y - 1, z - 1) - grad3(PERM[AB + 1], x, y - 1, z - 1));
  const m1 = l1 + v * (l2 - l1), m2 = l3 + v * (l4 - l3);
  return m1 + w * (m2 - m1);
}

// Rock displacement (m) at a world point: ridged multifractal (buttresses, crags), broad lumps, gullies down the flanks.
function rockDisp(x, y, z, s) {
  let r1 = 1 - Math.abs(noise3(x / 380 + 0.31, y / 380, z / 380 - 0.77)); r1 *= r1;
  let r2 = 1 - Math.abs(noise3(x / 165 + 11.3, y / 165, z / 165 - 7.1)); r2 *= r2;
  let r3 = 1 - Math.abs(noise3(x / 72 - 3.7, y / 72 + 5.2, z / 72)); r3 *= r3;
  const lump = noise3(x / 640 - 5.1, y / 640, z / 640 + 2.2);
  let gl = 1 - Math.abs(noise3(s / 84 + 2.1, y / 240, 4.4)); gl *= gl; gl *= gl;
  return 72 * (r1 - 0.45) + 34 * (r2 - 0.45) * (0.6 + 0.8 * r1) + 13 * (r3 - 0.45) + 42 * lump - 24 * gl;
}

// Bore outline radius at angle th (from +x toward +y, around the bore centre) for flare scale k.
function boreR(th, k) {
  const c = Math.abs(Math.cos(th)), sn = Math.abs(Math.sin(th));
  const n = Math.sin(th) >= 0 ? BORE_N_UP : BORE_N_LO;
  return 1 / Math.pow(Math.pow(c / (BORE_A * k), n) + Math.pow(sn / (BORE_B * k), n), 1 / n);
}
// Inside test of the bore outline shrunk by r (x lateral, yc relative to the bore centre).
function boreInside(x, yc, k, r) {
  const a = BORE_A * k - r, b = BORE_B * k - r;
  if (a <= 0 || b <= 0) return false;
  const n = yc >= 0 ? BORE_N_UP : BORE_N_LO;
  return Math.pow(Math.abs(x) / a, n) + Math.pow(Math.abs(yc) / b, n) < 1;
}

// Outline angles at uniform arc length (k = 1; the flare scales the shape uniformly so the angles stay valid).
// Index 0 = floor centre (-pi/2), counter-clockwise (up the right wall first), INT_B = back at the floor centre.
const OUT_TH = new Float64Array(INT_B + 1);
const OUT_ARC = new Float64Array(INT_B + 1);
let PERIM = 0;
(function outline() {
  const M = 2048, th = new Float64Array(M + 1), arc = new Float64Array(M + 1);
  let px = 0, py = -BORE_B;
  for (let i = 0; i <= M; i++) {
    const t = -Math.PI / 2 + (2 * Math.PI * i) / M, r = boreR(t, 1);
    const x = r * Math.cos(t), y = r * Math.sin(t);
    th[i] = t; arc[i] = i ? arc[i - 1] + Math.hypot(x - px, y - py) : 0; px = x; py = y;
  }
  PERIM = arc[M];
  let j = 0;
  for (let m = 0; m <= INT_B; m++) {
    const a = (PERIM * m) / INT_B;
    while (j < M - 1 && arc[j + 1] < a) j++;
    const f = (a - arc[j]) / Math.max(arc[j + 1] - arc[j], 1e-9);
    OUT_TH[m] = th[j] + (th[j + 1] - th[j]) * clamp(f, 0, 1);
    OUT_ARC[m] = a;
  }
  OUT_TH[0] = -Math.PI / 2; OUT_TH[INT_B] = 1.5 * Math.PI;
})();
// perimeter distance from the floor centre to the floor/wall corner (where the wall rises 1.5 m; floor-edge lights)
const EDGE_V = (() => {
  let px = 0, py = -BORE_B, a = 0;
  for (let i = 1; i <= 4096; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / 4096, r = boreR(t, 1), x = r * Math.cos(t), y = r * Math.sin(t);
    a += Math.hypot(x - px, y - py); px = x; py = y;
    if (y + BORE_B > 1.5) return a;
  }
  return 28;
})();

// ============================================================================
// GLSL
// ============================================================================
const f = (v) => { const s = String(v); return s.includes('.') || s.includes('e') ? s : s + '.0'; };

// Mirrors world.js GLSL_COMMON / GLSL_LIGHT (sky LUT lookup, exponential height fog, cloud shadow) so the ridge gets the
// exact aerial perspective and light of the terrain around it.
const GLSL_WORLD = /* glsl */`
uniform sampler2D uSkyLut;
uniform vec3 uSunDir;
uniform float uFogMie;
uniform float uFogRay;
vec3 skyLut(vec3 dir) {
  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0) + 1e-5, dir.z));
  vec2 c = vec2(sqrt(clamp(0.5 - 0.5 * dot(hd, uSunDir), 0.0, 1.0)), sqrt(hd.y));
  return textureLod(uSkyLut, (c * (LUT_SIZE - 1.0) + 0.5) / LUT_SIZE, 0.0).rgb;
}
float odepth(float yc, float yp, float d, float invH, float beta) {
  float dy = yp - yc;
  float ec = exp(-yc * invH);
  float fct = (abs(dy) > 1.0) ? (ec - exp(-yp * invH)) / (dy * invH) : ec;
  return beta * d * fct;
}
float fogT(float yp, float d) {
  float yc = cameraPosition.y;
  return exp(-(odepth(yc, yp, d, 1.0 / 1200.0, uFogMie) + odepth(yc, yp, d, 1.0 / 8000.0, uFogRay)));
}
`;
const GLSL_CLOUDSH = /* glsl */`
uniform sampler2D uCloudTex;
uniform vec2 uCloudOff;
uniform float uCloudAlt;
uniform float uCloudCut;
float cloudShadow(vec2 xz, float h) {
  vec2 sp = xz + uSunDir.xz * ((uCloudAlt - h) / max(uSunDir.y, 0.05));
  float c = texture(uCloudTex, sp * ${f(1 / CLOUD_TILE)} + uCloudOff).a;
  float d = smoothstep(uCloudCut, uCloudCut + 0.3, c);
  return 1.0 - 0.8 * d * smoothstep(uCloudAlt, uCloudAlt - 300.0, h);
}
`;

// ---------------------------------------------------------------------------- exterior (ridge + portal faces)
const EXT_VERT = GLSL_WORLD + /* glsl */`
attribute vec2 aShade;       // x: cavity AO, y: baked sun visibility
attribute vec3 aTan;         // surface tangent along uv.x
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTan;
varying vec2 vUv;
varying vec2 vShade;
varying vec3 vHaze;
varying float vFogT;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = mat3(modelMatrix) * normal;
  vTan = mat3(modelMatrix) * aTan;
  vUv = uv;
  vShade = aShade;
  vec3 toP = wp.xyz - cameraPosition;
  float dist = max(length(toP), 1e-3);
  vFogT = fogT(wp.y, dist);       // aerial perspective per vertex, like the terrain
  vHaze = skyLut(toP / dist);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const EXT_FRAG = GLSL_WORLD + GLSL_CLOUDSH + /* glsl */`
uniform sampler2D uDetail;
uniform sampler2D uBiome;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTan;
varying vec2 vUv;
varying vec2 vShade;
varying vec3 vHaze;
varying float vFogT;
const float DINV = ${f(1 / DETAIL_CELLS)};
const float S1 = 0.021 * DINV, S3 = 0.055 * DINV, S2 = 0.13 * DINV;
void main() {
  vec3 N = normalize(vNrm);
  float h = vWorld.y;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  // detail relief from the World's tiling noise texture, mapped by the sweep parametrisation (metres): no stretching on
  // cliffs, same octaves / fade distances as the terrain
  vec4 t1 = texture(uDetail, vUv * S1);
  float d1 = (t1.r - 0.5) * 0.98;
  float f1 = clamp(1.0 - dist * (1.0 / 7000.0), 0.0, 1.0);
  vec2 grad = (t1.gb - 0.5) * (4.0 * 0.021 * 6.0 * f1);
  vec4 t3 = texture(uDetail, vUv * S3 + vec2(0.13, 0.71));
  float f3 = clamp(1.0 - dist * (1.0 / 4000.0), 0.0, 1.0);
  float d3 = (t3.r - 0.5) * 0.98;
  grad += (t3.gb - 0.5) * (4.0 * 0.055 * 2.4 * f3);
  vec4 t2 = texture(uDetail, vUv * S2 + vec2(0.83, 0.29));
  float f2 = clamp(1.0 - dist * (1.0 / 1800.0), 0.0, 1.0);
  float d2 = t2.r - 0.5;
  grad += (t2.gb - 0.5) * (4.0 * 0.13 * 1.0 * f2);
  float steep = smoothstep(0.89, 0.66, N.y + 0.06 * d1);
  vec3 T = normalize(vTan - N * dot(vTan, N));
  vec3 B = cross(T, N);
  vec3 Nd = normalize(N - (T * grad.x + B * grad.y) * (1.0 + 0.9 * steep));
  // streaks running down the faces (uv.y follows the slope on the ridge and is vertical on the portal faces)
  vec4 st = texture(uDetail, vec2(vUv.x * (0.16 * DINV), vUv.y * (0.018 * DINV)) + vec2(0.21, 0.47));
  float streak = mix(1.0, 0.72 + 0.56 * st.r, steep * f2 * 0.9 + steep * 0.1);

  // biome weights: the terrain's rules (so the ridge's foot matches the ground it stands on), biased toward bare rock
  float bigv = texture(uBiome, vWorld.xz * ${f(1 / BIOME_SPAN)} + 0.5).r;
  float treeLine = 1500.0 + 240.0 * (bigv - 0.5);
  float forestPatch = smoothstep(0.30, 0.58, bigv + 0.25 * d1);
  float wForest = smoothstep(treeLine + 120.0, treeLine - 300.0, h) * smoothstep(0.74, 0.90, N.y) * smoothstep(3.0, 20.0, h) * forestPatch;
  float wSand = smoothstep(9.0, 2.0, h + 6.0 * d1);
  vec3 meadow = mix(vec3(0.13, 0.21, 0.05), vec3(0.26, 0.25, 0.08), bigv) * (1.0 + 0.22 * d1 + 0.2 * d3 * f3 + 0.2 * d2 * f2);
  vec3 forest = vec3(0.028, 0.055, 0.022) * (1.0 + 0.5 * d1 + 0.5 * d3 * f3 + (0.9 * max(d2, 0.0) + 0.3 * d2) * f2);
  vec3 rock = mix(vec3(0.16, 0.14, 0.13), vec3(0.30, 0.27, 0.24), 0.5 + 0.5 * sin(h * 0.045 + d1 * 4.0)) * (1.0 + 0.3 * d1 + 0.2 * d2 * f2) * streak;
  vec3 sand = vec3(0.46, 0.40, 0.28) * (1.0 + 0.2 * d1);
  vec3 alb = mix(meadow, forest, wForest);
  alb = mix(alb, rock, steep);
  alb = mix(alb, sand, wSand * (1.0 - steep));
  alb *= mix(0.78, 1.0, smoothstep(-2.0, 4.0, h));     // wet rock at the waterline

  // lighting (terrain model): sun * baked visibility * self-shadow * cloud shadow + hemispheric ambient * cavity
  float ndl = max(dot(Nd, uSunDir), 0.0);
  float selfSh = smoothstep(-0.1, 0.25, dot(N, uSunDir));
  float cs = cloudShadow(vWorld.xz, h);
  vec3 direct = uSunColor * (ndl * vShade.y * selfSh * cs);
  vec3 amb = mix(uGroundAmb, uSkyAmb, Nd.y * 0.5 + 0.5) * vShade.x * (1.0 - 0.3 * wForest);
  vec3 col = alb * (direct + amb);
  vec3 Hv = normalize(uSunDir + V);
  col += uSunColor * (pow(max(dot(Nd, Hv), 0.0), 24.0) * wSand * 0.12 * vShade.y * cs);
  gl_FragColor = vec4(col * vFogT + vHaze * (1.0 - vFogT), 1.0);
}
`;

// ---------------------------------------------------------------------------- interior (bore walls + fixtures)
const INT_VERT = /* glsl */`
attribute float aVs;         // perimeter distance from the floor centre (m)
attribute vec3 aTan;         // path tangent (toward the north portal)
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTan;
varying vec2 vUv;            // (path s, perimeter v) in metres
varying float vVs;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNrm = mat3(modelMatrix) * normal;
  vTan = mat3(modelMatrix) * aTan;
  vUv = uv;
  vVs = aVs;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const INT_FRAG = GLSL_WORLD + /* glsl */`
uniform sampler2D uDetail;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform float uLen;          // bore length (m)
uniform float uCamIn;        // 0: camera outside the bore .. 1: inside (smoothed by depth)
uniform vec3 uLampCol;       // ring lamp colour (linear)
uniform vec3 uPortC[2];      // floor centre of each opening
uniform vec3 uPortO[2];      // outward unit normal of each opening (horizontal)
uniform vec3 uPortR[2];      // lateral unit vector of each opening
uniform vec2 uPortK[2];      // (flare scale, centre height above the floor)
uniform float uLastRing;     // arc length of the last lamp ring
varying vec3 vWorld;
varying vec3 vNrm;
varying vec3 vTan;
varying vec2 vUv;
varying float vVs;
const float DINV = ${f(1 / DETAIL_CELLS)};
// average of a periodic box train (width w, centred on multiples of P) over a pixel footprint fw: crisp up close,
// converging to the duty cycle w/P in the distance (no aliasing / shimmer)
float pulse(float x, float P, float w, float fw) {
  fw = max(fw, 1e-4);
  float x0 = x - 0.5 * fw + 0.5 * w, x1 = x + 0.5 * fw + 0.5 * w;
  float i0 = floor(x0 / P) * w + min(mod(x0, P), w);
  float i1 = floor(x1 / P) * w + min(mod(x1, P), w);
  return (i1 - i0) / fw;
}
float box(float x, float hw, float fw) { return clamp((hw - abs(x)) / max(fw, 1e-4) + 0.5, 0.0, 1.0); }
void main() {
  float s = vUv.x, v = vUv.y, vs = vVs;
  vec3 N = normalize(vNrm);
  vec3 T = normalize(vTan);
  vec3 B = cross(T, N);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float fws = fwidth(s), fwv = fwidth(v), fwvs = fwidth(vs);

  // rock: streaky relief (stretched along the bore) from the tiling detail texture
  vec2 q = vec2(s * 0.45, v);
  vec4 n1 = texture(uDetail, q * (0.12 * DINV));
  vec4 n2 = texture(uDetail, q * (0.41 * DINV) + vec2(0.37, 0.61));
  vec4 n3 = texture(uDetail, q * (1.3 * DINV) + vec2(0.71, 0.13));
  float near = clamp(1.0 - dist * (1.0 / 260.0), 0.0, 1.0);
  vec2 g = (n1.gb - 0.5) * (4.0 * 0.12 * 3.2) + (n2.gb - 0.5) * (4.0 * 0.41 * 0.8) + (n3.gb - 0.5) * (4.0 * 1.3 * 0.12 * near);
  g.x *= 0.45;
  vec3 Nd = normalize(N - T * g.x - B * g.y);
  float floorM = 1.0 - smoothstep(${f(EDGE_V - 3)}, ${f(EDGE_V + 2)}, vs);
  float rough = n1.r * 0.6 + n2.r * 0.4;
  vec3 alb = mix(vec3(0.050, 0.046, 0.042), vec3(0.092, 0.084, 0.074), rough) * (0.7 + 0.6 * n1.a);
  alb = mix(alb, vec3(0.085, 0.082, 0.078) * (0.85 + 0.3 * n2.a), floorM * 0.7);

  // light pools from the two nearest lamp rings (rings at LIGHT_0 + i * LIGHT_DS, up to uLastRing)
  float sr0 = ${f(LIGHT_0)} + floor((clamp(s, ${f(LIGHT_0)}, uLastRing) - ${f(LIGHT_0)}) / ${f(LIGHT_DS)}) * ${f(LIGHT_DS)};
  float sr1 = min(sr0 + ${f(LIGHT_DS)}, uLastRing);
  float d0 = s - sr0, d1 = sr1 - s;             // signed: d0 > 0 ring behind, d1 > 0 ring ahead
  vec3 L0 = normalize(-T * d0 + N * 16.0);
  vec3 L1 = normalize(T * d1 + N * 16.0);
  float k0 = 1.0 / (1.0 + d0 * d0 * (1.0 / 170.0)); k0 *= k0;
  float k1 = 1.0 / (1.0 + d1 * d1 * (1.0 / 170.0)); k1 *= k1 * step(0.5, abs(sr1 - sr0));
  vec3 E = uLampCol * (1.8 * (k0 * max(dot(Nd, L0), 0.0) + k1 * max(dot(Nd, L1), 0.0)) + 0.03) + uSkyAmb * 0.45;   // cool fill: the gaps between pools read blue-grey
  // daylight spilling in through the openings
  float din = min(s, uLen - s);
  E += (uSkyAmb * 2.4 + uSunColor * 0.12) * (exp(-din * (1.0 / 45.0)) * (0.55 + 0.45 * Nd.y));
  // direct sun through an opening: trace toward the sun to the opening plane, test the (flared) outline there
  // (coherent branch: only fragments within 300 m of a portal pay for it)
  if (din < 300.0) for (int i = 0; i < 2; i++) {
    float sd = dot(uSunDir, uPortO[i]);
    vec3 qv = vWorld - uPortC[i];
    float back = -dot(qv, uPortO[i]);
    if (sd > 0.02 && back > 0.0 && back < 280.0) {
      vec3 hit = qv + uSunDir * (back / sd);
      float hx = dot(hit, uPortR[i]);
      float hy = hit.y - uPortK[i].y;
      float n = hy > 0.0 ? ${f(BORE_N_UP)} : ${f(BORE_N_LO)};
      float F = pow(abs(hx) / (${f(BORE_A)} * uPortK[i].x), n) + pow(abs(hy) / (${f(BORE_B)} * uPortK[i].x), n);
      E += uSunColor * (max(dot(Nd, uSunDir), 0.0) * (1.0 - smoothstep(0.8, 1.0, F)));
    }
  }
  vec3 col = alb * E;

  // emissive fixtures
  float inRange = step(${f(LIGHT_0 - 2)}, s) * step(s, uLastRing + 2.0);
  float wall = smoothstep(${f(EDGE_V + 4)}, ${f(EDGE_V + 8)}, vs);
  float ring = pulse(s - ${f(LIGHT_0)}, ${f(LIGHT_DS)}, 1.4, fws) * inRange;
  float seg = pulse(v, 4.2, 2.8, fwv);
  vec3 em = uLampCol * (7.5 * ring * wall * mix(0.05, 1.0, seg));
  // cool white marker rings just inside each opening
  float mark = box(s - 7.0, 0.9, fws) + box(s - (uLen - 7.0), 0.9, fws);
  em += vec3(0.85, 0.93, 1.0) * (16.0 * mark * wall * mix(0.2, 1.0, seg));
  // dashed centre line and floor-edge lights (strong speed cues)
  em += vec3(1.0, 0.9, 0.7) * (2.6 * pulse(s, 24.0, 9.0, fws) * box(vs, 0.45, fwvs));
  em += vec3(0.45, 0.8, 1.0) * (10.0 * pulse(s - 6.0, 12.0, 1.0, fws) * box(vs - ${f(EDGE_V)}, 0.55, fwvs));
  col += em;

  // haze: dark inside the bore, the World's aerial perspective for the part of the view ray outside it
  float inLen = mix(min(din, dist), dist, uCamIn);
  float Ti = exp(-inLen * (1.0 / 1500.0));
  col = col * Ti + uLampCol * (0.004 * (1.0 - Ti));
  float outLen = dist - inLen;
  if (outLen > 1.0) {               // coherent: skipped entirely while the camera is deep inside
    float To = fogT(vWorld.y, outLen);
    col = col * To + skyLut(-V) * (1.0 - To);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------- lights (additive billboards)
const LAMP_SIZE = 2.6;   // lamp billboard size (m) up close
const LIGHT_VERT = GLSL_WORLD + /* glsl */`
attribute vec3 aCenter;
attribute vec2 aCorner;
attribute vec4 aCol;         // rgb: linear emission; w: strobe phase (< 0: steady)
uniform float uTime;
varying vec2 vC;
varying vec3 vCol;
void main() {
  vec3 toC = aCenter - cameraPosition;
  float dist = max(length(toC), 1e-3);
  float on = 1.0;
  if (aCol.w >= 0.0) { float p = fract(uTime - aCol.w); on = smoothstep(0.0, 0.015, p) * (1.0 - smoothstep(0.05, 0.14, p)); }
  // keep lamps >= ~2 px wide in the distance, energy-conserving (bloom turns them into beacons)
  float size = max(${f(LAMP_SIZE)}, dist * 0.0021);
  float energy = ${f(LAMP_SIZE * LAMP_SIZE)} / (size * size);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = aCenter + (right * aCorner.x + up * aCorner.y) * size;
  vCol = aCol.rgb * (on * energy * fogT(aCenter.y, dist));
  vC = aCorner * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const LIGHT_FRAG = /* glsl */`
varying vec2 vC;
varying vec3 vCol;
void main() {
  float r2 = dot(vC, vC);
  if (r2 > 1.0) discard;
  float a = 1.0 - r2;
  gl_FragColor = vec4(vCol * (a * a), 1.0);
}
`;

// ============================================================================
// TUNNEL
// ============================================================================
const _F = { x: 0, z: 0, fy: 0, tx: 0, tz: 1 };
const _P = { H: 0, xc: 0, wl: 0, wr: 0 };
const _loc = { s: 0, x: 0, y: 0, i: 0, fy: 0 };   // last projection (collision helpers; reused, never allocated per call)

export class Tunnel {
  /**
   * @param {THREE.Scene} scene
   * @param {World} world   needs getHeight(x, z); uses world.uniforms (sky LUT, sun, haze, textures) when present
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const getH = (x, z) => { const h = world && world.getHeight ? world.getHeight(x, z) : 0; return Number.isFinite(h) ? h : 0; };
    this._fallbackTex = [];

    const tm = this.buildTimes = {};      // ms per build phase (diagnostics)
    let ta = now();
    this._buildPath(getH); tm.path = now() - ta; ta = now();
    const ext = this._buildExterior(getH); tm.exterior = now() - ta; ta = now();
    const int = this._buildInterior(); tm.interior = now() - ta; ta = now();
    const lights = this._buildLights(getH); tm.lights = now() - ta; ta = now();
    this._bakeShading(ext, getH); tm.bake = now() - ta;

    // ---- materials (World's shared uniform objects: sun / haze / LUT changes propagate automatically)
    const U = this._worldUniforms(world);
    const lutImg = U.uSkyLut.value && U.uSkyLut.value.image;
    const defines = { LUT_SIZE: `vec2(${f((lutImg && lutImg.width) || 256)}, ${f((lutImg && lutImg.height) || 64)})` };
    this._extMat = new THREE.ShaderMaterial({
      name: 'tunnelExterior', vertexShader: EXT_VERT, fragmentShader: EXT_FRAG, defines: { ...defines }, fog: false,
      uniforms: {
        uSkyLut: U.uSkyLut, uSunDir: U.uSunDir, uFogMie: U.uFogMie, uFogRay: U.uFogRay, uCloudTex: U.uCloudTex,
        uCloudOff: U.uCloudOff, uCloudAlt: U.uCloudAlt, uCloudCut: U.uCloudCut, uDetail: U.uDetail, uBiome: U.uBiome,
        uSunColor: U.uSunColor, uSkyAmb: U.uSkyAmb, uGroundAmb: U.uGroundAmb,
      },
    });
    const ends = this._ends;
    this._intU = {
      uSkyLut: U.uSkyLut, uSunDir: U.uSunDir, uFogMie: U.uFogMie, uFogRay: U.uFogRay, uDetail: U.uDetail,
      uSunColor: U.uSunColor, uSkyAmb: U.uSkyAmb,
      uLen: { value: this.length }, uCamIn: { value: 0 },
      uLampCol: { value: new THREE.Vector3(1.0, 0.56, 0.24) },
      uPortC: { value: [ends[0].c, ends[1].c] }, uPortO: { value: [ends[0].o, ends[1].o] },
      uPortR: { value: [ends[0].r, ends[1].r] }, uPortK: { value: [ends[0].kv, ends[1].kv] },
      uLastRing: { value: LIGHT_0 + Math.floor((this.length - 2 * LIGHT_0) / LIGHT_DS) * LIGHT_DS },
    };
    this._intMat = new THREE.ShaderMaterial({ name: 'tunnelInterior', vertexShader: INT_VERT, fragmentShader: INT_FRAG, defines: { ...defines }, fog: false, uniforms: this._intU });
    this._timeU = U.uTime;
    this._lightMat = new THREE.ShaderMaterial({
      name: 'tunnelLights', vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, defines: { ...defines }, fog: false,
      uniforms: { uSkyLut: U.uSkyLut, uSunDir: U.uSunDir, uFogMie: U.uFogMie, uFogRay: U.uFogRay, uTime: U.uTime },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    // ---- meshes (positions are world space; identity transforms)
    this.exterior = new THREE.Mesh(ext.geo, this._extMat);
    this.interior = new THREE.Mesh(int, this._intMat);
    this.lights = new THREE.Mesh(lights, this._lightMat);
    this.exterior.name = 'tunnelExterior'; this.interior.name = 'tunnelInterior'; this.lights.name = 'tunnelLights';
    // draw before the terrain (renderOrder 1) so it early-z rejects the ground hidden behind the ridge; the camera hook
    // below draws whichever of exterior / interior is in front first (one frame of latency)
    // lamps: transparent, before the cloud layer (10) / puffs (11) / smoke (20+) so those blend over them
    this.exterior.renderOrder = 0.5; this.interior.renderOrder = 0.6; this.lights.renderOrder = 5;
    const hook = (r, s, camera) => this._onCamera(camera);
    this.exterior.onBeforeRender = hook; this.interior.onBeforeRender = hook;
    for (const m of [this.exterior, this.interior, this.lights]) { m.matrixAutoUpdate = false; m.updateMatrix(); scene.add(m); }
    this.meshes = [this.exterior, this.interior, this.lights];
    this.lampColor = this._intU.uLampCol.value;     // linear RGB of the bore's lamp rings (tweakable at runtime)
    this.triangles = 0;
    for (const m of this.meshes) this.triangles += m.geometry.index.count / 3;
    this.buildTime = now() - t0;
  }

  // -------------------------------------------------------------------------- path & floor
  _buildPath(getH) {
    const curve = new THREE.CatmullRomCurve3(PATH_XZ.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    curve.arcLengthDivisions = 4000;
    const L = curve.getLength();
    const n = Math.max(3, Math.round(L / SAMPLE_DS) + 1);
    const ds = L / (n - 1);
    const sx = new Float64Array(n), sz = new Float64Array(n), tx = new Float64Array(n), tz = new Float64Array(n);
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      curve.getPointAt(u, p); curve.getTangentAt(u, t);
      const tl = Math.hypot(t.x, t.z) || 1;
      sx[i] = p.x; sz[i] = p.z; tx[i] = t.x / tl; tz[i] = t.z / tl;
    }
    // bore floor: smooth upper envelope of (max terrain under the flared bore footprint + clearance)
    const need = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const hw = BORE_A * flareK(i * ds, L) + 12, rx = -tz[i], rz = tx[i];
      let m = -Infinity;
      for (let o = -hw; o <= hw + 1e-6; o += hw / 4) m = Math.max(m, getH(sx[i] + rx * o, sz[i] + rz * o));
      need[i] = Math.max(Math.max(m, 0) + FLOOR_CLEAR, FLOOR_MIN);
    }
    const W = Math.max(1, Math.round(160 / ds));
    let fl = Float64Array.from(need);
    const tmp = new Float64Array(n);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < n; i++) { let m = -Infinity; for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) m = Math.max(m, fl[j]); tmp[i] = m; }
      for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { a += tmp[j]; c++; } fl[i] = Math.max(a / c, need[i]); }
    }
    for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { a += fl[j]; c++; } tmp[i] = a / c; }
    for (let i = 0; i < n; i++) fl[i] = Math.max(tmp[i], need[i]);
    this.length = L;
    this._n = n; this._ds = ds; this._sx = sx; this._sz = sz; this._tx = tx; this._tz = tz; this._fy = fl;
    let fmin = Infinity, fmax = -Infinity;
    for (let i = 0; i < n; i++) { if (fl[i] < fmin) fmin = fl[i]; if (fl[i] > fmax) fmax = fl[i]; }
    this.floorRange = [fmin, fmax];
    this.boreWidth = 2 * BORE_A; this.boreHeight = 2 * BORE_B;
  }

  /** Bore centre line at fraction t (0 = south portal .. 1 = north portal), written to `out` (no allocation). */
  pointAt(t, out) {
    const s = clamp(t, 0, 1) * this.length;
    this._frameAt(s, _F);
    return out.set(_F.x, _F.fy + BORE_B * flareK(s, this.length), _F.z);
  }

  /** Unit direction of the bore at fraction t (toward the north portal), written to `out`. */
  tangentAt(t, out) {
    const s = clamp(t, 0, 1) * this.length, d = this._ds;
    const f0 = this._frameAt(Math.max(s - d, 0), _F).fy, f1 = this._frameAt(Math.min(s + d, this.length), _F).fy;
    this._frameAt(s, _F);
    return out.set(_F.tx, (f1 - f0) / (2 * d), _F.tz).normalize();
  }

  // path frame at arc length s (clamped): floor centre, floor height, horizontal unit tangent
  _frameAt(s, out) {
    const u = clamp(s / this._ds, 0, this._n - 1.000001), i = u | 0, a = u - i;
    out.x = this._sx[i] + (this._sx[i + 1] - this._sx[i]) * a;
    out.z = this._sz[i] + (this._sz[i + 1] - this._sz[i]) * a;
    out.fy = this._fy[i] + (this._fy[i + 1] - this._fy[i]) * a;
    let tx = this._tx[i] + (this._tx[i + 1] - this._tx[i]) * a, tz = this._tz[i] + (this._tz[i + 1] - this._tz[i]) * a;
    const tl = Math.hypot(tx, tz) || 1;
    out.tx = tx / tl; out.tz = tz / tl;
    return out;
  }

  // ridge cross-section parameters at s: crest height above the floor, crest offset, sea-side / land-side half-widths
  _profileParams(s, out) {
    const L = this.length, e = Math.min(s, L - s);
    const u = clamp(e / NOSE, 0, 1), taper = 1 - (1 - u) * (1 - u);      // steep right above the portal, easing out
    const nA = noise3(s / 520 + 0.3, 4.1, 7.7), nB = noise3(s / 190 - 2.9, 1.7, 3.3), nC = noise3(s / 900 + 5.5, 9.9, 1.1);
    const hEnd = 2 * BORE_B * flareK(s, L) + H_END;
    out.H = hEnd + (Math.max(170, 320 + 160 * nA + 60 * nB) - hEnd) * taper;
    out.xc = (20 + 50 * nC) * taper;
    out.wl = 125 + (300 + 80 * noise3(s / 700 - 7.3, 2.2, 8.8) - 125) * taper;
    out.wr = 150 + (410 + 110 * noise3(s / 760 + 1.9, 6.6, 0.4) - 150) * taper;
    return out;
  }

  // -------------------------------------------------------------------------- exterior: ridge sweep + portal faces
  _buildExterior(getH) {
    const L = this.length, K = EXT_K;
    const NR = Math.max(8, Math.round(L / RING_DS_EXT) + 1), rds = L / (NR - 1);
    this._nr = NR; this._rds = rds;
    const loc = new Float64Array(NR * K * 2);             // displaced local profile (x, y above floor) per ring
    const tx = new Float64Array(K), ty = new Float64Array(K), tt = new Float64Array(K), tp = new Float64Array(K);
    for (let j = 0; j < NR; j++) {
      const s = j * rds;
      this._frameAt(s, _F); this._profileParams(s, _P);
      const rx = -_F.tz, rz = _F.tx, k = flareK(s, L), cy = BORE_B * k, aw = BORE_A * k;
      const protH = cy + BORE_B * k + ROCK_MIN;
      for (let i = 0; i < K; i++) {
        const q = -1 + (2 * i) / (K - 1), t = T_EDGE * Math.sign(q) * Math.pow(Math.abs(q), 1.25), at = Math.abs(t);
        const x = _P.xc + t * (t < 0 ? _P.wl : _P.wr);
        const base = Math.max(getH(_F.x + rx * x, _F.z + rz * x), -60) - _F.fy - BASE_SINK;
        const prof = at < 1 ? Math.pow(1 - at, 1.25) * (1 + 0.25 * at) : 0;   // peaked ridge, slightly convex flanks
        let y = base + (_P.H - base) * prof;
        // keep >= ROCK_MIN of rock over the bore; the constraint fades out 85 m beside it (never lifts the buried base)
        y = smax(y, protH - 400 * smoothstep(aw + 8, aw + 85, Math.abs(x)), 14);
        tx[i] = x; ty[i] = y; tt[i] = t; tp[i] = prof;
      }
      for (let i = 0; i < K; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(K - 1, i + 1);
        let nx = -(ty[i1] - ty[i0]), ny = tx[i1] - tx[i0];
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        const x = tx[i], y = ty[i], at = Math.abs(tt[i]);
        const D = rockDisp(_F.x + rx * x, _F.fy + y, _F.z + rz * x, s) * smoothstep(0, 0.3, tp[i]) * (1 - smoothstep(0.95, 1.12, at)) *
          (0.25 + 0.75 * smoothstep(0, 70, Math.min(s, L - s)));          // calmer at the portal faces
        const xd = x + nx * D * 0.2;
        let yd = y + D * 0.8 + ny * D * 0.2;
        yd = Math.max(yd, protH - 3 - 400 * smoothstep(aw + 8, aw + 85, Math.abs(xd)));
        loc[(j * K + i) * 2] = xd; loc[(j * K + i) * 2 + 1] = yd;
      }
    }
    // per-ring lateral height table for collision (max over the profile, so any fold is conservative)
    const tab = new Float32Array(NR * NX).fill(-1e9);
    for (let j = 0; j < NR; j++) {
      for (let i = 0; i < K - 1; i++) {
        const ax = loc[(j * K + i) * 2], ay = loc[(j * K + i) * 2 + 1], bx = loc[(j * K + i + 1) * 2], by = loc[(j * K + i + 1) * 2 + 1];
        const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
        for (let m = Math.max(0, Math.ceil((lo + XW) / DX)); m <= Math.min(NX - 1, Math.floor((hi + XW) / DX)); m++) {
          const x = -XW + m * DX, a = hi - lo > 1e-6 ? (x - ax) / (bx - ax) : 0;
          const y = ay + (by - ay) * clamp(a, 0, 1);
          if (y > tab[j * NX + m]) tab[j * NX + m] = y;
        }
      }
    }
    this._tab = tab;

    // ---- portal faces: offsets of the end rings (lean back above the crown + noise), shared by sweep and face
    const ends = [];
    const capOff = [new Float64Array(K), new Float64Array(K)];
    for (let e = 0; e < 2; e++) {
      const j = e === 0 ? 0 : NR - 1, s = j * rds;
      this._frameAt(s, _F);
      const k = flareK(s, L), rx = -_F.tz, rz = _F.tx;
      const crown = 2 * BORE_B * k;
      for (let i = 0; i < K; i++) {
        const x = loc[(j * K + i) * 2], y = loc[(j * K + i) * 2 + 1];
        const lean = clamp((y - crown - 6) * LEAN_SLOPE, 0, LEAN_MAX);
        const nz = 6 * noise3((_F.x + rx * x) / 23, (_F.fy + y) / 23, (_F.z + rz * x) / 23 + e * 7.7);
        capOff[e][i] = -lean + nz * smoothstep(crown * 0.5, crown + 20, y);
      }
      const ox = e === 0 ? -_F.tx : _F.tx, oz = e === 0 ? -_F.tz : _F.tz;
      ends.push({
        s, kf: k, cy: BORE_B * k, x: _F.x, z: _F.z, fy: _F.fy, ox, oz, rx, rz,
        // shader-facing copies: floor centre, outward normal, lateral axis, (flare, centre height)
        c: new THREE.Vector3(_F.x, _F.fy, _F.z), o: new THREE.Vector3(ox, 0, oz), r: new THREE.Vector3(rx, 0, rz),
        kv: new THREE.Vector2(k, BORE_B * k),
      });
    }
    this._ends = ends;

    // ---- vertex buffers: sweep (NR x K) + 2 faces ((CAP_RINGS+1) x (K + CAP_BOTTOM))
    const KC = K + CAP_BOTTOM, nSweep = NR * K, nCap = (CAP_RINGS + 1) * KC;
    const nv = nSweep + 2 * nCap;
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), tan = new Float32Array(nv * 3);
    const idx = [];
    for (let j = 0; j < NR; j++) {
      const s = j * rds;
      this._frameAt(s, _F);
      const rx = -_F.tz, rz = _F.tx;
      const e = j === 0 ? 0 : (j === NR - 1 ? 1 : -1);
      let v = 0;
      for (let i = 0; i < K; i++) {
        const x = loc[(j * K + i) * 2], y = loc[(j * K + i) * 2 + 1];
        if (i) v += Math.hypot(x - loc[(j * K + i - 1) * 2], y - loc[(j * K + i - 1) * 2 + 1]);
        let wx = _F.x + rx * x, wz = _F.z + rz * x;
        if (e >= 0) { const off = capOff[e][i]; wx += ends[e].ox * off; wz += ends[e].oz * off; }
        const o = j * K + i;
        pos[o * 3] = wx; pos[o * 3 + 1] = _F.fy + y; pos[o * 3 + 2] = wz;
        uv[o * 2] = s; uv[o * 2 + 1] = v;
        tan[o * 3] = _F.tx; tan[o * 3 + 1] = 0; tan[o * 3 + 2] = _F.tz;
      }
    }
    for (let j = 0; j < NR - 1; j++) for (let i = 0; i < K - 1; i++) {
      const a = j * K + i, b = a + 1, c = a + K, d = c + 1;
      idx.push(a, b, c, b, d, c);                      // (dP/dprofile) x (dP/ds) points out of the ridge
    }
    // portal faces: polar rings from the (flared, slightly inset) opening outline out to the end ring + buried closure
    const thM = new Float64Array(KC), ox2 = new Float64Array(KC), oy2 = new Float64Array(KC);
    for (let e = 0; e < 2; e++) {
      const E = ends[e], j = e === 0 ? 0 : NR - 1, base = nSweep + e * nCap;
      let yBot = Infinity;
      for (let i = 0; i < K; i++) yBot = Math.min(yBot, loc[(j * K + i) * 2 + 1]);
      yBot -= 40;
      for (let i = 0; i < K; i++) { ox2[i] = loc[(j * K + i) * 2]; oy2[i] = loc[(j * K + i) * 2 + 1]; }
      const xR = ox2[K - 1], xL = ox2[0];
      for (let b = 1; b <= CAP_BOTTOM; b++) { ox2[K - 1 + b] = xR + ((xL - xR) * b) / (CAP_BOTTOM + 1); oy2[K - 1 + b] = yBot; }
      // angles around the bore centre, unwrapped to decrease monotonically (clockwise: left base, crest, right base, bottom)
      for (let m = 0; m < KC; m++) {
        let th = Math.atan2(oy2[m] - E.cy, ox2[m]);
        if (m === 0 && th < 0) th += 2 * Math.PI;
        if (m > 0) { while (th > thM[m - 1]) th -= 2 * Math.PI; while (th < thM[m - 1] - 2 * Math.PI) th += 2 * Math.PI; th = Math.min(th, thM[m - 1] - 1e-4); }
        thM[m] = th;
      }
      for (let jj = 0; jj <= CAP_RINGS; jj++) {
        const w = (jj / CAP_RINGS) * (jj / CAP_RINGS);
        for (let m = 0; m < KC; m++) {
          const r = boreR(thM[m], E.kf) - CAP_INSET;
          const ix = r * Math.cos(thM[m]), iy = E.cy + r * Math.sin(thM[m]);
          const x = ix + (ox2[m] - ix) * w, y = iy + (oy2[m] - iy) * w;
          const dist = Math.hypot(x - ix, y - iy);
          const brow = 1 + 0.7 * Math.max(Math.sin(thM[m]), 0);           // the rim juts out most over the opening
          const bulge = RIM_H * brow * (dist / RIM_W) * Math.exp(1 - dist / RIM_W);
          const outer = m < K ? capOff[e][m] : 0;
          const wxp = E.x + E.rx * x, wzp = E.z + E.rz * x, wyp = E.fy + y;
          let rn = 1 - Math.abs(noise3(wxp / 26 + 3.1, wyp / 26, wzp / 26 - e * 5.3)); rn *= rn;
          const nz = 16 * (rn - 0.45) + 4 * noise3(wxp / 9, wyp / 9 + 1.7, wzp / 9);
          let off = jj === CAP_RINGS ? outer : bulge * (1 - w) + outer * Math.pow(w, 1.5) + nz * 4 * w * (1 - w) * smoothstep(0, 4, dist);
          if (jj === 0) off = 0;
          const o = base + jj * KC + m;
          pos[o * 3] = wxp + E.ox * off; pos[o * 3 + 1] = wyp; pos[o * 3 + 2] = wzp + E.oz * off;
          uv[o * 2] = x; uv[o * 2 + 1] = y;
          tan[o * 3] = E.rx; tan[o * 3 + 1] = 0; tan[o * 3 + 2] = E.rz;
        }
      }
      // triangles; winding chosen so the face normal points outward (checked numerically, flipped if needed)
      const first = idx.length;
      for (let jj = 0; jj < CAP_RINGS; jj++) for (let m = 0; m < KC; m++) {
        const m1 = (m + 1) % KC;
        const a = base + jj * KC + m, b = base + jj * KC + m1, c = a + KC, d = b + KC;
        idx.push(a, b, c, b, d, c);
      }
      let dot = 0;
      for (let q = first; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        dot += (uy * vz - uz * vy) * E.ox + (ux * vy - uy * vx) * E.oz;
      }
      if (dot < 0) for (let q = first; q < idx.length; q += 3) { const t = idx[q + 1]; idx[q + 1] = idx[q + 2]; idx[q + 2] = t; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
    geo.setIndex(new THREE.BufferAttribute(nv < 65536 ? new Uint16Array(idx) : new Uint32Array(idx), 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const bb = geo.boundingBox;
    this._bbMin = bb.min.clone(); this._bbMax = bb.max.clone();
    this.center = geo.boundingSphere.center.clone(); this.radius = geo.boundingSphere.radius;
    return { geo, nSweep, nCap };
  }

  // -------------------------------------------------------------------------- interior: bore walls
  _buildInterior() {
    const L = this.length, B = INT_B;
    const NI = Math.max(8, Math.round(L / RING_DS_INT) + 1);
    const nv = NI * (B + 1);
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), vsA = new Float32Array(nv), tan = new Float32Array(nv * 3);
    for (let i = 0; i < NI; i++) {
      const s = (i * L) / (NI - 1);
      this._frameAt(s, _F);
      const rx = -_F.tz, rz = _F.tx, k = flareK(s, L), cy = BORE_B * k;
      const endMask = smoothstep(0, 10, Math.min(s, L - s));
      for (let m = 0; m <= B; m++) {
        const th = OUT_TH[m], r0 = boreR(th, k), v = OUT_ARC[m] * k;
        const vs = Math.min(OUT_ARC[m], PERIM - OUT_ARC[m]) * k;
        // streaky relief: outward bias so the visible wall never sits inside the collision outline by more than ~1 m
        const upper = 0.3 + 0.7 * smoothstep(EDGE_V - 4, EDGE_V + 6, vs);
        const d = (1.5 * noise3(s / 46 + 0.5, v / 16, 3.3) + 0.5 * noise3(s / 19, v / 8, 9.1) + 0.6) * upper * endMask;
        const r = r0 + d;
        const x = r * Math.cos(th), y = cy + r * Math.sin(th);
        const o = i * (B + 1) + m;
        pos[o * 3] = _F.x + rx * x; pos[o * 3 + 1] = _F.fy + y; pos[o * 3 + 2] = _F.z + rz * x;
        uv[o * 2] = s; uv[o * 2 + 1] = v; vsA[o] = vs;
        tan[o * 3] = _F.tx; tan[o * 3 + 1] = 0; tan[o * 3 + 2] = _F.tz;
      }
    }
    const idx = new Uint16Array((NI - 1) * B * 6);
    let n = 0;
    for (let i = 0; i < NI - 1; i++) for (let m = 0; m < B; m++) {
      const a = i * (B + 1) + m, b = a + 1, c = a + B + 1, d = c + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c;   // normals point into the bore
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aVs', new THREE.BufferAttribute(vsA, 1));
    geo.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // -------------------------------------------------------------------------- lights: portal rim lamps + approach strobes
  _buildLights(getH) {
    const lamps = [];   // [x, y, z, r, g, b, phase]
    for (let e = 0; e < 2; e++) {
      const E = this._ends[e], k = E.kf;
      // rim lamps on the raised collar around the opening (walls + arch)
      const NRL = 15;
      for (let q = 0; q < NRL; q++) {
        const th = THREE.MathUtils.degToRad(-6 + (192 * q) / (NRL - 1));
        const r = boreR(th, k) + 3.5;
        const x = r * Math.cos(th), y = E.cy + r * Math.sin(th);
        const bulge = RIM_H * (3.5 / RIM_W) * Math.exp(1 - 3.5 / RIM_W) + 2.0;
        const top = q === (NRL >> 1);
        lamps.push([E.x + E.rx * x + E.ox * bulge, E.fy + y, E.z + E.rz * x + E.oz * bulge, top ? 30 : 16, top ? 4 : 8.5, top ? 3 : 3.2, -1]);
      }
      // sequenced approach strobes on the ground, running toward the opening (1 Hz)
      const NA = 12;
      for (let q = 0; q < NA; q++) {
        const d = 80 + q * 40;
        const x = E.x + E.ox * d, z = E.z + E.oz * d;
        lamps.push([x, Math.max(getH(x, z), 0) + 2.5, z, 20, 22, 26, (NA - 1 - q) * 0.035]);
      }
    }
    const n = lamps.length;
    const center = new Float32Array(n * 12), corner = new Float32Array(n * 8), col = new Float32Array(n * 16), pos = new Float32Array(n * 12);
    const idx = new Uint16Array(n * 6);
    const C = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let i = 0; i < n; i++) {
      const L = lamps[i];
      for (let c = 0; c < 4; c++) {
        const o = i * 4 + c;
        center[o * 3] = L[0]; center[o * 3 + 1] = L[1]; center[o * 3 + 2] = L[2];
        pos[o * 3] = L[0]; pos[o * 3 + 1] = L[1]; pos[o * 3 + 2] = L[2];
        corner[o * 2] = C[c][0]; corner[o * 2 + 1] = C[c][1];
        col[o * 4] = L[3]; col[o * 4 + 1] = L[4]; col[o * 4 + 2] = L[5]; col[o * 4 + 3] = L[6];
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCenter', new THREE.BufferAttribute(center, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 40;     // billboards grow with distance
    return geo;
  }

  // -------------------------------------------------------------------------- baked per-vertex cavity AO + sun visibility
  _bakeShading(ext, getH) {
    const geo = ext.geo, pos = geo.attributes.position.array, nv = pos.length / 3;
    const C = 24, M = 320, x0 = this._bbMin.x - M, z0 = this._bbMin.z - M;
    const gw = Math.ceil((this._bbMax.x - this._bbMin.x + 2 * M) / C) + 1, gh = Math.ceil((this._bbMax.z - this._bbMin.z + 2 * M) / C) + 1;
    const grid = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = x0 + i * C, z = z0 + j * C;
      let h = Math.max(getH(x, z), 0);
      if (x > this._bbMin.x - 20 && x < this._bbMax.x + 20 && z > this._bbMin.z - 20 && z < this._bbMax.z + 20) {
        this._project(x, z);
        if (_loc.s >= 0 && _loc.s <= this.length) { const ye = this._extHeight(_loc.s, _loc.x); if (ye > -1e8) h = Math.max(h, _loc.fy + ye); }
      }
      grid[j * gw + i] = h;
    }
    const H = (x, z) => {
      const u = clamp((x - x0) / C, 0, gw - 1.001), v = clamp((z - z0) / C, 0, gh - 1.001), i = u | 0, j = v | 0, a = u - i, b = v - j;
      const k = j * gw + i;
      return (grid[k] * (1 - a) + grid[k + 1] * a) * (1 - b) + (grid[k + gw] * (1 - a) + grid[k + gw + 1] * a) * b;
    };
    const sun = this.world && this.world.sunDirection ? this.world.sunDirection : new THREE.Vector3(-0.53, 0.37, -0.76).normalize();
    const hl = Math.hypot(sun.x, sun.z) || 1, sdx = sun.x / hl, sdz = sun.z / hl, tanE = sun.y / hl;
    const STEPS = [10, 20, 34, 52, 76, 108, 150, 205, 280, 380, 520, 700];
    const shade = new Float32Array(nv * 2);
    const nrm = geo.attributes.normal.array;
    for (let q = 0; q < nv; q++) {
      const px = pos[q * 3], py = pos[q * 3 + 1], pz = pos[q * 3 + 2];
      // start the march off the surface along the normal so a vertex doesn't shadow itself
      const sx = px + nrm[q * 3] * 3, sy = py + nrm[q * 3 + 1] * 3 + 1.5, sz = pz + nrm[q * 3 + 2] * 3;
      let maxE = -1;
      for (let k = 0; k < STEPS.length; k++) {
        const d = STEPS[k];
        const e = (H(sx + sdx * d, sz + sdz * d) - sy) / d - tanE;
        if (e > maxE) maxE = e;
      }
      const vis = 1 - smoothstep(-0.045, 0.045, maxE);
      const m40 = (H(px + 40, pz) + H(px - 40, pz) + H(px, pz + 40) + H(px, pz - 40)) * 0.25;
      const m120 = (H(px + 120, pz) + H(px - 120, pz) + H(px, pz + 120) + H(px, pz - 120)) * 0.25;
      const ao = clamp(0.62 + (py - m40) * 0.0045 + (py - m120) * 0.0016, 0.22, 1);
      shade[q * 2] = ao; shade[q * 2 + 1] = vis;
    }
    geo.setAttribute('aShade', new THREE.BufferAttribute(shade, 2));
  }

  // -------------------------------------------------------------------------- World uniforms (shared) with fallbacks
  _worldUniforms(world) {
    const W = (world && world.uniforms) || {};
    const tex = (rgba) => {
      const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
      t.needsUpdate = true; this._fallbackTex.push(t); return t;
    };
    const pick = (name, make) => (W[name] && 'value' in W[name] && W[name].value !== undefined && W[name].value !== null ? W[name] : { value: make() });
    const U = {
      uSkyLut: pick('uSkyLut', () => {
        const c = world && world.hazeColor ? world.hazeColor : new THREE.Color(0.35, 0.42, 0.55);
        const t = new THREE.DataTexture(new Float32Array([c.r, c.g, c.b, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        t.needsUpdate = true; this._fallbackTex.push(t); return t;
      }),
      uSunDir: pick('uSunDir', () => (world && world.sunDirection) || new THREE.Vector3(-0.53, 0.37, -0.76).normalize()),
      uFogMie: pick('uFogMie', () => 8e-5), uFogRay: pick('uFogRay', () => 0.7e-5),
      uCloudTex: pick('uCloudTex', () => tex([0, 128, 128, 0])), uCloudOff: pick('uCloudOff', () => new THREE.Vector2()),
      uCloudAlt: pick('uCloudAlt', () => 2400), uCloudCut: pick('uCloudCut', () => 0.49),
      uDetail: pick('uDetail', () => tex([128, 128, 128, 128])), uBiome: pick('uBiome', () => tex([128, 0, 0, 255])),
      uSunColor: pick('uSunColor', () => new THREE.Vector3(2.7, 1.75, 1.0)),
      uSkyAmb: pick('uSkyAmb', () => new THREE.Vector3(0.20, 0.29, 0.48)),
      uGroundAmb: pick('uGroundAmb', () => new THREE.Vector3(0.18, 0.13, 0.09)),
      uTime: pick('uTime', () => 0),
    };
    this._ownTime = !(W.uTime && 'value' in W.uTime);
    return U;
  }

  // -------------------------------------------------------------------------- per-frame camera hook (no allocations)
  _onCamera(camera) {
    if (!camera || !camera.matrixWorld) return;
    const e = camera.matrixWorld.elements, camX = e[12], camY = e[13], camZ = e[14];
    let inside = 0;
    if (camX > this._bbMin.x - 50 && camX < this._bbMax.x + 50 && camZ > this._bbMin.z - 50 && camZ < this._bbMax.z + 50) {
      this._project(camX, camZ);
      const s = _loc.s, L = this.length;
      if (s > -40 && s < L + 40) {
        const k = flareK(clamp(s, 0, L), L);
        // haze blend: 0 at 40 m outside a portal .. 1 at 120 m inside (outline grown 4 m so wall-hugging cameras count)
        if (boreInside(_loc.x, camY - _loc.fy - BORE_B * k, k, -4)) inside = smoothstep(-40, 120, Math.min(s, L - s));
      }
    }
    this._intU.uCamIn.value = inside;
    // next frame: draw the surface the camera is surrounded by first (early-z for the other one and the terrain)
    this.interior.renderOrder = inside > 0 ? 0.5 : 0.6;
    this.exterior.renderOrder = inside > 0 ? 0.6 : 0.5;
    if (this._ownTime) this._timeU.value = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
  }

  // -------------------------------------------------------------------------- analytic queries
  // Projects world XZ onto the path: writes _loc.s (arc length; < 0 before the south portal, > length past the north
  // one), _loc.x (lateral, + = right of the south->north direction), _loc.fy (floor height there), _loc.i (sample).
  _project(px, pz) {
    const n = this._n, SX = this._sx, SZ = this._sz;
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i += 16) { const dx = px - SX[i], dz = pz - SZ[i], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
    { const dx = px - SX[n - 1], dz = pz - SZ[n - 1], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = n - 1; } }
    const i0 = Math.max(0, best - 16), i1 = Math.min(n - 1, best + 16);
    for (let i = i0; i <= i1; i++) { const dx = px - SX[i], dz = pz - SZ[i], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
    const dx = px - SX[best], dz = pz - SZ[best];
    let along = dx * this._tx[best] + dz * this._tz[best];
    if (best > 0 && best < n - 1) along = clamp(along, -this._ds, this._ds);
    _loc.i = best;
    _loc.s = best * this._ds + along;
    _loc.x = dx * -this._tz[best] + dz * this._tx[best];
    const u = clamp(_loc.s / this._ds, 0, n - 1.000001), k = u | 0;
    _loc.fy = this._fy[k] + (this._fy[k + 1] - this._fy[k]) * (u - k);
    return _loc;
  }

  // ridge surface height above the local floor at (s, lateral x); -1e9 outside the ridge footprint
  _extHeight(s, x) {
    const fj = clamp(s / this._rds, 0, this._nr - 1.000001), j = fj | 0, a = fj - j;
    const fx = (x + XW) / DX;
    if (fx < 0 || fx > NX - 1.000001) return -1e9;
    const i = fx | 0, b = fx - i, T = this._tab;
    const r0 = j * NX + i, r1 = r0 + NX;
    const y00 = T[r0], y01 = T[r0 + 1], y10 = T[r1], y11 = T[r1 + 1];
    if (y00 < -1e8 || y01 < -1e8 || y10 < -1e8 || y11 < -1e8) return -1e9;   // ridge edge: buried, terrain handles it
    return (y00 * (1 - b) + y01 * b) * (1 - a) + (y10 * (1 - b) + y11 * b) * a;
  }

  /** True when the point is inside the bore (between the portals, within the cross-section). */
  isInside(p) {
    if (p.x < this._bbMin.x || p.x > this._bbMax.x || p.z < this._bbMin.z || p.z > this._bbMax.z) return false;
    this._project(p.x, p.z);
    const s = _loc.s, L = this.length;
    if (s < 0 || s > L) return false;
    const k = flareK(s, L);
    return boreInside(_loc.x, p.y - _loc.fy - BORE_B * k, k, 0);
  }

  /**
   * Sphere vs tunnel: 'wall' if a sphere of `radius` at `p` touches the bore walls, the portal faces or the rock mass,
   * else null. Cheap (bounding-box reject, ~70 distance tests, one table lookup); call it every frame for every jet.
   */
  collide(p, radius = 6) {
    const r = radius;
    if (p.x < this._bbMin.x - r || p.x > this._bbMax.x + r || p.z < this._bbMin.z - r || p.z > this._bbMax.z + r ||
        p.y < this._bbMin.y - r || p.y > this._bbMax.y + r) return null;
    this._project(p.x, p.z);
    const s = _loc.s, x = _loc.x, y = p.y - _loc.fy, L = this.length;
    if (s < -r || s > L + r) return null;
    const sc = clamp(s, 0, L), k = flareK(sc, L), yc = y - BORE_B * k;
    // portal faces lean back above the crown: the rock starts that far inside the end planes
    const lean = clamp((y - 2 * BORE_B * k - 6) * LEAN_SLOPE, 0, LEAN_MAX);
    const front = Math.max(lean - s, s - (L - lean));          // > 0: in front of a portal face
    if (front > 0) {
      if (front >= r) return null;
      const rr = Math.sqrt(r * r - front * front);              // sphere section on the face plane
      if (boreInside(x, yc, k, rr)) return null;                 // passes through the opening
      return y < this._extHeight(sc, x) + rr ? 'wall' : null;
    }
    if (boreInside(x, yc, k, r)) return null;                    // in the bore, clear of the walls
    if (boreInside(x, yc, k, 0)) return 'wall';                  // in the bore, touching a wall
    return y < this._extHeight(s, x) + r ? 'wall' : null;        // in / on the rock mass
  }

  /** 0..1 along the bore (south portal = 0) when near it (in it, or approaching within 400 m of a portal), else -1. */
  closestPathT(p) {
    if (p.x < this._bbMin.x - 500 || p.x > this._bbMax.x + 500 || p.z < this._bbMin.z - 500 || p.z > this._bbMax.z + 500) return -1;
    this._project(p.x, p.z);
    const s = _loc.s, L = this.length;
    if (s < -400 || s > L + 400) return -1;
    const k = flareK(clamp(s, 0, L), L);
    if (Math.abs(_loc.x) > 160 || Math.abs(p.y - _loc.fy - BORE_B * k) > 160) return -1;
    return clamp(s / L, 0, 1);
  }

  /**
   * Keeps a point (e.g. the chase camera) inside the bore cross-section with `margin` metres of clearance when it lies
   * between the portals. Returns true if the point was moved. Intended use: when the player isInside(), call it on the
   * camera position so it never pokes through the rock.
   */
  constrain(p, margin = 3) {
    if (p.x < this._bbMin.x || p.x > this._bbMax.x || p.z < this._bbMin.z || p.z > this._bbMax.z) return false;
    this._project(p.x, p.z);
    const s = _loc.s, L = this.length;
    if (s < 0 || s > L) return false;
    const k = flareK(s, L), cy = BORE_B * k, yc = p.y - _loc.fy - cy, x = _loc.x;
    if (boreInside(x, yc, k, margin)) return false;
    const th = Math.atan2(yc, x), rho = Math.hypot(x, yc);
    const rt = Math.max(boreR(th, k) - margin * 1.15, 1);
    if (rho <= rt) return false;
    const f2 = rt / rho, nx = x * f2, ny = yc * f2;
    const i = _loc.i, rx = -this._tz[i], rz = this._tx[i];
    p.x += rx * (nx - x); p.z += rz * (nx - x); p.y += ny - yc;
    return true;
  }

  /** Portal descriptors: bore centre at each opening and the unit direction pointing into the bore. */
  get entrances() {
    if (!this._entrances) {
      this._entrances = this._ends.map((E, i) => ({
        name: i === 0 ? 'south' : 'north',
        position: new THREE.Vector3(E.x, E.fy + E.cy, E.z),
        direction: new THREE.Vector3(-E.ox, 0, -E.oz),
      }));
    }
    return this._entrances;
  }

  dispose() {
    for (const m of this.meshes || []) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
    for (const m of [this._extMat, this._intMat, this._lightMat]) if (m) m.dispose();
    for (const t of this._fallbackTex) t.dispose();
    this._fallbackTex.length = 0;
    this.meshes = [];
  }
}
