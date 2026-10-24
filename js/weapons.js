import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// =================================================================================================
// PROJECT WINGNUT — js/weapons.js  (export class Weapons)
//
// Cannon tracers, homing missiles, countermeasure flares (with missile spoofing), GPU particle FX
// (smoke / fire / spark streaks), explosions with shockwave rings, aircraft debris, collisions + damage callbacks.
//
// Draw calls are constant (max 9, each object hides itself when idle), independent of the action:
//   smoke Points (premultiplied alpha "normal" blend: smoke, dust, spray, fireballs that cool to smoke)
//   fire Points (additive: flames, flashes, muzzle flashes)   spark streaks (additive instanced quads)
//   tracers (InstancedMesh, additive)   shockwave rings (instanced, additive)
//   missile bodies (InstancedMesh, MeshStandardMaterial)   motor flames (InstancedMesh, additive)
//   debris chunks (InstancedMesh, MeshStandardMaterial)   flare heads (Points, additive; trails reuse smoke + sparks)
//
// Flares: deployFlares(aircraft) ejects a burst of decoys over ~0.5 s. Each flare is a CPU decoy object
// ({ position, velocity, alive, health }) that missile guidance tracks like an aircraft, plus two GPU particles written
// once at ejection (the burning head sprite and a spark streak for its bright tail): the flare's flight (linear drag +
// gravity) has the same closed form on the CPU (_updateFlares) and in the shaders (wnIntegrate), so what is drawn and
// the decoy the missiles chase are the same point without any per-frame upload (only the smoke trail is emitted per
// frame). Missiles that target the deploying aircraft (within flareDecoyRange, or launched at it during
// the next flareProtectTime seconds) switch to a flare; they burst on it (flareFuse) or overshoot and lose it, and
// go ballistic when it burns out.
//
// Teams: update(dt, list, camera, teamTargets) takes optional per-team target lists ({ team: [targets] }, built by the
// game when units spawn or die, never per frame): rounds and fuses of a shooter whose team has an entry test only that
// list (e.g. the player's team: hostiles only, so no friendly fire), everyone else tests `list`. Targets flagged
// `immortal` (squadmates) take no damage: a round that reaches one stops there with a visible hit, a missile airbursts
// harmlessly (one that chases an immortal in no list airbursts on reaching it: a single extra test against its own
// target). Aircraft with `holdFire === true` never fire (fireGun / fireMissile refuse: the game's attack slots). An
// optional damageFilter(target, damage, shooter, kind, missile) lets the game adjust damage before it is applied.
//
// Missiles carry per-shot kinematics, fuse and seeker blind range (maxSpeed, boostTime, drag, life, fuse, blind, blindTime;
// like turnScale), reset to the missile* settings on every launch: the onMissileLaunch callback may give a shot its own profile (the game's player-team missiles).
// At low frame rates (dt > 1/50 s) missiles fly in up to 3 substeps of <= 1/60 s (guidance, motion and the swept fuse per
// substep, targets placed back along their velocity to where they were at each substep's end), so steering and hit rates
// match 60 fps.
//
// flakPuff(position) is the light AA burst (brief flash, a few sparks, a lingering dark smoke puff: ~17 particles,
// explode(p, 0.3) is ~80). delayEffect(kind, position, ...) runs an explosion / aircraft death / terrain impact a frame
// or more later, to spread a big effect bundle over frames.
//
// Particles are simulated on the GPU: the CPU writes a particle once, when it is spawned, into a ring
// buffer (interleaved, partial bufferSubData of only the freshly written range). The vertex shader
// evaluates position / size / colour analytically from (time - birth), initial velocity, linear drag
// and vertical acceleration. Nothing allocates per frame in steady state (module-scope scratch,
// pre-allocated pools, positional-argument spawn functions).
//
// Output is linear HDR radiance (no colorspace / tonemapping chunks); hot things are > 1 so bloom
// picks them up.
// =================================================================================================

const AIRCRAFT_RADIUS = 7;      // m — collision sphere (same as aircraft.js AIRCRAFT_RADIUS; hardcoded on purpose)
const G = 9.81;

const SMOKE_STRIDE = 24;        // floats per smoke particle (see _puff for the layout)
const POINT_STRIDE = 20;        // floats per additive glow particle (see _glow)
const SPARK_STRIDE = 16;        // floats per spark streak
const RING_STRIDE = 8;          // floats per shockwave ring
const RING_CAPACITY = 24;
const DEBRIS_CAPACITY = 72;
const MISSILE_CAPACITY = 48;
const EMITTER_CAPACITY = 64;
const DELAYED_CAPACITY = 24;
const FLARE_STRIDE = 16;        // floats per flare head sprite (see _ejectFlare for the layout)
const FLARE_CAPACITY = 128;     // flare decoys alive at once (CPU pool) = flare head sprite ring (GPU)
const BURST_CAPACITY = 16;      // flare bursts being ejected / inside their protection window at once
const BURST_MAX = 16;           // flares per burst (upper clamp of flareCount)
const NOZZLE_OFFSET = 1.64;     // m from missile origin to the nozzle exit (+Z local)

const KIND_TENDRIL = 0;         // emitter kinds
const KIND_COLUMN = 1;
const FX_SECONDARY = 0, FX_EXPLODE = 1, FX_DEATH = 2, FX_IMPACT = 3;   // delayed effect kinds (delayEffect)

// ---- module-scope scratch (zero per-frame allocation) -------------------------------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _vp = new THREE.Vector4();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Vector3();
const EMPTY = [];

// Allocation-free random numbers: Math.random() boxes a HeapNumber per call in V8 (thousands of particles per second
// = a steady trickle of garbage). rnd() reads a pre-filled table; it is tiny, so every JIT tier inlines it and the
// value stays unboxed. Period 16384 draws (several seconds of heavy spawning) — invisible in particle jitter.
const RAND_SIZE = 16384;
const RAND_TABLE = new Float32Array(RAND_SIZE);   // filled by the first Weapons constructor
let _ri = 0;
function rnd() { return RAND_TABLE[_ri = (_ri + 1) & (RAND_SIZE - 1)]; }
const rand = (a, b) => a + rnd() * (b - a);

/** Uniform random unit vector written into `out`. */
function randDir(out) {
  const u = rnd() * 2 - 1, th = rnd() * 6.283185307, s = Math.sqrt(1 - u * u);
  out.x = s * Math.cos(th); out.y = u; out.z = s * Math.sin(th);
  return out;
}

// =================================================================================================
// GLSL
// =================================================================================================
const GLSL_FOG_VERT = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
float wnFog(float depth) {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
  #else
    return smoothstep(fogNear, fogFar, depth);
  #endif
#else
  return 0.0;
#endif
}
`;

const GLSL_FOG_FRAG = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
#else
  const vec3 fogColor = vec3(0.0);
#endif
`;

const GLSL_INTEGRATE = /* glsl */`
// Exact solution of dv/dt = -k v + (0, gy, 0): world position after t seconds.
vec3 wnIntegrate(vec3 p0, vec3 v0, float t, float drag, float gy) {
  float k = max(drag, 0.05);
  float e = (1.0 - exp(-k * t)) / k;
  return p0 + v0 * e + vec3(0.0, gy * (t - e) / k, 0.0);
}
`;

// ---- smoke / dust / fireball points (premultiplied alpha) ----------------------------------------
const SMOKE_VERT = /* glsl */`
uniform float uTime;
uniform float uScreenH;
uniform float uMinPx;
uniform float uMaxPx;
uniform vec3 uWind;
uniform vec3 uSunDir;
attribute float aBirth;
attribute vec4 aVel;     // xyz initial velocity, w life
attribute vec4 aColor;   // rgb albedo, a peak opacity
attribute vec4 aSize;    // x size0, y size1 (diameters, m), z drag (1/s), w vertical accel (m/s^2, + = buoyant)
attribute vec4 aParams;  // x fire fraction of life, y fire intensity, z noise amount, w seed
attribute vec4 aStretch; // xyz world stretch vector (m; 0 = round puff), w fade-in time (s)
varying vec4 vColor;
varying vec4 vInfo;      // x life fraction, y fire temperature 0..1, z noise amount, w seed
varying vec3 vEll;       // xy screen-space major axis (unit), z minor/major ratio
varying vec3 vSun;
varying float vFireI;
varying float vFog;
${GLSL_FOG_VERT}
${GLSL_INTEGRATE}
void main() {
  float age = uTime - aBirth;
  float life = aVel.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float x = age / life;
  vec3 p = wnIntegrate(position, aVel.xyz, age, aSize.z, aSize.w) + uWind * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.5);
  float g = 1.0 - x;
  float size = mix(aSize.x, aSize.y, 1.0 - g * g * g);           // fast early expansion, then slows
  float pxScale = uScreenH * 0.5 * projectionMatrix[1][1];
  float px = size * pxScale / depth;
  // trail puffs are stretched along their emitter's path (screen-space ellipse) so a fast trail stays continuous
  vec2 axis = vec2(1.0, 0.0);
  float dl = 0.0;
  if (dot(aStretch.xyz, aStretch.xyz) > 0.0) {
    vec3 dv = (modelViewMatrix * vec4(aStretch.xyz, 0.0)).xyz;
    vec2 d = pxScale * (dv.xy * depth + mv.xy * dv.z) / (depth * depth);   // linearised projection of the stretch
    dl = length(d);
    if (dl > 1e-3) axis = d / dl;
  }
  float minorPx = max(px, uMinPx);
  float majorPx = max(minorPx, px + dl);
  float cpx = min(majorPx, uMaxPx);
  float energy = min(1.0, px / minorPx) * min(1.0, (px + dl) / majorPx);   // keep sub-pixel puffs from looking bold
  float nearFade = smoothstep(1.5, 1.5 + size * 0.8, depth);     // don't paint the lens when flying through
  float fade = clamp(age / max(aStretch.w, 0.01), 0.0, 1.0) * pow(g, 1.4);
  vEll = vec3(axis, minorPx / majorPx);
  vColor = vec4(aColor.rgb, aColor.a * fade * energy * nearFade);
  float fireT = aParams.x > 0.0 ? clamp(1.0 - x / aParams.x, 0.0, 1.0) : 0.0;
  vInfo = vec4(x, fireT, aParams.z, aParams.w);
  vFireI = aParams.y * energy * nearFade;
  vSun = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vFog = wnFog(depth);
  gl_PointSize = cpx;
  gl_Position = projectionMatrix * mv;
}
`;

const SMOKE_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
varying vec4 vColor;
varying vec4 vInfo;
varying vec3 vEll;
varying vec3 vSun;
varying float vFireI;
varying float vFog;
${GLSL_FOG_FRAG}
// blackbody-ish ramp tuned for ACES: 1 -> ~[13,5.5,1.6] white-yellow core, 0.6 -> orange, 0.35 -> red, 0 -> black
vec3 wnFireRamp(float t) {
  t = clamp(t, 0.0, 1.15);
  float t2 = t * t, t4 = t2 * t2;
  return vec3(13.0 * pow(t, 1.4), 5.5 * t4 * t2, 1.6 * t4 * t4 * t4);
}
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  pc.y = -pc.y;
  vec2 perp = vec2(-vEll.y, vEll.x);
  vec2 uv = vec2(dot(pc, vEll.xy), dot(pc, perp) / vEll.z);       // ellipse-normalised coordinates
  float r2 = dot(uv, uv);
  if (r2 >= 1.0) discard;
  float seed = vInfo.w;
  float ang = seed * 6.2832 + vInfo.x * (seed - 0.5) * 3.0;     // slow churn over the life
  float cs = cos(ang), sn = sin(ang);
  vec2 ruv = vec2(cs * uv.x - sn * uv.y, sn * uv.x + cs * uv.y);
  vec4 n1 = texture2D(uNoise, ruv * 0.30 + vec2(seed * 7.31, seed * 3.17));
  vec4 n2 = texture2D(uNoise, ruv * 0.55 + vec2(seed * 1.93, seed * 5.71) + 0.37);
  float lumps = n1.b * 0.55 + n2.a * 0.45;                      // cellular "cauliflower" lumps
  float fbm = n1.r * 0.6 + n2.g * 0.4;
  float n = mix(0.5, lumps * 0.65 + fbm * 0.35, vInfo.z);
  float r = sqrt(r2);
  float dens = clamp((1.0 - r) * 1.8 - 0.3 + (n - 0.5) * 1.8 * vInfo.z, 0.0, 1.0);
  dens *= smoothstep(1.0, 0.7, r);
  dens = dens * dens * (3.0 - 2.0 * dens);
  float T = vInfo.y;
  // fire is a little translucent in the core, but its ragged edges carry soot (dark rim instead of red-over-sky pink)
  float cover = vColor.a * mix(dens, sqrt(dens), 0.6 * T) * (1.0 - 0.3 * smoothstep(0.0, 0.5, T));
  float heat = T * (0.35 + 0.8 * n) * (0.6 + 0.5 * (1.0 - r));             // hot lumpy core, cooler edges
  vec3 fire = wnFireRamp(heat) * (vFireI * dens);
  if (cover < 0.002 && heat < 0.02) discard;
  // cheap lighting: sphere-impostor normal bumped by the noise, wrapped Lambert + forward scattering
  vec2 n2d = vEll.xy * uv.x + perp * uv.y;
  vec3 N = normalize(vec3(n2d + (vec2(n1.r, n2.g) - 0.5) * 0.9 * vInfo.z, sqrt(max(1.0 - r2, 0.0)) + 0.25));
  float wrap = clamp(dot(N, vSun) * 0.55 + 0.45, 0.0, 1.0);
  float occl = mix(0.55, 1.05, n);
  float fwd = pow(clamp(-vSun.z, 0.0, 1.0), 5.0) * (1.0 - dens) * 1.2;
  vec3 lit = vColor.rgb * (uAmbient * occl + uSunColor * (wrap * wrap * occl + fwd));
  vec3 col = lit * cover + fire;
  col = mix(col, fogColor * cover, vFog);
  gl_FragColor = vec4(col, cover);
}
`;

// ---- additive glow points (fire, flashes) ---------------------------------------------------------
const GLOW_VERT = /* glsl */`
uniform float uTime;
uniform float uScreenH;
uniform float uMinPx;
uniform float uMaxPx;
attribute float aBirth;
attribute vec4 aVel;     // xyz velocity, w life
attribute vec4 aColor;   // rgb radiance, a intensity multiplier
attribute vec4 aSize;    // size0, size1, drag, vertical accel
attribute vec4 aParams;  // x cooling 0..1, y unused, z noise amount, w seed
varying vec3 vColor;
varying vec4 vInfo;      // x life fraction, y cooling amount now, z noise, w seed
varying float vFog;
${GLSL_FOG_VERT}
${GLSL_INTEGRATE}
void main() {
  float age = uTime - aBirth;
  float life = aVel.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float x = age / life;
  vec3 p = wnIntegrate(position, aVel.xyz, age, aSize.z, aSize.w);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  float size = mix(aSize.x, aSize.y, 1.0 - (1.0 - x) * (1.0 - x));
  float px = size * uScreenH * 0.5 * projectionMatrix[1][1] / max(depth, 0.5);
  float cpx = clamp(px, uMinPx, uMaxPx);
  float energy = min(1.0, (px * px) / (cpx * cpx));
  float nearFade = smoothstep(0.5, 0.5 + size * 0.5, depth);
  vColor = aColor.rgb * (aColor.a * pow(1.0 - x, 1.5) * energy * nearFade);
  vInfo = vec4(x, aParams.x * x, aParams.z, aParams.w);
  vFog = wnFog(depth);
  gl_PointSize = cpx;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */`
uniform sampler2D uNoise;
varying vec3 vColor;
varying vec4 vInfo;
varying float vFog;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 >= 1.0) discard;
  float seed = vInfo.w;
  float ang = seed * 6.2832 + vInfo.x * 2.0;
  float cs = cos(ang), sn = sin(ang);
  vec2 ruv = vec2(cs * uv.x - sn * uv.y, sn * uv.x + cs * uv.y);
  float n = texture2D(uNoise, ruv * 0.4 + vec2(seed * 5.3, seed * 2.1)).b;
  float soft = 1.0 - r2;
  soft *= soft;
  float core = exp(-r2 * 9.0);
  float m = soft * mix(1.0, 0.25 + 1.5 * n, vInfo.z) * 0.7 + core * 0.55;
  float c = vInfo.y;
  vec3 col = vColor * vec3(1.0, 1.0 - 0.6 * c, 1.0 - 0.85 * c) * (m * (1.0 - vFog));
  gl_FragColor = vec4(col, 0.0);
}
`;

// ---- spark streaks (instanced camera-facing quads between p(t) and p(t - trail)) -------------------
const SPARK_VERT = /* glsl */`
uniform float uTime;
uniform float uScreenH;
uniform float uMinPx;
attribute vec4 iA;   // xyz p0, w birth
attribute vec4 iB;   // xyz v0, w life
attribute vec4 iC;   // rgb radiance, w width (m)
attribute vec4 iD;   // x drag, y vertical accel, z trail (s), w seed
varying vec3 vColor;
varying vec2 vQuad;
varying float vFog;
${GLSL_FOG_VERT}
${GLSL_INTEGRATE}
void main() {
  float age = uTime - iA.w;
  float life = iB.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float x = age / life;
  vec3 head = wnIntegrate(iA.xyz, iB.xyz, age, iD.x, iD.y);
  vec3 tail = wnIntegrate(iA.xyz, iB.xyz, max(age - iD.z, 0.0), iD.x, iD.y);
  vec3 hv = (modelViewMatrix * vec4(head, 1.0)).xyz;
  vec3 tv = (modelViewMatrix * vec4(tail, 1.0)).xyz;
  vec3 P = mix(hv, tv, position.x);
  vec3 d = hv - tv;
  float dl = length(d);
  vec3 dn = dl > 1e-5 ? d / dl : vec3(0.0);
  vec3 side = cross(d, P);
  float sl = length(side);
  side = sl > 1e-7 ? side / sl : vec3(1.0, 0.0, 0.0);
  float depth = max(-P.z, 0.5);
  float pxPerM = uScreenH * 0.5 * projectionMatrix[1][1] / depth;
  float w = iC.w;
  float k = max(1.0, uMinPx / (w * pxPerM));                    // never thinner than uMinPx ...
  P += side * (position.y * 0.5 * w * k) + dn * ((0.5 - position.x) * w * k);
  vColor = iC.rgb * vec3(1.0, 1.0 - 0.55 * x, 1.0 - 0.8 * x) * (pow(1.0 - x, 1.2) / k);  // ... but energy-conserving
  vQuad = position.xy;
  vFog = wnFog(depth);
  gl_Position = projectionMatrix * vec4(P, 1.0);
}
`;

const SPARK_FRAG = /* glsl */`
varying vec3 vColor;
varying vec2 vQuad;
varying float vFog;
void main() {
  float across = 1.0 - vQuad.y * vQuad.y;
  float along = 1.0 - vQuad.x;
  float m = across * (0.2 + 0.8 * along * along);
  gl_FragColor = vec4(vColor * (m * (1.0 - vFog)), 0.0);
}
`;

// ---- tracers (InstancedMesh of unit boxes, local -Z = direction of travel) -------------------------
const TRACER_VERT = /* glsl */`
uniform float uScreenH;
uniform float uMinPx;
uniform float uWidth;
attribute vec2 aTracer;  // x brightness, y seed
varying float vT;
varying float vI;
varying float vFog;
${GLSL_FOG_VERT}
void main() {
  vec4 cv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float depth = max(-cv.z, 0.5);
  float pxPerM = uScreenH * 0.5 * projectionMatrix[1][1] / depth;
  float k = max(1.0, uMinPx / (uWidth * pxPerM));               // keep distant tracers >= uMinPx wide
  vec3 p = position;
  p.xy *= k;
  vT = position.z + 0.5;                                         // 0 = head, 1 = tail
  vI = aTracer.x * pow(k, -0.35) * (0.9 + 0.2 * fract(aTracer.y * 7.0));  // brighter than physical when far (readability)
  vFog = wnFog(depth);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`;

const TRACER_FRAG = /* glsl */`
uniform vec3 uHead;
uniform vec3 uTail;
varying float vT;
varying float vI;
varying float vFog;
void main() {
  vec3 col = mix(uHead, uTail, vT) * ((1.0 - 0.3 * vT) * vI * (1.0 - vFog));
  gl_FragColor = vec4(col, 0.0);
}
`;

// ---- missile motor flame (InstancedMesh lathe cone, local +Z = exhaust direction) ------------------
const FLAME_VERT = /* glsl */`
uniform float uTime;
attribute vec2 aFlame;   // x intensity, y seed
varying float vZ;
varying float vRim;
varying float vI;
varying float vFog;
${GLSL_FOG_VERT}
void main() {
  vec3 p = position;
  float fl = 0.84 + 0.11 * sin(uTime * 71.0 + aFlame.y * 37.0) + 0.07 * sin(uTime * 157.0 + aFlame.y * 11.0);
  p.z *= fl;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  vec3 n = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
  vRim = abs(dot(n, normalize(-mv.xyz)));
  vZ = position.z;
  vI = aFlame.x;
  vFog = wnFog(-mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const FLAME_FRAG = /* glsl */`
varying float vZ;
varying float vRim;
varying float vI;
varying float vFog;
void main() {
  vec3 col = mix(vec3(18.0, 13.0, 8.0), vec3(10.0, 4.0, 0.9), smoothstep(0.0, 0.35, vZ));
  col = mix(col, vec3(2.5, 0.5, 0.06), smoothstep(0.35, 1.0, vZ));
  float a = pow(vRim, 1.5) * pow(1.0 - vZ, 0.8) * vI;
  gl_FragColor = vec4(col * (a * (1.0 - vFog)), 0.0);
}
`;

// ---- flare heads (additive points; one sprite per flare for its whole burn) ----------------------------
// The sprite flies the flare's exact trajectory (same closed form as the CPU decoy), so it needs no updates.
const FLARE_VERT = /* glsl */`
uniform float uTime;
uniform float uScreenH;
uniform float uMinPx;
uniform float uMaxPx;
attribute float aBirth;
attribute vec4 aVel;     // xyz initial velocity, w burn time (s)
attribute vec4 aParams;  // x diameter (m), y drag (1/s), z vertical accel (m/s^2), w seed
attribute vec4 aColor;   // rgb warm radiance (linear), a white-core multiplier
varying vec3 vColor;
varying float vCore;
varying float vFog;
${GLSL_FOG_VERT}
${GLSL_INTEGRATE}
void main() {
  float age = uTime - aBirth;
  float life = aVel.w;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float x = age / life;
  vec3 p = wnIntegrate(position, aVel.xyz, age, aParams.y, aParams.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.5);
  float s = aParams.w;
  // burn envelope: ignition pop, steady magnesium burn, sputtering burn-out over the last quarter
  float ign = smoothstep(0.0, 0.04, age);
  float pop = 1.0 + 1.3 * exp(-age * 12.0);
  float tail = 1.0 - smoothstep(0.72, 1.0, x);
  // flicker: incommensurate sines (they alias into irregular strobing at display rate) x a per-frame random step
  float fl = 0.74 + 0.13 * sin(uTime * 61.0 + s * 91.0) + 0.08 * sin(uTime * 137.0 + s * 37.0) + 0.05 * sin(uTime * 19.0 + s * 13.0);
  float h = fract(sin(floor(uTime * 30.0 + s * 7.0) * 12.9898 + s * 78.233) * 43758.5453);
  fl *= 0.8 + 0.4 * h;
  fl *= mix(1.0, 0.35 + 0.65 * h, smoothstep(0.65, 1.0, x));
  float size = aParams.x * (0.82 + 0.28 * fl) * pop;
  float pxScale = uScreenH * 0.5 * projectionMatrix[1][1];
  float px = size * pxScale / depth;
  float cpx = clamp(px, uMinPx, uMaxPx);
  float energy = min(1.0, (px * px) / (cpx * cpx));
  energy = sqrt(energy);                                         // far flares stay a little brighter (readability)
  float nearFade = smoothstep(1.0, 1.0 + size * 1.5, depth);
  vColor = aColor.rgb * (ign * pop * tail * fl * energy * nearFade);
  vCore = aColor.a;
  vFog = wnFog(depth);
  gl_PointSize = cpx;
  gl_Position = projectionMatrix * mv;
}
`;

const FLARE_FRAG = /* glsl */`
varying vec3 vColor;
varying float vCore;
varying float vFog;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 >= 1.0) discard;
  float core = exp(-r2 * 28.0);                                  // magnesium-white pinpoint
  float glow = exp(-r2 * 6.0);                                   // warm inner glow
  float halo = (1.0 - r2) * (1.0 - r2);                          // soft skirt, 0 at the sprite edge
  float lum = max(vColor.r, max(vColor.g, vColor.b));
  vec3 col = vec3(lum * vCore * core) + vColor * (0.5 * glow + 0.12 * halo);
  gl_FragColor = vec4(col * (1.0 - vFog), 0.0);
}
`;

// ---- shockwave rings (instanced ring billboards, GPU-animated) ---------------------------------------
const RING_VERT = /* glsl */`
uniform float uTime;
attribute vec4 aRingA;   // xyz centre, w birth
attribute vec4 aRingB;   // x max radius, y life, z intensity, w seed
varying vec2 vLocal;
varying float vX;
varying float vI;
varying float vFog;
${GLSL_FOG_VERT}
void main() {
  float age = uTime - aRingA.w;
  float life = aRingB.y;
  if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float x = age / life;
  float R = aRingB.x * (1.0 - pow(1.0 - x, 2.2));
  vec4 cv = modelViewMatrix * vec4(aRingA.xyz, 1.0);
  cv.xy += position.xy * max(R, 0.01);                           // billboard: offset in view space
  vLocal = position.xy;
  vX = x;
  vI = aRingB.z;
  vFog = wnFog(-cv.z);
  gl_Position = projectionMatrix * cv;
}
`;

const RING_FRAG = /* glsl */`
varying vec2 vLocal;
varying float vX;
varying float vI;
varying float vFog;
void main() {
  float r = length(vLocal);
  float inner = mix(0.93, 0.84, vX);
  float band = smoothstep(inner, 0.97, r) * (1.0 - smoothstep(0.97, 1.0, r));
  float g = 1.0 - vX;
  float fade = smoothstep(0.0, 0.08, vX) * g * g * g;          // reads as a quick expanding flash, gone before it gets big
  vec3 col = vec3(1.1, 1.02, 0.92) * (band * fade * vI * (1.0 - vFog));
  gl_FragColor = vec4(col, 0.0);
}
`;

// =================================================================================================
// Helpers: procedural noise texture, geometry
// =================================================================================================

/** Tileable RGBA8 noise: R = value fBm (low freq), G = value fBm (high freq), B/A = cellular "lumps". */
function makeNoiseTexture(size) {
  let s = 0x2545f491 | 0;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const value = (cells) => {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells, iy = Math.floor(fy);
      let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
      const y0 = iy % cells, y1 = (iy + 1) % cells;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells, ix = Math.floor(fx);
        let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1], c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
        const top = a + (b - a) * tx, bot = c + (d - c) * tx;
        out[y * size + x] = top + (bot - top) * ty;
      }
    }
    return out;
  };
  const cellular = (n) => {
    const fp = new Float32Array(n * n * 2);
    for (let i = 0; i < fp.length; i++) fp[i] = rnd();
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = (x / size) * n, py = (y / size) * n, cx = Math.floor(px), cy = Math.floor(py);
        let best = 1e9;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const gx = cx + i, gy = cy + j, wx = ((gx % n) + n) % n, wy = ((gy % n) + n) % n;
            const k = (wy * n + wx) * 2;
            const dx = gx + fp[k] - px, dy = gy + fp[k + 1] - py;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) best = d2;
          }
        }
        out[y * size + x] = Math.max(0, 1 - best * 1.6);          // dome-shaped bumps
      }
    }
    return out;
  };
  const fbm = (base, oct) => {
    const acc = new Float32Array(size * size);
    let amp = 1, tot = 0;
    for (let o = 0; o < oct; o++) {
      const l = value(base << o);
      for (let i = 0; i < acc.length; i++) acc[i] += l[i] * amp;
      tot += amp; amp *= 0.5;
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= tot;
    return acc;
  };
  const norm = (a) => {
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    const k = 1 / (hi - lo || 1);
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
    return a;
  };
  const R = norm(fbm(4, 4)), Gc = norm(fbm(8, 3)), B = norm(cellular(6)), A = norm(cellular(11));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = R[i] * 255; data[i * 4 + 1] = Gc[i] * 255; data[i * 4 + 2] = B[i] * 255; data[i * 4 + 3] = A[i] * 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Merge [geometry, [r,g,b]] parts into one non-indexed geometry with a vertex colour attribute. */
function mergeColored(parts) {
  let total = 0;
  const flat = parts.map(([g, c]) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    total += n.attributes.position.count;
    return [n, c];
  });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const [g, c] of flat) {
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c[0]; col[(o + i) * 3 + 1] = c[1]; col[(o + i) * 3 + 2] = c[2]; }
    o += cnt;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** ~3.2 m air-to-air missile, nose toward -Z, nozzle exit at z = +NOZZLE_OFFSET. */
function buildMissileGeometry() {
  const white = [0.86, 0.87, 0.86], grey = [0.55, 0.57, 0.6], dark = [0.06, 0.065, 0.07], band = [0.95, 0.62, 0.08];
  const parts = [];
  const body = new THREE.CylinderGeometry(0.11, 0.11, 2.6, 14, 1, false);
  body.rotateX(-Math.PI / 2); body.translate(0, 0, 0.2);                        // z -1.1 .. 1.5
  parts.push([body, white]);
  const nose = new THREE.ConeGeometry(0.11, 0.5, 14);
  nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -1.35);                      // tip at z = -1.6
  parts.push([nose, dark]);
  const ring = new THREE.CylinderGeometry(0.114, 0.114, 0.09, 14, 1, true);
  ring.rotateX(-Math.PI / 2); ring.translate(0, 0, -0.75);
  parts.push([ring, band]);
  const nozzle = new THREE.CylinderGeometry(0.085, 0.104, 0.14, 12, 1, true);
  nozzle.rotateX(-Math.PI / 2); nozzle.translate(0, 0, 1.57);
  parts.push([nozzle, dark]);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.BoxGeometry(0.025, 0.34, 0.46);
    fin.translate(0, 0.28, 1.2); fin.rotateZ(k * Math.PI / 2 + Math.PI / 4);
    parts.push([fin, grey]);
    const canard = new THREE.BoxGeometry(0.02, 0.2, 0.24);
    canard.translate(0, 0.21, -0.8); canard.rotateZ(k * Math.PI / 2 + Math.PI / 4);
    parts.push([canard, grey]);
  }
  return mergeColored(parts);
}

/** Unit-length flame (z 0..1 along +Z), max radius 0.13. */
function buildFlameGeometry() {
  const pts = [[0.0, 0.0], [0.09, 0.0], [0.13, 0.08], [0.12, 0.3], [0.08, 0.6], [0.035, 0.85], [0.0, 1.0]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 12);
  g.rotateX(Math.PI / 2);                                                       // lathe axis +Y -> +Z
  return g;
}

function fxMaterial(uniforms, vertexShader, fragmentShader, additive, side = THREE.FrontSide) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uniforms),
    vertexShader, fragmentShader,
    transparent: true, depthWrite: false, depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    premultipliedAlpha: true,      // Normal -> (ONE, ONE_MINUS_SRC_ALPHA), Additive -> (ONE, ONE)
    fog: true, side,
  });
}

// =================================================================================================
// ParticleRing: interleaved ring buffer with partial uploads of only what changed since the last upload
// =================================================================================================
class ParticleRing {
  constructor(capacity, stride, instanced) {
    this.cap = capacity;
    this.stride = stride;
    this.data = new Float32Array(capacity * stride);   // all zero: life = 0 -> every slot starts dead
    this.buf = instanced ? new THREE.InstancedInterleavedBuffer(this.data, stride, 1) : new THREE.InterleavedBuffer(this.data, stride);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.head = 0;
    this.pendStart = 0;          // first slot written since the last GPU upload
    this.pendCount = 0;          // slots written since the last upload (contiguous in ring order)
    this.dirty = false;
    this.live = new Float64Array(1);   // [0] = time when the last spawned particle dies (idle -> object hidden)
    this.live[0] = -1;
    this.rangeA = { start: 0, count: 0 };
    this.rangeB = { start: 0, count: 0 };
    this.buf.onUpload(() => { this.pendCount = 0; });
  }
  /** Reserve the next slot; returns its float offset (caller updates live[0]). */
  alloc() {
    const i = this.head;
    this.head = i + 1 === this.cap ? 0 : i + 1;
    if (this.pendCount === 0) this.pendStart = i;
    if (this.pendCount < this.cap) this.pendCount++;
    this.dirty = true;
    return i * this.stride;
  }
  /** Append one particle from a Float32Array record laid out like the ring ([3] = birth, [7] = life).
   *  Takes an object, not numbers, so hot emitters never box doubles whatever the JIT tier. */
  push(rec) {
    this.data.set(rec, this.alloc());
    const death = rec[3] + rec[7];
    if (death > this.live[0]) this.live[0] = death;
  }
  /** Describe the pending range(s) to the renderer (idempotent; safe to call several times per frame). */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const b = this.buf, s = this.stride, r = b.updateRanges;
    if (r) {
      r.length = 0;
      if (this.pendCount < this.cap) {
        const end = this.pendStart + this.pendCount;
        this.rangeA.start = this.pendStart * s;
        if (end <= this.cap) {
          this.rangeA.count = this.pendCount * s;
          r.push(this.rangeA);
        } else {
          this.rangeA.count = (this.cap - this.pendStart) * s;
          this.rangeB.start = 0;
          this.rangeB.count = (end - this.cap) * s;
          r.push(this.rangeA, this.rangeB);
        }
      } // else: no ranges = full upload
    }
    b.needsUpdate = true;
  }
}

// =================================================================================================
// Missile (game object). Rendering is instanced; `mesh` is a transform proxy (not added to the scene)
// whose matrix/matrixWorld are kept current, e.g. for a missile camera.
// =================================================================================================
export class Missile {
  constructor() {
    this.mesh = new THREE.Object3D();
    this.mesh.matrixAutoUpdate = false;
    this.position = this.mesh.position;          // alias
    this.quaternion = this.mesh.quaternion;      // alias
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);  // nose direction (unit)
    this.prev = new THREE.Vector3();             // position at the start of the current step
    this.owner = null;
    this.target = null;                          // Aircraft (or FlareDecoy) being guided to; null = unguided / track lost
    this.decoyedFrom = null;                     // the aircraft it was chasing before a flare spoofed it (else null)
    this.shookFrom = null;                       // the aircraft whose evasion broke its lock (breakLock; else null)
    this.unguided = false;                       // fired without a target: flies straight for its whole life
    this.groundLaunch = false;                   // fired by an `isGround` launcher (pops up, no rail drop)
    this.turnScale = 1;                          // per-shot multiplier on the turn limit (game balance hook)
    // per-shot kinematics (game balance hook like turnScale): reset to the Weapons missile* values on every launch
    this.maxSpeed = 620;                         // m/s at burnout
    this.boostTime = 2.2;                        // s of motor burn after the rail drop
    this.drag = 1.1e-4;                          // coast drag: dv/dt = -k v^2
    this.life = 6;                               // s before the self-destruct
    this.fuse = 14;                              // m proximity fuse radius
    this.blind = 90;                             // m, seeker blind range (per shot, like fuse)...
    this.blindTime = 0;                          //   or, when > 0, at most this many s of closure (min of the two)
    this.dud = false;                            // scripted miss: homes on a point missBy m beside its target, never fuses
    this.missBy = 0;
    this.missSide = 1;                           // which side of the target the dud passes (+1 / -1)
    this.lethal = false;                         // game flag (squadmate shots allowed to kill); reset on every launch
    this.alive = false;
    this.age = 0;
    this.speed = 0;
    this.boostAccel = 150;
    this.ignited = false;
    this.boosting = false;
    this.smokeAcc = 0;
    this.flameAcc = 0;
    this.seed = 0;
    this.id = 0;
  }
}

// =================================================================================================
// FlareDecoy: a burning countermeasure flare. Missile guidance tracks it exactly like an aircraft
// (position / velocity / alive / health). Pooled: never keep a reference past `alive === false`.
// =================================================================================================
export class FlareDecoy {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.alive = false;
    this.health = 0;
    this.isDecoy = true;
    this.isFlare = true;
    this.name = 'FLARE';
    this.owner = null;           // aircraft that deployed it
    this.ejected = false;        // false while still in the dispenser (it then rides along with the jet)
    this.inUse = false;          // pool bookkeeping
    this.poolIndex = -1;         //   (slot in Weapons._flarePool, pushed on the free stack when released)
    this.ejectAt = 0;            // scheduled ejection time (Weapons.time)
    this.birth = 0;              // actual ejection time = start of the burn
    this.life = 3.5;             // burn time (s)
    this.drag = 1.3;             // 1/s
    this.gy = -2 * G;            // vertical acceleration (m/s^2)
    this.side = 1;               // -1 = ejected to the left, +1 = to the right
    this.order = 0;              // 0..1 position in the burst
    this.p0 = new THREE.Vector3();
    this.v0 = new THREE.Vector3();
    this.prev = new THREE.Vector3(); // position at the previous update (start of this frame's trail segment)
    this.age = 0;                    // s since ejection
    this.smokeAcc = 0;
  }
}

class Chunk {
  constructor() {
    this.p = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.v = new THREE.Vector3();
    this.q = new THREE.Quaternion(); this.axis = new THREE.Vector3(1, 0, 0); this.spin = 0;
    this.s = new THREE.Vector3(1, 1, 1); this.tint = 0.2;
    this.age = 0; this.life = 4; this.burn = 2; this.smokeAcc = 0; this.fireAcc = 0; this.big = false;
  }
}

// =================================================================================================
// Weapons
// =================================================================================================
export class Weapons {
  /**
   * @param {THREE.Scene} scene
   * @param {object} world  needs getHeight(x,z) and sunDirection (both optional; sea level / default sun used otherwise)
   * @param {object} opts   { onHit(target, damage, shooter, kind), onKill(target, shooter), onExplosion(position, size),
   *                          onMissileLaunch(missile), smokeCapacity, fireCapacity, sparkCapacity, maxBullets }
   */
  constructor(scene, world, { onHit = null, onKill = null, onExplosion = null, onMissileLaunch = null, onDecoy = null,
    smokeCapacity = 4096, fireCapacity = 1024, sparkCapacity = 512, maxBullets = 600 } = {}) {
    this.scene = scene;
    this.world = world || null;
    if (RAND_TABLE[0] === 0) for (let i = 0; i < RAND_SIZE; i++) RAND_TABLE[i] = Math.random();   // one-time fill
    this.onHit = onHit; this.onKill = onKill; this.onExplosion = onExplosion; this.onMissileLaunch = onMissileLaunch;
    this.onDecoy = onDecoy;                  // optional: onDecoy(missile, flare, aircraft) when a flare spoofs a missile
    this.damageFilter = null;                // optional: (target, damage, shooter, kind, missile) => damage to apply
    this._teamTargets = null;                // per-team target lists for this frame (see update)
    this.time = 0;
    this.missiles = [];                      // live missiles (array identity is stable)

    // ---- tunables -------------------------------------------------------------------------------
    this.gunRate = 25;                       // rounds/s total (alternating muzzles)
    this.bulletSpeed = 950;                  // m/s, added to shooter velocity
    this.bulletLife = 1.4;                   // s (~1.6 km incl. shooter speed; despawns before long flights look odd)
    this.bulletGravity = G * 0.3;            // m/s^2 (slight drop)
    this.bulletDamage = 4;
    this.bulletRadius = AIRCRAFT_RADIUS;     // hit sphere radius (m) for shooters whose team is not in gunHitRadius
    this.gunHitRadius = { player: 16, enemy: 6 };   // m, hit sphere radius by SHOOTER team (arcade-generous for the player)
    this.gunConvergence = 600;               // m — the two muzzle streams converge at this range
    this.gunSpread = 0.0012;                 // rad, random dispersion per round
    this.tracerLength = 12;                  // m
    this.tracerWidth = 0.2;                  // m (widened on screen to >= 2 px, energy-compensated)
    this.missileCooldown = 0.6;              // s, per aircraft
    this.missileDropTime = 0.15;             // s free fall off the rail before motor ignition
    this.missileBoostTime = 2.2;             // s
    this.missileMaxSpeed = 620;              // m/s at burnout
    this.missileMinSpeed = 140;              // m/s floor while coasting
    this.missileDrag = 1.1e-4;               // coast drag: dv/dt = -k v^2
    // Air-launched guidance is pursuit-dominant (Ace Combat / Project Wingman feel): midcourse the nose chases a point
    // only a fraction of the way along the target's flight path (lagged lead pursuit), so missiles arc in behind the
    // target and a hard turn across their path makes them overshoot; over the last missileTermTime s before the blind
    // range the lead ramps to full and PN fades in, so good shots (tail chases, gentle turns, head-on) still connect.
    // Ground launches (SAMs) keep classic proportional navigation + a small pursuit bias.
    //   a = N Vc (Omega x lambda) + kp v (pursuit dir - nose dir)     (tuned with the headless missile harness)
    this.missileNavGain = 0;                 // PN constant N for air launches midcourse (0: pure lead pursuit)
    this.missilePursuitGain = 3.2;           // 1/s, pursuit gain: nose turn rate per radian of aim error
    this.missileLeadFrac = 0.2;              // midcourse: fraction of the full time-to-go lead the pursuit point uses
    this.missileTermTime = 1.0;              // s to the blind range: over this the lead ramps up to full (terminal homing)
    this.missileTermNavGain = 4;             //   and N ramps up to this (set course by the blind range; the turn cap rules it)
    this.samNavGain = 4;                     // ground launches: true PN
    this.samPursuitGain = 1.2;               //   plus a small pursuit bias toward the full lead point
    this.missileTurnRateBoost = 7;           // rad/s max while the motor burns
    this.missileTurnRateCoast = 2.5;         // rad/s asymptotic max while coasting
    this.missileSeekerCos = 0;               // cos(max off-boresight angle) = cos(90°)
    this.missileLife = 6;                    // s
    this.missileFuse = 14;                   // m proximity fuse
    this.missileLag = 0.18;                  // s, airframe response lag on the guidance command (late breaks overshoot)
    this.missileBlindRange = 90;             // m, the seeker stops steering this close (last-instant jinks cause misses)
    this.missileBlindTime = 0;               // s: when > 0, the blind range is at most this many s of closure (0 = metres only)
    this.missileBlindTailCos = 0.3;          //   (tail-aspect launches only: target velocity within ~70 deg of the line of sight,
    this.missileBlindTailRange = 1800;       //   launched within this many m)
    this.missileArmTime = 0.25;              // s before the fuse arms
    this.dudBurstRadius = 25;                // m: a dud passing this close to anyone airbursts harmlessly (never a hit)
    this.missileDamage = 65;
    this.missileSmokeRate = 90;              // puffs/s while boosting (main.js scales this with the quality tier)
    this.missileCoastSmokeRate = 55;         // puffs/s while coasting (capped at missileSmokeRate) — dense the whole flight
    this.terrainCeiling = 3200;              // m — skip getHeight() for projectiles above this altitude
    this.fxMaxDistance = 6000;               // m — skip small impact FX farther than this from the camera
    this.maxPointSize = 256;                 // px clamp for particle sprites (min is 2 px)
    // flares (deployFlares). Cooldown / count limits are the caller's job.
    this.flareCount = 10;                    // flares per burst (clamped 1..16; 8-12 reads right)
    this.flareBurstTime = 0.5;               // s over which a burst is ejected (alternating left / right)
    this.flareBurnTime = 3.5;                // s per flare (+-8 % random)
    this.flareEjectSpeedMin = 25;            // m/s relative to the jet, outward + downward
    this.flareEjectSpeedMax = 50;
    this.flareDrag = 1.3;                    // 1/s linear drag: flares bleed the jet's speed and fall away behind
    this.flareGravity = G * 2;               // m/s^2 — heavy pellets: with linear drag this gives a ~15 m/s terminal fall
    this.flareSize = 4.5;                    // m, burning-flare sprite diameter
    this.flareRadiance = 14;                 // linear radiance of the warm glow (the white core peaks around 1.6x this)
    this.flareCore = 1.0;                    // white-core multiplier
    this.flareColor = new THREE.Vector3(1.0, 0.78, 0.52);   // warm hue of the glow (linear, max component 1)
    this.flareSmokeSpacing = 3.5;            // m of flight per trail puff (+ flareSmokeRate puffs/s while it hangs)
    this.flareSmokeRate = 9;
    this.flareStreakRadiance = 12;           // bright tail right behind each flare (linear radiance at ejection)
    this.flareStreakWidth = 1.0;             // m
    this.flareStreakTime = 0.07;             // s of flight the tail spans
    this.flareDecoyRange = 4000;             // m — missiles closer than this to the deploying jet are spoofed
    this.flareProtectTime = 1.0;             // s — missiles launched at the jet this soon after deploying are spoofed too
    this.flareFuse = 12;                     // m — a spoofed missile bursts when it passes this close to its flare

    // ---- shared uniforms ------------------------------------------------------------------------
    this._noiseTex = makeNoiseTexture(128);
    this._u = {
      uTime: { value: 0 },
      uScreenH: { value: 720 },
      uMinPx: { value: 2 },
      uMaxPx: { value: 256 },
      uWind: { value: new THREE.Vector3(3, 0, 1.5) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.5).normalize() },
      uSunColor: { value: new THREE.Vector3(1.5, 1.3, 1.05) },
      uAmbient: { value: new THREE.Vector3(0.3, 0.36, 0.46) },
      uNoise: { value: this._noiseTex },
    };
    this.wind = this._u.uWind.value;              // m/s, drifts all smoke (tunable, live)
    this.smokeAmbient = this._u.uAmbient.value;   // linear radiance multiplier for smoke shadow side (live)
    this.smokeSunIntensity = 1.5;                 // sun-side smoke radiance scale (hue taken from world.sunLight if present)
    this.smokeSunColor = new THREE.Vector3(1.0, 0.87, 0.7);  // sun hue used when world.sunLight is missing (or adaptation off)
    this.smokeSunFromWorld = true;                // take the sun hue from world.sunLight.color when available

    const U = this._u;
    this._onBeforeRender = (renderer) => {        // true viewport height (render target aware) for pixel sizing
      renderer.getCurrentViewport(_vp);
      if (_vp.w > 0) U.uScreenH.value = _vp.w;
    };

    this._objects = [];
    this._initParticles(smokeCapacity, fireCapacity, sparkCapacity);
    this._initTracers(maxBullets);
    this._initMissiles();
    this._initRings();
    this._initDebris();
    this._initFlares();

    // ---- CPU-side pools -------------------------------------------------------------------------
    this._acState = new WeakMap();                // per-aircraft gun/missile state
    this._emitters = [];
    for (let i = 0; i < EMITTER_CAPACITY; i++) {
      this._emitters.push({ active: false, kind: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, dur: 0, rate: 0, acc: 0, s: 1 });
    }
    this._delayed = [];
    for (let i = 0; i < DELAYED_CAPACITY; i++) {
      this._delayed.push({ active: false, kind: FX_SECONDARY, at: 0, frame: 0, x: 0, y: 0, z: 0, s: 1, vx: 0, vy: 0, vz: 0 });
    }
    this._frameNo = 0;                            // update() calls completed (delayEffect's frame counter)
    this._dPos = new THREE.Vector3();             // delayed-effect scratch position
    this._recS = new Float32Array(SMOKE_STRIDE);  // scratch particle records (see ParticleRing.push)
    this._recG = new Float32Array(POINT_STRIDE);
    this._recK = new Float32Array(SPARK_STRIDE);
    this._recF = new Float32Array(FLARE_STRIDE);
    this._cbPos = new THREE.Vector3();            // position handed to onExplosion (copy it if you keep it)
    this._tmpPos = new THREE.Vector3();
    this._tmpVel = new THREE.Vector3();
    this._muzzleTmp = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._hasCam = false;
    this._dt = 0;
    this._tOff = 0;                               // s a missile substep ends before the frame's end (targets interpolated back)
    this._missileSerial = 0;
    this._stats = { bullets: 0, missiles: 0, debris: 0, emitters: 0, flares: 0, drawCalls: 0 };
  }

  // ===============================================================================================
  // Construction
  // ===============================================================================================
  _add(obj, renderOrder) {
    obj.frustumCulled = false;
    obj.renderOrder = renderOrder;
    obj.onBeforeRender = this._onBeforeRender;
    obj.visible = false;
    this.scene.add(obj);
    this._objects.push(obj);
    return obj;
  }

  _pointGeometry(ring) {
    const g = new THREE.BufferGeometry();
    const b = ring.buf;
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(b, 3, 0));
    g.setAttribute('aBirth', new THREE.InterleavedBufferAttribute(b, 1, 3));
    g.setAttribute('aVel', new THREE.InterleavedBufferAttribute(b, 4, 4));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(b, 4, 8));
    g.setAttribute('aSize', new THREE.InterleavedBufferAttribute(b, 4, 12));
    g.setAttribute('aParams', new THREE.InterleavedBufferAttribute(b, 4, 16));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return g;
  }

  _initParticles(smokeCap, fireCap, sparkCap) {
    const U = this._u;
    // smoke: premultiplied alpha, drawn before the additive layers
    this._smokeRing = new ParticleRing(Math.max(64, smokeCap | 0), SMOKE_STRIDE, false);
    this._smokeMat = fxMaterial({ uTime: U.uTime, uScreenH: U.uScreenH, uMinPx: U.uMinPx, uMaxPx: U.uMaxPx, uWind: U.uWind,
      uSunDir: U.uSunDir, uSunColor: U.uSunColor, uAmbient: U.uAmbient, uNoise: U.uNoise }, SMOKE_VERT, SMOKE_FRAG, false);
    const smokeGeo = this._pointGeometry(this._smokeRing);
    smokeGeo.setAttribute('aStretch', new THREE.InterleavedBufferAttribute(this._smokeRing.buf, 4, 20));
    this._smokePoints = this._add(new THREE.Points(smokeGeo, this._smokeMat), 20);
    // fire: additive points
    this._fireRing = new ParticleRing(Math.max(64, fireCap | 0), POINT_STRIDE, false);
    this._fireMat = fxMaterial({ uTime: U.uTime, uScreenH: U.uScreenH, uMinPx: U.uMinPx, uMaxPx: U.uMaxPx, uNoise: U.uNoise },
      GLOW_VERT, GLOW_FRAG, true);
    this._firePoints = this._add(new THREE.Points(this._pointGeometry(this._fireRing), this._fireMat), 23);
    // sparks: additive instanced streak quads
    this._sparkRing = new ParticleRing(Math.max(32, sparkCap | 0), SPARK_STRIDE, true);
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    sg.setIndex([0, 2, 1, 2, 3, 1]);
    const b = this._sparkRing.buf;
    sg.setAttribute('iA', new THREE.InterleavedBufferAttribute(b, 4, 0));
    sg.setAttribute('iB', new THREE.InterleavedBufferAttribute(b, 4, 4));
    sg.setAttribute('iC', new THREE.InterleavedBufferAttribute(b, 4, 8));
    sg.setAttribute('iD', new THREE.InterleavedBufferAttribute(b, 4, 12));
    sg.instanceCount = this._sparkRing.cap;
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this._sparkMat = fxMaterial({ uTime: U.uTime, uScreenH: U.uScreenH, uMinPx: { value: 1.5 } }, SPARK_VERT, SPARK_FRAG, true,
      THREE.DoubleSide);
    this._sparkMesh = this._add(new THREE.Mesh(sg, this._sparkMat), 24);
  }

  _initTracers(maxBullets) {
    const cap = Math.max(16, maxBullets | 0);
    this._bulletCap = cap;
    this._bPos = new Float32Array(cap * 3);
    this._bVel = new Float32Array(cap * 3);
    this._bAge = new Float32Array(cap);
    this._bSeed = new Float32Array(cap);
    this._bGround = new Float32Array(cap);       // next time a ground query is needed (clearance-based)
    this._bRad = new Float32Array(cap);          // hit sphere radius (m), from the shooter's team at firing time
    this._bOwner = new Array(cap).fill(null);
    this._nb = 0;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this._tracerAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this._tracerAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTracer', this._tracerAttr);
    this._tracerMat = fxMaterial({ uScreenH: this._u.uScreenH, uMinPx: { value: 2.0 }, uWidth: { value: this.tracerWidth },
      uHead: { value: new THREE.Vector3(9, 5, 1.8) }, uTail: { value: new THREE.Vector3(7, 2.4, 0.45) } },
    TRACER_VERT, TRACER_FRAG, true);
    this._tracerMesh = this._add(new THREE.InstancedMesh(geo, this._tracerMat, cap), 25);
    this._tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._tracerMesh.count = 0;
    this._tracerRangeM = { start: 0, count: 0 };
    this._tracerRangeA = { start: 0, count: 0 };
    this.tracerHeadColor = this._tracerMat.uniforms.uHead.value;   // linear radiance (live tunable)
    this.tracerTailColor = this._tracerMat.uniforms.uTail.value;
  }

  _initMissiles() {
    this._missilePool = [];
    this._missileTotal = 0;
    this._missileGeo = buildMissileGeometry();
    this._missileMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.15 });
    this._missileMesh = this._add(new THREE.InstancedMesh(this._missileGeo, this._missileMat, MISSILE_CAPACITY), 0);
    this._missileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._missileMesh.count = 0;
    const fg = buildFlameGeometry();
    this._flameAttr = new THREE.InstancedBufferAttribute(new Float32Array(MISSILE_CAPACITY * 2), 2);
    this._flameAttr.setUsage(THREE.DynamicDrawUsage);
    fg.setAttribute('aFlame', this._flameAttr);
    this._flameMat = fxMaterial({ uTime: this._u.uTime }, FLAME_VERT, FLAME_FRAG, true);
    this._flameMesh = this._add(new THREE.InstancedMesh(fg, this._flameMat, MISSILE_CAPACITY), 22);
    this._flameMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._flameMesh.count = 0;
  }

  _initRings() {
    this._ringRing = new ParticleRing(RING_CAPACITY, RING_STRIDE, true);
    const rg = new THREE.RingGeometry(0.6, 1.0, 48, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(rg.getIndex());
    g.setAttribute('position', rg.getAttribute('position'));
    g.setAttribute('aRingA', new THREE.InterleavedBufferAttribute(this._ringRing.buf, 4, 0));
    g.setAttribute('aRingB', new THREE.InterleavedBufferAttribute(this._ringRing.buf, 4, 4));
    g.instanceCount = RING_CAPACITY;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this._ringGeoSrc = rg;
    this._ringMat = fxMaterial({ uTime: this._u.uTime }, RING_VERT, RING_FRAG, true, THREE.DoubleSide);
    this._ringMesh = this._add(new THREE.Mesh(g, this._ringMat), 21);
  }

  _initDebris() {
    this._chunks = [];
    for (let i = 0; i < DEBRIS_CAPACITY; i++) this._chunks.push(new Chunk());
    this._nChunks = 0;
    this._debrisMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.35 });
    this._debrisMesh = this._add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this._debrisMat, DEBRIS_CAPACITY), 0);
    this._debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEBRIS_CAPACITY * 3), 3);
    this._debrisMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._debrisMesh.count = 0;
  }

  _initFlares() {
    const U = this._u;
    // GPU: one additive sprite per flare (written once, at ejection). Smoke trails / tail streaks use the shared pools.
    this._flareRing = new ParticleRing(FLARE_CAPACITY, FLARE_STRIDE, false);
    const b = this._flareRing.buf, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(b, 3, 0));
    g.setAttribute('aBirth', new THREE.InterleavedBufferAttribute(b, 1, 3));
    g.setAttribute('aVel', new THREE.InterleavedBufferAttribute(b, 4, 4));
    g.setAttribute('aParams', new THREE.InterleavedBufferAttribute(b, 4, 8));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(b, 4, 12));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this._flareMat = fxMaterial({ uTime: U.uTime, uScreenH: U.uScreenH, uMinPx: U.uMinPx, uMaxPx: U.uMaxPx },
      FLARE_VERT, FLARE_FRAG, true);
    this._flarePoints = this._add(new THREE.Points(g, this._flareMat), 23);
    // CPU: decoy pool with a free-index stack (O(1) alloc / release) + burst records; no per-frame allocation
    this._flarePool = [];
    for (let i = 0; i < FLARE_CAPACITY; i++) { const f = new FlareDecoy(); f.poolIndex = i; this._flarePool.push(f); }
    this._flareFree = new Int16Array(FLARE_CAPACITY);
    this._resetFlareFree();
    this._flaresInUse = 0;
    this._bursts = [];
    for (let i = 0; i < BURST_CAPACITY; i++) {
      this._bursts.push({ active: false, aircraft: null, t0: 0, count: 0, next: 0, assigned: 0, flares: new Array(BURST_MAX).fill(null) });
    }
  }

  // ===============================================================================================
  // Particle primitives (positional args -> no allocation). Sizes are diameters in metres.
  // ===============================================================================================
  /** Smoke / dust / spray / fireball puff (premultiplied pool). fireFrac = fraction of life spent glowing
   *  (0 = plain smoke); fireI = glow strength (1 ≈ [13,5.5,1.6] radiance at the hottest point).
   *  (sx,sy,sz) optional world stretch vector: the sprite becomes an ellipse elongated along it (trails). */
  _puff(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag, grav, fireFrac, fireI, noise, birth, sx = 0, sy = 0, sz = 0, fadeIn = 0.04) {
    const d = this._recS;
    d[0] = x; d[1] = y; d[2] = z; d[3] = birth;
    d[4] = vx; d[5] = vy; d[6] = vz; d[7] = life;
    d[8] = r; d[9] = g; d[10] = b; d[11] = a;
    d[12] = s0; d[13] = s1; d[14] = drag; d[15] = grav;
    d[16] = fireFrac; d[17] = fireI; d[18] = noise; d[19] = rnd();
    d[20] = sx; d[21] = sy; d[22] = sz; d[23] = fadeIn;   // stretch vector (m) along the emitter path, fade-in (s)
    this._smokeRing.push(d);
  }

  /** Additive glow sprite (fire, flashes). r,g,b = linear radiance (can be >> 1); cool 0..1 = reddening with age. */
  _glow(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, drag, grav, cool, noise, birth) {
    const d = this._recG;
    d[0] = x; d[1] = y; d[2] = z; d[3] = birth;
    d[4] = vx; d[5] = vy; d[6] = vz; d[7] = life;
    d[8] = r; d[9] = g; d[10] = b; d[11] = 1;
    d[12] = s0; d[13] = s1; d[14] = drag; d[15] = grav;
    d[16] = cool; d[17] = 0; d[18] = noise; d[19] = rnd();
    this._fireRing.push(d);
  }

  /** Additive streak spark. width (m); trail = streak length expressed in seconds of motion. */
  _spark(x, y, z, vx, vy, vz, life, r, g, b, width, drag, grav, trail, birth) {
    const d = this._recK;
    d[0] = x; d[1] = y; d[2] = z; d[3] = birth;
    d[4] = vx; d[5] = vy; d[6] = vz; d[7] = life;
    d[8] = r; d[9] = g; d[10] = b; d[11] = width;
    d[12] = drag; d[13] = grav; d[14] = trail; d[15] = rnd();
    this._sparkRing.push(d);
  }

  _ring(x, y, z, radius, life, intensity) {
    const R = this._ringRing, d = R.data, o = R.alloc(), t = this.time;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = t;
    d[o + 4] = radius; d[o + 5] = life; d[o + 6] = intensity; d[o + 7] = rnd();
    if (t + life > R.live[0]) R.live[0] = t + life;
  }

  _emit(kind, x, y, z, vx, vy, vz, dur, rate, s) {
    const E = this._emitters;
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (e.active) continue;
      e.active = true; e.kind = kind; e.x = x; e.y = y; e.z = z; e.vx = vx; e.vy = vy; e.vz = vz;
      e.age = 0; e.dur = dur; e.rate = rate; e.acc = rnd(); e.s = s;
      return;
    }
  }

  _delay(after, x, y, z, s, vx, vy, vz) { this._schedule(FX_SECONDARY, after, 0, x, y, z, s, vx, vy, vz); }

  /** Pooled delayed effect: fires in the first update() at least `frames` updates and `after` seconds from now.
   *  False when the pool is full. */
  _schedule(kind, after, frames, x, y, z, s, vx, vy, vz) {
    const D = this._delayed;
    for (let i = 0; i < D.length; i++) {
      const e = D[i];
      if (e.active) continue;
      e.active = true; e.kind = kind; e.at = this.time + after; e.frame = this._frameNo + frames;
      e.x = x; e.y = y; e.z = z; e.s = s; e.vx = vx; e.vy = vy; e.vz = vz;
      return true;
    }
    return false;
  }

  /**
   * Run an effect a little later, e.g. to spread the CPU cost of a big effect bundle over frames. kind: 'explode' (as
   * explode()), 'secondary' (an explosion without tendrils or shockwave ring), 'death' (aircraftDeath at that point:
   * blasts, burning debris, a smoke column; size unused) or 'impact' (terrainImpact, size = scale). position and the
   * optional velocity are copied now. It fires in the first update() that is at least `frames` updates later (1 = the
   * next frame, whatever the frame rate) and at least `after` seconds later. With the pool full it runs at once.
   */
  delayEffect(kind, position, size = 1, frames = 1, after = 0, velocity = null) {
    if (!position) return;
    const k = kind === 'explode' ? FX_EXPLODE : kind === 'death' ? FX_DEATH : kind === 'impact' ? FX_IMPACT : FX_SECONDARY;
    const v = velocity || _zero, n = frames > 0 ? Math.floor(frames) : 0, a = after > 0 ? +after : 0;
    if (!this._schedule(k, a, n, position.x, position.y, position.z, size, v.x, v.y, v.z)) this._runEffect(k, position.x, position.y, position.z, size, v.x, v.y, v.z);
  }

  _runEffect(kind, x, y, z, s, vx, vy, vz) {
    if (kind === FX_SECONDARY) this._explode(x, y, z, s, vx, vy, vz, false);   // secondary blast: no tendrils
    else if (kind === FX_EXPLODE) this._explode(x, y, z, s, vx, vy, vz, true);
    else if (kind === FX_DEATH) this._death(x, y, z, vx, vy, vz);
    else this.terrainImpact(this._dPos.set(x, y, z), s);
  }

  /** Push pending particle writes to the renderer and update visibility. Called by every public spawning method. */
  _commit() {
    const t = this.time;
    this._smokeRing.flush(); this._fireRing.flush(); this._sparkRing.flush(); this._ringRing.flush(); this._flareRing.flush();
    this._smokePoints.visible = t < this._smokeRing.live[0];
    this._firePoints.visible = t < this._fireRing.live[0];
    this._flarePoints.visible = t < this._flareRing.live[0];
    this._sparkMesh.visible = t < this._sparkRing.live[0];
    this._ringMesh.visible = t < this._ringRing.live[0];
  }

  // ===============================================================================================
  // World / aircraft helpers
  // ===============================================================================================
  _ground(x, z) {
    const w = this.world;
    if (w && typeof w.getHeight === 'function') {
      const h = w.getHeight(x, z);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }

  _state(a) {
    let s = this._acState.get(a);
    if (!s) { s = { gunNext: -1, muzzle: 0, missileReady: 0, rail: 0 }; this._acState.set(a, s); }
    return s;
  }

  static _isDead(a) {
    return !a || a.alive === false || (typeof a.health === 'number' && a.health <= 0);
  }

  _forward(a, out) {
    if (typeof a.getForward === 'function') return a.getForward(out);
    out.set(0, 0, -1);
    return a.quaternion ? out.applyQuaternion(a.quaternion) : out;
  }

  _upOf(a, out) {
    if (typeof a.getUp === 'function') return a.getUp(out);
    out.set(0, 1, 0);
    return a.quaternion ? out.applyQuaternion(a.quaternion) : out;
  }

  _far(x, y, z) {
    if (!this._hasCam) return false;
    const c = this._camPos, dx = x - c.x, dy = y - c.y, dz = z - c.z, m = this.fxMaxDistance;
    return dx * dx + dy * dy + dz * dz > m * m;
  }

  // ===============================================================================================
  // Gun
  // ===============================================================================================
  /** Call every frame the trigger is held. Returns the number of rounds fired this call. */
  fireGun(aircraft) {
    if (!aircraft || aircraft.holdFire === true || Weapons._isDead(aircraft)) return 0;
    const st = this._state(aircraft);
    const now = this.time, interval = 1 / (aircraft.gunRate || this.gunRate);   // per-aircraft rate (enemies fire slower)
    if (st.gunNext < now - 0.1) st.gunNext = now;               // trigger (re)pressed: first round immediately
    let n = 0;
    while (st.gunNext <= now + 1e-6 && n < 8) {
      if (typeof aircraft.ammo === 'number') {
        if (aircraft.ammo <= 0) break;
        aircraft.ammo--;
      }
      this._spawnBullet(aircraft, st, now - st.gunNext);
      st.gunNext += interval;
      n++;
    }
    if (n > 0) this._commit();
    return n;
  }

  _spawnBullet(a, st, lead) {
    const muzzles = typeof a.getGunMuzzles === 'function' ? a.getGunMuzzles() : null;
    let m = muzzles && muzzles.length ? muzzles[st.muzzle % muzzles.length] : a.position;
    st.muzzle++;
    const av = a.velocity || _zero;
    this._forward(a, _fwd);
    if (m === a.position && a.isGround === true) {               // ground gun without muzzles: fire from above its base
      const hr = typeof a.hitRadius === 'number' && a.hitRadius > 0 ? a.hitRadius : 4;
      m = this._muzzleTmp.copy(a.position);
      m.y += Math.min(hr, 12) * 0.5 + 1.5;
    }
    // harmonised guns: aim each muzzle at a point `gunConvergence` ahead of the aircraft centre, plus dispersion
    _v0.copy(a.position).addScaledVector(_fwd, this.gunConvergence).sub(m).normalize();
    const sp = this.gunSpread;
    _v0.x += (rnd() - 0.5) * 2 * sp; _v0.y += (rnd() - 0.5) * 2 * sp; _v0.z += (rnd() - 0.5) * 2 * sp;
    _v0.normalize();
    const t = this.time;
    // muzzle flash (moves with the aircraft) + a short forward flame tongue
    if (!this._far(m.x, m.y, m.z)) {
      const g = this._recG;
      g[0] = m.x; g[1] = m.y; g[2] = m.z; g[3] = t; g[4] = av.x; g[5] = av.y; g[6] = av.z; g[7] = 0.07;
      g[8] = 16; g[9] = 10; g[10] = 4; g[11] = 1; g[12] = 2.2 + rnd() * 0.8; g[13] = 1; g[14] = 0.1; g[15] = 0;
      g[16] = 0.5; g[17] = 0; g[18] = 0.5; g[19] = rnd();
      this._fireRing.push(g);
      const k = this._recK;
      k[0] = m.x; k[1] = m.y; k[2] = m.z; k[3] = t;
      k[4] = av.x + _v0.x * 160; k[5] = av.y + _v0.y * 160; k[6] = av.z + _v0.z * 160; k[7] = 0.05;
      k[8] = 14; k[9] = 9; k[10] = 4; k[11] = 0.3; k[12] = 0.1; k[13] = 0; k[14] = 0.03; k[15] = rnd();
      this._sparkRing.push(k);
    }
    if (this._nb >= this._bulletCap) return;                    // pool full (very unlikely): round is not simulated
    const i = this._nb++, i3 = i * 3, spd = this.bulletSpeed;
    const vx = av.x + _v0.x * spd, vy = av.y + _v0.y * spd, vz = av.z + _v0.z * spd;
    this._bVel[i3] = vx; this._bVel[i3 + 1] = vy; this._bVel[i3 + 2] = vz;
    this._bPos[i3] = m.x + vx * lead; this._bPos[i3 + 1] = m.y + vy * lead; this._bPos[i3 + 2] = m.z + vz * lead;
    this._bAge[i] = lead;
    this._bSeed[i] = rnd();
    this._bGround[i] = 0;
    this._bRad[i] = this._gunRadius(a);
    this._bOwner[i] = a;
  }

  /** Bullet hit-sphere radius for rounds fired by `a`: its own gunHitRadius, else gunHitRadius[a.team], else bulletRadius. */
  _gunRadius(a) {
    if (a && typeof a.gunHitRadius === 'number' && a.gunHitRadius > 0) return a.gunHitRadius;
    const tbl = this.gunHitRadius, team = a ? a.team : undefined;
    const r = tbl && team !== undefined && team !== null ? tbl[team] : undefined;
    return typeof r === 'number' && r > 0 ? r : this.bulletRadius;
  }

  _removeBullet(i) {
    const last = --this._nb;
    if (i !== last) {
      const i3 = i * 3, l3 = last * 3;
      this._bPos[i3] = this._bPos[l3]; this._bPos[i3 + 1] = this._bPos[l3 + 1]; this._bPos[i3 + 2] = this._bPos[l3 + 2];
      this._bVel[i3] = this._bVel[l3]; this._bVel[i3 + 1] = this._bVel[l3 + 1]; this._bVel[i3 + 2] = this._bVel[l3 + 2];
      this._bAge[i] = this._bAge[last]; this._bSeed[i] = this._bSeed[last]; this._bOwner[i] = this._bOwner[last];
      this._bGround[i] = this._bGround[last]; this._bRad[i] = this._bRad[last];
    }
    this._bOwner[last] = null;
  }

  /** Targets that the rounds / fuse of `owner` test against: teamTargets[owner.team] when given, else `list`. */
  _listFor(owner, list) {
    const tt = this._teamTargets;
    if (tt !== null && owner) { const T = tt[owner.team]; if (T !== undefined) return T; }
    return list;
  }

  _updateBullets(dt, list) {
    const P = this._bPos, V = this._bVel, A = this._bAge;
    const mat = this._tracerMesh.instanceMatrix.array, ta = this._tracerAttr.array;
    const life = this.bulletLife, gdt = this.bulletGravity * dt, BR = this._bRad;
    const L = this.tracerLength, w = this.tracerWidth, ceil = this.terrainCeiling;
    for (let i = 0; i < this._nb;) {
      const i3 = i * 3;
      A[i] += dt;
      if (A[i] >= life) { this._removeBullet(i); continue; }
      const ax = P[i3], ay = P[i3 + 1], az = P[i3 + 2];
      V[i3 + 1] -= gdt;
      const vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2];
      const bx = ax + vx * dt, by = ay + vy * dt, bz = az + vz * dt;
      P[i3] = bx; P[i3 + 1] = by; P[i3 + 2] = bz;
      // ---- hit test: segment travelled this frame vs. each target sphere, in the target's moving frame. Radius =
      //      max(shooter team's gunHitRadius, target.hitRadius if any); the earliest crossing along the segment wins
      //      Only the owner team's target list is tested (see update).
      const owner = this._bOwner[i], rB = BR[i];
      const tl = this._listFor(owner, list), nl = tl.length;
      let hit = null, hx = 0, hy = 0, hz = 0, bestU = 2;
      for (let j = 0; j < nl; j++) {
        const T = tl[j];
        if (T === owner || Weapons._isDead(T)) continue;
        const tr = T.hitRadius, big = typeof tr === 'number' && tr > rB, RR = big ? tr : rB;
        const tp = T.position, tv = T.velocity || _zero;
        const sx = ax - (tp.x - tv.x * dt), sy = ay - (tp.y - tv.y * dt), sz = az - (tp.z - tv.z * dt);
        const ex = bx - tp.x, ey = by - tp.y, ez = bz - tp.z;
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const len2 = dx * dx + dy * dy + dz * dz;
        let u = len2 > 1e-9 ? -(sx * dx + sy * dy + sz * dz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const cx = sx + dx * u, cy = sy + dy * u, cz = sz + dz * u;
        const c2 = cx * cx + cy * cy + cz * cz;
        if (c2 < RR * RR && u < bestU) {
          // sparks on the airframe (<= 5 m from its centre at life size, x its drawn scale; or ~its hull for big
          // targets), not in mid-air where a generous sphere was merely grazed
          const vs = T.visualScale > 1 ? T.visualScale : 1, surf = big && tr > 6 ? tr * 0.85 : 5 * vs;
          const k = Math.min(0.85, surf / Math.max(Math.sqrt(c2), 1e-3));
          hit = T; bestU = u; hx = tp.x + cx * k; hy = tp.y + cy * k; hz = tp.z + cz * k;
        }
      }
      if (hit) {
        const inv = 1 / Math.max(1e-6, Math.sqrt(vx * vx + vy * vy + vz * vz));
        this._removeBullet(i);
        this._gunHit(hit, owner, hx, hy, hz, vx * inv, vy * inv, vz * inv);
        continue;
      }
      // ---- ground / water. Re-query only when the bullet could have reached the surface: with terrain slopes
      //      up to ~45°, the ground can't close faster than the bullet's speed, so clearance / speed is a safe wait.
      if (by < ceil && this.time >= this._bGround[i]) {
        const h = this._ground(bx, bz), floor = h > 0 ? h : 0;
        if (by < floor) {
          this._removeBullet(i);
          if (!this._far(bx, by, bz)) { this._tmpPos.set(bx, floor, bz); this.terrainImpact(this._tmpPos, 0.25); }
          continue;
        }
        this._bGround[i] = this.time + Math.max(0, by - floor - 4) / (Math.sqrt(vx * vx + vy * vy + vz * vz) + 1);
      }
      // ---- tracer instance: box from the head back along the velocity (shorter right after firing)
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const Dx = vx / sp, Dy = vy / sp, Dz = vz / sp;
      const len = Math.min(L, A[i] * this.bulletSpeed + 0.5);
      // right-handed basis with local -Z along D: Z = -D, X = normalize(up x Z), Y = Z x X
      const Zx = -Dx, Zy = -Dy, Zz = -Dz;
      let Xx = Zz, Xz = -Zx, xl = Math.sqrt(Xx * Xx + Xz * Xz);
      if (xl < 1e-5) { Xx = 1; Xz = 0; xl = 1; }
      Xx /= xl; Xz /= xl;
      const Yx = Zy * Xz, Yy = Zz * Xx - Zx * Xz, Yz = -Zy * Xx;
      const o = i * 16;
      mat[o] = Xx * w; mat[o + 1] = 0; mat[o + 2] = Xz * w; mat[o + 3] = 0;
      mat[o + 4] = Yx * w; mat[o + 5] = Yy * w; mat[o + 6] = Yz * w; mat[o + 7] = 0;
      mat[o + 8] = Zx * len; mat[o + 9] = Zy * len; mat[o + 10] = Zz * len; mat[o + 11] = 0;
      mat[o + 12] = bx - Dx * len * 0.5; mat[o + 13] = by - Dy * len * 0.5; mat[o + 14] = bz - Dz * len * 0.5; mat[o + 15] = 1;
      ta[i * 2] = (1 - 0.5 * (A[i] / life)) * Math.min(1, (life - A[i]) * 4);   // dims with age, last 0.25 s fades out
      ta[i * 2 + 1] = this._bSeed[i];
      i++;
    }
    const n = this._nb, mesh = this._tracerMesh;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      const im = mesh.instanceMatrix, r1 = im.updateRanges;
      this._tracerRangeM.start = 0; this._tracerRangeM.count = n * 16;
      if (r1) { r1.length = 0; r1.push(this._tracerRangeM); }
      im.needsUpdate = true;
      const r2 = this._tracerAttr.updateRanges;
      this._tracerRangeA.start = 0; this._tracerRangeA.count = n * 2;
      if (r2) { r2.length = 0; r2.push(this._tracerRangeA); }
      this._tracerAttr.needsUpdate = true;
    }
  }

  _gunHit(target, shooter, x, y, z, dx, dy, dz) {
    const immortal = target.immortal === true;     // (squadmates, in the enemy team's list) a visible hit, never damage
    const vs = target.visualScale > 1 ? target.visualScale : 1;   // flash and smoke sized to the airframe as drawn
    const dmg = immortal ? 0 : this.damageFilter ? this.damageFilter(target, this.bulletDamage, shooter, 'gun', null) : this.bulletDamage;
    if (!immortal && this.onHit) this.onHit(target, dmg, shooter, 'gun');
    if (!this._far(x, y, z)) {
      const tv = target.velocity || _zero, t = this.time;
      const k = this._recK;                      // sparks sprayed back toward the shooter, carried by the target's motion
      k[0] = x; k[1] = y; k[2] = z; k[3] = t; k[11] = 0.09; k[12] = 2; k[13] = -G; k[14] = 0.035;
      for (let i = 0; i < 9; i++) {
        randDir(_v1);
        let ux = _v1.x - dx * 0.7, uy = _v1.y - dy * 0.7, uz = _v1.z - dz * 0.7;
        const il = 1 / (Math.sqrt(ux * ux + uy * uy + uz * uz) || 1);
        const sp = (30 + rnd() * 100) * il, c = 0.7 + rnd() * 0.5;
        ux *= sp; uy *= sp; uz *= sp;
        k[4] = tv.x + ux; k[5] = tv.y + uy; k[6] = tv.z + uz; k[7] = 0.15 + rnd() * 0.25;
        k[8] = 16 * c; k[9] = 10 * c; k[10] = 4.5 * c; k[15] = rnd();
        this._sparkRing.push(k);
      }
      const g = this._recG;
      g[0] = x; g[1] = y; g[2] = z; g[3] = t; g[4] = tv.x; g[5] = tv.y; g[6] = tv.z; g[7] = 0.08;
      g[8] = 20; g[9] = 14; g[10] = 7; g[11] = 1; g[12] = 3.5 * vs; g[13] = 1.5 * vs; g[14] = 0.1; g[15] = 0;
      g[16] = 0.3; g[17] = 0; g[18] = 0.3; g[19] = rnd();
      this._fireRing.push(g);
      const p = this._recS;                      // a wisp of smoke that streams off behind the target
      p[0] = x; p[1] = y; p[2] = z; p[3] = t; p[4] = tv.x * 0.92; p[5] = tv.y * 0.92; p[6] = tv.z * 0.92; p[7] = 1.0;
      p[8] = 0.22; p[9] = 0.21; p[10] = 0.2; p[11] = 0.5; p[12] = 1.2 * vs; p[13] = 5 * vs; p[14] = 0.8; p[15] = 0.5;
      p[16] = 0; p[17] = 0; p[18] = 1; p[19] = rnd(); p[20] = 0; p[21] = 0; p[22] = 0; p[23] = 0.04;
      this._smokeRing.push(p);
    }
    if (immortal) return;
    const killed = typeof target.applyDamage === 'function' ? target.applyDamage(dmg) === true : false;
    if (killed) {
      if (this.onKill) this.onKill(target, shooter);
      this.aircraftDeath(target);
    }
  }

  // ===============================================================================================
  // Missiles
  // ===============================================================================================
  /** Launch a missile from the next rail. target: Aircraft|null (null = unguided). Returns the Missile or null. */
  fireMissile(aircraft, target = null) {
    if (!aircraft || aircraft.holdFire === true || Weapons._isDead(aircraft)) return null;
    if (typeof aircraft.missiles === 'number' && aircraft.missiles <= 0) return null;
    const st = this._state(aircraft);
    if (this.time < st.missileReady) return null;
    let m = this._missilePool.pop();
    if (!m) {
      if (this._missileTotal >= MISSILE_CAPACITY) return null;
      m = new Missile();
      this._missileTotal++;
    }
    st.missileReady = this.time + this.missileCooldown;
    if (typeof aircraft.missiles === 'number') aircraft.missiles--;
    const rails = typeof aircraft.getMissileRails === 'function' ? aircraft.getMissileRails() : null;
    const rail = rails && rails.length ? rails[st.rail % rails.length] : aircraft.position;
    st.rail++;
    m.owner = aircraft;
    m.target = target && !Weapons._isDead(target) && target.position ? target : null;
    m.groundLaunch = aircraft.isGround === true;
    if (m.groundLaunch) {
      // ground launcher (SAM site, ship): pop up out of the launcher toward the target (>= ~20 deg), no rail drop
      const hr = typeof aircraft.hitRadius === 'number' && aircraft.hitRadius > 0 ? aircraft.hitRadius : 4;
      m.position.copy(aircraft.position); m.position.y += Math.min(hr, 12) * 0.5 + 2;
      if (m.target) _fwd.subVectors(m.target.position, m.position).normalize(); else _fwd.set(0, 1, 0);
      if (!(_fwd.y >= 0.35)) { _fwd.y = 0.35; _fwd.normalize(); }
      m.velocity.copy(_fwd).multiplyScalar(45);
      m.quaternion.setFromUnitVectors(_v0.set(0, 0, -1), _fwd);
    } else {
      this._forward(aircraft, _fwd);
      this._upOf(aircraft, _up);
      m.position.copy(rail);
      m.velocity.copy(aircraft.velocity || _zero).addScaledVector(_up, -4);   // ejected slightly downward
      if (aircraft.quaternion) m.quaternion.copy(aircraft.quaternion); else m.quaternion.setFromUnitVectors(_v0.set(0, 0, -1), _fwd);
    }
    m.prev.copy(m.position);
    m.forward.copy(_fwd);
    m.unguided = m.target === null;        // no target: flies straight (no seeker, no ballistic sag)
    m.decoyedFrom = null; m.shookFrom = null;
    m.alive = true; m.age = 0; m.speed = m.velocity.length();
    m.ignited = false; m.boosting = false;
    m.smokeAcc = rnd(); m.flameAcc = rnd();
    m.seed = rnd(); m.id = ++this._missileSerial;
    m.turnScale = 1;                       // per-shot multiplier on the turn limit (game balance hook)
    m.maxSpeed = this.missileMaxSpeed; m.boostTime = this.missileBoostTime; m.drag = this.missileDrag; m.life = this.missileLife;   // per-shot kinematics
    m.fuse = this.missileFuse;             //   and fuse (likewise)
    m.blind = this.missileBlindRange; m.blindTime = this.missileBlindTime;   //   and seeker blind range (likewise)
    m.dud = false; m.missBy = 0; m.missSide = 1; m.lethal = false;   // pooled: the launch callback may set these
    m.ax = 0; m.ay = 0; m.az = 0;          // pooled: guidance lag state (_guide's own reset never fires: it starts after the rail drop)
    m.mesh.updateMatrix(); m.mesh.matrixWorld.copy(m.mesh.matrix);
    this.missiles.push(m);
    if (this.onMissileLaunch) this.onMissileLaunch(m);
    // the closure-time blind range (blindTime) is for good tail shots only: launched within missileBlindTailRange with the
    // target flying away from the missile (its velocity within acos(missileBlindTailCos) of the line of sight). Crossing,
    // head-on and long-range shots keep the fixed blind range, so they still overshoot a hard turn
    if (m.blindTime > 0) {
      const T0 = m.target, tv = T0 && T0.velocity, sp = tv ? tv.length() : 0;
      if (!T0 || !T0.position || sp < 1) m.blindTime = 0;
      else {
        _v0.subVectors(T0.position, m.position);
        const d = _v0.length();
        if (d < 1 || d > this.missileBlindTailRange || _v0.dot(tv) / (d * sp) < this.missileBlindTailCos) m.blindTime = 0;
      }
    }
    // launched into a fresh flare burst (within flareProtectTime): the target's flares spoof this one too. Done after
    // the launch callback so that it still reports the intended target.
    const T = m.target;
    if (T && m.alive && this._flaresInUse > 0 && T.position) {
      const b = this._protectingBurst(T), R = this.flareDecoyRange;
      if (b && m.position.distanceToSquared(T.position) <= R * R) this._decoy(m, b);
    }
    return m;
  }

  _updateMissiles(dt, list) {
    const arr = this.missiles;
    let w = 0, nb = 0, nf = 0;
    const fa = this._flameAttr.array;
    // low frame rate (dt > 1/50 s): up to 3 substeps of <= 1/60 s per missile (60 fps and above: one step, as before)
    const nSub = dt > 1 / 50 ? Math.min(3, Math.ceil(dt * 60 - 1e-6)) : 1, sub = dt / nSub;
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (m.alive) {
        if (nSub === 1) this._stepMissile(m, list);
        else {
          this._dt = sub;
          for (let k = 0; k < nSub && m.alive; k++) { this._tOff = (nSub - 1 - k) * sub; this._stepMissile(m, list); }
          this._dt = dt; this._tOff = 0;
        }
      }
      if (!m.alive) { m.owner = null; m.target = null; m.decoyedFrom = null; m.shookFrom = null; this._missilePool.push(m); continue; }
      arr[w++] = m;
      m.mesh.updateMatrix();
      m.mesh.matrixWorld.copy(m.mesh.matrix);
      this._missileMesh.setMatrixAt(nb++, m.mesh.matrix);
      if (m.boosting) {
        const f = m.forward;
        _v0.copy(m.position).addScaledVector(f, -NOZZLE_OFFSET);
        _scale.set(1.6, 1.6, 4.2);
        _m0.compose(_v0, m.quaternion, _scale);
        this._flameMesh.setMatrixAt(nf, _m0);
        fa[nf * 2] = Math.min(1, (m.age - this.missileDropTime) / 0.12);
        fa[nf * 2 + 1] = m.seed;
        nf++;
      }
    }
    arr.length = w;
    this._missileMesh.count = nb;
    this._missileMesh.visible = nb > 0;
    if (nb > 0) this._missileMesh.instanceMatrix.needsUpdate = true;
    this._flameMesh.count = nf;
    this._flameMesh.visible = nf > 0;
    if (nf > 0) { this._flameMesh.instanceMatrix.needsUpdate = true; this._flameAttr.needsUpdate = true; }
  }

  _stepMissile(m, list) {
    const dt = this._dt;
    m.age += dt;
    m.prev.copy(m.position);
    const t = this.time;
    if (m.age < this.missileDropTime) {
      if (!m.groundLaunch) m.velocity.y -= G * dt;               // free fall off the rail, motor not lit yet
    } else {
      if (!m.ignited) this._ignite(m);
      const boostEnd = this.missileDropTime + m.boostTime;
      m.boosting = m.age < boostEnd;
      _v1.copy(m.forward);                                       // old nose direction
      if (m.target) this._guide(m);
      if (m.boosting) m.speed = Math.min(m.maxSpeed, m.speed + m.boostAccel * dt);
      else m.speed = Math.max(this.missileMinSpeed, m.speed - m.drag * m.speed * m.speed * dt);
      m.speed = Math.max(this.missileMinSpeed * 0.5, m.speed - G * m.forward.y * dt * 0.5);   // climbing costs speed
      const fw = m.forward, sp = m.speed;
      m.velocity.x = fw.x * sp; m.velocity.y = fw.y * sp; m.velocity.z = fw.z * sp;
      if (!m.target && !m.boosting && !m.unguided) {             // lost its track (or its flare burnt out): ballistic
        m.velocity.y -= G * 0.6 * dt;
        m.forward.copy(m.velocity).normalize();
      }
      _q0.setFromUnitVectors(_v1, m.forward);                    // keep roll continuous, then add a slow roll
      m.quaternion.premultiply(_q0);
      _q0.setFromAxisAngle(_zAxis, 1.6 * dt);
      m.quaternion.multiply(_q0);
    }
    const mp = m.position, mv = m.velocity;
    mp.x += mv.x * dt; mp.y += mv.y * dt; mp.z += mv.z * dt;
    if (m.ignited) this._missileTrail(m);

    // ---- proximity fuse vs any live aircraft / ground target in the owner team's list except the owner (segment test in
    //      the target's frame); radius = max(missileFuse, 0.8 * target.fuseRadius (else hitRadius)) so big ground targets
    //      (ships) fuse at their hull: GroundTarget.fuseRadius keeps the life-size sphere, hitRadius covers the drawn unit
    //      for rounds. A dud only airbursts, harmlessly, and only if something comes within dudBurstRadius (it aims wide).
    if (m.age > this.missileArmTime) {
      const F = m.dud ? this.dudBurstRadius : m.fuse;
      const ax = m.prev.x, ay = m.prev.y, az = m.prev.z, bx = m.position.x, by = m.position.y, bz = m.position.z;
      const own = m.owner, tl = this._listFor(own, list), o = this._tOff, od = o + dt;   // (substep: target positions o s back)
      let best = null, bestU = 2, px = 0, py = 0, pz = 0;
      for (let j = 0; j < tl.length; j++) {
        const T = tl[j];
        if (T === own || Weapons._isDead(T)) continue;
        const tr = T.fuseRadius !== undefined ? T.fuseRadius : T.hitRadius, fr = typeof tr === 'number' && tr * 0.8 > F ? tr * 0.8 : F, R2 = fr * fr;
        const tp = T.position, tv = T.velocity || _zero;
        const sx = ax - (tp.x - tv.x * od), sy = ay - (tp.y - tv.y * od), sz = az - (tp.z - tv.z * od);
        const ex = bx - (tp.x - tv.x * o), ey = by - (tp.y - tv.y * o), ez = bz - (tp.z - tv.z * o);
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const len2 = dx * dx + dy * dy + dz * dz;
        let u = len2 > 1e-9 ? -(sx * dx + sy * dy + sz * dz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const cx = sx + dx * u, cy = sy + dy * u, cz = sz + dz * u;
        if (cx * cx + cy * cy + cz * cz < R2 && u < bestU) {
          best = T; bestU = u; px = ax + (bx - ax) * u; py = ay + (by - ay) * u; pz = az + (bz - az) * u;
        }
      }
      if (best) {
        if (m.dud || best.immortal === true) this._detonate(m, null, px, py, pz, true);   // dud / an immortal: harmless airburst
        else this._detonate(m, best, px, py, pz);
        return;
      }
      // chasing an immortal (in no list): reaching it is a harmless airburst, never a hit
      const I = m.target;
      if (I !== null && I.immortal === true && !Weapons._isDead(I)) {
        const tp = I.position, tv = I.velocity || _zero;
        const sx = ax - (tp.x - tv.x * od), sy = ay - (tp.y - tv.y * od), sz = az - (tp.z - tv.z * od);
        const dx = bx - (tp.x - tv.x * o) - sx, dy = by - (tp.y - tv.y * o) - sy, dz = bz - (tp.z - tv.z * o) - sz;
        const len2 = dx * dx + dy * dy + dz * dz;
        let u = len2 > 1e-9 ? -(sx * dx + sy * dy + sz * dz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const cx = sx + dx * u, cy = sy + dy * u, cz = sz + dz * u;
        if (cx * cx + cy * cy + cz * cz < F * F) { this._detonate(m, null, ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, true); return; }
      }
      // ---- spoofed: burst on the flare it is chasing (or overshoot it: _guide then drops the track)
      const D = m.target;
      if (D && D.isDecoy && D.alive) {
        const tp = D.position, tv = D.velocity, F2 = this.flareFuse * this.flareFuse;
        const sx = ax - (tp.x - tv.x * od), sy = ay - (tp.y - tv.y * od), sz = az - (tp.z - tv.z * od);
        const ex = bx - (tp.x - tv.x * o), ey = by - (tp.y - tv.y * o), ez = bz - (tp.z - tv.z * o);
        const dx = ex - sx, dy = ey - sy, dz = ez - sz;
        const len2 = dx * dx + dy * dy + dz * dz;
        let u = len2 > 1e-9 ? -(sx * dx + sy * dy + sz * dz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const cx = sx + dx * u, cy = sy + dy * u, cz = sz + dz * u;
        if (cx * cx + cy * cy + cz * cz < F2) {
          this._detonate(m, null, ax + (bx - ax) * u, ay + (by - ay) * u, az + (bz - az) * u, true);
          return;
        }
      }
    }
    // ---- ground / water impact. Skipped near a ground target the missile is guiding onto: the fuse above must get
    //      the target, not the terrain it stands on
    const p = m.position;
    if (p.y < this.terrainCeiling && !this._nearGroundTarget(m)) {
      const h = this._ground(p.x, p.z);
      if (p.y < h || p.y < 0) { this._detonate(m, null, p.x, Math.max(h, 0), p.z); return; }
    }
    // ---- end of life: self-destruct airburst
    if (m.age >= m.life) this._detonate(m, null, p.x, p.y, p.z);
  }

  /** True while m is guiding onto a live `isGround` target and is within ~60 m (+ its hitRadius) of it. */
  _nearGroundTarget(m) {
    const T = m.target;
    if (!T || T.isGround !== true || !T.position || Weapons._isDead(T)) return false;
    const r = 60 + (typeof T.hitRadius === 'number' && T.hitRadius > 0 ? T.hitRadius : 0);
    return T.position.distanceToSquared(m.position) < r * r;
  }

  _ignite(m) {
    m.ignited = true;
    m.boosting = true;
    m.forward.normalize();
    m.speed = Math.max(m.velocity.length(), 60);
    m.boostAccel = Math.max(60, (m.maxSpeed - m.speed) / Math.max(0.1, m.boostTime));   // per-shot profile
    const f = m.forward, v = m.velocity, t = this.time - this._tOff;
    const nx = m.position.x - f.x * NOZZLE_OFFSET, ny = m.position.y - f.y * NOZZLE_OFFSET, nz = m.position.z - f.z * NOZZLE_OFFSET;
    this._glow(nx, ny, nz, v.x, v.y, v.z, 0.1, 6, 3, 16, 10, 5, 0.1, 0, 0.6, 0.5, t);
    for (let k = 0; k < 6; k++) {
      this._puff(nx + rand(-0.5, 0.5), ny + rand(-0.5, 0.5), nz + rand(-0.5, 0.5), v.x * 0.3 + rand(-4, 4), v.y * 0.3 + rand(-4, 4),
        v.z * 0.3 + rand(-4, 4), rand(1.5, 2.5), 1.6, 7, 0.88, 0.88, 0.88, 0.5, 2, 0.5, 0.05, 0.5, 1, t);
    }
  }

  /** Lagged lead pursuit (air launches) or proportional navigation (ground launches) with airframe lag and a turn-rate
   *  cap; the seeker drops the track beyond missileSeekerCos off boresight. */
  _guide(m) {
    const T = m.target, dt = this._dt, boostEnd = this.missileDropTime + m.boostTime;
    if (Weapons._isDead(T)) { m.target = null; return; }
    const dir = m.forward, tp = T.position, tv = T.velocity || _zero, o = this._tOff;   // (substep: target o s back)
    let rx = tp.x - tv.x * o - m.position.x, ry = tp.y - tv.y * o - m.position.y, rz = tp.z - tv.z * o - m.position.z;
    if (m.missBy > 0 && !T.isDecoy) {
      // scripted near miss: home on a point beside the target, across the line of sight (and a little above it)
      const h = Math.sqrt(rx * rx + rz * rz);
      if (h > 1) { const s = m.missBy * m.missSide / h, offX = -rz * s, offZ = rx * s; rx += offX; rz += offZ; }
      ry += m.missBy * 0.3;
    }
    const r2 = rx * rx + ry * ry + rz * rz;
    if (r2 < 1e-4) return;
    const dist = Math.sqrt(r2), lx = rx / dist, ly = ry / dist, lz = rz / dist;
    if (lx * dir.x + ly * dir.y + lz * dir.z < this.missileSeekerCos) { m.target = null; return; }
    const vrx = tv.x - m.velocity.x, vry = tv.y - m.velocity.y, vrz = tv.z - m.velocity.z;
    // closing speed Vc = -(r · v_rel) / |r|
    const vc = Math.max(-(rx * vrx + ry * vry + rz * vrz) / dist, 150);
    // blind range: m.blind metres, or with m.blindTime set, no more than that many seconds of closure. A fixed distance
    // is a fixed time only at one closing speed: 90 m is ~0.07 s head-on but 0.25-0.35 s in a close tail chase (a slow
    // missile closing at 250-400 m/s), long enough for a bandit's ordinary turn to carry it out of the fuse radius
    const blind = m.blindTime > 0 ? Math.min(m.blind, vc * m.blindTime) : m.blind;
    if (dist < blind) return;                                     // terminal: no more corrections
    // LOS rotation rate  Ω = (r × v_rel) / |r|²
    const ox = (ry * vrz - rz * vry) / r2, oy = (rz * vrx - rx * vrz) / r2, oz = (rx * vry - ry * vrx) / r2;
    // air launches: lagged lead pursuit (N, lead fraction) blending into terminal PN over the missileTermTime s before
    // the blind range (so the endgame course is set by the time the seeker stops steering)
    const sam = m.groundLaunch === true, tg = dist / vc, tb = (dist - blind) / vc;
    const w = sam ? 1 : tb >= this.missileTermTime ? 0 : 1 - tb / this.missileTermTime;   // 0 midcourse .. 1 at blind range
    const k = (sam ? this.samNavGain : this.missileNavGain + (this.missileTermNavGain - this.missileNavGain) * w) * vc;
    // pursuit point: the target's position plus a fraction of its travel over the estimated time-to-go (SAMs: all of it)
    const tgo = Math.min(tg, 2.5) * (sam ? 1 : this.missileLeadFrac + (1 - this.missileLeadFrac) * w);
    let qx = rx + tv.x * tgo, qy = ry + tv.y * tgo, qz = rz + tv.z * tgo;
    const ql = 1 / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
    qx *= ql; qy *= ql; qz *= ql;
    // commanded acceleration a = N Vc (Ω × λ)  + a pursuit term toward that point
    const kp = (sam ? this.samPursuitGain : this.missilePursuitGain) * m.speed;
    let ax = k * (oy * lz - oz * ly) + (qx - dir.x) * kp;
    let ay = k * (oz * lx - ox * lz) + (qy - dir.y) * kp;
    let az = k * (ox * ly - oy * lx) + (qz - dir.z) * kp;
    const along = ax * dir.x + ay * dir.y + az * dir.z;          // only the lateral part turns the missile
    ax -= along * dir.x; ay -= along * dir.y; az -= along * dir.z;
    // airframe lag: the achieved lateral acceleration follows the command with a short time constant
    if (m.ax === undefined || m.age < 0.05) { m.ax = 0; m.ay = 0; m.az = 0; }
    const kl = this.missileLag > 0 ? 1 - Math.exp(-dt / this.missileLag) : 1;
    m.ax += (ax - m.ax) * kl; m.ay += (ay - m.ay) * kl; m.az += (az - m.az) * kl;
    const al2 = m.ax * dir.x + m.ay * dir.y + m.az * dir.z;
    ax = m.ax - al2 * dir.x; ay = m.ay - al2 * dir.y; az = m.az - al2 * dir.z;
    const alat = Math.sqrt(ax * ax + ay * ay + az * az);
    if (alat < 1e-6) return;
    let rate = alat / Math.max(m.speed, 50);
    const maxRate = m.boosting ? this.missileTurnRateBoost
      : this.missileTurnRateCoast + (this.missileTurnRateBoost - this.missileTurnRateCoast) * Math.exp(-(m.age - boostEnd) / 1.5);
    const lim = maxRate * (m.turnScale || 1);
    if (rate > lim) rate = lim;
    const ang = rate * dt, c = Math.cos(ang), s = Math.sin(ang) / alat;
    dir.set(dir.x * c + ax * s, dir.y * c + ay * s, dir.z * c + az * s).normalize();
  }

  _missileTrail(m) {
    const dt = this._dt, t = this.time - this._tOff, f = m.forward, v = m.velocity;
    const cx = m.position.x - f.x * NOZZLE_OFFSET, cy = m.position.y - f.y * NOZZLE_OFFSET, cz = m.position.z - f.z * NOZZLE_OFFSET;
    const px = m.prev.x - f.x * NOZZLE_OFFSET, py = m.prev.y - f.y * NOZZLE_OFFSET, pz = m.prev.z - f.z * NOZZLE_OFFSET;
    const ddx = cx - px, ddy = cy - py, ddz = cz - pz;
    const far = this._far(cx, cy, cz);
    // smoke: spread along the path travelled this frame, with matching sub-frame birth times, each puff stretched along
    // the flight path (~1.9x the mean spacing between puffs: at ~1 puff per frame the sub-frame jitter opens gaps of up to
    // two spacings) so even a fast coasting trail reads as one continuous plume
    const boost = m.boosting;
    const rate = Math.max(1, boost ? this.missileSmokeRate : Math.min(this.missileCoastSmokeRate, this.missileSmokeRate));
    m.smokeAcc += rate * dt;
    let n = m.smokeAcc | 0;
    m.smokeAcc -= n;
    const st = -1.9 * m.speed / rate;
    const S = this._recS;
    S[14] = 1.6; S[15] = boost ? 0.5 : 0.4; S[16] = 0; S[17] = 0; S[18] = 1;
    S[20] = f.x * st; S[21] = f.y * st; S[22] = f.z * st; S[23] = 0.02;
    for (let k = 0; k < n; k++) {
      const u = (k + rnd()) / n;
      S[0] = px + ddx * u; S[1] = py + ddy * u; S[2] = pz + ddz * u; S[3] = t - (1 - u) * dt;
      const wv = 0.84 + rnd() * 0.1;
      S[8] = wv; S[9] = wv; S[10] = wv; S[19] = rnd();
      if (boost) {
        S[4] = -f.x * 15 + (rnd() - 0.5) * 5; S[5] = -f.y * 15 + (rnd() - 0.5) * 5 + 0.5; S[6] = -f.z * 15 + (rnd() - 0.5) * 5;
        S[7] = 4.5 + rnd(); S[11] = 0.38 + rnd() * 0.18; S[12] = 1.8 + rnd() * 0.6; S[13] = 12 + rnd() * 6;
      } else {
        S[4] = (rnd() - 0.5) * 3; S[5] = (rnd() - 0.5) * 3; S[6] = (rnd() - 0.5) * 3;
        S[7] = 4 + rnd(); S[11] = 0.3 + rnd() * 0.1; S[12] = 1.9 + rnd() * 0.4; S[13] = 9 + rnd() * 3;
      }
      this._smokeRing.push(S);
    }
    // short fiery exhaust tail right behind the nozzle (blends the flame cone into the smoke)
    if (boost && !far) {
      m.flameAcc += 150 * dt;
      n = m.flameAcc | 0;
      m.flameAcc -= n;
      const g = this._recG;
      g[11] = 1; g[13] = 0.5; g[14] = 0.1; g[15] = 0; g[16] = 1; g[17] = 0; g[18] = 0.6;
      const ex = v.x - f.x * 90, ey = v.y - f.y * 90, ez = v.z - f.z * 90;
      for (let k = 0; k < n; k++) {
        const u = (k + rnd()) / n, c = 0.8 + rnd() * 0.4;
        g[0] = px + ddx * u; g[1] = py + ddy * u; g[2] = pz + ddz * u; g[3] = t - (1 - u) * dt;
        g[4] = ex + (rnd() - 0.5) * 12; g[5] = ey + (rnd() - 0.5) * 12; g[6] = ez + (rnd() - 0.5) * 12;
        g[7] = 0.08 + rnd() * 0.04; g[8] = 14 * c; g[9] = 7 * c; g[10] = 2.5 * c; g[12] = 2.0 + rnd() * 0.6;
        g[19] = rnd();
        this._fireRing.push(g);
      }
    }
  }

  /** Warhead: victim = aircraft hit (damage + kill), else an airburst (air = true: on a flare; or the end-of-life
   *  self-destruct) or a ground / water impact. */
  _detonate(m, victim, x, y, z, air = false) {
    m.alive = false;
    m.boosting = false;
    const owner = m.owner;
    if (victim) {
      const dmg = this.damageFilter ? this.damageFilter(victim, this.missileDamage, owner, 'missile', m) : this.missileDamage;
      if (this.onHit) this.onHit(victim, dmg, owner, 'missile');
      const tv = victim.velocity || _zero;
      this._tmpPos.set(x, y, z);
      this._tmpVel.copy(tv).multiplyScalar(0.6);
      this.explode(this._tmpPos, 1.0, this._tmpVel);
      const killed = typeof victim.applyDamage === 'function' ? victim.applyDamage(dmg) === true : false;
      if (killed) {
        if (this.onKill) this.onKill(victim, owner);
        this.aircraftDeath(victim);
      }
    } else if (air || (m.age >= m.life && y > this._ground(x, z) + 1)) {
      this._tmpPos.set(x, y, z);
      this._tmpVel.copy(m.velocity).multiplyScalar(air ? 0.15 : 0.3);
      this.explode(this._tmpPos, air ? 0.7 : 0.45, this._tmpVel);     // airburst on a flare / self-destruct
    } else {
      this._tmpPos.set(x, y, z);
      if (y > 0.5) this.explode(this._tmpPos, 0.8, null);             // warhead on land
      this._tmpPos.set(x, y, z);
      this.terrainImpact(this._tmpPos, 1);                            // dust or water column
    }
  }

  // ===============================================================================================
  // Flares (countermeasures)
  // ===============================================================================================
  /**
   * One countermeasure burst: `flareCount` flares ejected over `flareBurstTime` from the jet's rear belly, alternating
   * left / right, outward + downward at flareEjectSpeedMin..Max (plus the jet's velocity); strong drag makes them fall
   * away behind. Every live missile whose target is `aircraft` and that is within `flareDecoyRange` of it switches to
   * one of the burst's flares; so does any missile launched at `aircraft` during the next `flareProtectTime` seconds.
   * No cooldown / count limit here (the caller's job).
   * @returns {number} in-flight missiles spoofed by this call (0 if none; also 0 when aircraft is null / dead, and then
   *   nothing is deployed). Later spoofs (launches inside the protection window) are reported through onDecoy.
   */
  deployFlares(aircraft) {
    if (!aircraft || !aircraft.position || Weapons._isDead(aircraft)) return 0;
    const b = this._allocBurst();
    const n = Math.max(1, Math.min(BURST_MAX, Math.round(+this.flareCount) || 10));
    const t = this.time, interval = n > 1 ? Math.max(0, +this.flareBurstTime || 0) / (n - 1) : 0;
    const av = aircraft.velocity || _zero;
    b.active = true; b.aircraft = aircraft; b.t0 = t; b.count = 0; b.next = 0; b.assigned = 0;
    for (let i = 0; i < n; i++) {
      const f = this._allocFlare();
      if (!f) break;                                             // pool exhausted (pathological): a smaller burst
      f.inUse = true; f.alive = true; f.health = 1; f.ejected = false; f.owner = aircraft;
      f.ejectAt = t + i * interval + (i > 0 && i < n - 1 ? (rnd() - 0.5) * 0.4 * interval : 0);
      f.side = (i & 1) === 0 ? -1 : 1;
      f.order = n > 1 ? i / (n - 1) : 0;
      f.life = Math.max(0.2, (+this.flareBurnTime || 3.5) * rand(0.92, 1.08));
      f.position.copy(aircraft.position); f.velocity.copy(av);   // in the dispenser until ejected
      f.smokeAcc = rnd();
      b.flares[b.count++] = f;
    }
    if (b.count === 0) { this._freeBurst(b); return 0; }
    let spoofed = 0;
    const R = this.flareDecoyRange, R2 = R * R, p = aircraft.position, ms = this.missiles;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m.alive || m.target !== aircraft || m.position.distanceToSquared(p) > R2) continue;
      if (this._decoy(m, b)) spoofed++;
    }
    return spoofed;
  }

  /**
   * Broken lock (js/ai.js: an ace's well-timed max-G break, a boss's post-stall Cobra): every live missile guiding on
   * `aircraft` with a time to impact under `maxTti` s (just `only`, when given) loses its track: it flies on along its
   * last course (ballistic once the motor is out) and misses unless that course still carries it through the fuse
   * radius (the fuse stays live). The jet's own maneuver after the call is what takes it off that course.
   * @returns {number} missiles that lost their lock
   */
  breakLock(aircraft, maxTti, only = null) {
    if (!aircraft || !aircraft.position) return 0;
    const p = aircraft.position, av = aircraft.velocity || _zero, ms = this.missiles;
    let n = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m.alive || m.target !== aircraft || (only !== null && m !== only)) continue;
      const rx = m.position.x - p.x, ry = m.position.y - p.y, rz = m.position.z - p.z, d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const vc = Math.max(50, -(rx * (m.velocity.x - av.x) + ry * (m.velocity.y - av.y) + rz * (m.velocity.z - av.z)) / Math.max(d, 1));
      if (d / vc >= maxTti) continue;
      m.target = null; m.shookFrom = aircraft; n++;
    }
    return n;
  }

  /** Condensation burst around a jet (the boss Cobra's onset, js/ai.js): a dozen white vapor puffs that bloom off the
   *  airframe and hang back in the air. Plain smoke-pool sprites, no glow. */
  vaporBurst(aircraft) {
    if (!aircraft || !aircraft.position) return;
    const p = aircraft.position, v = aircraft.velocity || _zero, t = this.time, s = aircraft.visualScale || 1;
    for (let k = 0; k < 14; k++) {
      randDir(_v0);
      const r = rand(2, 7) * s;
      this._puff(p.x + _v0.x * r, p.y + _v0.y * r * 0.5, p.z + _v0.z * r, v.x * 0.55 + _v0.x * rand(10, 22), v.y * 0.55 + _v0.y * rand(6, 14),
        v.z * 0.55 + _v0.z * rand(10, 22), rand(0.9, 1.6), rand(5, 8) * s, rand(18, 28) * s, 0.96, 0.97, 1, 0.6, 2.2, 0, 0, 0, 0.8, t, 0, 0, 0, 0.03);
    }
  }

  _allocFlare() {
    if (this._flareFreeN === 0) return null;
    this._flaresInUse++;
    return this._flarePool[this._flareFree[--this._flareFreeN]];
  }

  /** Every flare free (pool order: index 0 is handed out first). */
  _resetFlareFree() {
    this._flareFreeN = 0;
    for (let i = FLARE_CAPACITY - 1; i >= 0; i--) this._flareFree[this._flareFreeN++] = i;
  }

  /** Back to the pool. Missiles still chasing it lose their target and go ballistic (then self-destruct at end of life). */
  _releaseFlare(f) {
    if (!f.inUse) return;
    f.inUse = false; f.alive = false; f.health = 0; f.ejected = false; f.owner = null;
    this._flareFree[this._flareFreeN++] = f.poolIndex;
    this._flaresInUse--;
    const ms = this.missiles;
    for (let j = 0; j < ms.length; j++) if (ms[j].target === f) ms[j].target = null;
  }

  _allocBurst() {
    const B = this._bursts;
    let oldest = B[0];
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b.active) return b;
      if (b.t0 < oldest.t0) oldest = b;
    }
    // all busy (pathological): retire the oldest burst now; flares still in its dispenser are dropped
    for (let j = oldest.next; j < oldest.count; j++) oldest.flares[j].alive = false;
    this._freeBurst(oldest);
    return oldest;
  }

  _freeBurst(b) {
    b.active = false; b.aircraft = null;
    for (let j = 0; j < b.count; j++) b.flares[j] = null;
    b.count = 0; b.next = 0;
  }

  /** The most recent burst of `a` still inside its protection window, or null. */
  _protectingBurst(a) {
    const B = this._bursts, t = this.time, win = this.flareProtectTime;
    let best = null;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.active && b.aircraft === a && t - b.t0 <= win && (best === null || b.t0 > best.t0)) best = b;
    }
    return best;
  }

  /** Retarget missile m onto one of burst b's first flares: one ejected on the missile's side of the jet (so it does
   *  not fly through the jet to reach it), several missiles spread round-robin over them. */
  _decoy(m, b) {
    const a = b.aircraft, F = b.flares, nEarly = Math.min(b.count, 6);
    let side = 1;
    if (a && a.position) {
      this._forward(a, _fwd); this._upOf(a, _up);
      _right.crossVectors(_fwd, _up);
      const p = a.position;
      side = (m.position.x - p.x) * _right.x + (m.position.y - p.y) * _right.y + (m.position.z - p.z) * _right.z >= 0 ? 1 : -1;
    }
    let cnt = 0;
    for (let j = 0; j < nEarly; j++) if (F[j].alive && F[j].side === side) cnt++;
    let pick = null;
    if (cnt > 0) {
      let want = b.assigned % cnt;
      for (let j = 0; j < nEarly; j++) {
        const f = F[j];
        if (!f.alive || f.side !== side) continue;
        if (want-- === 0) { pick = f; break; }
      }
    } else {
      for (let j = 0; j < b.count; j++) if (F[j].alive) { pick = F[j]; break; }
    }
    if (!pick) return false;
    b.assigned++;
    m.decoyedFrom = m.target;
    m.target = pick;
    if (this.onDecoy) this.onDecoy(m, pick, a);
    return true;
  }

  /** Flare leaves the dispenser: fix its trajectory (back-dated to its scheduled time) and write its GPU sprites
   *  (burning head + bright tail streak), both flown by the shaders from that single write. */
  _ejectFlare(f, a) {
    const lag = Math.max(0, this.time - f.ejectAt);
    const ap = a.position, av = a.velocity || _zero;
    this._forward(a, _fwd); this._upOf(a, _up);
    _right.crossVectors(_fwd, _up).normalize();
    const sd = f.side, o = f.order;
    // dispenser: rear belly, a little outboard (local +Z is aft)
    const lx = sd * rand(0.5, 1.2), ly = -rand(0.6, 0.9), lz = rand(1.5, 3.5);
    const px = ap.x + _right.x * lx + _up.x * ly - _fwd.x * lz - av.x * lag;
    const py = ap.y + _right.y * lx + _up.y * ly - _fwd.y * lz - av.y * lag;
    const pz = ap.z + _right.z * lx + _up.z * ly - _fwd.z * lz - av.z * lag;
    // outward + downward (+ a little aft): the first flares of a burst fan out sideways, the last ones drop
    let dx = sd * (0.95 - 0.45 * o + rand(-0.12, 0.12)), dy = -(0.5 + 0.45 * o + rand(0, 0.15)), dz = rand(0.05, 0.35);
    const sp = rand(this.flareEjectSpeedMin, this.flareEjectSpeedMax) / Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx *= sp; dy *= sp; dz *= sp;
    const vx = av.x + _right.x * dx + _up.x * dy - _fwd.x * dz;
    const vy = av.y + _right.y * dx + _up.y * dy - _fwd.y * dz;
    const vz = av.z + _right.z * dx + _up.z * dy - _fwd.z * dz;
    f.p0.set(px, py, pz); f.v0.set(vx, vy, vz);
    f.birth = f.ejectAt;
    f.drag = Math.max(0.05, this.flareDrag * rand(0.9, 1.1));   // same clamp as wnIntegrate
    f.gy = -this.flareGravity;
    f.ejected = true;
    f.position.set(px, py, pz); f.velocity.set(vx, vy, vz); f.prev.set(px, py, pz); f.age = 0;
    // the burning flare: ONE sprite for its whole burn (the shader flies the same closed-form trajectory)
    const r = this._recF, c = this.flareColor, R = this.flareRadiance;
    r[0] = px; r[1] = py; r[2] = pz; r[3] = f.birth;
    r[4] = vx; r[5] = vy; r[6] = vz; r[7] = f.life;
    r[8] = this.flareSize * rand(0.85, 1.15); r[9] = f.drag; r[10] = f.gy; r[11] = rnd();
    r[12] = R * c.x; r[13] = R * c.y; r[14] = R * c.z; r[15] = this.flareCore;
    this._flareRing.push(r);
    // bright comet tail: one spark streak drawn from p(t - flareStreakTime) to p(t) along the same closed-form flight,
    // long while the flare is fast, shrinking to a glint as it slows (it dims / warms with age: bright-then-grey trail)
    // (records instead of positional spawn calls: no double boxing whatever the JIT tier)
    const k = this.flareStreakRadiance, K = this._recK;
    K[0] = px; K[1] = py; K[2] = pz; K[3] = f.birth; K[4] = vx; K[5] = vy; K[6] = vz; K[7] = f.life;
    K[8] = k * c.x; K[9] = k * c.y; K[10] = k * c.z; K[11] = this.flareStreakWidth;
    K[12] = f.drag; K[13] = f.gy; K[14] = this.flareStreakTime; K[15] = rnd();
    this._sparkRing.push(K);
    if (!this._far(px, py, pz)) {                                // ignition pop at the dispenser
      const sz = this.flareSize, g = this._recG;
      g[0] = px; g[1] = py; g[2] = pz; g[3] = f.birth; g[4] = vx; g[5] = vy; g[6] = vz; g[7] = 0.09;
      g[8] = 10; g[9] = 8; g[10] = 6; g[11] = 1; g[12] = sz * 1.4; g[13] = sz * 2.4; g[14] = 3; g[15] = 0;
      g[16] = 0.2; g[17] = 0; g[18] = 0.3; g[19] = rnd();
      this._fireRing.push(g);
    }
  }

  /** Eject due flares, fly them (closed form = the sprites'), emit their smoke trails, retire burnt-out ones. */
  _updateFlares() {
    if (this._flaresInUse === 0) return;
    const t = this.time;
    const B = this._bursts;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (!b.active) continue;
      const a = b.aircraft, dead = Weapons._isDead(a);
      while (b.next < b.count) {
        const f = b.flares[b.next];
        if (!dead && f.ejectAt > t) break;
        if (dead) f.alive = false;                               // jet destroyed mid-burst: the rest never leave
        else if (f.alive) this._ejectFlare(f, a);
        b.next++;
      }
      if (!dead) {                                               // still in the dispenser: ride along with the jet
        const av = a.velocity || _zero;
        for (let j = b.next; j < b.count; j++) { const f = b.flares[j]; f.position.copy(a.position); f.velocity.copy(av); }
      }
      if (b.next >= b.count && t - b.t0 >= Math.max(this.flareBurstTime, this.flareProtectTime)) this._freeBurst(b);
    }
    const P = this._flarePool;
    for (let i = 0; i < P.length; i++) {
      const f = P[i];
      if (!f.inUse) continue;
      if (!f.alive) { this._releaseFlare(f); continue; }
      if (!f.ejected) continue;
      const age = t - f.birth;
      if (age >= f.life) { this._releaseFlare(f); continue; }   // burnt out
      const pos = f.position;
      f.prev.copy(pos);
      f.age = age;
      const k = f.drag, ek = Math.exp(-k * age), e = (1 - ek) / k, gy = f.gy;
      pos.set(f.p0.x + f.v0.x * e, f.p0.y + f.v0.y * e + gy * (age - e) / k, f.p0.z + f.v0.z * e);
      f.velocity.set(f.v0.x * ek, f.v0.y * ek + gy * (1 - ek) / k, f.v0.z * ek);
      if (pos.y < this.terrainCeiling) {
        const h = this._ground(pos.x, pos.z);
        if (pos.y < (h > 0 ? h : 0)) { this._releaseFlare(f); continue; }   // fell onto the ground / into the sea
      }
      this._flareTrail(f);                                       // object arg only: doubles would be boxed per call
    }
  }

  /** Thin smoke trail: one puff per flareSmokeSpacing m of flight + a trickle while the flare hangs, each stretched
   *  along the path (1.9x the mean puff spacing) so the fast first second stays one continuous line. */
  _flareTrail(f) {
    const dt = this._dt, t = this.time, p = f.position, v = f.velocity, o = f.prev;
    const ox = o.x, oy = o.y, oz = o.z, ddx = p.x - ox, ddy = p.y - oy, ddz = p.z - oz;
    const L = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    const burn = f.age / f.life;
    const rateF = L / Math.max(0.5, this.flareSmokeSpacing) + this.flareSmokeRate * dt;   // expected puffs this frame
    f.smokeAcc += rateF;
    let n = f.smokeAcc | 0;
    f.smokeAcc -= n;
    if (n > 8) n = 8;
    if (n === 0) return;
    const S = this._recS, st = -1.9 / Math.max(rateF, 1e-3), a0 = 0.6 * (1 - 0.6 * burn * burn);
    S[14] = 1.2; S[15] = 0.5; S[16] = 0; S[17] = 0; S[18] = 0.55;
    S[20] = ddx * st; S[21] = ddy * st; S[22] = ddz * st; S[23] = 0.05;
    for (let k = 0; k < n; k++) {
      const u = (k + rnd()) / n, wv = 0.74 + rnd() * 0.1;
      S[0] = ox + ddx * u; S[1] = oy + ddy * u; S[2] = oz + ddz * u; S[3] = t - (1 - u) * dt;
      S[4] = v.x * 0.04 + (rnd() - 0.5) * 2; S[5] = v.y * 0.04 + (rnd() - 0.5) * 2; S[6] = v.z * 0.04 + (rnd() - 0.5) * 2;
      S[7] = 2.2 + rnd() * 0.8;
      S[8] = wv; S[9] = wv; S[10] = wv * 0.98; S[11] = a0 * (0.8 + 0.4 * rnd());
      S[12] = 0.7 + rnd() * 0.2; S[13] = 2.6 + rnd() * 0.9; S[19] = rnd();
      this._smokeRing.push(S);
    }
  }

  // ===============================================================================================
  // Explosions / deaths / impacts
  // ===============================================================================================
  /** Explosion FX: flash, fireball sprites (white-hot -> dark smoke), shockwave ring, sparks, smoke, tendrils.
   *  Optional `velocity` (Vector3) is partially inherited by the fireball (e.g. a dying aircraft's momentum). */
  explode(position, size = 1, velocity = null) {
    if (!position) return;
    this._explode(position.x, position.y, position.z, size, velocity ? velocity.x : 0, velocity ? velocity.y : 0,
      velocity ? velocity.z : 0, true);
  }

  /** Light AA flak burst: a brief, very bright flash with a hot core, a few shell-fragment sparks and a dense, dark,
   *  lumpy smoke puff that hangs in the air for ~5 s. About 17 particles and no shockwave ring (explode(p, 0.3) spawns
   *  ~80). notify = false skips onExplosion (no sound, screen flash or shake: purely cosmetic flak). */
  flakPuff(position, notify = true) {
    if (!position) return;
    const px = position.x, py = position.y, pz = position.z, t = this.time;
    this._glow(px, py, pz, 0, 0, 0, 0.11, 6, 13, 20, 13, 6, 2, 0, 0.3, 0.2, t);                      // flash
    this._glow(px, py, pz, 0, 0, 0, rand(0.18, 0.26), 3.5, 7, 7, 2.6, 0.6, 2.5, 0, 1, 0.8, t);       // hot core, cools fast
    const life0 = rand(5, 6);                                                                     // smoke: a dense core puff,
    this._puff(px, py, pz, 0, 0.6, 0, life0, 5, rand(16, 19), 0.05, 0.047, 0.044, 0.92, 2.2, 0.35, 0.14 / life0, 0.9, 1, t);
    for (let i = 0; i < 5; i++) {                                                                 // and lumps around it
      randDir(_v0);
      const r0 = rand(1.2, 2.6), sp = rand(4, 9), life = rand(3.8, 5.2), dark = rand(0.05, 0.09);
      this._puff(px + _v0.x * r0, py + _v0.y * r0, pz + _v0.z * r0, _v0.x * sp, _v0.y * sp + 0.5, _v0.z * sp,
        life, rand(3.5, 4.5), rand(10, 14), dark, dark * 0.95, dark * 0.9, rand(0.75, 0.9), 2.4, 0.3, 0.1 / life, 0.6, 1, t);
    }
    for (let i = 0; i < 8; i++) {                                                                 // shell fragments
      randDir(_v0);
      const sp = rand(80, 170), c = rand(0.7, 1.2);
      this._spark(px, py, pz, _v0.x * sp, _v0.y * sp, _v0.z * sp, rand(0.25, 0.55), 14 * c, 7 * c, 2.2 * c, 0.13, 0.9, -G, rand(0.04, 0.07), t);
    }
    this._commit();
    if (notify && this.onExplosion) { this._cbPos.set(px, py, pz); this.onExplosion(this._cbPos, 0.3); }
  }

  _explode(px, py, pz, size, bx, by, bz, tendrils) {
    const s = Math.max(0.1, +size || 1), ss = Math.sqrt(s);
    const t = this.time;
    // flash: one big, very short additive sprite -> instant bloom pop
    this._glow(px, py, pz, bx * 0.5, by * 0.5, bz * 0.5, 0.15, 18 * s, 30 * s, 16, 10, 5, 2, 0, 0.4, 0.2, t);
    // hot additive core puffs
    for (let i = 0; i < 4; i++) {
      randDir(_v0);
      const sp = rand(4, 14) * ss;
      this._glow(px + _v0.x * s, py + _v0.y * s, pz + _v0.z * s, bx * 0.4 + _v0.x * sp, by * 0.4 + _v0.y * sp, bz * 0.4 + _v0.z * sp,
        rand(0.25, 0.4), rand(5, 7) * s, rand(11, 15) * s, 6, 2.2, 0.5, 2.5, 3, 1, 0.8, t);
    }
    // core fireball sprites: orange-white -> dark smoke over ~0.8 s
    const nCore = rnd() < 0.5 ? 2 : 3;
    for (let i = 0; i < nCore; i++) {
      const life = rand(2.0, 2.6);
      this._puff(px + rand(-1.5, 1.5) * s, py + rand(-1, 1.5) * s, pz + rand(-1.5, 1.5) * s,
        bx * 0.35 + rand(-3, 3), by * 0.35 + rand(0, 4), bz * 0.35 + rand(-3, 3),
        life, rand(8, 10) * s, rand(22, 28) * s, 0.07, 0.065, 0.06, 0.9, 2.5, 2.5, 0.8 / life, rand(0.9, 1.05), 1, t);
    }
    // lumpy fireball lobes pushed outward
    const nLobes = Math.min(18, Math.round(10 + 4 * s));
    for (let i = 0; i < nLobes; i++) {
      randDir(_v0);
      const r0 = rand(0.5, 2.5) * s, sp = rand(15, 45) * ss, life = rand(1.3, 2.2), fire = rand(0.4, 0.75);
      this._puff(px + _v0.x * r0, py + _v0.y * r0, pz + _v0.z * r0,
        bx * 0.35 + _v0.x * sp, by * 0.35 + _v0.y * sp + 3, bz * 0.35 + _v0.z * sp,
        life, rand(4, 6) * s, rand(13, 17) * s, 0.09, 0.085, 0.08, 0.85, 3.5, 2, fire / life, rand(0.6, 0.85), 1, t);
    }
    // sparks
    const nSparks = Math.min(60, Math.round(38 + 10 * s));
    for (let i = 0; i < nSparks; i++) {
      randDir(_v0);
      _v0.y = _v0.y * 0.8 + 0.25;
      const sp = rand(60, 200) * (0.7 + 0.3 * s), c = rand(0.6, 1.25);
      this._spark(px, py, pz, bx * 0.5 + _v0.x * sp, by * 0.5 + _v0.y * sp, bz * 0.5 + _v0.z * sp,
        rand(0.5, 1.3), 14 * c, 6 * c, 1.5 * c, 0.2 * Math.pow(s, 0.3), 0.9, -G, rand(0.05, 0.09), t);
    }
    // grey smoke puffs, rising and growing
    const nSmoke = Math.min(30, Math.round(18 + 5 * s));
    for (let i = 0; i < nSmoke; i++) {
      randDir(_v0);
      const r0 = rand(1, 4) * s, sp = rand(6, 20) * ss, life = rand(4, 7), grey = rand(0.14, 0.28);
      this._puff(px + _v0.x * r0, py + _v0.y * r0, pz + _v0.z * r0,
        bx * 0.3 + _v0.x * sp, by * 0.3 + _v0.y * sp + 4, bz * 0.3 + _v0.z * sp,
        life, rand(6, 8) * s, rand(20, 27) * s, grey, grey * 0.95, grey * 0.9, rand(0.5, 0.7), 1.2, 2.2, 0.35 / life, 0.5, 1,
        t + rand(0, 0.15), 0, 0, 0, 0.25);
    }
    // tendrils: invisible emitters thrown outward, leaving curling smoke / fire trails
    if (tendrils && s >= 0.6) {
      const nT = Math.min(7, Math.round(2 + 2.2 * s));
      for (let i = 0; i < nT; i++) {
        randDir(_v0);
        _v0.y = Math.abs(_v0.y) * 0.8 + 0.2;
        _v0.normalize();
        const sp = rand(25, 48) * ss;
        this._emit(KIND_TENDRIL, px, py, pz, bx * 0.4 + _v0.x * sp, by * 0.4 + _v0.y * sp, bz * 0.4 + _v0.z * sp, rand(0.4, 0.75), 40, s);
      }
    }
    if (tendrils) this._ring(px, py, pz, 60 * s, 0.5, 1);                 // secondary blasts don't add rings
    this._commit();
    if (this.onExplosion) { this._cbPos.set(px, py, pz); this.onExplosion(this._cbPos, size); }
  }

  /** Big explosion + chained secondary blasts + 12 burning debris chunks + a lingering black smoke column, sized to the
   *  airframe as drawn (its visualScale: enemies are drawn larger than life; never below life size). */
  aircraftDeath(aircraft) {
    if (!aircraft || !aircraft.position) return;
    const p = aircraft.position, v = aircraft.velocity || _zero, k = aircraft.visualScale > 1 ? aircraft.visualScale : 1;
    this._death(p.x, p.y, p.z, v.x, v.y, v.z, k);
  }

  _death(px, py, pz, vx, vy, vz, k = 1) {
    this._tmpPos.set(px, py, pz);
    this._tmpVel.set(vx * 0.45, vy * 0.45, vz * 0.45);
    this.explode(this._tmpPos, 2.2 * k, this._tmpVel);
    this._delay(0.16, px + vx * 0.08 + rand(-6, 6) * k, py + rand(-3, 5) * k, pz + vz * 0.08 + rand(-6, 6) * k, 1.2 * k, vx * 0.5, vy * 0.5, vz * 0.5);
    this._delay(0.4, px + vx * 0.2 + rand(-9, 9) * k, py + rand(-5, 4) * k, pz + vz * 0.2 + rand(-9, 9) * k, 0.9 * k, vx * 0.4, vy * 0.4, vz * 0.4);
    for (let i = 0; i < 12; i++) this._spawnChunk(px, py, pz, vx, vy, vz, i < 2, k);
    this._emit(KIND_COLUMN, px, py, pz, vx * 0.08, vy * 0.08, vz * 0.08, 4.5, 16, k);
    this._commit();
  }

  /** Dust puff + dirt (land) or a white spray column (water, position.y <= 0.5). `scale` 1 = missile/aircraft, 0.25 = bullet. */
  terrainImpact(position, scale = 1) {
    if (!position) return;
    const s = Math.max(0.05, +scale || 1), ss = Math.sqrt(s), t = this.time;
    const x = position.x, z = position.z;
    if (position.y <= 0.5) {
      const y = 0.3;
      const nCol = Math.max(3, Math.round(26 * s));
      for (let i = 0; i < nCol; i++) {
        const a = rand(0, 6.283), rr = rnd() * 2 * s, hs = rand(2, 9) * ss, c = Math.cos(a), sn = Math.sin(a);
        this._puff(x + c * rr, y, z + sn * rr, c * hs, rand(28, 62) * ss, sn * hs,
          rand(1.8, 3.0), rand(2, 3) * s, rand(9, 13) * s, 0.95, 0.97, 1.0, rand(0.55, 0.8), 0.6, -G, 0, 0, 0.8, t);
      }
      const nMist = Math.max(2, Math.round(10 * s));
      for (let i = 0; i < nMist; i++) {
        const a = rand(0, 6.283), hs = rand(6, 16) * ss, c = Math.cos(a), sn = Math.sin(a);
        this._puff(x, y + s, z, c * hs, rand(1, 4), sn * hs,
          rand(3, 4.5), rand(5, 7) * s, rand(22, 30) * s, 0.92, 0.94, 0.97, rand(0.35, 0.5), 1.2, 0.4, 0, 0, 1, t + rand(0, 0.2));
      }
    } else {
      const h = this._ground(x, z);
      const y = this.world && typeof this.world.getHeight === 'function' ? Math.max(h, 0) : position.y;
      const nDust = Math.max(2, Math.round(12 * s));
      for (let i = 0; i < nDust; i++) {
        const a = rand(0, 6.283), hs = rand(6, 20) * ss, c = Math.cos(a), sn = Math.sin(a), rr = rnd() * 2 * s;
        this._puff(x + c * rr, y + s, z + sn * rr, c * hs, rand(4, 10) * ss, sn * hs,
          rand(3, 5), rand(4, 6) * s, rand(20, 28) * s, 0.46, 0.38, 0.29, rand(0.5, 0.7), 1.6, 0.6, 0, 0, 1, t + rand(0, 0.1));
      }
      const nDirt = Math.max(2, Math.round(10 * s));
      for (let i = 0; i < nDirt; i++) {
        const a = rand(0, 6.283), hs = rand(3, 12) * ss, c = Math.cos(a), sn = Math.sin(a);
        this._puff(x, y + 0.5, z, c * hs, rand(20, 45) * ss, sn * hs,
          rand(1.2, 2.0), rand(0.7, 1.0) * ss, rand(0.4, 0.6) * ss, 0.07, 0.06, 0.05, 0.95, 0.4, -G, 0, 0, 0.25, t);
      }
      const nSp = Math.max(1, Math.round(4 * s));
      for (let i = 0; i < nSp; i++) {
        randDir(_v0);
        _v0.y = Math.abs(_v0.y) + 0.3;
        const sp = rand(30, 90) * ss;
        this._spark(x, y + 0.3, z, _v0.x * sp, _v0.y * sp, _v0.z * sp, rand(0.2, 0.5), 14, 8, 3, 0.08, 1.5, -G, 0.04, t);
      }
    }
    this._commit();
  }

  _spawnChunk(px, py, pz, vx, vy, vz, big, k = 1) {
    if (this._nChunks >= DEBRIS_CAPACITY) return;
    const c = this._chunks[this._nChunks++];
    randDir(_v0);
    const sp = big ? rand(8, 22) : rand(15, 45);
    c.p.set(px + _v0.x * 2 * k, py + _v0.y * 2 * k, pz + _v0.z * 2 * k);
    c.prev.copy(c.p);
    c.v.set(vx * 0.75 + _v0.x * sp, vy * 0.75 + _v0.y * sp + rand(0, 10), vz * 0.75 + _v0.z * sp);
    randDir(c.axis);
    c.spin = rand(2, 9) * (big ? 0.4 : 1);
    randDir(_v0);
    c.q.setFromAxisAngle(_v0, rand(0, 6.283));
    if (big) c.s.set(rand(0.9, 1.3), rand(0.8, 1.1), rand(2.8, 4.2));
    else {
      const k = rnd();
      if (k < 0.4) c.s.set(rand(1.2, 2.6), rand(0.08, 0.2), rand(0.7, 1.5));        // skin / wing panel
      else if (k < 0.75) c.s.set(rand(0.4, 0.9), rand(0.4, 0.8), rand(0.6, 1.6));   // chunk
      else c.s.set(rand(0.2, 0.5), rand(0.2, 0.5), rand(0.2, 0.5));                 // bits
    }
    if (k !== 1) c.s.multiplyScalar(k);                                             // pieces of a jet drawn larger than life
    c.tint = big ? rand(0.16, 0.26) : rand(0.06, 0.32);
    c.age = 0; c.life = rand(3.6, 4.4);
    c.burn = big ? c.life : rand(1.0, 3.0);
    c.smokeAcc = rnd(); c.fireAcc = rnd();
    c.big = big;
  }

  _updateDebris(dt) {
    const mesh = this._debrisMesh, mat = mesh.instanceMatrix.array, col = mesh.instanceColor.array;
    const drag = Math.exp(-0.35 * dt), gdt = G * dt;
    for (let i = 0; i < this._nChunks;) {
      const c = this._chunks[i];
      c.age += dt;
      if (c.age >= c.life) { this._removeChunk(i); continue; }
      const p = c.p, v = c.v;
      c.prev.x = p.x; c.prev.y = p.y; c.prev.z = p.z;
      v.x *= drag; v.y = v.y * drag - gdt; v.z *= drag;
      p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
      _q0.setFromAxisAngle(c.axis, c.spin * dt);
      c.q.premultiply(_q0);
      const h = Math.max(this._ground(c.p.x, c.p.z), 0);
      if (c.p.y < h) {
        const big = c.big;
        this._removeChunk(i);
        if (!this._far(c.p.x, h, c.p.z)) { this._tmpPos.set(c.p.x, h + (h <= 0 ? -0.1 : 0.5), c.p.z); this.terrainImpact(this._tmpPos, big ? 0.6 : 0.3); }
        continue;
      }
      this._chunkTrail(c);
      _m0.compose(c.p, c.q, c.s);
      _m0.toArray(mat, i * 16);
      const glow = c.age < c.burn ? 1.25 : 1;
      col[i * 3] = c.tint * glow; col[i * 3 + 1] = c.tint; col[i * 3 + 2] = c.tint * 1.04;
      i++;
    }
    mesh.count = this._nChunks;
    mesh.visible = this._nChunks > 0;
    if (this._nChunks > 0) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
  }

  _removeChunk(i) {
    const last = --this._nChunks;
    if (i !== last) { const tmp = this._chunks[i]; this._chunks[i] = this._chunks[last]; this._chunks[last] = tmp; }
  }

  _chunkTrail(c) {
    const dt = this._dt, t = this.time, burning = c.age < c.burn, fade = 1 - c.age / c.life;
    const ox = c.prev.x, oy = c.prev.y, oz = c.prev.z, ddx = c.p.x - ox, ddy = c.p.y - oy, ddz = c.p.z - oz;
    const vx = c.v.x, vy = c.v.y, vz = c.v.z, big = c.big;
    const rate = (big ? 36 : 14) * (0.4 + 0.6 * fade);
    c.smokeAcc += rate * dt;
    let n = c.smokeAcc | 0;
    c.smokeAcc -= n;
    const st = -1.2 / rate;                            // stretch along the path: ~1.2x the spacing between puffs
    const S = this._recS;
    S[11] = big ? 0.55 : 0.5; S[14] = 1.2; S[15] = 1.2; S[16] = burning ? 0.07 : 0; S[17] = 0.7; S[18] = 1;
    S[20] = vx * st; S[21] = vy * st; S[22] = vz * st; S[23] = 0.04;
    for (let k = 0; k < n; k++) {
      const u = (k + rnd()) / n;
      S[0] = ox + ddx * u; S[1] = oy + ddy * u; S[2] = oz + ddz * u; S[3] = t - (1 - u) * dt;
      S[4] = vx * 0.15 + (rnd() - 0.5) * 3; S[5] = vy * 0.15 + rnd() * 2; S[6] = vz * 0.15 + (rnd() - 0.5) * 3;
      S[7] = big ? 2.6 + rnd() : 1.8 + rnd();
      const grey = burning ? 0.07 + rnd() * 0.06 : 0.14 + rnd() * 0.08;
      S[8] = grey; S[9] = grey; S[10] = grey;
      S[12] = big ? 2.2 + rnd() * 0.8 : 1.4 + rnd() * 0.8; S[13] = big ? 10 + rnd() * 3 : 6 + rnd() * 3;
      S[19] = rnd();
      this._smokeRing.push(S);
    }
    if (burning && !this._far(c.p.x, c.p.y, c.p.z)) {
      c.fireAcc += (big ? 50 : 30) * dt;
      n = c.fireAcc | 0;
      c.fireAcc -= n;
      const g = this._recG;
      g[8] = 9; g[9] = 2.4; g[10] = 0.4; g[11] = 1; g[12] = big ? 4.5 : 2.6; g[13] = 0.8; g[14] = 1.5; g[15] = 2;
      g[16] = 1; g[17] = 0; g[18] = 0.8;
      for (let k = 0; k < n; k++) {
        const u = (k + rnd()) / n;
        g[0] = ox + ddx * u; g[1] = oy + ddy * u; g[2] = oz + ddz * u; g[3] = t - (1 - u) * dt;
        g[4] = vx * 0.8 + (rnd() - 0.5) * 8; g[5] = vy * 0.8 + (rnd() - 0.5) * 8; g[6] = vz * 0.8 + (rnd() - 0.5) * 8;
        g[7] = 0.22 + rnd() * 0.18; g[19] = rnd();
        this._fireRing.push(g);
      }
    }
  }

  _updateEmitters(dt) {
    const E = this._emitters, t = this.time;
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (!e.active) continue;
      e.age += dt;
      if (e.age >= e.dur) { e.active = false; continue; }
      const ox = e.x, oy = e.y, oz = e.z;
      if (e.kind === KIND_TENDRIL) {
        const f = Math.exp(-0.9 * dt);
        e.vx *= f; e.vy = e.vy * f - G * dt; e.vz *= f;
      } else {
        const f = Math.exp(-1.5 * dt);
        e.vx *= f; e.vy *= f; e.vz *= f;
      }
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      if (e.kind === KIND_TENDRIL && e.y < this._ground(e.x, e.z)) { e.active = false; continue; }
      const rate = e.kind === KIND_COLUMN ? e.rate * Math.sqrt(1 - e.age / e.dur) : e.rate;
      e.acc += rate * dt;
      const n = e.acc | 0;
      e.acc -= n;
      const s = e.s, ss = Math.sqrt(s), S = this._recS, g = this._recG;
      const ddx = e.x - ox, ddy = e.y - oy, ddz = e.z - oz;
      S[20] = 0; S[21] = 0; S[22] = 0; S[23] = 0.04; S[18] = 1;
      if (e.kind === KIND_TENDRIL) {
        const heat = 1 - e.age / e.dur;
        S[11] = 0.42; S[12] = 1.6 * ss; S[14] = 1.5; S[15] = 1.2; S[16] = 0.12; S[17] = 0.6 * heat;
        g[7] = 0.25; g[8] = 9 * heat; g[9] = 2.4 * heat; g[10] = 0.4 * heat; g[11] = 1; g[12] = 3.0 * ss; g[13] = 1;
        g[14] = 1.5; g[15] = 0; g[16] = 1; g[17] = 0; g[18] = 0.8;
        g[4] = e.vx * 0.5; g[5] = e.vy * 0.5; g[6] = e.vz * 0.5;
      } else {
        S[11] = 0.6; S[14] = 0.6; S[15] = 1.8; S[16] = e.age < 0.8 ? 0.06 : 0; S[17] = 0.8;
      }
      for (let k = 0; k < n; k++) {
        const u = (k + rnd()) / n, birth = t - (1 - u) * dt;
        const x = ox + ddx * u, y = oy + ddy * u, z = oz + ddz * u;
        S[3] = birth; S[19] = rnd();
        if (e.kind === KIND_TENDRIL) {
          const grey = 0.22 + rnd() * 0.12;
          S[0] = x; S[1] = y; S[2] = z;
          S[4] = e.vx * 0.1 + (rnd() - 0.5) * 2; S[5] = e.vy * 0.1 + rnd() * 1.5; S[6] = e.vz * 0.1 + (rnd() - 0.5) * 2;
          S[7] = 1.6 + rnd(); S[8] = grey; S[9] = grey * 0.97; S[10] = grey * 0.94; S[13] = (6 + rnd() * 2) * ss;
          this._smokeRing.push(S);
          if ((k & 1) === 0) {
            g[0] = x; g[1] = y; g[2] = z; g[3] = birth; g[19] = rnd();
            this._fireRing.push(g);
          }
        } else {
          randDir(_v0);
          const grey = 0.04 + rnd() * 0.03;
          S[0] = x + _v0.x * 4; S[1] = y + _v0.y * 4; S[2] = z + _v0.z * 4;
          S[4] = e.vx + (rnd() - 0.5) * 5; S[5] = e.vy + 2 + rnd() * 3; S[6] = e.vz + (rnd() - 0.5) * 5;
          S[7] = 7 + rnd() * 2; S[8] = grey; S[9] = grey; S[10] = grey;
          S[12] = (8 + rnd() * 3) * s; S[13] = (34 + rnd() * 10) * s;
          this._smokeRing.push(S);
        }
      }
    }
  }

  _processDelayed() {
    const D = this._delayed, f = this._frameNo;
    for (let i = 0; i < D.length; i++) {
      const e = D[i];
      if (!e.active || e.at > this.time || e.frame > f) continue;
      e.active = false;
      this._runEffect(e.kind, e.x, e.y, e.z, e.s, e.vx, e.vy, e.vz);
    }
  }

  // ===============================================================================================
  // Frame update
  // ===============================================================================================
  /** Integrate bullets, missiles, debris and emitters; resolve hits; push particle data. Call once per frame.
   *  teamTargets (optional, { team: [targets] }): what shooters on that team can hit; other shooters use aircraftList. */
  update(dt, aircraftList, camera, teamTargets = null) {
    dt = Math.min(Math.max(+dt || 0, 0), 0.05);
    const list = Array.isArray(aircraftList) ? aircraftList : EMPTY;
    this._teamTargets = teamTargets && typeof teamTargets === 'object' ? teamTargets : null;
    this.time += dt;
    this._dt = dt;
    if (camera && camera.matrixWorld) {
      const e = camera.matrixWorld.elements;
      this._camPos.set(e[12], e[13], e[14]);
      this._hasCam = true;
    }
    this._syncUniforms();
    if (dt > 0) {
      this._processDelayed();
      this._updateBullets(dt, list);
      this._updateFlares();                 // before missiles: guidance + flare fuse see this frame's flare positions
      this._updateMissiles(dt, list);
      this._updateDebris(dt);
      this._updateEmitters(dt);
    }
    this._commit();
    this._frameNo++;
  }

  _syncUniforms() {
    const U = this._u, w = this.world;
    U.uTime.value = this.time;
    if (w && w.sunDirection && w.sunDirection.isVector3) U.uSunDir.value.copy(w.sunDirection).normalize();
    const sc = U.uSunColor.value, k = this.smokeSunIntensity;
    const c = w && w.sunLight && w.sunLight.color;
    if (this.smokeSunFromWorld && c && c.isColor) {
      const mx = Math.max(c.r, c.g, c.b, 1e-4);
      sc.set(c.r / mx * k, c.g / mx * k, c.b / mx * k);
    } else {
      sc.copy(this.smokeSunColor).multiplyScalar(k);
    }
    this._tracerMat.uniforms.uWidth.value = this.tracerWidth;
    U.uMaxPx.value = this.maxPointSize;
  }

  /** Compile every FX material now. The pooled FX objects stay hidden while idle, so without this their shaders compile
   *  (and stall a frame) on first use. Optional; call once after construction. Program variants depend on the output
   *  target, so pass the render target the scene is drawn into (e.g. PostFX's HDR scene target), or null for the canvas. */
  precompile(renderer, camera, target = null) {
    if (!renderer || typeof renderer.compile !== 'function' || !camera) return;
    const objs = this._objects, vis = this._visScratch || (this._visScratch = []);
    const prevTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
    for (let i = 0; i < objs.length; i++) { vis[i] = objs[i].visible; objs[i].visible = true; }
    try {
      if (target !== prevTarget) renderer.setRenderTarget(target);
      renderer.compile(this.scene, camera);
    } catch (e) { /* optional optimisation: ignore */ }
    finally {
      if (target !== prevTarget) renderer.setRenderTarget(prevTarget);
      for (let i = 0; i < objs.length; i++) objs[i].visible = vis[i];
    }
  }

  /** Cheap counters for a debug overlay (returns a reused object). */
  getStats() {
    const s = this._stats;
    s.bullets = this._nb; s.missiles = this.missiles.length; s.debris = this._nChunks; s.flares = this._flaresInUse;
    let e = 0;
    for (let i = 0; i < this._emitters.length; i++) if (this._emitters[i].active) e++;
    s.emitters = e;
    let dc = 0;
    for (let i = 0; i < this._objects.length; i++) if (this._objects[i].visible) dc++;
    s.drawCalls = dc;
    return s;
  }

  dispose() {
    for (const o of this._objects) {
      if (o.parent) o.parent.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.isInstancedMesh && typeof o.dispose === 'function') o.dispose();
    }
    this._objects.length = 0;
    if (this._ringGeoSrc) this._ringGeoSrc.dispose();
    this._noiseTex.dispose();
    this.missiles.length = 0;
    this._missilePool.length = 0;
    this._nb = 0;
    this._nChunks = 0;
    this._bOwner.fill(null);
    for (const e of this._emitters) e.active = false;
    for (const e of this._delayed) e.active = false;
    for (const f of this._flarePool) { f.inUse = false; f.alive = false; f.health = 0; f.owner = null; }
    this._resetFlareFree();
    this._flaresInUse = 0;
    for (const b of this._bursts) this._freeBurst(b);
  }
}
