// js/timeofday.js — time-of-day lighting presets (day, golden hour, dusk, overcast dusk, evening, night) and the one
// function that applies a preset to the world, the PostFX pipeline, the weapon smoke and the night lights.
//
// A preset only changes values: uniforms, light colours, fog, exposure, bloom, the sky lookup table (re-graded on the CPU
// from a cached ungraded table) and, when the light direction moves, the baked terrain shadow and the PMREM environment
// (re-rendered into the same target). prewarmTimeOfDay (at boot) has World bake every preset's shadow and ungraded sky
// table in idle time, so the first use of a preset copies cached data instead of baking for 80-250 ms. Nothing here runs
// per frame and no shader is switched: the night extras (stars, ground lights and stronger engine glow) are
// behind uniforms or visibility flags (the ground lights are built at boot so the shader precompile and warm-up cover
// them), so the day look and its cost are unchanged.
//
// Campaign missions name their preset in js/missions.js (`time`, default 'day'); INFINITY rotates presets every
// ROTATE_ROUNDS rounds (js/infinity.js timeForRound). ?tod=<name> overrides both (benchmarks, screenshots).
// The Glassfall (js/glassfall.js) blends any preset toward its red variant (glassfallPreset, GLASSFALL below): one step
// per detonation, and missions[].red (M21) starts fully red.
//
// Lights for the night (shared uniform objects, read by js/engine_fx.js, js/targets.js and js/world.js). Jets carry no
// nav lights or strobes (combat jets fly dark): at night they read by their engine glow and the HUD markers.
//   NIGHT_FX.engine   exhaust glow multiplier (AfterburnerFX uIntensity)
//   NIGHT_FX.uGround  ground lights (settlements, mission units) intensity; 0 hides them (no draw call)

export const NIGHT_FX = {
  engine: 1,
  uGround: { value: 0 },
};

const D = (e, a) => ({ elev: e, az: a });   // degrees above the horizon; degrees left of -Z (the starting heading)

// Field guide (all linear HDR):
//   sun        light direction (the moon at night): every shader, the terrain shadow bake, the aircraft light
//   sunColor   direct light on terrain, sea, clouds, smoke hue      skyAmb / groundAmb  ambient (terrain, sea, clouds)
//   sky        { k: scale of the analytic sky, tint: per channel, sat: saturation, base: added glow (horizon-weighted) }
//   disc       sun / moon disc { k: brightness scale, tint }       stars: 0..1 star field in the sky shader
//   fog        haze density multiplier (shader fog and scene.fog)
//   light      aircraft DirectionalLight { color, intensity }; hemi: HemisphereLight { sky, ground, intensity }; env:
//              environment-map intensity (sky reflections on the jets)
//   clouds     { cut: coverage threshold (lower = more cloud), tint, puff: billboard puff brightness }   water: { tint (body colour), spec (sun/moon path) }
//   post       { exposure, bloom, threshold, flare, sat, contrast, wb (white balance before ACES) }
//   smoke      weapon smoke { sun: sun-side radiance, amb: shadow side }
//   lights     { engine, ground }: the night lights above
export const TIME_PRESETS = {
  day: {
    label: 'Day', sun: D(22, 35),
    sunColor: [2.7, 1.75, 1.0], skyAmb: [0.20, 0.29, 0.48], groundAmb: [0.18, 0.13, 0.09],
    sky: { k: 1, tint: [1, 1, 1], sat: 1, base: [0, 0, 0] }, disc: { k: 1, tint: [1, 1, 1] }, stars: 0, fog: 1,
    light: { color: 0xffd3a0, intensity: 3.0 }, hemi: { sky: 0x9cc0ea, ground: 0x6f5e46, intensity: 0.6 }, env: 1,
    clouds: { cut: 0.49, tint: [1, 1, 1], puff: 1 }, water: { tint: [1, 1, 1], spec: 1 },
    post: { exposure: 1, bloom: 0.55, threshold: 1, flare: 1, sat: 1, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 1.5, amb: [0.3, 0.36, 0.46] },
    lights: { engine: 1, ground: 0 },
  },
  golden: {
    label: 'Golden hour', sun: D(8, 40),
    sunColor: [2.55, 1.32, 0.56], skyAmb: [0.16, 0.20, 0.33], groundAmb: [0.17, 0.11, 0.06],
    sky: { k: 1.15, tint: [1.04, 1, 0.94], sat: 1, base: [0, 0, 0] }, disc: { k: 1, tint: [1, 0.92, 0.8] }, stars: 0, fog: 1.1,
    light: { color: 0xffb877, intensity: 2.8 }, hemi: { sky: 0x8fa8d0, ground: 0x6f5034, intensity: 0.55 }, env: 1,
    clouds: { cut: 0.47, tint: [1.04, 0.98, 0.92], puff: 1 }, water: { tint: [1, 0.95, 0.9], spec: 1 },
    post: { exposure: 1.08, bloom: 0.55, threshold: 1, flare: 1, sat: 1.04, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 1.35, amb: [0.26, 0.29, 0.38] },
    lights: { engine: 1, ground: 0 },
  },
  dusk: {
    label: 'Dusk', sun: D(2.2, 44),
    sunColor: [1.65, 0.62, 0.24], skyAmb: [0.085, 0.095, 0.17], groundAmb: [0.085, 0.055, 0.04],
    sky: { k: 1.6, tint: [1.05, 0.92, 1.12], sat: 1, base: [0.002, 0.0018, 0.004] }, disc: { k: 1.2, tint: [1, 0.75, 0.55] }, stars: 0, fog: 1.2,
    light: { color: 0xff9a5c, intensity: 2.0 }, hemi: { sky: 0x5d6c98, ground: 0x4e3626, intensity: 0.45 }, env: 0.8,
    clouds: { cut: 0.46, tint: [1.0, 0.92, 0.9], puff: 0.8 }, water: { tint: [0.85, 0.8, 0.85], spec: 1 },
    post: { exposure: 1.45, bloom: 0.55, threshold: 1.05, flare: 0.9, sat: 1.04, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 0.75, amb: [0.12, 0.12, 0.17] },
    lights: { engine: 1.15, ground: 0.25 },
  },
  overcast: {
    label: 'Overcast dusk', sun: D(7, 40),
    sunColor: [0.42, 0.39, 0.37], skyAmb: [0.105, 0.112, 0.13], groundAmb: [0.055, 0.052, 0.05],
    sky: { k: 0.32, tint: [0.9, 0.95, 1.06], sat: 0.3, base: [0.001, 0.001, 0.0012] }, disc: { k: 0, tint: [1, 1, 1] }, stars: 0, fog: 1.8,
    light: { color: 0xb8bcc4, intensity: 0.75 }, hemi: { sky: 0x8a919c, ground: 0x4a4744, intensity: 0.5 }, env: 0.5,
    clouds: { cut: 0.2, tint: [0.6, 0.62, 0.66], puff: 0.62 }, water: { tint: [0.7, 0.75, 0.75], spec: 0.04 },
    post: { exposure: 1.5, bloom: 0.5, threshold: 1.1, flare: 0, sat: 0.78, contrast: 0.88, wb: [0.97, 1, 1.04] },
    smoke: { sun: 0.35, amb: [0.12, 0.125, 0.135] },
    lights: { engine: 1.2, ground: 0.35 },
  },
  evening: {
    label: 'Evening', sun: D(0.4, 48),
    sunColor: [0.62, 0.25, 0.14], skyAmb: [0.12, 0.105, 0.19], groundAmb: [0.07, 0.05, 0.04],
    sky: { k: 0.85, tint: [0.92, 0.8, 1.08], sat: 1, base: [0.0025, 0.0018, 0.0045] }, disc: { k: 0, tint: [1, 1, 1] }, stars: 0.35, fog: 1.0,
    light: { color: 0xd8805c, intensity: 1.2 }, hemi: { sky: 0x7078a8, ground: 0x4a3428, intensity: 1.5 }, env: 1.0,
    clouds: { cut: 0.47, tint: [0.95, 0.8, 0.85], puff: 0.6 }, water: { tint: [0.7, 0.62, 0.75], spec: 0.6 },
    post: { exposure: 2.3, bloom: 0.5, threshold: 1.2, flare: 0, sat: 1.05, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 0.22, amb: [0.06, 0.055, 0.08] },
    lights: { engine: 1.3, ground: 0.7 },
  },
  night: {
    label: 'Night', sun: D(30, -28),
    sunColor: [0.075, 0.095, 0.15], skyAmb: [0.012, 0.017, 0.032], groundAmb: [0.006, 0.006, 0.008],
    sky: { k: 0.016, tint: [0.62, 0.82, 1.3], sat: 0.8, base: [0.0005, 0.0007, 0.0013] }, disc: { k: 0.14, tint: [0.9, 0.95, 1.0] }, stars: 1, fog: 1,
    light: { color: 0x9fb4e0, intensity: 0.35 }, hemi: { sky: 0x2c3a5c, ground: 0x15171c, intensity: 0.3 }, env: 0.3,
    clouds: { cut: 0.5, tint: [0.9, 0.95, 1.05], puff: 0.55 }, water: { tint: [0.8, 0.9, 1.1], spec: 1.1 },
    post: { exposure: 2.6, bloom: 0.45, threshold: 1.35, flare: 0.15, sat: 0.78, contrast: 1, wb: [0.96, 1, 1.06] },
    smoke: { sun: 0.1, amb: [0.02, 0.024, 0.035] },
    lights: { engine: 1.4, ground: 1 },
  },
};
export const TIME_NAMES = Object.keys(TIME_PRESETS);

/** Boot: build what a preset change would otherwise build mid-game (the ground lights, before the shader precompile) and
 *  queue the idle-time bakes of every preset's light direction (World.queueLighting), most used first. */
export function prewarmTimeOfDay(world, { bake = true } = {}) {
  if (!world) return;
  if (world._buildGroundLights && !world.groundLights && TIME_NAMES.some((n) => TIME_PRESETS[n].lights.ground > 0)) {
    world._buildGroundLights(); world.groundLights.visible = false;
  }
  if (bake && world.queueLighting) for (const n of ['golden', 'dusk', 'overcast', 'night', 'evening']) world.queueLighting(TIME_PRESETS[n].sun);
}

/** The preset object for a name; unknown or missing names give 'day'. */
export function timePreset(name) { return TIME_PRESETS[name] || TIME_PRESETS.day; }

/**
 * Apply preset `name` to { world, post, weapons } (each optional). Values only; World.setLighting skips the sky,
 * shadow and environment rebuilds when nothing they depend on changed. `glass` (0..1) blends the preset toward its red
 * Glassfall variant (glassfallPreset); env: true / 'defer' / false (World.setLighting). Returns the preset name applied.
 */
export function applyTimeOfDay(name, { world = null, post = null, weapons = null } = {}, glass = 0, env = true) {
  const key = TIME_PRESETS[name] ? name : 'day';
  applyPreset(glass > 0 ? glassfallPreset(key, glass) : TIME_PRESETS[key], { world, post, weapons }, env);
  return key;
}

/** Apply a preset object (a TIME_PRESETS entry or a glassfallPreset blend) to { world, post, weapons }. env = false
 *  skips the environment-map rebuild (World.setLighting). */
export function applyPreset(P, { world = null, post = null, weapons = null } = {}, env = true) {
  if (world && world.setLighting) world.setLighting(P, env);
  if (post) {
    const q = P.post;
    post.exposure = q.exposure; post.bloomStrength = q.bloom; post.bloomThreshold = q.threshold; post.flareStrength = q.flare;
    if (post.setGrade) post.setGrade(q.sat, q.contrast, q.wb);
  }
  if (weapons) {
    weapons.smokeSunIntensity = P.smoke.sun;
    if (weapons.smokeAmbient && weapons.smokeAmbient.set) weapons.smokeAmbient.set(P.smoke.amb[0], P.smoke.amb[1], P.smoke.amb[2]);
  }
  const L = P.lights;
  NIGHT_FX.engine = L.engine;
  NIGHT_FX.uGround.value = L.ground;
}

// ---- The Glassfall (js/glassfall.js): thunderglass warheads turn the sky red ------------------------------------------
// GLASSFALL is a red variant of whichever preset is current, not a preset of its own: colours take its hue at the base
// preset's brightness (so a red day stays a day and a red evening stays an evening), and the brightness terms scale the
// base's. The sun direction is the base's, so a blend never re-bakes the terrain shadow: World.setLighting only re-grades
// the cached sky table (well under a millisecond) and, on the last step only, the environment, copied from the red end
// state World.prepareEnvVariant rendered at mission load (js/glassfall.js prepare; steps run one frame after each
// detonation, under the flash).
// glassfallPreset(name, k) linearly blends the base preset toward that variant (k = 0: the base, 1: fully red).
export const GLASSFALL = {
  sunColor: [1, 0.3, 0.17], skyAmb: [1, 0.3, 0.26], groundAmb: [1, 0.36, 0.28],   // hues (scaled to the base's luminance)
  skyTint: [4.2, 0.55, 0.26], skySat: 1.15, skyK: 0.55, skyBase: [0.0045, 0.0006, 0.0005],   // tint relative to the base's
  disc: { k: 0.8, tint: [1, 0.38, 0.28] }, stars: 0.4, fog: 1.45,
  light: { color: [1, 0.36, 0.24], k: 0.95 }, hemi: { sky: [1, 0.36, 0.3], ground: [1, 0.42, 0.32], k: 1 }, env: 0.9,
  clouds: { tint: [1.4, 0.45, 0.38] }, water: { tint: [1.1, 0.45, 0.4], spec: 0.85 },
  post: { exposure: 1.04, bloom: 0.08, flare: 0.6, sat: 1.06, contrast: 1.04, wb: [1.12, 0.9, 0.87] },
  smoke: { amb: [1, 0.42, 0.36] },
};
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const hex3 = (h, o) => { o[0] = ((h >> 16) & 255) / 255; o[1] = ((h >> 8) & 255) / 255; o[2] = (h & 255) / 255; return o; };
const toHex = (c) => (Math.round(Math.min(1, Math.max(0, c[0])) * 255) << 16) | (Math.round(Math.min(1, Math.max(0, c[1])) * 255) << 8) | Math.round(Math.min(1, Math.max(0, c[2])) * 255);
const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];
const _blend = {};   // the result object of glassfallPreset, reused (one blend in use at a time)
/** out = lerp(a, hue scaled to a's luminance x gain, k) (3-vectors). */
function towardHueMax(out, a, hue, k) {   // the same for a display colour (0..1): hue scaled to a's brightest channel
  const s = Math.max(a[0], a[1], a[2]) / Math.max(hue[0], hue[1], hue[2]);
  for (let i = 0; i < 3; i++) out[i] = a[i] + (hue[i] * s - a[i]) * k;
  return out;
}
function towardHue(out, a, hue, k, gain = 1) {
  const s = lum(a) / Math.max(1e-6, lum(hue)) * gain;
  for (let i = 0; i < 3; i++) out[i] = a[i] + (hue[i] * s - a[i]) * k;
  return out;
}
const mix = (a, b, k) => a + (b - a) * k;
/**
 * Preset `name` blended toward its red Glassfall variant by k (0..1). Returns a shared object (overwritten by the next
 * call; applyPreset copies the values out). Called on detonations and mission loads, never per frame.
 */
export function glassfallPreset(name, k) {
  const B = timePreset(name), G = GLASSFALL, o = _blend;
  k = Math.min(1, Math.max(0, k));
  o.label = B.label + ' (Glassfall)'; o.sun = B.sun;
  o.sunColor = towardHue(o.sunColor || [0, 0, 0], B.sunColor, G.sunColor, k, 0.95);
  o.skyAmb = towardHue(o.skyAmb || [0, 0, 0], B.skyAmb, G.skyAmb, k);
  o.groundAmb = towardHue(o.groundAmb || [0, 0, 0], B.groundAmb, G.groundAmb, k);
  const S = o.sky || (o.sky = { k: 1, tint: [1, 1, 1], sat: 1, base: [0, 0, 0] });
  S.k = mix(B.sky.k, B.sky.k * G.skyK, k); S.sat = mix(B.sky.sat, G.skySat, k);
  for (let i = 0; i < 3; i++) {
    S.tint[i] = mix(B.sky.tint[i], B.sky.tint[i] * G.skyTint[i], k);
  }
  { const s = Math.max(lum(B.sky.base), lum(G.skyBase) * Math.min(1, B.sky.k)) / lum(G.skyBase);   // the red glow
    for (let i = 0; i < 3; i++) S.base[i] = mix(B.sky.base[i], G.skyBase[i] * s, k); }
  const D = o.disc || (o.disc = { k: 1, tint: [1, 1, 1] });
  D.k = mix(B.disc.k, B.disc.k * G.disc.k, k);
  for (let i = 0; i < 3; i++) D.tint[i] = mix(B.disc.tint[i], G.disc.tint[i], k);
  o.stars = mix(B.stars, B.stars * G.stars, k); o.fog = mix(B.fog, B.fog * G.fog, k);
  const Li = o.light || (o.light = { color: 0, intensity: 1 });
  Li.color = toHex(towardHueMax(_c, hex3(B.light.color, _a), G.light.color, k)); Li.intensity = mix(B.light.intensity, B.light.intensity * G.light.k, k);
  const H = o.hemi || (o.hemi = { sky: 0, ground: 0, intensity: 1 });
  H.sky = toHex(towardHueMax(_c, hex3(B.hemi.sky, _a), G.hemi.sky, k)); H.ground = toHex(towardHueMax(_c, hex3(B.hemi.ground, _b), G.hemi.ground, k));
  H.intensity = mix(B.hemi.intensity, B.hemi.intensity * G.hemi.k, k);
  o.env = mix(B.env, B.env * G.env, k);
  const C = o.clouds || (o.clouds = { cut: 0.5, tint: [1, 1, 1], puff: 1 });
  C.cut = B.clouds.cut; C.puff = B.clouds.puff; towardHue(C.tint, B.clouds.tint, G.clouds.tint, k);
  const W = o.water || (o.water = { tint: [1, 1, 1], spec: 1 });
  towardHue(W.tint, B.water.tint, G.water.tint, k); W.spec = mix(B.water.spec, B.water.spec * G.water.spec, k);
  const P = o.post || (o.post = { exposure: 1, bloom: 0.5, threshold: 1, flare: 1, sat: 1, contrast: 1, wb: [1, 1, 1] }), q = B.post;
  P.exposure = mix(q.exposure, q.exposure * G.post.exposure, k); P.bloom = mix(q.bloom, q.bloom + G.post.bloom, k); P.threshold = q.threshold;
  P.flare = mix(q.flare, q.flare * G.post.flare, k); P.sat = mix(q.sat, q.sat * G.post.sat, k); P.contrast = mix(q.contrast, q.contrast * G.post.contrast, k);
  for (let i = 0; i < 3; i++) P.wb[i] = mix(q.wb[i], q.wb[i] * G.post.wb[i], k);
  const M = o.smoke || (o.smoke = { sun: 1, amb: [0, 0, 0] });
  M.sun = B.smoke.sun; towardHue(M.amb, B.smoke.amb, G.smoke.amb, k);
  o.lights = B.lights;
  return o;
}
