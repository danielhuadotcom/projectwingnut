import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// =====================================================================================================
// AfterburnerFX — jet exhaust: hot nozzle interior, military-power core flame, afterburner plume with
// Mach (shock) diamonds. ONE draw call per jet for all nozzles (24 triangles for a twin).
//
// Technique (per nozzle, all inside one merged mesh):
//   * A convex bounding frustum ("hull") per nozzle, rendered BACK faces only. The fragment shader rebuilds
//     the view ray in nozzle space, gets the entry point analytically from the same 6 planes (t0, clamped to
//     the camera so it also works from inside the plume) and the exit point from the rasterised back face (t1).
//     The hull is sized from uniforms in the vertex shader (short in military power, long in afterburner).
//   * Bright, sharp features are ANALYTIC line integrals of anisotropic blobs (closed form, alias-free from any
//     angle, no stepping noise): white-hot exit core, tapering potential-core streaks, the shock-diamond train
//     (lens profile with a hot pinpoint), and the faint blue-violet military-power flame.
//   * The orange-amber envelope is a short jittered ray march (3..10 steps: few across the plume, more along
//     it; samples crowd the nozzle end on axial rays) of an analytic density - rounded-rectangle -> round
//     cross-section, taper, axial fade, shock-cell beading - displaced by advected 3D noise (a procedural
//     32^3 RGBA8 texture, 1-3 fetches per step by quality). Emission-absorption: long axial paths (chase /
//     rear views) saturate at an orange source radiance instead of piling up to white.
//   * The hull's start cap sits slightly inside the nozzle exit and doubles as the glowing nozzle-interior
//     plate (seen through the opening, occluded by the nozzle walls via the depth test, veiled by the flame).
//   * Sub-pixel safety: hull inflated to >= 1.5 px, blobs widened to >= 1 px with flux preserved, and a
//     footprint LOD that swaps the ray march for 3 analytic envelope blobs at range -> stable glowing dots.
//   * Linear HDR output (core ~10-20, envelope ~1-3), soft-saturated per fragment so axial views / a camera
//     inside the plume cannot blow out; near-camera fade; additive, depthWrite off, depthTest on, fog off.
// Shared: geometry per nozzle layout (ref-counted cache), noise texture, base material (cloned per instance,
// identical source -> one GL program). No per-frame allocations; time inputs are wrapped on the CPU (float32-safe).
// =====================================================================================================

const R_REF = Math.sqrt(0.5 * 0.3);   // equivalent radius of the reference nozzle (halfWidth 0.5, halfHeight 0.3)
const PLATE_DEPTH = 0.12;              // glow plate / hull start, inside the exit plane (reference metres)
const AB_LEN = 10.8;                   // afterburner envelope length for the reference nozzle (m), long PW-style trail
const AB_HULL_LEN = 11.4;              // hull length in full afterburner (reference m)

// hull cross-section multipliers: start = (halfWidth, halfHeight) * xy, end = (R, R) * zw   (R = sqrt(hw*hh))
const HULL_MIL = [1.22, 1.30, 0.80, 0.86];
const HULL_AB = [1.42, 1.70, 0.95, 1.10];
const KICK_GROW = 0.12;                // light-up kick: plume grows by this fraction at the kick peak
const FLOW = 14;                       // turbulence advection speed (reference m/s, visual not physical)

const QUALITY = {          // envelope ray-march steps: min (across the plume) .. max (along it, chase/rear views)
  low: { steps: 5, minSteps: 3, q: 0, diamonds: 4 },
  medium: { steps: 7, minSteps: 4, q: 1, diamonds: 5 },
  high: { steps: 10, minSteps: 6, q: 2, diamonds: 5 },
  ultra: { steps: 10, minSteps: 8, q: 3, diamonds: 6 },
};

const f = (v) => { const s = String(v); return s.includes('.') || s.includes('e') ? s : s + '.0'; };

/* ─────────────────────────────────────────── shaders ─────────────────────────────────────────── */

const VERT = /* glsl */`
#define R_REF ${f(R_REF)}
#define PLATE_DEPTH ${f(PLATE_DEPTH)}
attribute vec4 aCorner;   // xy: corner signs (-1/+1), z: ring (0 = start cap inside the nozzle, 1 = far end), w: 1 = plate
attribute vec4 aNozzle;   // xyz: exit-plane centre (object space), w: nozzle index
attribute vec2 aSize;     // halfWidth, halfHeight of the exit
uniform vec3 uCamObj;     // camera position in object space
uniform vec4 uHull;       // start (xy, x halfWidth/halfHeight), end (zw, x R)
uniform float uLen;       // hull length (reference metres)
uniform float uPixAngle;  // radians per pixel
varying vec3 vPos;        // position relative to the nozzle exit centre
flat varying vec3 vCam;   // camera relative to the nozzle exit centre
flat varying vec4 vNoz;   // halfWidth, halfHeight, scale, isPlate
flat varying float vSeed;
void main() {
  float a0 = aSize.x, b0 = aSize.y;
  float R = sqrt(a0 * b0);
  float s = R / R_REF;
  vec3 cam = uCamObj - aNozzle.xyz;
  float infl = 1.5 * uPixAngle * max(length(cam), 1.0);
  bool start = aCorner.z < 0.5;
  vec2 he = start ? vec2(a0, b0) * uHull.xy : vec2(R) * uHull.zw;
  float z = start ? -PLATE_DEPTH * s : uLen * s + infl;
  vec3 p = vec3(aCorner.xy * (he + infl), z);
  vPos = p;
  vCam = cam;
  vNoz = vec4(a0, b0, s, aCorner.w);
  vSeed = aNozzle.w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + aNozzle.xyz, 1.0);
}
`;

const FRAG = /* glsl */`
#define PLATE_DEPTH ${f(PLATE_DEPTH)}
#define SQRT_PI 1.7724539
#define ENV_ABS 0.4        // envelope self-absorption per unit emitted radiance (saturates at 1/ENV_ABS)
uniform float uTime;      // flicker clock (s, wrapped on the CPU)
uniform vec3 uAdv;        // turbulence advection phases (noise-tile units, wrapped on the CPU in double precision)
uniform float uHeat;      // nozzle metal heat 0..1 (lagged throttle)
uniform float uAB;        // afterburner mix 0..1 (ramped)
uniform float uMil;       // military-power flame amount 0..1
uniform float uMilLen;    // military flame length (reference m)
uniform float uLen;       // hull length (reference m)
uniform vec4 uHull;
uniform vec4 uEnv;        // x: envelope length (ref m), y: width mult, z: brightness, w: turbulence
uniform vec4 uDia;        // x: AB diamond intensity, y: spacing (ref m), z: count, w: mil diamond intensity
uniform float uSteps;     // max envelope ray-march steps (0 = analytic LOD only)
uniform float uMinSteps;  // min steps (short paths across the plume)
uniform float uLod;       // 0 = ray march, 1 = analytic envelope
uniform float uQuality;   // 0 low .. 3 ultra
uniform float uPixAngle;
uniform float uIntensity;
uniform float uDebug;
uniform highp sampler3D uNoise;

varying vec3 vPos;
flat varying vec3 vCam;
flat varying vec4 vNoz;
flat varying float vSeed;

float sat(float x) { return clamp(x, 0.0, 1.0); }
// emitters closer than a few metres to the camera fade out (no blow-out when flying through a plume)
float nearFade(float t) { return smoothstep(0.6, 3.5, t); }

// Line integral along ro + t*rd of an axis-aligned blob centred at c with radii sg (density = exp(-Q)).
// k morphs the profile from a gaussian ellipsoid (0) to a lens (1: round at the sides, pointed at the axial
// tips), evaluated at the ray's closest approach. pk adds a hot pinpoint (half-radius gaussian) over a dimmer
// halo. fp = pixel footprint: radii widened to >= ~1 px with the flux kept (no sub-pixel sparkle at range).
float blob(vec3 ro, vec3 rd, vec3 c, vec3 sg, float k, float pk, float fp, out float ts) {
  vec3 is = inversesqrt(sg * sg + fp * fp);
  vec3 w = (ro - c) * is;
  vec3 v = rd * is;
  float A = dot(v, v);
  ts = -dot(w, v) / A;
  vec3 q = w + v * ts;
  float qr = dot(q.xy, q.xy);
  float qz = q.z * q.z;
  float lz = 1.0 - k * 0.78 * sat(sqrt(qz) * 0.42);
  float Q = qr / (lz * lz) + qz;
  float flux = (sg.x * sg.y * sg.z) * (is.x * is.y * is.z);
  float e1 = exp(-Q);
  float e4 = e1 * e1; e4 *= e4;
  return flux * SQRT_PI * inversesqrt(A) * (e1 + pk * (1.15 * e4 - 0.58 * e1)) * sat(1.0 - Q * 0.15);
}

vec3 envColor(float T) { return mix(vec3(1.0, 0.07, 0.20), vec3(1.0, 0.30, 0.40), T); }   // pink-red envelope

void main() {
  float a0 = vNoz.x, b0 = vNoz.y, s = vNoz.z;
  float R = sqrt(a0 * b0);
  vec3 ro = vCam;
  vec3 dv = vPos - ro;
  float tHit = length(dv);
  vec3 rd = dv / max(tHit, 1e-5);
  float fp = uPixAngle * max(length(ro), 1.0);     // pixel footprint near this nozzle (object units)
  float infl = 1.5 * fp;
  float time = uTime + vSeed * 3.71;

  // ---- ray entry into the hull frustum (identical parameters to the vertex shader) ----
  float z0 = -PLATE_DEPTH * s;
  float z1 = uLen * s + infl;
  vec2 h0 = vec2(a0, b0) * uHull.xy + infl;
  vec2 h1 = vec2(R) * uHull.zw + infl;
  vec2 kk = (h1 - h0) / (z1 - z0);                 // side-plane slopes
  vec2 dd = h0 - kk * z0;                          // |x| - kk.x*z <= dd.x ,  |y| - kk.y*z <= dd.y
  float tIn = -1e5;
  if (rd.z > 1e-5) tIn = (z0 - ro.z) / rd.z;
  else if (rd.z < -1e-5) tIn = (z1 - ro.z) / rd.z;
  float den = rd.x - kk.x * rd.z;
  if (den < 0.0) tIn = max(tIn, (dd.x - ro.x + kk.x * ro.z) / den);
  den = -rd.x - kk.x * rd.z;
  if (den < 0.0) tIn = max(tIn, (dd.x + ro.x + kk.x * ro.z) / den);
  den = rd.y - kk.y * rd.z;
  if (den < 0.0) tIn = max(tIn, (dd.y - ro.y + kk.y * ro.z) / den);
  den = -rd.y - kk.y * rd.z;
  if (den < 0.0) tIn = max(tIn, (dd.y + ro.y + kk.y * ro.z) / den);
  float t0 = max(tIn, 0.0);
  float t1 = tHit;

  vec3 col = vec3(0.0);
  float ab = uAB;

  float ts;
  float grow = mix(0.55, 1.0, ab);                   // the shock train stretches out as the burner lights
  float sp = mix(0.62, uDia.y, ab) * s * grow;       // shock-cell spacing
  float zf = mix(0.50, 1.00, ab) * s * grow;         // first diamond

  // ---- afterburner: white-hot exit core + tapering potential-core streak ----
  if (ab > 0.002) {
    float I = blob(ro, rd, vec3(0.0, 0.0, 0.22 * s), vec3(0.50 * a0, 0.50 * b0, 0.30 * s), 0.5, 0.0, fp, ts);
    col += vec3(1.0, 0.80, 0.78) * (42.0 * ab * I * nearFade(ts));
    I = blob(ro, rd, vec3(0.0, 0.0, 1.25 * s * grow), vec3(0.40 * a0, 0.44 * b0, 0.90 * s), 0.0, 0.0, fp, ts);
    vec3 pc = (ro + rd * ts) / s;
    float nc = textureLod(uNoise, vec3(pc.xy * 0.8 + vSeed * 0.37, pc.z * 0.32 - uAdv.x), 0.0).g;
    col += vec3(1.0, 0.42, 0.46) * (3.5 * ab * I * (0.4 + 1.2 * nc) * nearFade(ts));
    I = blob(ro, rd, vec3(0.0, 0.0, 3.2 * s * grow), vec3(0.30 * R, 0.30 * R, 1.30 * s), 0.0, 0.0, fp, ts);
    pc = (ro + rd * ts) / s;
    nc = textureLod(uNoise, vec3(pc.xy * 0.8 + 0.5 + vSeed * 0.37, pc.z * 0.32 - uAdv.x), 0.0).r;
    col += vec3(1.0, 0.24, 0.32) * (2.0 * ab * I * (0.3 + 1.4 * nc) * nearFade(ts));
  }

  // ---- shock diamonds: AB train (white-yellow -> amber, fading downstream); faint violet cells at mil ----
  float milD = uMil * uDia.w;
  if (ab * uDia.x + milD > 0.01) {
    float cnt = mix(3.0, uDia.z, ab);
    float kz = mix(0.12, 0.20, ab) * s;
    float kr = mix(0.75, 1.0, ab) * 0.28;
    for (int k = 0; k < 6; k++) {
      float fk = float(k);
      float wk = sat(cnt - fk);
      if (wk <= 0.0) break;
      float zk = zf + sp * fk * (1.0 - 0.025 * fk) + 0.03 * s * sin(time * (9.0 + 2.1 * fk) + fk * 1.9);
      float sh = 1.0 - 0.08 * fk;
      vec2 sxy = mix(vec2(a0, b0), vec2(R), sat(fk / 3.0)) * (kr * sh);
      float I = blob(ro, rd, vec3(0.0, 0.0, zk), vec3(sxy, kz * (1.0 - 0.05 * fk)), 1.0, 1.0, fp, ts);
      float amp = (ab * uDia.x * pow(0.74, fk) + milD * pow(0.75, fk)) * wk
                * (1.0 + 0.12 * sin(time * (23.0 + 3.7 * fk) + fk * 2.7));
      vec3 cAB = mix(vec3(1.0, 0.86, 0.80), vec3(1.0, 0.45, 0.50), sat(fk / 4.5));
      col += mix(vec3(0.50, 0.40, 1.0), cAB, ab) * (amp * I * nearFade(ts));
    }
  }

  // ---- military power: short, faint, translucent blue-violet core flame with a little shimmer ----
  if (uMil > 0.002) {
    float Lm = uMilLen * s;
    float I1 = blob(ro, rd, vec3(0.0, 0.0, 0.35 * Lm), vec3(0.45 * a0, 0.45 * b0, 0.36 * Lm), 0.2, 0.0, fp, ts);
    float n1 = nearFade(ts);
    float I2 = blob(ro, rd, vec3(0.0, 0.0, 0.85 * Lm), vec3(0.28 * a0, 0.32 * b0, 0.50 * Lm), 0.4, 0.0, fp, ts);
    vec3 pm = (ro + rd * ts) / s;
    float nm = textureLod(uNoise, vec3(pm.xy * 1.1 + vSeed * 0.37, pm.z * 0.5 - uAdv.x), 0.0).g;
    col += (vec3(0.28, 0.38, 1.0) * (I1 * n1) + vec3(0.40, 0.34, 1.0) * (I2 * (0.45 + 1.1 * nm) * nearFade(ts))) * (uMil * 0.40);
  }

  // ---- afterburner envelope: orange-amber, turbulent, tapering (ray march, or analytic LOD at range) ----
  float trans = 1.0;                                 // envelope transmittance along the ray (veils the plate)
  if (ab > 0.002) {
    vec3 env = vec3(0.0);
    float Le = uEnv.x * s;
    float Rr = R * 0.92;
    if (uLod < 0.999 && uSteps > 0.5 && t1 > t0) {
      // step count follows the path length: few across the plume, up to uSteps along it
      float n = clamp(ceil((t1 - t0) / (0.28 * s)), min(uMinSteps, uSteps), uSteps);
      float L = t1 - t0;
      float wa = -0.75 * rd.z;                         // t(u) = t0 + L*(u + wa*u*(1-u)): samples crowd the nozzle end
      float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      vec2 nofs = vec2(vSeed * 0.37);
      for (int i = 0; i < 10; i++) {
        if (float(i) >= n) break;
        float uu = (float(i) + jit) / n;
        float t = t0 + L * (uu + wa * uu * (1.0 - uu));
        float dt = L / n * (1.0 + wa * (1.0 - 2.0 * uu));
        vec3 p = ro + rd * t;
        float zn = p.z / Le;
        if (zn < -0.02 || zn > 1.0) continue;
        float rf = smoothstep(0.0, 0.5, zn);
        // shock cells: the jet boundary and brightness pulse with the diamond train, dying out downstream
        float u = (p.z - zf) / sp;
        float cellA = sat(1.0 - u * 0.2) * step(-0.5, u);
        float cell = cos(6.2831853 * u * (1.0 + 0.025 * u)) * cellA;
        float w = uEnv.y * (1.0 + 0.12 * smoothstep(0.0, 0.15, zn)) * (1.0 - 0.6 * smoothstep(0.25, 1.0, zn)) * (1.0 + 0.04 * cell);
        vec2 he = mix(vec2(a0, b0), vec2(Rr), rf) * w;
        vec2 uv = p.xy / he;
        float q = mix(max(abs(uv.x), abs(uv.y)), length(uv), 0.35 + 0.65 * rf);
        vec3 pr = p / s;
        vec4 nA = textureLod(uNoise, vec3(pr.xy * 0.75 + nofs, pr.z * 0.32 - uAdv.x), 0.0);
        float nB = nA.g;
        if (uQuality > 0.5) nB = textureLod(uNoise, vec3(pr.xy * 0.75 + nofs + 0.37, pr.z * 0.32 - uAdv.y + 0.21), 0.0).g;
        float turb = (nA.r - 0.5) * 1.3 + (nB - 0.5) * 0.7;
        if (uQuality > 2.5) turb += (textureLod(uNoise, vec3(pr.xy * 1.9 + nofs, pr.z * 0.8 - uAdv.z), 0.0).b - 0.5) * 0.45;
        float qq = q * (1.0 + turb * uEnv.w * (0.3 + 0.9 * zn));
        float d = smoothstep(1.05, 0.1, qq);
        // never let density touch the hull planes (no visible seams)
        vec2 hh = h0 + kk * (p.z - z0);
        d *= smoothstep(1.0, 0.86, max(abs(p.x) / hh.x, abs(p.y) / hh.y));
        float axial = smoothstep(-0.02, 0.03, zn) * pow(max(1.0 - zn, 0.0), 1.3);
        float T = sat((1.0 - qq) * 1.3 + 0.15 * cell) * (1.0 - 0.55 * zn);
        float pch = smoothstep(0.15, 0.85, nB);
        // emission-absorption: long (axial) paths saturate at the source radiance instead of piling up to white
        float a = d * axial * (0.2 + 1.6 * pch * pch) * (1.0 + 0.15 * cell) * nearFade(t) * dt;
        env += envColor(T) * (a * trans);
        trans *= exp(-a * uEnv.z * ENV_ABS * ab);
      }
    }
    if (uLod > 0.001) {
      vec3 e = vec3(0.0);
      for (int j = 0; j < 3; j++) {
        float zn = 0.14 + 0.27 * float(j);
        float rf = smoothstep(0.0, 0.5, zn);
        float w = uEnv.y * (1.0 + 0.12 * smoothstep(0.0, 0.15, zn)) * (1.0 - 0.6 * smoothstep(0.25, 1.0, zn));
        vec2 he = mix(vec2(a0, b0), vec2(Rr), rf) * w;
        float I = blob(ro, rd, vec3(0.0, 0.0, zn * Le), vec3(he * 0.6, 0.15 * Le), 0.0, 0.0, fp, ts);
        e += envColor(0.55 * (1.0 - 0.55 * zn)) * (I * pow(1.0 - zn, 1.3) * 1.16 * nearFade(ts));
      }
      float me = max(e.r, max(e.g, e.b)) * uEnv.z * ENV_ABS * ab + 1e-6;
      e *= (1.0 - exp(-me)) / me;
      env = mix(env, e, uLod);
      trans = mix(trans, exp(-me), uLod);
    }
    col += env * (uEnv.z * ab);
  }

  // ---- glowing nozzle interior (the hull's start cap, seen through the exit opening) ----
  if (vNoz.w > 0.5) {
    vec2 pa = vec2(a0, b0) + fp;                     // opening, widened to >= 1 px at range
    vec2 uv = vPos.xy / pa;
    float e = max(abs(uv.x), abs(uv.y));
    float soft = clamp(fp / min(pa.x, pa.y), 0.05, 1.0);
    float mask = 1.0 - smoothstep(1.0 - soft, 1.0, e);
    float sq = mix(e, length(uv) * 0.7071, 0.5);    // rounded-rectangle radius, 0 centre .. ~1 rim
    float cv = sat(-rd.z);                          // 1 = looking straight up the nozzle
    // hot core (turbine / flame holder) visible head-on, cooler liner toward the rim and at oblique angles
    float core = (1.0 - smoothstep(0.05, 0.95, sq)) * mix(0.35, 1.0, cv * cv);
    float rings = sat(1.0 - fp * 6.0 / R) * (0.3 + 0.7 * ab);   // flame-holder rings, only resolvable up close
    float ringMod = 1.0 - (0.2 + 0.2 * ab) * rings * (0.5 + 0.5 * cos(sq * 26.0 - ab * time * 2.0));
    float hk = pow(uHeat, 2.2);
    vec3 milC = mix(vec3(1.0, 0.17, 0.03) * 0.9, vec3(1.0, 0.33, 0.075) * 3.2, core) * hk;
    vec3 abC = mix(vec3(1.0, 0.30, 0.30) * 1.0, vec3(1.0, 0.72, 0.62) * 8.0, core);
    float flick = 1.0 + 0.06 * ab * sin(time * 41.0) + 0.03 * sin(time * 17.0 + 1.3);
    col += mix(milC, abC, ab) * (ringMod * mask * flick * trans * (a0 * b0) / (pa.x * pa.y));
  }

  col *= uIntensity;
  if (uDebug > 0.5) col += vec3(0.05, 0.0, 0.10);
  // soft saturation: linear up to 10, asymptotically 26 (axial views / stacked emitters cannot explode)
  float m = max(col.r, max(col.g, col.b));
  if (m > 10.0) col *= (10.0 + 16.0 * (1.0 - exp(-(m - 10.0) / 16.0))) / m;
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ─────────────────────────────────────── shared resources ─────────────────────────────────────── */

const _geoCache = new Map();          // layout key -> { geo, refs }
let _noiseTex = null, _noiseRefs = 0;
let _baseMat = null;

// scratch (no per-frame allocations)
const _inv = new THREE.Matrix4();
const _cam = new THREE.Vector3();
const _v2 = new THREE.Vector2();

function layoutKey(nozzles) {
  return nozzles.map((n) => [n.position.x, n.position.y, n.position.z, n.halfWidth, n.halfHeight].map((v) => v.toFixed(4)).join(',')).join('|');
}

// Per nozzle: 8 hull corners (ring 0 at the plate depth, ring 1 at the far end) + 4 separate start-cap corners
// flagged as the glow plate. Outward CCW winding; the material renders BackSide.
function buildGeometry(nozzles) {
  const n = nozzles.length, V = 12;
  const corner = new Float32Array(n * V * 4), noz = new Float32Array(n * V * 4);
  const size = new Float32Array(n * V * 2), pos = new Float32Array(n * V * 3);
  const index = [];
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const kMax = 1 + KICK_GROW;
  for (let i = 0; i < n; i++) {
    const nz = nozzles[i], a0 = nz.halfWidth, b0 = nz.halfHeight, R = Math.sqrt(a0 * b0), s = R / R_REF;
    const c = nz.position;
    for (let v = 0; v < V; v++) {
      const ring = v >= 4 && v < 8 ? 1 : 0, plate = v >= 8 ? 1 : 0, cc = C[v % 4], o = i * V + v;
      corner.set([cc[0], cc[1], ring, plate], o * 4);
      noz.set([c.x, c.y, c.z, i], o * 4);
      size.set([a0, b0], o * 2);
      // placeholder = maximum extent (bounds / fallback); the vertex shader computes the live hull
      const hx = ring ? R * HULL_AB[2] * kMax : a0 * HULL_AB[0] * kMax;
      const hy = ring ? R * HULL_AB[3] * kMax : b0 * HULL_AB[1] * kMax;
      const z = ring ? AB_HULL_LEN * 1.12 * kMax * s : -PLATE_DEPTH * s;
      pos.set([c.x + cc[0] * hx, c.y + cc[1] * hy, c.z + z], o * 3);
    }
    const b = i * V;
    index.push(b + 8, b + 11, b + 10, b + 8, b + 10, b + 9);    // start cap / plate (normal -Z)
    index.push(b + 4, b + 5, b + 6, b + 4, b + 6, b + 7);       // far cap (normal +Z)
    for (let k = 0; k < 4; k++) {                               // sides
      const p = k, q = (k + 1) % 4;
      index.push(b + p, b + q, b + 4 + q, b + p, b + 4 + q, b + 4 + p);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 4));
  geo.setAttribute('aNozzle', new THREE.BufferAttribute(noz, 4));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 2));
  geo.setIndex(index);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.boundingSphere.radius += 4.0;   // margin for the >= 1.5 px hull inflation of distant jets
  return geo;
}

function acquireGeometry(nozzles) {
  const key = layoutKey(nozzles);
  let e = _geoCache.get(key);
  if (!e) { e = { geo: buildGeometry(nozzles), refs: 0 }; _geoCache.set(key, e); }
  e.refs++;
  return { key, geo: e.geo };
}

function releaseGeometry(key) {
  const e = _geoCache.get(key);
  if (!e) return;
  if (--e.refs <= 0) { e.geo.dispose(); _geoCache.delete(key); }
}

// 32^3 periodic value noise, 4 independent channels: R/B 4 cells per tile, G/A 8 cells per tile.
function acquireNoise() {
  _noiseRefs++;
  if (_noiseTex) return _noiseTex;
  const N = 32, chans = [[4, 0x9e3779b9], [8, 0x85ebca6b], [4, 0xc2b2ae35], [8, 0x27d4eb2f]];
  const data = new Uint8Array(N * N * N * 4);
  const vals = new Float32Array(N * N * N);
  const i0 = new Int32Array(N), i1 = new Int32Array(N), wt = new Float32Array(N);
  for (let c = 0; c < 4; c++) {
    const F = chans[c][0];
    const lat = new Float32Array(F * F * F);
    let h = chans[c][1] >>> 0;
    for (let i = 0; i < lat.length; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; lat[i] = h / 4294967296; }
    for (let x = 0; x < N; x++) {                  // per-axis lattice cell + quintic weight (same for x, y, z)
      const fx = (x * F) / N, ix = Math.floor(fx), t = fx - ix;
      i0[x] = ix % F; i1[x] = (ix + 1) % F; wt[x] = t * t * t * (t * (t * 6 - 15) + 10);
    }
    let lo = Infinity, hi = -Infinity, o = 0;
    for (let z = 0; z < N; z++) {
      const z0 = i0[z] * F * F, z1 = i1[z] * F * F, tz = wt[z];
      for (let y = 0; y < N; y++) {
        const y0 = i0[y] * F, y1 = i1[y] * F, ty = wt[y];
        const a00 = z0 + y0, a01 = z0 + y1, a10 = z1 + y0, a11 = z1 + y1;
        for (let x = 0; x < N; x++, o++) {
          const x0 = i0[x], x1 = i1[x], tx = wt[x];
          const b00 = lat[a00 + x0] + (lat[a00 + x1] - lat[a00 + x0]) * tx;
          const b01 = lat[a01 + x0] + (lat[a01 + x1] - lat[a01 + x0]) * tx;
          const b10 = lat[a10 + x0] + (lat[a10 + x1] - lat[a10 + x0]) * tx;
          const b11 = lat[a11 + x0] + (lat[a11 + x1] - lat[a11 + x0]) * tx;
          const c0 = b00 + (b01 - b00) * ty, c1 = b10 + (b11 - b10) * ty;
          const v = c0 + (c1 - c0) * tz;
          vals[o] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    const sc = 255 / Math.max(1e-6, hi - lo);      // stretch to the full 8-bit range
    for (let i = 0; i < vals.length; i++) data[i * 4 + c] = Math.round((vals[i] - lo) * sc);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  _noiseTex = tex;
  return tex;
}

function releaseNoise() {
  if (--_noiseRefs <= 0 && _noiseTex) { _noiseTex.dispose(); _noiseTex = null; _noiseRefs = 0; }
}

function baseMaterial() {
  if (_baseMat) return _baseMat;
  _baseMat = new THREE.ShaderMaterial({
    name: 'AfterburnerFX',
    uniforms: {
      uTime: { value: 0 }, uAdv: { value: new THREE.Vector3() }, uHeat: { value: 0 }, uAB: { value: 0 }, uMil: { value: 0 },
      uMilLen: { value: 1 }, uLen: { value: 1 }, uHull: { value: new THREE.Vector4(...HULL_MIL) },
      uEnv: { value: new THREE.Vector4(AB_LEN, 1, 3.2, 0.9) }, uDia: { value: new THREE.Vector4(80, 1.08, 5, 0.45) },
      uSteps: { value: 10 }, uMinSteps: { value: 6 }, uLod: { value: 0 }, uQuality: { value: 2 }, uPixAngle: { value: 0.002 },
      uIntensity: { value: 1 }, uDebug: { value: 0 },
      uCamObj: { value: new THREE.Vector3() }, uNoise: { value: null },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    fog: false,
    lights: false,
    toneMapped: false,
  });
  return _baseMat;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);

/* ─────────────────────────────────────────── AfterburnerFX ─────────────────────────────────────────── */

// Afterburner / exhaust plume for a jet. Local frame matches the jet: nose -Z, exhaust flows toward +Z.
// nozzles: [{ position: Vector3 (local center of the nozzle exit plane), halfWidth (m, local X), halfHeight (m, local Y) }]
export class AfterburnerFX {
  constructor({ nozzles = [
    { position: new THREE.Vector3(-0.85, 0, 7.6), halfWidth: 0.55, halfHeight: 0.32 },
    { position: new THREE.Vector3(0.85, 0, 7.6), halfWidth: 0.55, halfHeight: 0.32 },
  ], quality = 'high' } = {}) {
    this.object3d = new THREE.Group();
    this.object3d.name = 'afterburner';
    // sanitised copy of the layout
    this.nozzles = (Array.isArray(nozzles) ? nozzles : []).filter((n) => n && n.position).map((n) => ({
      position: new THREE.Vector3(+n.position.x || 0, +n.position.y || 0, +n.position.z || 0),
      halfWidth: Math.max(0.02, +n.halfWidth || 0.5),
      halfHeight: Math.max(0.02, +n.halfHeight || 0.3),
    }));
    this.quality = 'high';
    this._qual = QUALITY.high;
    this.debugHull = false;

    // simulation state
    this._first = true;
    this._time = 0;
    this._seed = Math.random() * 100;
    this._thr = 0; this._heat = 0;
    this._abOn = false; this._abRamp = 0; this._kick = 0;

    this.mesh = null;
    if (!this.nozzles.length) return;

    const { key, geo } = acquireGeometry(this.nozzles);
    this._key = key;
    this._mat = baseMaterial().clone();               // same source -> same GL program, own uniforms
    this._mat.uniforms.uNoise.value = acquireNoise();
    this._u = this._mat.uniforms;
    this.mesh = new THREE.Mesh(geo, this._mat);
    this.mesh.name = 'afterburnerPlume';
    this.mesh.visible = false;
    this.mesh.raycast = () => {};                      // never pickable
    this.object3d.add(this.mesh);

    // reference point / size for the footprint LOD
    this._center = new THREE.Vector3();
    let rSum = 0;
    for (const n of this.nozzles) { this._center.add(n.position); rSum += Math.sqrt(n.halfWidth * n.halfHeight); }
    this._center.multiplyScalar(1 / this.nozzles.length);
    this._R = rSum / this.nozzles.length;

    this.mesh.onBeforeRender = (renderer, scene, camera) => this._beforeRender(renderer, camera);
    this.setQuality(quality);
  }

  update(dt, { throttle = 0, afterburner = false, speed = 0, time } = {}) {
    if (!this.mesh) return;
    dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    const thrIn = Number.isFinite(throttle) ? clamp01(throttle) : 0;
    const abOn = !!afterburner;
    this._time = Number.isFinite(time) ? time : this._time + dt;

    if (this._first) {   // spawn: start in the steady state, no kick
      this._first = false;
      this._thr = this._heat = thrIn; this._abOn = abOn; this._abRamp = abOn ? 1 : 0;
    }
    // engine spool (fast) and nozzle metal heat (slow cool-down)
    this._thr += (thrIn - this._thr) * (1 - Math.exp(-dt / 0.15));
    this._heat += (Math.max(thrIn, this._abRamp) - this._heat) * (1 - Math.exp(-dt / (thrIn > this._heat ? 0.35 : 0.9)));
    // afterburner: ~0.25 s ramp each way, quick brightness kick on light-up
    if (abOn && !this._abOn && this._abRamp < 0.35) this._kick = 1;
    this._abOn = abOn;
    this._abRamp = clamp01(this._abRamp + (abOn ? dt : -dt) / 0.25);
    this._kick *= Math.exp(-dt / 0.12);
    if (this._kick < 1e-3) this._kick = 0;

    const r = this._abRamp, ab = r * r * (3 - 2 * r), kick = this._kick, thr = this._thr;
    const sf = clamp01((Number.isFinite(speed) ? speed : 0) / 460);
    const milVis = smooth(0.38, 0.62, thr);
    const mil = smooth(0.42, 0.95, thr) * (1 - ab);
    const milLen = 1.0 + 0.7 * smooth(0.5, 0.97, thr);
    const grow = 1 + KICK_GROW * kick;
    const abLen = AB_LEN * (1 + 0.08 * sf) * grow;

    const U = this._u;
    // time-derived shader inputs, kept small for float32: flicker clock wraps every 10 min (an invisible phase jump),
    // turbulence advection phases wrap per noise tile (seamless, the texture repeats) at a constant flow speed
    const T = this._time + this._seed;
    U.uTime.value = T % 600;
    U.uAdv.value.set(fract(T * FLOW * 0.32), fract(T * FLOW * 0.55), fract(T * FLOW * 0.94));
    U.uHeat.value = clamp01(this._heat);
    U.uAB.value = ab;
    U.uMil.value = mil;
    U.uMilLen.value = milLen;
    U.uIntensity.value = 1 + 0.9 * kick;
    U.uLen.value = lerp(0.25 + milVis * 1.9 * milLen, AB_HULL_LEN * (1 + 0.08 * sf), ab) * grow;
    U.uEnv.value.set(lerp(milLen * 0.8, abLen, ab), grow, 4.4, 1.3);
    U.uHull.value.set(
      lerp(HULL_MIL[0], HULL_AB[0], ab) * grow, lerp(HULL_MIL[1], HULL_AB[1], ab) * grow,
      lerp(HULL_MIL[2], HULL_AB[2], ab) * grow, lerp(HULL_MIL[3], HULL_AB[3], ab) * grow);
    U.uDebug.value = this.debugHull ? 1 : 0;

    // nothing visible (cold, idle, burner out): skip the draw entirely
    this.mesh.visible = this.debugHull || thr > 0.03 || this._heat > 0.03 || ab > 0.002;
  }

  setQuality(q) {
    const Q = QUALITY[q] || QUALITY.high;
    this.quality = QUALITY[q] ? q : 'high';
    this._qual = Q;
    if (!this._u) return;
    this._u.uQuality.value = Q.q;
    this._u.uDia.value.z = Q.diamonds;
    this._u.uSteps.value = Q.steps;
    this._u.uMinSteps.value = Q.minSteps;
  }

  // per render: camera in object space (CPU double precision), pixel angle, footprint LOD
  _beforeRender(renderer, camera) {
    const U = this._u;
    _inv.copy(this.mesh.matrixWorld).invert();
    _cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
    U.uCamObj.value.copy(_cam);
    const rt = renderer.getRenderTarget();
    // the viewport, not the allocation: PostFX renders the scene into a renderScale sub-rectangle of its target
    let h = rt ? rt.viewport.w : renderer.getDrawingBufferSize(_v2).y;
    const p5 = camera.projectionMatrix.elements[5];
    const pa = camera.isPerspectiveCamera && p5 > 0 && h > 0 ? 2 / (p5 * h) : 0.002;
    U.uPixAngle.value = pa;
    // footprint of one pixel at the nozzles relative to the nozzle size
    const ratio = (pa * _cam.distanceTo(this._center)) / this._R;
    const base = this._qual.steps;
    let steps = ratio > 0.35 ? Math.max(3, Math.round(base * 0.6)) : base;
    const lod = clamp01((ratio - 0.9) / 0.8);
    if (lod >= 1) steps = 0;
    U.uSteps.value = steps;
    U.uLod.value = lod;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.object3d.removeFromParent();
    if (this.mesh) {
      this.object3d.remove(this.mesh);
      this.mesh.onBeforeRender = () => {};
      this._mat.dispose();
      releaseGeometry(this._key);
      releaseNoise();
      this.mesh = null;
    }
  }
}
