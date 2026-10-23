// js/timeofday.js — time-of-day lighting presets (day, golden hour, dusk, overcast dusk, evening, night) and the one
// function that applies a preset to the world, the PostFX pipeline, the weapon smoke and the night lights.
//
// A preset only changes values: uniforms, light colours, fog, exposure, bloom, the sky lookup table (rebuilt on the CPU
// when the light direction or the sky terms change) and, when the light direction moves, the baked terrain shadow and
// the PMREM environment (World.setLighting caches the shadow per direction, so the bake runs once per preset). Nothing
// here runs per frame and no shader is switched: the night extras (stars, ground lights, stronger nav lights and engine
// glow) are behind uniforms or visibility flags, so the day look and its cost are unchanged.
//
// Campaign missions name their preset in js/missions.js (`time`, default 'day'); INFINITY rotates presets every
// ROTATE_ROUNDS rounds (js/infinity.js timeForRound). ?tod=<name> overrides both (benchmarks, screenshots).
//
// Lights for the night (shared uniform objects, read by js/aircraft.js, js/engine_fx.js, js/targets.js and js/world.js):
//   NIGHT_FX.uNav     x: nav light / strobe intensity multiplier, y: minimum sprite size in px
//   NIGHT_FX.engine   exhaust glow multiplier (AfterburnerFX uIntensity)
//   NIGHT_FX.uGround  ground lights (settlements, mission units) intensity; 0 hides them (no draw call)

export const NIGHT_FX = {
  uNav: { value: { x: 1, y: 2 } },   // vec2 uniform ({ x, y } uploads like a THREE.Vector2; no THREE import here)
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
//   lights     { nav, navPx, engine, ground }: the night lights above
export const TIME_PRESETS = {
  day: {
    label: 'Day', sun: D(22, 35),
    sunColor: [2.7, 1.75, 1.0], skyAmb: [0.20, 0.29, 0.48], groundAmb: [0.18, 0.13, 0.09],
    sky: { k: 1, tint: [1, 1, 1], sat: 1, base: [0, 0, 0] }, disc: { k: 1, tint: [1, 1, 1] }, stars: 0, fog: 1,
    light: { color: 0xffd3a0, intensity: 3.0 }, hemi: { sky: 0x9cc0ea, ground: 0x6f5e46, intensity: 0.6 }, env: 1,
    clouds: { cut: 0.49, tint: [1, 1, 1], puff: 1 }, water: { tint: [1, 1, 1], spec: 1 },
    post: { exposure: 1, bloom: 0.55, threshold: 1, flare: 1, sat: 1, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 1.5, amb: [0.3, 0.36, 0.46] },
    lights: { nav: 1, navPx: 2, engine: 1, ground: 0 },
  },
  golden: {
    label: 'Golden hour', sun: D(8, 40),
    sunColor: [2.55, 1.32, 0.56], skyAmb: [0.16, 0.20, 0.33], groundAmb: [0.17, 0.11, 0.06],
    sky: { k: 1.15, tint: [1.04, 1, 0.94], sat: 1, base: [0, 0, 0] }, disc: { k: 1, tint: [1, 0.92, 0.8] }, stars: 0, fog: 1.1,
    light: { color: 0xffb877, intensity: 2.8 }, hemi: { sky: 0x8fa8d0, ground: 0x6f5034, intensity: 0.55 }, env: 1,
    clouds: { cut: 0.47, tint: [1.04, 0.98, 0.92], puff: 1 }, water: { tint: [1, 0.95, 0.9], spec: 1 },
    post: { exposure: 1.08, bloom: 0.55, threshold: 1, flare: 1, sat: 1.04, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 1.35, amb: [0.26, 0.29, 0.38] },
    lights: { nav: 1.2, navPx: 2, engine: 1, ground: 0 },
  },
  dusk: {
    label: 'Dusk', sun: D(2.2, 44),
    sunColor: [1.65, 0.62, 0.24], skyAmb: [0.085, 0.095, 0.17], groundAmb: [0.085, 0.055, 0.04],
    sky: { k: 1.6, tint: [1.05, 0.92, 1.12], sat: 1, base: [0.002, 0.0018, 0.004] }, disc: { k: 1.2, tint: [1, 0.75, 0.55] }, stars: 0, fog: 1.2,
    light: { color: 0xff9a5c, intensity: 2.0 }, hemi: { sky: 0x5d6c98, ground: 0x4e3626, intensity: 0.45 }, env: 0.8,
    clouds: { cut: 0.46, tint: [1.0, 0.92, 0.9], puff: 0.8 }, water: { tint: [0.85, 0.8, 0.85], spec: 1 },
    post: { exposure: 1.45, bloom: 0.55, threshold: 1.05, flare: 0.9, sat: 1.04, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 0.75, amb: [0.12, 0.12, 0.17] },
    lights: { nav: 1.6, navPx: 2.5, engine: 1.15, ground: 0.25 },
  },
  overcast: {
    label: 'Overcast dusk', sun: D(7, 40),
    sunColor: [0.42, 0.39, 0.37], skyAmb: [0.105, 0.112, 0.13], groundAmb: [0.055, 0.052, 0.05],
    sky: { k: 0.32, tint: [0.9, 0.95, 1.06], sat: 0.3, base: [0.001, 0.001, 0.0012] }, disc: { k: 0, tint: [1, 1, 1] }, stars: 0, fog: 1.8,
    light: { color: 0xb8bcc4, intensity: 0.75 }, hemi: { sky: 0x8a919c, ground: 0x4a4744, intensity: 0.5 }, env: 0.5,
    clouds: { cut: 0.2, tint: [0.6, 0.62, 0.66], puff: 0.62 }, water: { tint: [0.7, 0.75, 0.75], spec: 0.04 },
    post: { exposure: 1.5, bloom: 0.5, threshold: 1.1, flare: 0, sat: 0.78, contrast: 0.88, wb: [0.97, 1, 1.04] },
    smoke: { sun: 0.35, amb: [0.12, 0.125, 0.135] },
    lights: { nav: 1.8, navPx: 2.5, engine: 1.2, ground: 0.35 },
  },
  evening: {
    label: 'Evening', sun: D(0.4, 48),
    sunColor: [0.62, 0.25, 0.14], skyAmb: [0.12, 0.105, 0.19], groundAmb: [0.07, 0.05, 0.04],
    sky: { k: 0.85, tint: [0.92, 0.8, 1.08], sat: 1, base: [0.0025, 0.0018, 0.0045] }, disc: { k: 0, tint: [1, 1, 1] }, stars: 0.35, fog: 1.0,
    light: { color: 0xd8805c, intensity: 1.2 }, hemi: { sky: 0x7078a8, ground: 0x4a3428, intensity: 1.5 }, env: 1.0,
    clouds: { cut: 0.47, tint: [0.95, 0.8, 0.85], puff: 0.6 }, water: { tint: [0.7, 0.62, 0.75], spec: 0.6 },
    post: { exposure: 2.3, bloom: 0.5, threshold: 1.2, flare: 0, sat: 1.05, contrast: 1, wb: [1, 1, 1] },
    smoke: { sun: 0.22, amb: [0.06, 0.055, 0.08] },
    lights: { nav: 2.4, navPx: 3, engine: 1.3, ground: 0.7 },
  },
  night: {
    label: 'Night', sun: D(30, -28),
    sunColor: [0.075, 0.095, 0.15], skyAmb: [0.012, 0.017, 0.032], groundAmb: [0.006, 0.006, 0.008],
    sky: { k: 0.016, tint: [0.62, 0.82, 1.3], sat: 0.8, base: [0.0005, 0.0007, 0.0013] }, disc: { k: 0.14, tint: [0.9, 0.95, 1.0] }, stars: 1, fog: 1,
    light: { color: 0x9fb4e0, intensity: 0.35 }, hemi: { sky: 0x2c3a5c, ground: 0x15171c, intensity: 0.3 }, env: 0.3,
    clouds: { cut: 0.5, tint: [0.9, 0.95, 1.05], puff: 0.55 }, water: { tint: [0.8, 0.9, 1.1], spec: 1.1 },
    post: { exposure: 2.6, bloom: 0.45, threshold: 1.35, flare: 0.15, sat: 0.78, contrast: 1, wb: [0.96, 1, 1.06] },
    smoke: { sun: 0.1, amb: [0.02, 0.024, 0.035] },
    lights: { nav: 3.2, navPx: 3.5, engine: 1.4, ground: 1 },
  },
};
export const TIME_NAMES = Object.keys(TIME_PRESETS);

/** The preset object for a name; unknown or missing names give 'day'. */
export function timePreset(name) { return TIME_PRESETS[name] || TIME_PRESETS.day; }

/**
 * Apply preset `name` to { world, post, weapons } (each optional). Values only; World.setLighting skips the sky,
 * shadow and environment rebuilds when nothing they depend on changed. Returns the preset name actually applied.
 */
export function applyTimeOfDay(name, { world = null, post = null, weapons = null } = {}) {
  const key = TIME_PRESETS[name] ? name : 'day', P = TIME_PRESETS[key];
  if (world && world.setLighting) world.setLighting(P);
  if (post) {
    const q = P.post;
    post.exposure = q.exposure; post.bloomStrength = q.bloom; post.bloomThreshold = q.threshold; post.flareStrength = q.flare;
    if (post.setGrade) post.setGrade(q.sat, q.contrast, q.wb);
  }
  if (weapons) {
    weapons.smokeSunIntensity = P.smoke.sun;
    if (weapons.smokeAmbient && weapons.smokeAmbient.set) weapons.smokeAmbient.set(P.smoke.amb[0], P.smoke.amb[1], P.smoke.amb[2]);
  }
  const L = P.lights, nav = NIGHT_FX.uNav.value;
  nav.x = L.nav; nav.y = L.navPx;
  NIGHT_FX.engine = L.engine;
  NIGHT_FX.uGround.value = L.ground;
  return key;
}
