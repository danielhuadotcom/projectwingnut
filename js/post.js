import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';

// =====================================================================================================
// PostFX — HDR post-processing built on core Three.js only (no addons / EffectComposer).
//
// Resolution model
//   output   = the canvas drawing buffer (width * pixelRatio). The composite always writes it at native size.
//   internal = output * renderScale (0.5..1). Scene + bloom render at this size into SUB-RECTANGLES of targets
//              allocated once at the output size, so setRenderScale() is free at runtime (viewport + UV scale,
//              no reallocation, no shader recompile). Every tap is clamped to the active sub-rectangle, and the
//              MSAA resolve only covers the rendered area.
//
// Per frame (GPU timer labels 'scene' / 'bloom' / 'composite' via this.profiler):
//   1. scene      -> rtScene      R11G11B10F with MSAA 2/4, RGBA16F without MSAA; depth            internal res
//   2. bright     -> level[0]     exposure, soft threshold, luma-weighted (anti-firefly) prefilter  1/2 or 1/4 res
//   3. downsample -> level[1..]   13-tap "CoD:AW" (4-tap box at 'low') down to ~22 px tall
//   4. upsample   -> up[..0]      tent of the coarser level, lerp with the same-res level ("scatter"); the last pass
//                                 also applies bloomStrength and adds the analytic lens flare (ghosts / halo / streak /
//                                 glare): smooth content, so 1/4 (or 1/16) of the pixels is plenty
//   5. composite  -> canvas       1:1 fetch, or bilinear upscale + RCAS-style contrast-adaptive sharpening; FXAA-console
//                                 style edge AA when MSAA is off; chromatic aberration (skipped where < 0.3 px);
//                                 exposure, + bloom/flare texture, vignette, ACES (Hill fit), damage/flash overlays,
//                                 linear->sRGB, hash grain (also dithers the 8-bit output)
// All passes draw one fullscreen triangle with ShaderMaterials; no per-frame allocations.
// Measured on an integrated laptop GPU at 1080p the passes are bandwidth-bound first (~30 GB/s effective: one full-res RGBA16F
// read ~0.5 ms, R11G11B10F ~0.28 ms) and ALU-bound second, which is what the format / pass layout above optimises.
// =====================================================================================================

const MIN_SCALE = 0.5;
const MAX_SCALE = 1.0;

// Quality presets (MSAA samples and render scale are separate setters). start: first bloom level (1 = half res,
// 2 = quarter res); bright/down/up: filter tap counts (13 = CoD:AW 36-texel filter, 4 = box; 9 = 3x3 tent, 4 = 4-tap);
// flare: 0 off, 1 glare + streak only, 2 full (ghosts + halo); ca: chromatic aberration; grain: grain multiplier.
// 'ultra' is exactly the original bloom. 'high' differs only by the 4-tap bright prefilter (-0.28 ms at 1080p on
// integrated GPU; the bright pass is sampler-bound): a slightly tighter glow on thin bright lines (tracers), elsewhere within
// ~1/255. Presets only change uniforms and the bloom chain's start level -- never a shader program or a render-target
// format -- so runtime switches cannot trigger pipeline (re)compiles.
export const POST_QUALITY = {
  low:    { start: 2, bright: 4,  down: 4,  up: 4, flare: 1, ca: 0, grain: 0.35 },
  medium: { start: 2, bright: 13, down: 13, up: 9, flare: 2, ca: 1, grain: 1 },
  high:   { start: 1, bright: 4,  down: 13, up: 9, flare: 2, ca: 1, grain: 1 },
  ultra:  { start: 1, bright: 13, down: 13, up: 9, flare: 2, ca: 1, grain: 1 },
};

// Lens-flare ghosts along the sun -> centre axis: [k (position = sun * (1 - k)), radius, weight, tint]
const GHOSTS = [
  [0.42, 0.040, 0.080, [1.00, 0.55, 0.25]],
  [0.70, 0.022, 0.070, [0.40, 0.90, 1.00]],
  [1.20, 0.090, 0.030, [0.60, 0.40, 1.00]],
  [1.45, 0.030, 0.085, [1.00, 0.80, 0.50]],
  [1.80, 0.060, 0.050, [0.30, 0.60, 1.00]],
  [2.30, 0.120, 0.018, [1.00, 0.45, 0.30]],
  [-0.35, 0.050, 0.035, [0.60, 1.00, 0.70]],
];

const GHOST_MAX_RADIUS = Math.max(...GHOSTS.map((g) => g[1]));

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;      // 0..1 across the current viewport (= the active sub-rectangle)
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Downsample / bright pass. uWide 1: 13 bilinear taps on a 2-texel grid = 36-texel footprint (Jimenez 2014,
// "Next Generation Post Processing in CoD:AW"). uWide 0: 4 bilinear taps on the texel corners around the footprint
// centre = exact 4x4 box (also an exact 4x4 box for the 4x quarter-res bright pass). A uniform (coherent) branch rather
// than a #define so quality changes never switch programs. BRIGHT adds exposure, the soft
// (quadratic-knee) threshold per tap and a luma-weighted ("partial Karis") average per 2x2 group so fireflies /
// sub-pixel sparkle cannot flicker the bloom.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec4 uSrc;          // xy: uv extent of the source's active sub-rectangle, zw: 1 / allocated source size
uniform vec2 uSrcMax;       // largest uv a tap may use (centre of the last valid texel): no bleed from outside the sub-rect
uniform float uWide;        // 1: 13-tap filter, 0: 4-tap box
#ifdef BRIGHT
uniform float uExposure;
uniform vec4 uThreshold;    // x: threshold, y: threshold - knee, z: 2 * knee, w: 0.25 / knee
uniform float uKaris;
#endif
varying vec2 vUv;

vec3 tap(vec2 uv, vec2 off) {
  vec3 c = texture2D(tSrc, min(uv + off * uSrc.zw, uSrcMax)).rgb;
#ifdef BRIGHT
  c = clamp(c, vec3(0.0), vec3(16384.0)) * uExposure;        // kills negatives / NaN / absurd values
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold.y, 0.0, uThreshold.z);
  soft = soft * soft * uThreshold.w;
  c *= max(soft, br - uThreshold.x) / max(br, 1e-4);
#endif
  return c;
}

#ifdef BRIGHT
vec3 avg4(vec3 a, vec3 b, vec3 c, vec3 d) {
  const vec3 L = vec3(0.2126, 0.7152, 0.0722);
  vec4 w = 1.0 / (1.0 + uKaris * vec4(dot(a, L), dot(b, L), dot(c, L), dot(d, L)));
  return (a * w.x + b * w.y + c * w.z + d * w.w) / (w.x + w.y + w.z + w.w);
}
#else
vec3 avg4(vec3 a, vec3 b, vec3 c, vec3 d) { return (a + b + c + d) * 0.25; }
#endif

void main() {
  vec2 uv = vUv * uSrc.xy;
  vec3 col;
  if (uWide > 0.5) {
    vec3 a = tap(uv, vec2(-2.0,  2.0)), b = tap(uv, vec2(0.0,  2.0)), c = tap(uv, vec2(2.0,  2.0));
    vec3 d = tap(uv, vec2(-2.0,  0.0)), e = tap(uv, vec2(0.0,  0.0)), f = tap(uv, vec2(2.0,  0.0));
    vec3 g = tap(uv, vec2(-2.0, -2.0)), h = tap(uv, vec2(0.0, -2.0)), i = tap(uv, vec2(2.0, -2.0));
    vec3 j = tap(uv, vec2(-1.0,  1.0)), k = tap(uv, vec2(1.0,  1.0));
    vec3 l = tap(uv, vec2(-1.0, -1.0)), m = tap(uv, vec2(1.0, -1.0));
    col = avg4(j, k, l, m) * 0.5 + (avg4(a, b, d, e) + avg4(b, c, e, f) + avg4(d, e, g, h) + avg4(e, f, h, i)) * 0.125;
  } else {
    col = avg4(tap(uv, vec2(-1.0, 1.0)), tap(uv, vec2(1.0, 1.0)), tap(uv, vec2(-1.0, -1.0)), tap(uv, vec2(1.0, -1.0)));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// Upsample: tent of the coarser level, blended with the same-resolution downsample ("scatter" lerp keeps
// the result bounded by the input brightness, so bloomStrength has a predictable meaning).
// uTent 1: 3x3 tent at uRadius texels. uTent 0: 4 bilinear taps at +-0.5 * uRadius texels (narrower, cheaper).
// FINAL (last pass, level 0): also applies bloomStrength and adds the lens flare / glare / anamorphic streak, so the
// full-resolution composite just adds one texture (the flare is smooth: 1/4 or 1/16 of the pixels is plenty).
const UP_FRAG = /* glsl */ `
uniform sampler2D tLow;     // coarser level being upsampled
uniform sampler2D tHigh;    // same-resolution downsample level
uniform vec4 uLow;          // xy: uv extent of tLow's active sub-rect, zw: 1 / allocated tLow size
uniform vec2 uLowMax;       // uv clamp for tLow taps
uniform vec4 uHigh;         // xy: uv extent of tHigh's active sub-rect
uniform float uRadius;
uniform float uScatter;
uniform float uTent;        // 1: 9-tap tent, 0: 4 taps
#ifdef FINAL
uniform float uStrength;    // bloomStrength
uniform float uAspect;      // output aspect
uniform vec4 uSun;          // xy: sun in centred height-normalised coords, z: flare intensity (0 = skip), w: ghost count
uniform vec4 uAxis;         // xy: unit sun -> centre axis, z: max ghost radius (ghosts all lie on that axis)
uniform vec4 uGhost[7];     // xy: ghost centre, z: radius^2, w: 1 / radius
uniform vec3 uGhostCol[7];  // tint * weight * edge fade (CPU-side)
#endif
varying vec2 vUv;
vec3 tapL(vec2 uv) { return texture2D(tLow, min(uv, uLowMax)).rgb; }

#ifdef FINAL
// all analytic, no textures. q/s are centred, height-normalised coords (x: +-aspect/2)
vec3 lensFlare(vec2 q, vec2 s) {
  vec3 col = vec3(0.0);
  // ghosts: one distance-to-axis test rejects most pixels before looking at individual discs
  if (uSun.w > 0.0 && abs(q.x * uAxis.y - q.y * uAxis.x) < uAxis.z) {
    for (int i = 0; i < 7; i++) {
      vec2 d = q - uGhost[i].xy;
      float dd = dot(d, d);
      if (dd < uGhost[i].z) {
        float t = sqrt(dd) * uGhost[i].w;
        col += uGhostCol[i] * ((1.0 - smoothstep(0.6, 1.0, t)) * (0.55 + 0.45 * smoothstep(0.3, 1.0, t)));
      }
    }
  }
  float q2 = dot(q, q);
  if (uSun.w > 0.0 && q2 > 0.0784 && q2 < 0.2704) {     // faint chromatic halo ring (radius 0.40 +- 0.12)
    float hd = sqrt(q2) - 0.40;
    col += mix(vec3(1.0, 0.55, 0.35), vec3(0.45, 0.65, 1.0), smoothstep(-0.03, 0.03, hd)) * (exp(-hd * hd * 700.0) * 0.01);
  }
  vec2 sv = q - s;                      // anamorphic streak (horizontal) + veiling glare around the sun
  float ay = abs(sv.y);
  if (ay < 0.07) {
    float ax = abs(sv.x);
    col += vec3(0.50, 0.68, 1.0) * (0.28 * exp(-ay * 110.0) * (0.55 * exp(-ax * 1.6) + 0.45 * exp(-ax * 7.0)));
  }
  float dl = length(sv);
  col += vec3(1.0, 0.82, 0.62) * (0.06 * exp(-dl * 6.0) + 0.22 * exp(-dl * 30.0));
  return col;
}
#endif

void main() {
  vec2 uv = vUv * uLow.xy;
  vec2 t = uLow.zw * uRadius;
  vec3 s;
  if (uTent > 0.5) {
    s = (tapL(uv - t) + tapL(uv + vec2(t.x, -t.y)) + tapL(uv + vec2(-t.x, t.y)) + tapL(uv + t)
      + 2.0 * (tapL(uv - vec2(0.0, t.y)) + tapL(uv - vec2(t.x, 0.0)) + tapL(uv + vec2(t.x, 0.0)) + tapL(uv + vec2(0.0, t.y)))
      + 4.0 * tapL(uv)) * (1.0 / 16.0);
  } else {
    vec2 h = t * 0.5;
    s = (tapL(uv - h) + tapL(uv + vec2(h.x, -h.y)) + tapL(uv + vec2(-h.x, h.y)) + tapL(uv + h)) * 0.25;
  }
  vec3 col = mix(texture2D(tHigh, vUv * uHigh.xy).rgb, s, uScatter);
#ifdef FINAL
  col *= uStrength;
  if (uSun.z > 0.0) col += lensFlare((vUv - 0.5) * vec2(uAspect, 1.0), uSun.xy) * uSun.z;
#endif
  gl_FragColor = vec4(col, 1.0);
}
`;

// Composite. Two programs: FULL 0 = lean 1:1 fetch (internal == output, MSAA on); FULL 1 = 5 taps (centre + 4
// diagonals at +-0.5 input texel) feeding, via uniform branches, bilinear upscale + contrast-adaptive sharpening
// (FSR1 RCAS limiter on luma, uSharp > 0) and FXAA-console edge AA (uFxaa, used when MSAA is off; +4 directional taps on
// edge pixels only). Sharpening works on luma normalised by the local maximum and AA blends in a reversible
// luma-tonemapped space, so neither can ring around HDR highlights. The bloom texture already contains bloomStrength
// and the lens flare (see UP_FRAG FINAL).
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec4 uScene;        // xy: uv extent of the scene's active sub-rect, zw: 1 / allocated scene size (texel)
uniform vec2 uSceneMax;     // uv clamp (centre of the last valid scene texel)
uniform vec4 uBloom;        // xy: uv extent of the bloom sub-rect, zw: uv clamp
uniform float uAspect;
uniform float uExposure;
uniform vec2 uChroma;       // x: chromatic aberration strength * 0.0018, y: r^2 below which CA is < 0.3 px (taps skipped)
uniform float uVignette;
uniform float uFlash;
uniform float uDamage;
uniform float uGrain;       // grain amplitude (0.028 * grain)
uniform vec2 uGrainSeed;
uniform float uSharp;       // RCAS strength 0..1 (FULL 1)
uniform float uFxaa;        // 1: edge AA (FULL 1)
varying vec2 vUv;

// ---- Stephen Hill's ACES fit (same matrices as three.js' ACESFilmicToneMapping; the 1/0.6 exposure convention
// of three.js -- scene 1.0 -> ~0.8 display -- is folded into the input matrix) ----
const mat3 ACESInputMat = mat3(
  0.59719 / 0.6, 0.07600 / 0.6, 0.02840 / 0.6,
  0.35458 / 0.6, 0.90834 / 0.6, 0.13383 / 0.6,
  0.04823 / 0.6, 0.01566 / 0.6, 0.83777 / 0.6);
const mat3 ACESOutputMat = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);
vec3 acesFitted(vec3 c) {
  vec3 v = ACESInputMat * c;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACESOutputMat * (a / b), 0.0, 1.0);
}
vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

float hash12(vec2 p) {                  // Dave Hoskins' hash without sine: white-noise film grain
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 sceneTap(vec2 uv) { return texture2D(tScene, min(uv, uSceneMax)).rgb; }

#if FULL == 1
const vec3 LW = vec3(0.299, 0.587, 0.114);
// Reversible luma tonemap for edge blending (exposure folded in): t = c*E / (1 + luma(c)*E), c*E = t / (1 - luma(t)),
// luma(t) in [0,1): blends happen in a perceptual-ish space so AA'd edges don't fatten towards the bright side.
vec3 tmap(vec3 c) { c = max(c, vec3(0.0)) * uExposure; return c * (1.0 / (1.0 + dot(c, LW))); }
vec3 itmap(vec3 t) { return t * (1.0 / max(1.0 - dot(t, LW), 1e-3)); }
#endif

void main() {
  vec2 uv = vUv;
  vec2 p = uv * 2.0 - 1.0;
  float r2 = dot(p, p);
  vec2 suv = uv * uScene.xy;

  // ---- scene colour at the output pixel (exposed HDR) ----
  vec3 c0, hdr;
#if FULL == 0
  c0 = texture2D(tScene, suv).rgb;      // exactly on a texel centre (internal == output)
  hdr = max(c0, vec3(0.0)) * uExposure;
#else
  // 5 taps: centre + 4 diagonals at +-0.5 input texel (bilinear: 2x2 box averages at native res, as in FXAA console)
  vec2 tx = uScene.zw;
  vec2 h = 0.5 * tx;
  c0 = sceneTap(suv);
  vec3 cNW = sceneTap(suv + vec2(-h.x, h.y)), cNE = sceneTap(suv + h);
  vec3 cSW = texture2D(tScene, suv - h).rgb, cSE = sceneTap(suv + vec2(h.x, -h.y));
  float Lc = max(dot(c0, LW), 0.0), Lnw = max(dot(cNW, LW), 0.0), Lne = max(dot(cNE, LW), 0.0);
  float Lsw = max(dot(cSW, LW), 0.0), Lse = max(dot(cSE, LW), 0.0);
  float Lmn4 = min(min(Lnw, Lne), min(Lsw, Lse)), Lmx4 = max(max(Lnw, Lne), max(Lsw, Lse));
  float Lmax = max(Lmx4, Lc);
  hdr = max(c0, vec3(0.0)) * uExposure;
  vec3 fx = hdr;
  float fxw = 0.0;
  float Lmin = min(Lmn4, Lc);
  float tMin = Lmin * uExposure / (1.0 + Lmin * uExposure), tMax = Lmax * uExposure / (1.0 + Lmax * uExposure);
  float gMax = sqrt(tMax), gRange = gMax - sqrt(tMin);   // ~gamma-space luma range for the edge test
  float thr = max(0.05, gMax * 0.166);
  if (uFxaa > 0.5 && gRange >= thr) {
    // FXAA console: blend along the edge, direction from the diagonals. Weighted by edge strength and by gradient
    // coherence: thin features (no usable direction) are left alone instead of smeared, and the smooth weight
    // avoids per-pixel on/off speckle.
    vec2 dir = vec2((Lsw + Lse) - (Lnw + Lne), (Lnw + Lsw) - (Lne + Lse));
    float d2 = dot(dir, dir), rng = Lmax - Lmin;
    fxw = smoothstep(thr, 2.0 * thr, gRange) * smoothstep(0.0625, 0.25, d2 / max(4.0 * rng * rng, 1e-20));
    if (fxw > 0.0) {
      dir *= inversesqrt(max(d2, 1e-20));
      vec3 a = (tmap(sceneTap(suv - dir * h)) + tmap(sceneTap(suv + dir * h))) * 0.5;
      vec2 dir2 = clamp(dir / max(min(abs(dir.x), abs(dir.y)) * 8.0, 1e-4), -2.0, 2.0);
      vec3 b = (tmap(sceneTap(suv - dir2 * (2.0 * tx))) + tmap(sceneTap(suv + dir2 * (2.0 * tx)))) * 0.25 + a * 0.5;
      float lb = dot(b, LW);
      fx = itmap((lb < tMin || lb > tMax) ? a : b);
    }
  }
  if (uSharp > 0.0) {
    // FSR1 RCAS limiter on luma, with the diagonal ring (a gentler, isotropic 3x3 sharpen). One reciprocal maps the
    // taps into [0,1) relative to the local maximum (bright neighbourhoods approach 1, where RCAS stops sharpening).
    // The result is then clamped to the local [min, max] (CAS-style, no over/undershoot: edges get steeper but no
    // halos, and a lone dark texel inside a bright ring is not driven to black). Applied as a luma ratio (keeps hue).
    float sN = uExposure / (1.0 + Lmax * uExposure);
    float le = Lc * sN, mn4 = Lmn4 * sN, mx4 = Lmx4 * sN;
    float hitMin = min(mn4, le) / (4.0 * mx4 + 1e-6);
    float hitMax = (1.0 - max(mx4, le)) / (4.0 * mn4 - 4.0);
    float lobe = max(-0.1875, min(max(-hitMin, hitMax), 0.0)) * uSharp;
    float lsh = (lobe * (Lnw + Lne + Lsw + Lse) * sN + le) / (4.0 * lobe + 1.0);
    lsh = clamp(lsh, min(mn4, le), max(mx4, le));
    hdr *= lsh / max(le, 1e-8);
  }
  hdr = mix(hdr, fx, fxw);
#endif

  // ---- chromatic aberration: radial, ~r^3, isotropic in pixels; taps skipped where it is < 0.3 px ----
  if (r2 > uChroma.y) {
    vec2 ca = p * (r2 * uChroma.x * smoothstep(uChroma.y, 1.3 * uChroma.y, r2)) * vec2(1.0, uAspect) * uScene.xy;
    float cr = sceneTap(suv + ca).r;
    float cb = sceneTap(suv - ca).b;
    hdr.r = max(hdr.r + (max(cr, 0.0) - max(c0.r, 0.0)) * uExposure, 0.0);
    hdr.b = max(hdr.b + (max(cb, 0.0) - max(c0.b, 0.0)) * uExposure, 0.0);
  }

  // ---- bloom * strength + lens flare (one texture, prepared at 1/2 or 1/4 res) ----
  hdr += texture2D(tBloom, min(uv * uBloom.xy, uBloom.zw)).rgb;

  // vignette (scene-referred, like a lens)
  float rad = sqrt(r2);
  hdr *= 1.0 - uVignette * smoothstep(0.3, 1.5, rad);

  vec3 ldr = acesFitted(hdr);

  // damage: red edge pulse (display-referred)
  if (uDamage > 0.0) {
    float edge = smoothstep(0.25, 1.3, rad);
    ldr = mix(ldr, vec3(0.72, 0.015, 0.0), clamp(uDamage * (edge * 0.9 + 0.08), 0.0, 1.0));
  }
  // flash: toward white (skipped while none is live, e.g. with flashEnabled off)
  if (uFlash > 0.0) ldr = mix(ldr, vec3(1.0), uFlash);

  // encode + very subtle animated grain (also dithers the 8-bit output)
  vec3 srgb = linearToSRGB(ldr);
  float n = hash12(gl_FragCoord.xy + uGrainSeed) - 0.5;
  srgb += n * uGrain * (1.0 - 0.55 * dot(srgb, vec3(0.299, 0.587, 0.114)));
  gl_FragColor = vec4(srgb, 1.0);
}
`;

/* ───────────────────────────────── helpers ───────────────────────────────── */

function smoothstep01(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function makeMaterial(fragmentShader, uniforms, defines) {
  return new THREE.ShaderMaterial({
    uniforms, defines, vertexShader: FS_VERT, fragmentShader,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, fog: false, lights: false,
  });
}

/* ───────────────────────────────── PostFX ───────────────────────────────── */

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} width   CSS px
   * @param {number} height  CSS px
   * @param {number} pixelRatio   output pixels per CSS px (the canvas' pixel ratio, NOT multiplied by the render scale)
   * @param {{samples?: number, renderScale?: number, quality?: string, compactHDR?: boolean}} [options]
   *        samples: MSAA samples of the HDR scene target (0, 2, 4; default 4)
   *        renderScale: internal resolution scale 0.5..1 (default 1); quality: 'low'|'medium'|'high'|'ultra' (default 'high')
   *        compactHDR: use R11G11B10F for the bloom chain and the multisampled scene target (default true); false =
   *        RGBA16F everywhere (more precision headroom, ~1.3 ms slower at 4x MSAA 1080p on an integrated laptop GPU)
   */
  constructor(renderer, width, height, pixelRatio = 1, { samples = 4, renderScale = 1, quality = 'high', compactHDR = true } = {}) {
    this.renderer = renderer;
    this.compactHDR = compactHDR !== false;

    // ---- public tunables (SPEC) ----
    this.exposure = 1.0;
    this.bloomStrength = 0.55;
    this.bloomThreshold = 1.0;      // linear HDR, applied to scene * exposure
    this.bloomRadius = 1.0;         // 1 = default; larger = wider/softer glow
    this.vignette = 0.35;
    this.chromatic = 1.0;           // 1 = subtle (~4 px at the corners of a 1280 px wide frame), 0 = off
    // ---- extra tunables ----
    this.bloomKnee = 0.5;           // soft-threshold knee as a fraction of the threshold
    this.bloomKaris = 0.35;         // luma-weight strength of the anti-flicker average (0 = plain box)
    this.flareStrength = 1.0;       // lens flare / glare / anamorphic streak scale, 0 = off
    this.grain = 1.0;               // film grain scale, 0 = off (1 = +-3/255 max)
    this.flashTime = 0.3;           // seconds for a flash to decay to ~4 %
    this.flashEnabled = true;       // false: flash() is ignored, so no flash starts (the game's "Screen flash" setting)
    this.damageTime = 0.6;          // seconds for a damage pulse to decay to ~5 %
    this.sharpness = null;          // RCAS strength 0..1 when upscaling; null = automatic (stronger at lower scales)
    this.fxaa = true;               // edge AA folded into the composite whenever MSAA is off (activeSamples === 0)
    this.samples = samples;         // requested MSAA samples (setSamples() applies immediately; setSize() also re-reads it)

    // ---- internal state ----
    this._flash = 0;
    this._damage = 0;
    this._time = 0;
    this._sun = new THREE.Vector2(0.5, 0.5);
    this._sunVisible = false;
    this._sunIntensity = 1;
    this._sunFade = 0;
    this._renderScale = THREE.MathUtils.clamp(Number(renderScale) || 1, MIN_SCALE, MAX_SCALE);
    this._quality = POST_QUALITY[quality] ? quality : 'high';
    this._q = { ...POST_QUALITY[this._quality] };

    // ---- capabilities ----
    const caps = renderer.capabilities;
    this.isWebGL2 = !!caps.isWebGL2;
    let hdr = false;
    try {
      hdr = this.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    } catch (e) { hdr = false; }
    this.hdrType = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (!hdr) console.warn('PostFX: float render targets unavailable, falling back to 8-bit (bloom will clip).');

    // ---- fullscreen triangle + ortho camera (never touches the game scene) ----
    this._fsGeo = new THREE.BufferGeometry();
    this._fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this._tri = new THREE.Mesh(this._fsGeo, null);
    this._tri.frustumCulled = false;
    this._tri.matrixAutoUpdate = false;
    this._fsScene = new THREE.Scene();
    this._fsScene.add(this._tri);
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // ---- per-resolution uniform data (preallocated, updated by _applyScale) ----
    this._sceneSrc = new THREE.Vector4(1, 1, 1, 1);     // xy: uv extent of the scene sub-rect, zw: texel
    this._sceneMax = new THREE.Vector2(1, 1);
    this._bloomRect = new THREE.Vector4(1, 1, 1, 1);    // xy: uv extent of the final bloom level, zw: uv clamp

    // ---- materials (uniform objects shared by all variants of a pass) ----
    this._downU = {
      tSrc: { value: null }, uSrc: { value: this._sceneSrc }, uSrcMax: { value: this._sceneMax }, uWide: { value: 1 },
      uExposure: { value: 1 }, uThreshold: { value: new THREE.Vector4(1, 0.5, 1, 0.5) }, uKaris: { value: 0.35 },
    };
    this._ghost = GHOSTS.map(() => new THREE.Vector4(0, 0, 0, 1));
    this._ghostCol = GHOSTS.map(() => new THREE.Vector3());
    this._upU = {
      tLow: { value: null }, tHigh: { value: null }, uLow: { value: null }, uLowMax: { value: null }, uHigh: { value: null },
      uRadius: { value: 1 }, uScatter: { value: 0.7 }, uTent: { value: 1 },
      // FINAL pass only: bloom strength + lens flare
      uStrength: { value: 0.55 }, uAspect: { value: 1 }, uSun: { value: new THREE.Vector4(0, 0, 0, 0) },
      uAxis: { value: new THREE.Vector4(1, 0, 10, 0) }, uGhost: { value: this._ghost }, uGhostCol: { value: this._ghostCol },
    };
    this._grainSeed = new THREE.Vector2(0, 0);
    this._compU = {
      tScene: { value: null }, tBloom: { value: null },
      uScene: { value: this._sceneSrc }, uSceneMax: { value: this._sceneMax }, uBloom: { value: this._bloomRect },
      uAspect: { value: 1 }, uExposure: { value: 1 }, uChroma: { value: new THREE.Vector2(0.0018, 1e9) },
      uVignette: { value: 0.35 }, uFlash: { value: 0 }, uDamage: { value: 0 }, uGrain: { value: 0.028 }, uGrainSeed: { value: this._grainSeed },
      uSharp: { value: 0 }, uFxaa: { value: 0 },
    };
    // Six programs in total, all drawn from the first frame on (see _warmComposite); presets, render scale, sharpening
    // and FXAA only change uniforms.
    this._brightMat = makeMaterial(DOWN_FRAG, this._downU, { BRIGHT: 1 });
    this._downMat = makeMaterial(DOWN_FRAG, this._downU, {});
    this._upMat = makeMaterial(UP_FRAG, this._upU, {});
    this._upFinalMat = makeMaterial(UP_FRAG, this._upU, { FINAL: 1 });
    this._compLean = makeMaterial(COMPOSITE_FRAG, this._compU, { FULL: 0 });
    this._compFull = makeMaterial(COMPOSITE_FRAG, this._compU, { FULL: 1 });
    this._mats = [this._brightMat, this._downMat, this._upMat, this._upFinalMat, this._compLean, this._compFull];
    this._warmed = false;           // both composite programs drawn once (see _warmComposite)
    this._vpTmp = new THREE.Vector4();

    // ---- render targets ----
    this.rtScene = null;
    this._levels = [];              // bloom chain: { down, up, W, H, aw, ah, src: Vector4, max: Vector2 }
    this.activeSamples = 0;
    this.bloomLevels = 0;
    this.renderWidth = 1; this.renderHeight = 1;
    if (!(width > 0) || !(height > 0)) {
      const c = renderer.domElement;
      width = (c && c.clientWidth) || 1; height = (c && c.clientHeight) || 1;
    }
    this.setSize(width, height, pixelRatio);
    this._precompile();
  }

  /* ------------------------------------------------------------------ public API */

  /** Current internal resolution scale (0.5..1). Assigning it calls setRenderScale(). */
  get renderScale() { return this._renderScale; }
  set renderScale(s) { this.setRenderScale(s); }

  /** Current quality preset name. Assigning it calls setQuality(). */
  get quality() { return this._quality; }
  set quality(q) { this.setQuality(q); }

  /**
   * (Re)creates all render targets for an output (canvas) of width*pixelRatio x height*pixelRatio pixels.
   * pixelRatio is the canvas pixel ratio; the internal resolution is that times renderScale (see setRenderScale).
   */
  setSize(width, height, pixelRatio = this.pixelRatio || 1) {
    this.width = width; this.height = height; this.pixelRatio = pixelRatio;
    // floor() matches WebGLRenderer.setSize() so the composite maps 1:1 onto the drawing buffer
    const pw = Math.max(1, Math.floor(width * pixelRatio)), ph = Math.max(1, Math.floor(height * pixelRatio));
    if (this.rtScene && pw === this.pixelWidth && ph === this.pixelHeight) {
      // same output size: nothing to reallocate (only pick up a changed `samples`, the pre-setSamples() way)
      if (this._effectiveSamples() !== this.activeSamples) this._createSceneTarget();
      this._applyScale();
      return;
    }
    this.pixelWidth = pw; this.pixelHeight = ph;
    this._createSceneTarget();
    this._createBloomTargets();
    this._compU.uAspect.value = this._upU.uAspect.value = this.pixelWidth / this.pixelHeight;
    this._applyScale();
  }

  /**
   * Internal render scale, clamped to 0.5..1. Instant and allocation-free: the scene and bloom render into a
   * sub-rectangle of the full-size targets and the composite upscales to the canvas (with RCAS sharpening).
   * Returns the applied scale.
   */
  setRenderScale(s) {
    const v = THREE.MathUtils.clamp(Number(s) || 1, MIN_SCALE, MAX_SCALE);
    if (v !== this._renderScale) { this._renderScale = v; this._applyScale(); }
    return this._renderScale;
  }

  /** MSAA samples for the scene target: 0, 2 or 4 (clamped to the device). Recreates only the scene target. */
  setSamples(n) {
    const v = Number(n);
    this.samples = v >= 3 ? 4 : v >= 1 ? 2 : 0;
    if (this._effectiveSamples() !== this.activeSamples || !this.rtScene) {
      this._createSceneTarget();
      this._applyScale();
    }
    return this.activeSamples;
  }

  /** Quality preset: 'low' | 'medium' | 'high' | 'ultra' (bloom chain, flare, chromatic aberration, grain). */
  setQuality(q) {
    const key = POST_QUALITY[q] ? q : 'high';
    const prev = this._q;
    this._quality = key;
    this._q = { ...POST_QUALITY[key] };
    if (!prev || prev.start !== this._q.start || this._levels.length === 0) { this._createBloomTargets(); this._applyScale(); }
    return this._quality;
  }

  /** Additive white flash (clamped to 1) decaying over ~flashTime seconds. No-op while flashEnabled is false. */
  flash(intensity) {
    if (!this.flashEnabled) return;
    const v = Number(intensity);
    if (v > 0) this._flash = Math.min(1, this._flash + v);
  }

  /** Red edge-vignette pulse (clamped to 1) decaying over ~damageTime seconds. */
  damage(intensity) {
    const v = Number(intensity);
    if (v > 0) this._damage = Math.min(1, this._damage + v);
  }

  /**
   * Sun position in 0..1 screen coords, (0,0) = bottom-left, (1,1) = top-right (i.e. NDC * 0.5 + 0.5).
   * visible=false disables the flare (fades out smoothly). Optional intensity scales it (default 1).
   */
  setSunScreenPos(x, y, visible, intensity = 1) {
    if (Number.isFinite(x) && Number.isFinite(y)) this._sun.set(x, y);
    this._sunVisible = !!visible;
    this._sunIntensity = Number.isFinite(intensity) ? Math.max(0, intensity) : 1;
  }

  /** Renders scene with camera through the whole pipeline onto the canvas. */
  render(scene, camera, dt) {
    const r = this.renderer;
    const rt = this.rtScene;
    if (!rt) return;
    if (!(dt > 0) || !(dt < 1)) dt = 1 / 60;
    this._tick(dt);

    const prevAutoClear = r.autoClear;
    const info = r.info;
    const prevAutoReset = info.autoReset;
    if (prevAutoReset) { info.autoReset = false; info.reset(); }   // so info.render.* covers the whole frame

    // 1. scene -> HDR sub-rectangle. three.js resolves MSAA with a blit of rt.width x rt.height; shrinking those
    //    two fields for the duration of the call limits the resolve to the rendered area (the GL storage is
    //    untouched: it was allocated up front by initRenderTarget, and nothing else in render() reads them).
    const prof = this.profiler;            // optional js/profiler.js instance (pass-mode GPU timing hooks)
    if (prof) prof.beginPass('scene');
    r.setRenderTarget(rt);
    const allocW = rt.width, allocH = rt.height;
    const shrink = rt.samples > 0 && (this.renderWidth !== allocW || this.renderHeight !== allocH);
    if (shrink) { rt.width = this.renderWidth; rt.height = this.renderHeight; }
    try { r.render(scene, camera); }
    finally { if (shrink) { rt.width = allocW; rt.height = allocH; } }
    if (prof) { prof.endPass(); prof.beginPass('bloom'); }

    // 2. bloom bright pass (scene -> level 0 at 1/2 or 1/4 res)
    r.autoClear = false;    // every post pass fully overwrites its (sub-rect) target
    const tri = this._tri, fsScene = this._fsScene, cam = this._fsCam;
    const L = this._levels, n = L.length;
    const du = this._downU;
    const th = Math.max(0, this.bloomThreshold);
    const knee = Math.max(1e-4, th * Math.max(0, this.bloomKnee));
    du.tSrc.value = rt.texture; du.uSrc.value = this._sceneSrc; du.uSrcMax.value = this._sceneMax;
    du.uExposure.value = Math.max(0, this.exposure);
    du.uThreshold.value.set(th, th - knee, 2 * knee, 0.25 / knee);
    du.uKaris.value = Math.max(0, this.bloomKaris);
    const q = this._q;
    du.uWide.value = q.bright === 13 ? 1 : 0;
    tri.material = this._brightMat;
    r.setRenderTarget(L[0].down);
    r.render(fsScene, cam);

    // 3. progressive downsample
    du.uWide.value = q.down === 13 ? 1 : 0;
    tri.material = this._downMat;
    for (let i = 1; i < n; i++) {
      du.tSrc.value = L[i - 1].down.texture; du.uSrc.value = L[i - 1].src; du.uSrcMax.value = L[i - 1].max;
      r.setRenderTarget(L[i].down);
      r.render(fsScene, cam);
    }

    // 4. progressive upsample (tent + scatter blend); the last pass also applies bloomStrength and adds the flare
    const uu = this._upU;
    const radius = THREE.MathUtils.clamp(this.bloomRadius, 0, 3);
    uu.uRadius.value = radius;
    uu.uScatter.value = THREE.MathUtils.clamp(0.4 + 0.3 * radius, 0.05, 0.92);
    uu.uStrength.value = Math.max(0, this.bloomStrength);
    uu.uTent.value = q.up === 9 ? 1 : 0;
    this._updateFlare();
    let low = L[n - 1].down, lowLv = L[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      tri.material = i === 0 ? this._upFinalMat : this._upMat;
      uu.tLow.value = low.texture; uu.uLow.value = lowLv.src; uu.uLowMax.value = lowLv.max;
      uu.tHigh.value = L[i].down.texture; uu.uHigh.value = L[i].src;
      r.setRenderTarget(L[i].up);
      r.render(fsScene, cam);
      low = L[i].up; lowLv = L[i];
    }

    if (prof) { prof.endPass(); prof.beginPass('composite'); }
    // 5. composite -> canvas (native resolution)
    const cu = this._compU;
    cu.tScene.value = rt.texture;
    cu.tBloom.value = low.texture;
    cu.uExposure.value = Math.max(0, this.exposure);
    const chroma = q.ca ? Math.max(0, this.chromatic) : 0;
    // CA offset in output px ~ r^3 * chroma * 0.0018 * width -> skip the two extra taps where it is < 0.3 px
    cu.uChroma.value.set(chroma * 0.0018, chroma > 0 ? Math.pow(0.3 / (chroma * 0.0018 * this.pixelWidth), 2 / 3) : 1e9);
    cu.uVignette.value = THREE.MathUtils.clamp(this.vignette, 0, 1);
    cu.uFlash.value = this._flash;
    cu.uDamage.value = this._damage;
    cu.uGrain.value = 0.028 * Math.max(0, this.grain) * q.grain;
    const upscaled = this.renderWidth !== this.pixelWidth || this.renderHeight !== this.pixelHeight;
    const sharp = this.sharpness === null || this.sharpness === undefined ? this._autoSharpness() : THREE.MathUtils.clamp(Number(this.sharpness) || 0, 0, 1);
    cu.uSharp.value = sharp;
    const fx = this.fxaa && this.activeSamples === 0 ? 1 : 0;
    cu.uFxaa.value = fx;
    const full = upscaled || sharp > 0 || fx === 1;
    if (!this._warmed) this._warmComposite(full ? this._compLean : this._compFull);
    tri.material = full ? this._compFull : this._compLean;
    r.setRenderTarget(null);
    r.render(fsScene, cam);
    if (prof) prof.endPass();

    // restore renderer state
    r.autoClear = prevAutoClear;
    if (prevAutoReset) info.autoReset = true;
  }

  dispose() {
    this._disposeTargets();
    for (const m of this._mats) m.dispose();
    this._mats.length = 0;
    this._fsGeo.dispose();
    this._tri.material = null;
  }

  /* ------------------------------------------------------------------ internals */

  _effectiveSamples() {
    if (!this.isWebGL2) return 0;
    const max = this.renderer.capabilities.maxSamples || 0;
    return Math.max(0, Math.min(this.samples | 0, max));
  }

  /**
   * R11G11B10F if the preset asks for it and the device can render (and multisample) it; else RGBA16F.
   * The scene target only uses it with MSAA: there it halves the multisample + resolve traffic (measured in-game on
   * Integrated laptop GPU: 4x scene 5.7 -> 4.4 ms, 2x 4.35 -> 2.6 ms), while as a plain (non-MSAA) render target it measured slower
   * than RGBA16F (2.32 vs 2.08 ms; likely lost render compression for blended draws), so 0x keeps RGBA16F.
   */
  _useR11(samples, isScene = false) {
    if (!this.compactHDR || this.hdrType !== THREE.HalfFloatType) return false;
    if (isScene && samples === 0) return false;
    if (this._r11Samples === undefined) {
      this._r11Samples = -1;
      try {
        const gl = this.renderer.getContext();
        if (this.renderer.extensions.has('EXT_color_buffer_float')) {
          const list = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.R11F_G11F_B10F, gl.SAMPLES);
          this._r11Samples = list && list.length ? Math.max(...list) : 0;
        }
      } catch (e) { this._r11Samples = -1; }
    }
    return this._r11Samples >= samples;
  }

  _rtBase() {
    return {
      type: this.hdrType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false, colorSpace: THREE.NoColorSpace,
    };
  }

  _createSceneTarget() {
    if (this.rtScene) { this.rtScene.dispose(); this.rtScene = null; }
    const samples = this._effectiveSamples();
    const opts = { ...this._rtBase(), depthBuffer: true, samples, resolveDepthBuffer: false, resolveStencilBuffer: false };
    if (this._useR11(samples, true)) { opts.format = THREE.RGBFormat; opts.internalFormat = 'R11F_G11F_B10F'; }
    const rt = new THREE.WebGLRenderTarget(this.pixelWidth, this.pixelHeight, opts);
    rt.texture.name = 'PostFX.scene';
    // allocate the GL storage now, at full size (the per-frame resolve trick in render() relies on it)
    try { this.renderer.initRenderTarget(rt); } catch (e) { /* allocated lazily on first use instead */ }
    this.rtScene = rt;
    this.activeSamples = samples;
  }

  _createBloomTargets() {
    for (const lv of this._levels) { lv.down.dispose(); if (lv.up) lv.up.dispose(); }
    this._levels.length = 0;
    const pw = this.pixelWidth || 1, ph = this.pixelHeight || 1;
    // coarsest level ~22 px tall at the OUTPUT height (5 levels at 720p/1080p): glow width is independent of renderScale
    const end = THREE.MathUtils.clamp(Math.floor(Math.log2(Math.max(2, ph) / 22)), 4, 7);
    const start = Math.min(this._q.start, end - 1);
    const base = this._rtBase();
    if (this._useR11(0)) { base.format = THREE.RGBFormat; base.internalFormat = 'R11F_G11F_B10F'; }
    let w = pw, h = ph;
    for (let lv = 1; lv <= end; lv++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      if (lv < start) continue;
      const down = new THREE.WebGLRenderTarget(w, h, base);
      down.texture.name = 'PostFX.down' + lv;
      const up = lv < end ? new THREE.WebGLRenderTarget(w, h, base) : null;
      if (up) up.texture.name = 'PostFX.up' + lv;
      this._levels.push({ down, up, lv, W: w, H: h, aw: w, ah: h, src: new THREE.Vector4(1, 1, 1 / w, 1 / h), max: new THREE.Vector2(1, 1) });
    }
    this._bloomEnd = end;
    this._bloomStart = start;
    this.bloomLevels = this._levels.length;
  }

  /** Recomputes the internal size, sub-rect viewports and the uv extents / clamps used by every pass. */
  _applyScale() {
    const pw = this.pixelWidth, ph = this.pixelHeight;
    const s = this._renderScale;
    const rw = Math.max(1, Math.min(pw, Math.round(pw * s)));
    const rh = Math.max(1, Math.min(ph, Math.round(ph * s)));
    this.renderWidth = rw; this.renderHeight = rh;
    if (this.rtScene) this.rtScene.viewport.set(0, 0, rw, rh);
    this._sceneSrc.set(rw / pw, rh / ph, 1 / pw, 1 / ph);
    this._sceneMax.set((rw - 0.5) / pw, (rh - 0.5) / ph);
    // bloom: the same floor-halving chain as the allocation, started from the internal size
    let w = rw, h = rh, idx = 0;
    for (let lv = 1; lv <= this._bloomEnd; lv++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      if (lv < this._bloomStart) continue;
      const L = this._levels[idx++];
      if (!L) break;
      const aw = Math.min(w, L.W), ah = Math.min(h, L.H);
      L.aw = aw; L.ah = ah;
      L.down.viewport.set(0, 0, aw, ah);
      if (L.up) L.up.viewport.set(0, 0, aw, ah);
      L.src.set(aw / L.W, ah / L.H, 1 / L.W, 1 / L.H);
      L.max.set((aw - 0.5) / L.W, (ah - 0.5) / L.H);
    }
    const f = this._levels[0];
    if (f) this._bloomRect.set(f.src.x, f.src.y, f.max.x, f.max.y);
  }

  /** RCAS strength when `sharpness` is null: 0 at native res, ramping to full strength at renderScale <= 0.75
   *  (tuned on the resolution chart in test_post.html: best PSNR vs native and closest gradient energy). */
  _autoSharpness() {
    const s = this._renderScale;
    if (s >= 0.999) return 0;
    return THREE.MathUtils.clamp(0.5 + (1 - s) * 2.0, 0, 1);
  }

  /** Compiles and links all six programs up front (in parallel where KHR_parallel_shader_compile exists). */
  _precompile() {
    const r = this.renderer;
    if (typeof r.compile !== 'function') return;
    const prevTarget = r.getRenderTarget();
    try {
      const build = (mats) => {
        const s = new THREE.Scene();
        for (const m of mats) { const o = new THREE.Mesh(this._fsGeo, m); o.frustumCulled = false; s.add(o); }
        return s;
      };
      const go = (s) => { if (typeof r.compileAsync === 'function') r.compileAsync(s, this._fsCam).catch(() => {}); else r.compile(s, this._fsCam); };
      // bloom passes render into linear render targets, the composite into the canvas: compile each against its
      // real destination so the program cache keys match what render() will ask for
      r.setRenderTarget(this._levels[0] ? this._levels[0].down : null);
      go(build([this._brightMat, this._downMat, this._upMat, this._upFinalMat]));
      r.setRenderTarget(null);
      go(build([this._compLean, this._compFull]));
    } catch (e) { /* compiled lazily on first use instead */ }
    r.setRenderTarget(prevTarget);
  }

  /**
   * On ANGLE -> D3D12 a program's first real draw builds its GPU pipeline (measured here: ~0.4 s stall for the upscale
   * composite), even when three.js has already compiled and linked it. Render-scale changes flip the composite between
   * its two programs at any time (dynamic resolution), so on the first frame the one not in use is drawn once into a
   * 1x1 corner of the canvas, right before the real composite of the same frame overwrites it.
   */
  _warmComposite(mat) {
    const r = this.renderer;
    this._warmed = true;
    const vp = r.getViewport(this._vpTmp);
    const x = vp.x, y = vp.y, w = vp.z, h = vp.w;
    this._tri.material = mat;
    r.setRenderTarget(null);
    r.setViewport(0, 0, 1, 1);
    r.render(this._fsScene, this._fsCam);
    r.setViewport(x, y, w, h);
  }

  /** Lens-flare uniforms for the final bloom upsample: sun position, ghost discs (with their off-screen fade
   *  precomputed here instead of per pixel) and the sun -> centre axis they all lie on. */
  _updateFlare() {
    const q = this._q;
    const u = this._upU;
    const asp = this.pixelWidth / this.pixelHeight;
    const sx = (this._sun.x - 0.5) * asp, sy = this._sun.y - 0.5;
    const inten = q.flare > 0 ? this._sunFade * Math.max(0, this.flareStrength) : 0;
    const ghosts = q.flare >= 2 && inten > 0 ? GHOSTS.length : 0;
    u.uSun.value.set(sx, sy, inten, ghosts);
    if (!ghosts) return;
    const len = Math.hypot(sx, sy);
    if (len > 1e-3) u.uAxis.value.set(sx / len, sy / len, GHOST_MAX_RADIUS, 0);
    else u.uAxis.value.set(1, 0, 10, 0);              // sun at the centre: every ghost is there too, no rejection
    const ex = 2 / asp;
    for (let i = 0; i < GHOSTS.length; i++) {
      const [k, rad, w, tint] = GHOSTS[i];
      const gx = sx * (1 - k), gy = sy * (1 - k);
      const fd = 1 - smoothstep01(0.7, 1.15, Math.hypot(gx * ex, gy * 2));   // fade ghosts that leave the frame
      this._ghost[i].set(gx, gy, rad * rad, 1 / rad);
      this._ghostCol[i].set(tint[0] * w * fd, tint[1] * w * fd, tint[2] * w * fd);
    }
  }

  _tick(dt) {
    this._time += dt;
    // exponential decays: time constants chosen so the level is ~4-5 % after flashTime / damageTime
    this._flash *= Math.exp(-dt / Math.max(0.01, this.flashTime / 3.3));
    if (this._flash < 1e-3) this._flash = 0;
    this._damage *= Math.exp(-dt / Math.max(0.01, this.damageTime / 3.0));
    if (this._damage < 1e-3) this._damage = 0;
    // lens flare intensity: fades as the sun leaves the screen, slewed to avoid pops when visibility toggles
    let target = 0;
    if (this._sunVisible) {
      const m = Math.max(Math.abs(this._sun.x - 0.5), Math.abs(this._sun.y - 0.5)) * 2;
      target = (1 - smoothstep01(0.85, 1.2, m)) * this._sunIntensity;
    }
    this._sunFade += (target - this._sunFade) * (1 - Math.exp(-dt * 12));
    if (this._sunFade < 1e-4) this._sunFade = 0;
    this._grainSeed.set(Math.random() * 1024, Math.random() * 1024);
  }

  _disposeTargets() {
    if (this.rtScene) { this.rtScene.dispose(); this.rtScene = null; }
    for (const lv of this._levels) { lv.down.dispose(); if (lv.up) lv.up.dispose(); }
    this._levels.length = 0;
  }
}
