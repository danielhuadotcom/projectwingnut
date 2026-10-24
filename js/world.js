import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js';
import { NIGHT_FX } from './timeofday.js';

// PROJECT WINGNUT — js/world.js
// Sky (analytic Rayleigh/Mie), sun & lights, clipmap heightfield terrain, animated water,
// cloud layer + billboard puffs, height fog / aerial perspective, PMREM environment map.
// Everything procedural, linear HDR output (no tone mapping in shaders).
//
// Rendering cost notes (measured on an integrated laptop GPU at 1080p with a 4x MSAA HDR scene target):
//  - Shading is cheap now; the world is fill-bound (MSAA sample writes + resolve), so every pixel is written once:
//    opaque objects with renderOrder 0 (jets) first, then the terrain (1), which also renders the sea surface (rendered
//    heights clamped to the water plane, so there is no hidden seabed layer under a separate water plane and no depth
//    fighting), then the sky LAST (1000) at the far plane with depth test on, so only uncovered pixels run it. Seen from
//    below, the cloud layer is composited inside the sky shader instead of being blended as an extra layer; the cloud
//    mesh is only drawn when the camera is above the layer, the water mesh only when it is below the sea surface.
//    In normal flight the world is 3 draw calls (terrain, sky, puffs). The clipmap index buffer is ordered in
//    concentric rings so the terrain draws front-to-back. Small on-screen triangles cost fill (MSAA edges, partial
//    quads), so grid density is the main knob of the lower quality presets.
//  - The analytic sky is evaluated once into a small lookup texture (rebuilt by setSunDirection) and sampled by the sky,
//    the aerial perspective of every surface, the water reflection, the clouds and the puffs.
//  - Per-pixel procedural noise is replaced by textures baked once on the GPU at startup (mipmapped, so detail fades
//    with distance instead of shimmering): a tiling gradient-noise texture with derivatives (terrain micro-relief, puff
//    shapes), a tiling wave-spectrum slope texture (sea normal layers), the tiling cloud-coverage FBM (cloud layer, cloud
//    shadows, puffs) and a world-aligned copy of the original large-scale biome noise (so forest/snow layouts are
//    unchanged).
//  - Terrain vertices outside the view frustum are culled cheaply in the vertex shader; fog/haze is per vertex.
//  - setQuality('low' | 'medium' | 'high' | 'ultra') switches shader variants / grid density / puff count at runtime.

export const WORLD_HALF = 20000;      // playable half-size (m)
export const SEA_LEVEL = 0;

// ============================================================================
// TERRAIN GENERATION (pure JS; no THREE dependency so it can be unit-tested)
// ============================================================================
// --- TERRAIN GEN BEGIN
const HM_N = 1024;                               // heightmap texels per side
const HM_HALF = 22000;                           // heightmap covers ±22 km (2 km margin past WORLD_HALF)
const HM_STEP = (2 * HM_HALF) / (HM_N - 1);      // ≈ 43.01 m per texel
const HM_INV_STEP = 1 / HM_STEP;
const LOW_SCALE = 4;                             // macro pass runs at 1/4 resolution
const LOW_N = HM_N / LOW_SCALE + 3;              // + margin texels for the cubic kernel

// Sun: elevation 22°, azimuth 35° left of -Z (ahead-left of a jet flying -Z)
const SUN_ELEV = 22 * Math.PI / 180;
const SUN_AZ = 35 * Math.PI / 180;
const SUN_DIR_DEFAULT = [-Math.cos(SUN_ELEV) * Math.sin(SUN_AZ), Math.sin(SUN_ELEV), -Math.cos(SUN_ELEV) * Math.cos(SUN_AZ)];

// --- 2D gradient (Perlin-style) noise, ~[-1, 1]
const _perm = new Uint8Array(512);
(function seedPerm() {
  let s = 1337;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    const j = (s >>> 0) % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
})();
const _gx = new Float32Array(16), _gz = new Float32Array(16);
for (let i = 0; i < 16; i++) { const a = (i + 0.5) * Math.PI / 8; _gx[i] = Math.cos(a); _gz[i] = Math.sin(a); }

function gnoise(x, z) {
  const X = Math.floor(x), Z = Math.floor(z);
  const fx = x - X, fz = z - Z;
  const xi = X & 255, zi = Z & 255;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = _perm[xi] + zi, b = _perm[xi + 1] + zi;
  const g00 = _perm[a] & 15, g10 = _perm[b] & 15, g01 = _perm[a + 1] & 15, g11 = _perm[b + 1] & 15;
  const n00 = _gx[g00] * fx + _gz[g00] * fz;
  const n10 = _gx[g10] * (fx - 1) + _gz[g10] * fz;
  const n01 = _gx[g01] * fx + _gz[g01] * (fz - 1);
  const n11 = _gx[g11] * (fx - 1) + _gz[g11] * (fz - 1);
  const nx0 = n00 + u * (n10 - n00), nx1 = n01 + u * (n11 - n01);
  return (nx0 + v * (nx1 - nx0)) * 1.42;
}

function sstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function blob(x, z, cx, cz, r) {
  const dx = (x - cx) / r, dz = (z - cz) / r; const d2 = dx * dx + dz * dz;
  if (d2 >= 1) return 0; const q = 1 - d2; return q * q;
}
function ridge(n) { n = 1 - Math.abs(n); return n * n; }

// Macro terrain at world (x,z): low-frequency content only. Writes 5 floats at out[o..o+4]:
// [hBase, hillAmpHi, mtnAmpHi, warpX, warpZ]. High-frequency octaves are added at full res.
function macroAt(x, z, out, o) {
  // large-scale domain warp
  const wx = gnoise(x * (1 / 5200) + 3.1, z * (1 / 5200) + 7.7) * 1400 + gnoise(x * (1 / 1700) + 11.3, z * (1 / 1700) - 4.2) * 420;
  const wz = gnoise(x * (1 / 5200) - 9.4, z * (1 / 5200) + 2.6) * 1400 + gnoise(x * (1 / 1700) - 6.8, z * (1 / 1700) + 13.1) * 420;
  const px = x + wx, pz = z + wz;

  // continent field c (meters-ish): > 0 land, < 0 sea. Sea lies toward -X/-Z (ahead-left of spawn).
  let c = Math.max(-4200, Math.min(9000, px * 0.62 + pz * 0.78 + 2600));
  c += gnoise(px / 9000 + 1.0, pz / 9000 + 2.0) * 3200;
  c += gnoise(px / 3600 + 5.0, pz / 3600 - 3.0) * 1300;
  c += gnoise(px / 1500 - 2.0, pz / 1500 + 8.0) * 450;
  // far landmass across the water (ahead-left, silhouetted against the sun) + islands
  c += blob(px, pz, -12500, -15000, 8500) * 11000;
  c += blob(px, pz, -5500, -9000, 2600) * 6800;
  c += blob(px, pz, 4500, -13500, 3000) * 7000;
  c += blob(px, pz, -15500, 3500, 3400) * 7400;
  c += blob(px, pz, -1500, -17500, 2400) * 6500;
  c += blob(px, pz, -9000, -2500, 1800) * 5600;
  // ocean around the world edge
  const edge = Math.max(Math.abs(x), Math.abs(z));
  c -= 9000 * sstep(17500, 22000, edge);

  const dist0 = Math.sqrt(x * x + z * z);
  const land = sstep(-400, 600, c);
  const inland = sstep(0, 6500, c);

  // base elevation: coastal plain rising inland; shallow shelf then sea floor
  let h = c > 0 ? c * 0.012 + 170 * sstep(1500, 7000, c) : Math.max(c * 0.03, -85);

  // rolling hills (3 low octaves; 2 more at full res)
  const hillAmp = (50 + 150 * inland) * land + 6 * (1 - land);
  let hills = gnoise(px / 3000 + 0.5, pz / 3000 + 0.3);
  hills += gnoise(px / 1500 - 3.3, pz / 1500 + 1.7) * 0.5;
  hills += gnoise(px / 750 + 7.1, pz / 750 - 2.9) * 0.25;
  h += hillAmp * hills;

  // mountains: ridged multifractal, masked near spawn and in the sea; regional variation
  const region = 0.55 + 0.45 * gnoise(px / 11000 + 4.4, pz / 11000 - 6.1);
  const landM = sstep(-300, 2800, c);
  let mtnMask = sstep(3500, 9000, dist0) * landM * region;
  // two signature massifs: a snow-capped range east of the spawn and tall peaks on the sun-side landmass
  mtnMask = Math.min(1.0, mtnMask + landM * (0.6 * blob(x, z, 9500, 2500, 6500) + 0.5 * blob(x, z, -12500, -15000, 6500)));
  let m = ridge(gnoise(px / 7000 + 2.2, pz / 7000 + 9.9));
  m += ridge(gnoise(px / 3500 - 5.5, pz / 3500 + 3.3)) * 0.5;
  m += ridge(gnoise(px / 1750 + 8.8, pz / 1750 - 1.1)) * 0.25;
  m += ridge(gnoise(px / 875 - 4.4, pz / 875 + 6.6)) * 0.125;
  const mtnAmp = 1850 * mtnMask;
  const mtnLow = Math.max(m - 0.32, 0);
  h += mtnAmp * mtnLow;
  const mtnAmpHi = mtnAmp * (0.35 + 0.65 * Math.min(mtnLow, 1.2) / 1.2);

  // lakes: carve basins in inland low ground (water plane at y = 0 fills them)
  const lakeN = gnoise(px / 2600 + 12.5, pz / 2600 - 7.5);
  const lakeMask = sstep(0.36, 0.58, lakeN) * sstep(1200, 3500, c) * sstep(700, 250, h);
  h += (-30 - h) * lakeMask;

  // spawn safety: compress heights near the origin
  const comp = 0.3 + 0.7 * sstep(2500, 5200, dist0);
  if (h > 0) h *= comp;
  const detail = (1 - lakeMask) * comp;

  out[o] = h;
  out[o + 1] = hillAmp * detail;
  out[o + 2] = mtnAmpHi * detail;
  out[o + 3] = wx;
  out[o + 4] = wz;
}

// Catmull-Rom weights for fractional position t
function cubicW(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

// Builds the full-resolution heightfield. Returns Float32Array(HM_N*HM_N), row-major, z-major (index = j*HM_N + i),
// texel (i,j) at world (−HM_HALF + i*HM_STEP, −HM_HALF + j*HM_STEP).
function generateHeightfield() {
  const NV = 5;
  // 1) macro pass at low resolution (with 1-texel margin below, 2 above)
  const low = new Float32Array(LOW_N * LOW_N * NV);
  const lowStep = HM_STEP * LOW_SCALE;
  for (let j = 0; j < LOW_N; j++) {
    const z = -HM_HALF + (j - 1) * lowStep;
    for (let i = 0; i < LOW_N; i++) {
      macroAt(-HM_HALF + (i - 1) * lowStep, z, low, (j * LOW_N + i) * NV);
    }
  }
  // 2) separable bicubic upsample: rows first (LOW_N rows × HM_N columns)
  const W = HM_N;
  const mid = new Float32Array(LOW_N * W * NV);
  const wgt = new Float64Array(4);
  const wx = new Float64Array(W * 4), ix = new Int32Array(W);
  for (let i = 0; i < W; i++) {
    const u = i / LOW_SCALE; const k = Math.floor(u);
    cubicW(u - k, wgt); ix[i] = k; // low index k ↔ margin-shifted index k+1; kernel spans k..k+3
    wx[i * 4] = wgt[0]; wx[i * 4 + 1] = wgt[1]; wx[i * 4 + 2] = wgt[2]; wx[i * 4 + 3] = wgt[3];
  }
  for (let j = 0; j < LOW_N; j++) {
    const rowBase = j * LOW_N * NV;
    const outBase = j * W * NV;
    for (let i = 0; i < W; i++) {
      const k = ix[i];
      const w0 = wx[i * 4], w1 = wx[i * 4 + 1], w2 = wx[i * 4 + 2], w3 = wx[i * 4 + 3];
      const b0 = rowBase + k * NV, b1 = b0 + NV, b2 = b1 + NV, b3 = b2 + NV;
      const ob = outBase + i * NV;
      for (let v = 0; v < NV; v++) {
        mid[ob + v] = w0 * low[b0 + v] + w1 * low[b1 + v] + w2 * low[b2 + v] + w3 * low[b3 + v];
      }
    }
  }
  // 3) columns + high-frequency octaves → final heights
  const height = new Float32Array(W * W);
  const row = new Float32Array(W * NV);
  for (let j = 0; j < W; j++) {
    const u = j / LOW_SCALE; const k = Math.floor(u);
    cubicW(u - k, wgt);
    const r0 = k * W * NV, r1 = r0 + W * NV, r2 = r1 + W * NV, r3 = r2 + W * NV;
    const w0 = wgt[0], w1 = wgt[1], w2 = wgt[2], w3 = wgt[3];
    for (let n = 0; n < W * NV; n++) row[n] = w0 * mid[r0 + n] + w1 * mid[r1 + n] + w2 * mid[r2 + n] + w3 * mid[r3 + n];
    const z = -HM_HALF + j * HM_STEP;
    for (let i = 0; i < W; i++) {
      const x = -HM_HALF + i * HM_STEP;
      const b = i * NV;
      const px = x + row[b + 3], pz = z + row[b + 4];
      let h = row[b];
      const hillHi = gnoise(px / 375 + 1.3, pz / 375 - 5.1) * 0.125 + gnoise(px / 187 - 9.7, pz / 187 + 3.9) * 0.0625;
      const mtnHi = ridge(gnoise(px / 437 + 6.2, pz / 437 - 2.8)) * 0.0625 + ridge(gnoise(px / 218 - 3.6, pz / 218 + 7.4)) * 0.031;
      h += row[b + 1] * hillHi + row[b + 2] * (mtnHi - 0.035);
      if (h > 2250) h = 2250 + (h - 2250) * 0.45;   // soft ceiling: peaks top out around 2600 m
      height[j * W + i] = h;
    }
  }
  // hard border: deep sea on the outermost texels (clamped sampling extends it to infinity)
  for (let i = 0; i < W; i++) { height[i] = -85; height[(W - 1) * W + i] = -85; height[i * W] = -85; height[i * W + W - 1] = -85; }
  return height;
}

// Bilinear sample of a heightfield array at world (x,z) — identical math to the GLSL sampler.
function sampleHeightCPU(h, x, z) {
  let u = (x + HM_HALF) * HM_INV_STEP, v = (z + HM_HALF) * HM_INV_STEP;
  const mx = HM_N - 1.001;
  u = u < 0 ? 0 : (u > mx ? mx : u);
  v = v < 0 ? 0 : (v > mx ? mx : v);
  const i0 = u | 0, j0 = v | 0;
  const fx = u - i0, fz = v - j0;
  const k = j0 * HM_N + i0;
  const h00 = h[k], h10 = h[k + 1], h01 = h[k + HM_N], h11 = h[k + HM_N + 1];
  const a = h00 + (h10 - h00) * fx, b = h01 + (h11 - h01) * fx;
  return a + (b - a) * fz;
}

// Aux texture (RGBA8): R,G = normal.xz*0.5+0.5, B = baked sun shadow (1 = lit), A = cavity/AO (1 = exposed)
function generateAux(height, aux, sunDir) {
  const W = HM_N;
  const inv2 = 1 / (2 * HM_STEP);
  for (let j = 0; j < W; j++) {
    const jm = Math.max(j - 1, 0), jp = Math.min(j + 1, W - 1);
    const j4m = Math.max(j - 4, 0), j4p = Math.min(j + 4, W - 1);
    const j12m = Math.max(j - 12, 0), j12p = Math.min(j + 12, W - 1);
    for (let i = 0; i < W; i++) {
      const im = Math.max(i - 1, 0), ip = Math.min(i + 1, W - 1);
      const h0 = height[j * W + i];
      // Sobel 3x3 (slightly smoothed) finite differences
      let nx = ((height[jm * W + im] - height[jm * W + ip]) + 2 * (height[j * W + im] - height[j * W + ip]) + (height[jp * W + im] - height[jp * W + ip])) * (inv2 * 0.25);
      let nz = ((height[jm * W + im] - height[jp * W + im]) + 2 * (height[jm * W + i] - height[jp * W + i]) + (height[jm * W + ip] - height[jp * W + ip])) * (inv2 * 0.25);
      const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
      nx *= inv; nz *= inv;
      // cavity: height relative to the neighbourhood mean at two scales (valleys < 0.5 < ridges)
      const i4m = Math.max(i - 4, 0), i4p = Math.min(i + 4, W - 1);
      const i12m = Math.max(i - 12, 0), i12p = Math.min(i + 12, W - 1);
      const m4 = (height[j * W + i4m] + height[j * W + i4p] + height[j4m * W + i] + height[j4p * W + i]) * 0.25;
      const m12 = (height[j * W + i12m] + height[j * W + i12p] + height[j12m * W + i] + height[j12p * W + i]) * 0.25;
      const cav = (h0 - m4) * 0.0045 + (h0 - m12) * 0.0016;
      const ao = Math.min(1, Math.max(0.15, 0.62 + cav));
      const o = (j * W + i) * 4;
      aux[o] = Math.round((nx * 0.5 + 0.5) * 255);
      aux[o + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      aux[o + 2] = 255;
      aux[o + 3] = Math.round(ao * 255);
    }
  }
  bakeSunShadow(height, aux, sunDir);
}

// Soft cast-shadow term from the heightfield toward the sun, computed at half resolution and
// bilinearly expanded into the aux B channel.
const SHADOW_STEPS = [1, 2, 3, 4, 6, 8, 11, 15, 20, 27, 36, 48, 64, 85, 112, 148, 196];
function bakeSunShadow(height, aux, sunDir) {
  const job = shadowJob(sunDir);
  while (!shadowJobStep(height, job, Infinity)) { /* all rows */ }
  const ch = job.ch, n = HM_N * HM_N;
  for (let i = 0; i < n; i++) aux[i * 4 + 2] = ch[i];
}
// The bake as resumable work (World bakes the time-of-day directions in idle time): half-resolution horizon rows
// first, then the bilinear expansion to a full-resolution channel (job.ch, HM_N^2 bytes).
function shadowJob(sunDir) {
  const S = HM_N >> 1;
  return { dir: sunDir.slice(), phase: 0, j: 0, sh: new Float32Array(S * S), ch: new Uint8Array(HM_N * HM_N) };
}
/** Bake rows of `job` until performance.now() passes `until`. True when the job is complete. */
function shadowJobStep(height, job, until) {
  const W = HM_N, S = W >> 1, sunDir = job.dir, sh = job.sh, ch = job.ch;
  const hl = Math.sqrt(sunDir[0] * sunDir[0] + sunDir[2] * sunDir[2]);
  const dx = sunDir[0] / hl, dz = sunDir[2] / hl;
  const tanE = sunDir[1] / hl;
  while (job.phase === 0) {
    const j = job.j;
    const z = -HM_HALF + (2 * j) * HM_STEP;
    for (let i = 0; i < S; i++) {
      const x = -HM_HALF + (2 * i) * HM_STEP;
      const h0 = height[(2 * j) * W + 2 * i] + 1.5;
      let maxE = -1;
      for (let s = 0; s < SHADOW_STEPS.length; s++) {
        const d = SHADOW_STEPS[s] * HM_STEP;
        const hs = sampleHeightCPU(height, x + dx * d, z + dz * d);
        const e = (hs - h0) / d - tanE;
        if (e > maxE) maxE = e;
      }
      // soft penumbra ±~2.5°
      sh[j * S + i] = 1 - sstep(-0.045, 0.045, maxE);
    }
    if (++job.j >= S) { job.phase = 1; job.j = 0; }
    if (performance.now() > until) return false;
  }
  while (job.phase === 1) {
    const j = job.j;
    const v = Math.min(j * 0.5, S - 1.001), j0 = v | 0, fz = v - j0;
    for (let i = 0; i < W; i++) {
      const u = Math.min(i * 0.5, S - 1.001), i0 = u | 0, fx = u - i0;
      const k = j0 * S + i0;
      const a = sh[k] + (sh[k + 1] - sh[k]) * fx, b = sh[k + S] + (sh[k + S + 1] - sh[k + S]) * fx;
      ch[j * W + i] = Math.round((a + (b - a) * fz) * 255);
    }
    if (++job.j >= W) { job.phase = 2; job.sh = null; return true; }
    if (performance.now() > until) return false;
  }
  return true;
}


// ============================================================================
// CLOUD COVERAGE FIELD — tiling 4-octave value-noise FBM, baked into a texture on the GPU and mirrored on the CPU
// (cloudDensityAt). Octave lattices wrap with the tile, so the baked texture repeats seamlessly every CLOUD_TILE m.
// ============================================================================
// --- integer hash shared (bit-exactly) between JS and GLSL
function ihash(ix, iz) {
  let h = (Math.imul(ix, 0x9E3779B1) ^ Math.imul(iz, 0x85EBCA77)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297A2D39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 8) / 16777216;
}
const CLOUD_SCALE = 2600;                        // base wavelength of the coverage FBM (m)
const CLOUD_CELLS = 16;                          // base-octave lattice cells per tile (octaves: 16, 32, 64, 128)
const CLOUD_TILE = CLOUD_SCALE * CLOUD_CELLS;    // 41.6 km repeat period (larger than the 40 km playable square)
const CLOUD_TEX_N = 1024;                        // 8 texels per lattice cell of the finest octave
const CLOUD_WIND = [9.0, 4.5];                   // m/s drift of the coverage field
const CLOUD_GRAD = 3500;                         // cloud-top normal = normalize(-dFBM/dx * CLOUD_GRAD, 1, -dFBM/dz * CLOUD_GRAD)
const CLOUD_GRAD_RANGE = 8;                      // texture G/B encode dFBM * CLOUD_GRAD in [-8, 8]
function vnoiseTile(x, z, P, salt) {
  const X = Math.floor(x), Z = Math.floor(z);
  const fx = x - X, fz = z - Z;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const x0 = ((X % P) + P) % P, z0 = ((Z % P) + P) % P;
  const x1 = (x0 + 1) % P, z1 = (z0 + 1) % P;
  const sx = salt * 157, sz = salt * 311;
  const a = ihash(x0 + sx, z0 + sz), b = ihash(x1 + sx, z0 + sz), c = ihash(x0 + sx, z1 + sz), d = ihash(x1 + sx, z1 + sz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function cloudFbmCPU(x, z, t) {
  const u = (x + CLOUD_WIND[0] * t) / CLOUD_TILE, v = (z + CLOUD_WIND[1] * t) / CLOUD_TILE;
  let s = 0, a = 0.5;
  for (let k = 0; k < 4; k++) { const P = CLOUD_CELLS << k; s += a * vnoiseTile(u * P, v * P, P, k); a *= 0.5; }
  return s;
}
// --- TERRAIN GEN END

// Tiling detail-noise texture (terrain micro relief / biome breakup, water normals, puff shapes):
// R = gradient noise value (0.5 + n/1.4, n in ±0.7), G/B = dn/dp per lattice cell (0.5 + d/4), A = value noise.
const DETAIL_N = 512, DETAIL_CELLS = 64;         // 8 texels per lattice cell; one tile = 64 noise cells
// World-aligned biome texture: the original large-scale biome noise (forest patches, tree/snow line variation; gradient
// noise with 714 m cells), baked over the heightmap area so the biome layout matches the procedural original exactly.
const BIOME_N = 512;                             // 86 m per texel, ~8 texels per noise cell

// Max-filtered mip chain of the heightfield (mip k texel = max of its 2^k x 2^k base texels). With `peaks` presets the
// coarse clipmap levels sample it with blocks of ~0.35 cell; bilinear filtering spreads each block maximum by about
// ±0.5 cell, enough that a crest between two vertices still lifts the nearest one, so distant ridges keep their height
// on sparse grids (and do not pop as the grid snaps). Mip 0 is the plain heightfield.
const MAXMIP_BIAS = -1.5;                        // lod = log2(cell / texel) + bias; lod < 0.5 uses the exact path
function buildMaxMips(height) {
  const mips = [{ data: height, width: HM_N, height: HM_N }];
  let src = height, n = HM_N;
  while (n > 1) {
    const m = n >> 1, dst = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      const r0 = 2 * j * n, r1 = r0 + n;
      for (let i = 0; i < m; i++) {
        const a = src[r0 + 2 * i], b = src[r0 + 2 * i + 1], c = src[r1 + 2 * i], d = src[r1 + 2 * i + 1];
        dst[j * m + i] = Math.max(Math.max(a, b), Math.max(c, d));
      }
    }
    mips.push({ data: dst, width: m, height: m });
    src = dst; n = m;
  }
  return mips;
}

// ============================================================================
// SKY MODEL CONSTANTS (Preetham-style single scattering, tuned for golden hour)
// ============================================================================
const SKY_RAYLEIGH = 2.2, SKY_TURBIDITY = 4.0, SKY_MIE = 0.006, SKY_MIE_G = 0.80;
const SKY_K = 260.0;                      // soft compression knee of in-scatter (keeps the aureole in a sane HDR range)
const BETA_R = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5].map(v => v * SKY_RAYLEIGH);
const BETA_M = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14].map(v => 0.434 * (0.2 * SKY_TURBIDITY) * 10e-18 * v * SKY_MIE);
const SUN_DISC_COS = Math.cos(0.55 * Math.PI / 180);   // visual sun radius 0.55° (about 2x real, reads better)
function sunIntensity(sunY) {
  const zen = Math.acos(Math.min(1, Math.max(-1, sunY)));
  return 1000 * Math.max(0, 1 - Math.exp(-((Math.PI / 1.95 - zen) / 1.5)));
}
// JS mirror of the sky radiance model (used for scene.fog color). dir/sunDir: arrays.
function skyRadianceJS(dir, sunDir, sunE, scale, grade = null) {
  const cosZen = Math.max(dir[1], 0);
  const zen = Math.acos(cosZen);
  const inv = 1 / (cosZen + 0.15 * Math.pow(93.885 - zen * 180 / Math.PI, -1.253));
  const cosT = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const rPh = 0.0596831 * (1 + cosT * cosT);
  const g2 = SKY_MIE_G * SKY_MIE_G;
  const mPh = 0.0795775 * (1 - g2) / Math.pow(1 - 2 * SKY_MIE_G * cosT + g2, 1.5);
  const sf = Math.min(1, Math.max(0, Math.pow(1 - sunDir[1], 5)));
  const lin = [0, 0, 0], fex = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    fex[k] = Math.exp(-(BETA_R[k] * 8400 * inv + BETA_M[k] * 1250 * inv));
    const ratio = (BETA_R[k] * rPh + BETA_M[k] * mPh) / (BETA_R[k] + BETA_M[k]);
    lin[k] = Math.pow(sunE * ratio * (1 - fex[k]), 1.5) * (1 + (Math.pow(sunE * ratio * fex[k], 0.5) - 1) * sf);
  }
  const lm = Math.max(lin[0], lin[1], lin[2]);
  const comp = SKY_K / (SKY_K + lm);
  const add = [0, 0.0003, 0.00075];
  const out = [0, 1, 2].map(k => ((lin[k] * comp + 0.1 * fex[k]) * 0.04 + add[k]) * scale);
  if (grade) gradeSky(out, 0, Math.sqrt(cosZen), grade);
  return out;
}
// Time-of-day grade of the analytic sky (js/timeofday.js preset.sky): tint, saturation, then an added glow weighted
// toward the horizon (twilight / night airglow). Identity for the day preset. c: rgb array at offset o; v = sqrt(cosZen).
function gradeSky(c, o, v, g) {
  let r = c[o] * g.tint[0], gg = c[o + 1] * g.tint[1], b = c[o + 2] * g.tint[2];
  if (g.sat !== 1) { const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b; r = l + (r - l) * g.sat; gg = l + (gg - l) * g.sat; b = l + (b - l) * g.sat; }
  const w = 0.3 + 0.7 * (1 - v) * (1 - v) * (1 - v);
  c[o] = r + g.base[0] * w; c[o + 1] = gg + g.base[1] * w; c[o + 2] = b + g.base[2] * w;
}
// Atmospheric transmittance toward a direction with the given cos(zenith) (per channel, written to out).
function skyExtinction(cosZen, out) {
  const cz = Math.max(cosZen, 0);
  const zen = Math.acos(Math.min(1, cz));
  const inv = 1 / (cz + 0.15 * Math.pow(93.885 - zen * 180 / Math.PI, -1.253));
  for (let k = 0; k < 3; k++) out[k] = Math.exp(-(BETA_R[k] * 8400 * inv + BETA_M[k] * 1250 * inv));
  return out;
}
// Sky radiance lookup table (no sun disc). The model only depends on cos(zenith) and cos(angle to the sun), so the LUT
// is exact up to interpolation: u = sqrt((1 - cosSun) / 2) = sin(angle/2) (dense near the sun's Mie aureole),
// v = sqrt(cosZenith) (dense near the horizon). Below-horizon directions use the horizon row (same as the old hazeColor).
const SKY_LUT_W = 256, SKY_LUT_H = 64;
// The table is built in two steps so a time-of-day grade change (the Glassfall's red sky steps) never re-runs the
// scattering model: buildSkyLutRows writes the ungraded, unscaled radiance (it depends only on the sun height; World
// caches it per height and can build it rows at a time in idle time), gradeSkyLut scales and grades it (cheap).
function buildSkyLutRows(out, sunE, sunFade, j0 = 0, j1 = SKY_LUT_H) {
  const g = SKY_MIE_G, g2 = g * g, fex = _lutFex, lin = _lutLin;
  for (let j = j0; j < j1; j++) {
    const v = j / (SKY_LUT_H - 1);
    skyExtinction(v * v, fex);
    for (let i = 0; i < SKY_LUT_W; i++) {
      const u = i / (SKY_LUT_W - 1);
      const cosT = 1 - 2 * u * u;
      const rPh = 0.0596831 * (1 + cosT * cosT);
      const mPh = 0.0795775 * (1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5);
      let lm = 0;
      for (let k = 0; k < 3; k++) {
        const ratio = (BETA_R[k] * rPh + BETA_M[k] * mPh) / (BETA_R[k] + BETA_M[k]);
        const l = Math.pow(sunE * ratio * (1 - fex[k]), 1.5) * (1 + (Math.sqrt(sunE * ratio * fex[k]) - 1) * sunFade);
        lin[k] = l; if (l > lm) lm = l;
      }
      const comp = SKY_K / (SKY_K + lm);
      const o = (j * SKY_LUT_W + i) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = (lin[k] * comp + 0.1 * fex[k]) * 0.04 + SKY_ADD[k];
      out[o + 3] = 1;
    }
  }
}
const _lutFex = [0, 0, 0], _lutLin = [0, 0, 0], SKY_ADD = [0, 0.0003, 0.00075];
/** out = grade(base * scale) per texel (out may be base): gradeSky, with its per-row and per-grade terms hoisted. */
function gradeSkyLut(out, base, scale, g = null) {
  const rowN = SKY_LUT_W * 4;
  if (!g) {
    for (let o = 0, n = SKY_LUT_H * rowN; o < n; o += 4) { out[o] = base[o] * scale; out[o + 1] = base[o + 1] * scale; out[o + 2] = base[o + 2] * scale; out[o + 3] = 1; }
    return;
  }
  const tr = g.tint[0] * scale, tg = g.tint[1] * scale, tb = g.tint[2] * scale, sat = g.sat, b0 = g.base[0], b1 = g.base[1], b2 = g.base[2];
  for (let j = 0; j < SKY_LUT_H; j++) {
    const v = j / (SKY_LUT_H - 1), u = 1 - v, w = 0.3 + 0.7 * u * u * u, a0 = b0 * w, a1 = b1 * w, a2 = b2 * w;
    for (let o = j * rowN, e = o + rowN; o < e; o += 4) {
      let r = base[o] * tr, gg = base[o + 1] * tg, b = base[o + 2] * tb;
      if (sat !== 1) { const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b; r = l + (r - l) * sat; gg = l + (gg - l) * sat; b = l + (b - l) * sat; }
      out[o] = r + a0; out[o + 1] = gg + a1; out[o + 2] = b + a2; out[o + 3] = 1;
    }
  }
}

// ============================================================================
// QUALITY PRESETS
// levels: lattice cells per side of each clipmap level (cell size doubles per level, CELL0 at level 0; multiples of 4).
//         On this GPU the terrain is fill-bound and smaller on-screen triangles cost more per pixel (MSAA edges,
//         partial quads), so coarser grids are the main lever below 'high'.
// peaks:  coarse levels sample the max-filtered height mips so distant ridges keep their height on sparse grids
//         (false = exact bilinear heights everywhere, i.e. the original terrain geometry)
// detail: terrain detail layers (1: 48 m relief + biome breakup, 2: + 18 m, 3: + 8 m near the camera, 4: + 3 m micro)
// water: wave normal layers (2..4); foam: shoreline foam; refl: reflected-terrain march taps (0 = sky and clouds only)
// puffG: billboard puff grid (puffG² puffs)
// ============================================================================
const QUALITY = {
  low:    { levels: [48, 48, 48, 48, 48, 48, 48, 48], cell0: 16, peaks: true, detail: 1, water: 2, foam: 1, refl: 0, puffG: 6 },
  medium: { levels: [64, 64, 64, 64, 64, 64, 64, 64], cell0: 16, peaks: true, detail: 2, water: 2, foam: 1, refl: 3, puffG: 8 },
  high:   { levels: [128, 128, 128, 128, 128, 128, 128, 128], cell0: 8, peaks: false, detail: 3, water: 3, foam: 1, refl: 7, puffG: 8 },
  ultra:  { levels: [128, 128, 128, 128, 128, 128, 128, 128], cell0: 8, peaks: false, detail: 4, water: 4, foam: 1, refl: 7, puffG: 10 },
};
const MAX_LEVELS = 10, MAX_PUFF_G = 10;

// ============================================================================
// GLSL CHUNKS
// ============================================================================
const f = (v) => { const s = String(v); return s.includes('.') || s.includes('e') ? s : s + '.0'; };

const GLSL_COMMON = /* glsl */`
const float HM_HALF = ${f(HM_HALF)};
const float HM_INV_STEP = ${f(HM_INV_STEP)};
const float HM_NF = ${f(HM_N)};
const float CLOUD_INV_TILE = ${f(1 / CLOUD_TILE)};
const float DINV = ${f(1 / DETAIL_CELLS)};
const vec2 LUT_SIZE = vec2(${f(SKY_LUT_W)}, ${f(SKY_LUT_H)});
const float SUN_COS = ${f(SUN_DISC_COS)};
uniform highp sampler2D uHeight;   // exact R32F heights (texelFetch; terrain vertices, matches World.getHeight)
uniform sampler2D uHeightLin;      // same heights as R16F, bilinear, max-filtered mips (water depth, cloud masks, far terrain)
uniform sampler2D uSkyLut;         // precomputed sky radiance, see buildSkyLut
uniform sampler2D uCloudTex;       // tiling coverage: R = FBM, GB = gradient, A = 3-octave FBM (shadows)
uniform sampler2D uDetail;         // tiling noise: R = gradient noise, GB = its derivatives, A = value noise
uniform sampler2D uBiome;          // world-aligned large-scale biome noise (R), see BIOME_N
uniform vec3 uSunDir;
uniform float uFogMie;
uniform float uFogRay;
uniform float uTime;
uniform vec2 uCloudOff;

// integer hash (bit-exact with the JS version) -> [0,1)
float hash2(vec2 i) {
  uvec2 q = uvec2(ivec2(i));
  uint h = (q.x * 0x9E3779B1u) ^ (q.y * 0x85EBCA77u);
  h ^= h >> 15u; h *= 0x2C1B3C6Du;
  h ^= h >> 12u; h *= 0x297A2D39u;
  h ^= h >> 15u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
// bilinear heightfield sample from 4 exact texels (matches World.getHeight)
float sampleHeight(vec2 xz) {
  vec2 u = clamp((xz + HM_HALF) * HM_INV_STEP, 0.0, HM_NF - 1.001);
  vec2 fl = floor(u);
  vec2 fr = u - fl;
  ivec2 i0 = ivec2(fl);
  float h00 = texelFetch(uHeight, i0, 0).r;
  float h10 = texelFetch(uHeight, i0 + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, i0 + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, i0 + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
}
vec2 hmUV(vec2 xz) { return ((xz + HM_HALF) * HM_INV_STEP + 0.5) * (1.0 / HM_NF); }
float heightLin(vec2 xz) { return textureLod(uHeightLin, hmUV(xz), 0.0).r; }
// sky radiance toward dir (unit); directions below the horizon get the horizon colour of their azimuth
vec3 skyLut(vec3 dir) {
  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0) + 1e-5, dir.z));
  vec2 c = vec2(sqrt(clamp(0.5 - 0.5 * dot(hd, uSunDir), 0.0, 1.0)), sqrt(hd.y));
  return textureLod(uSkyLut, (c * (LUT_SIZE - 1.0) + 0.5) / LUT_SIZE, 0.0).rgb;
}
// --- height fog: optical depth of an exponential layer along a segment
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

const GLSL_LIGHT = /* glsl */`
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform float uCloudAlt;
uniform float uCloudCut;
uniform vec3 uCloudTint;           // time-of-day tint of the cloud layer and puffs (1 = day)
uniform float uPuffK;              // extra brightness scale of the billboard puffs (dark presets keep them in the deck)
uniform vec3 uWaterTint;           // time-of-day tint of the sea body colour (1 = day)
uniform float uSpecK;              // strength of the specular sun (moon) path on the sea (1 = day)
float cloudShadow(vec2 xz, float h) {
  vec2 sp = xz + uSunDir.xz * ((uCloudAlt - h) / max(uSunDir.y, 0.05));
  float c = texture(uCloudTex, sp * CLOUD_INV_TILE + uCloudOff).a;
  float d = smoothstep(uCloudCut, uCloudCut + 0.3, c);
  return 1.0 - 0.8 * d * smoothstep(uCloudAlt, uCloudAlt - 300.0, h);
}
`;

// ---------------------------------------------------------------------------- one-time texture bakes
const BAKE_VERT = /* glsl */`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BAKE_NOISE = /* glsl */`
float hash2(vec2 i) {
  uvec2 q = uvec2(ivec2(i));
  uint h = (q.x * 0x9E3779B1u) ^ (q.y * 0x85EBCA77u);
  h ^= h >> 15u; h *= 0x2C1B3C6Du;
  h ^= h >> 12u; h *= 0x297A2D39u;
  h ^= h >> 15u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
// tiling value noise with derivatives (lattice wraps every P cells); salt decorrelates octaves (mirrors vnoiseTile)
vec3 noisedTile(vec2 p, float P, float salt) {
  vec2 i = floor(p);
  vec2 fr = p - i;
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * fr * fr * (fr * (fr - 2.0) + 1.0);
  vec2 i0 = mod(i, P), i1 = mod(i0 + 1.0, P);
  vec2 s = vec2(157.0, 311.0) * salt;
  float a = hash2(i0 + s), b = hash2(vec2(i1.x, i0.y) + s), c = hash2(vec2(i0.x, i1.y) + s), d = hash2(i1 + s);
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
}
// tiling gradient noise with derivatives, value ~[-0.7, 0.7]
vec3 gnoisedTile(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 fr = p - i;
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * fr * fr * (fr * (fr - 2.0) + 1.0);
  vec2 i0 = mod(i, P), i1 = mod(i0 + 1.0, P);
  float aa = hash2(i0) * 6.2831853, ab = hash2(vec2(i1.x, i0.y)) * 6.2831853;
  float ac = hash2(vec2(i0.x, i1.y)) * 6.2831853, ad = hash2(i1) * 6.2831853;
  vec2 ga = vec2(cos(aa), sin(aa)), gb = vec2(cos(ab), sin(ab)), gc = vec2(cos(ac), sin(ac)), gd = vec2(cos(ad), sin(ad));
  float va = dot(ga, fr), vb = dot(gb, fr - vec2(1.0, 0.0)), vc = dot(gc, fr - vec2(0.0, 1.0)), vd = dot(gd, fr - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k,
              ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va));
}
`;
// original (non-tiling) gradient noise with analytic derivatives, value ~[-0.7, 0.7]
const BAKE_GNOISED = /* glsl */`
vec3 gnoised(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = p - i;
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * fr * fr * (fr * (fr - 2.0) + 1.0);
  float aa = hash2(i) * 6.2831853, ab = hash2(i + vec2(1.0, 0.0)) * 6.2831853;
  float ac = hash2(i + vec2(0.0, 1.0)) * 6.2831853, ad = hash2(i + vec2(1.0, 1.0)) * 6.2831853;
  vec2 ga = vec2(cos(aa), sin(aa)), gb = vec2(cos(ab), sin(ab)), gc = vec2(cos(ac), sin(ac)), gd = vec2(cos(ad), sin(ad));
  float va = dot(ga, fr), vb = dot(gb, fr - vec2(1.0, 0.0)), vc = dot(gc, fr - vec2(0.0, 1.0)), vd = dot(gd, fr - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  return vec3(va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k,
              ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va));
}
`;
const BAKE_BIOME_FRAG = BAKE_NOISE + BAKE_GNOISED + /* glsl */`
void main() {
  vec2 xz = (gl_FragCoord.xy * ${f(1 / BIOME_N)} - 0.5) * ${f(2 * HM_HALF)};
  float big = gnoised(xz * 0.0014 + 3.0).x;
  gl_FragColor = vec4(clamp(big * 0.7 + 0.5, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;
const BAKE_DETAIL_FRAG = BAKE_NOISE + /* glsl */`
void main() {
  vec2 uv = gl_FragCoord.xy * (1.0 / ${f(DETAIL_N)});
  vec2 p = uv * ${f(DETAIL_CELLS)};
  vec3 g = gnoisedTile(p, ${f(DETAIL_CELLS)});
  float vn = noisedTile(p, ${f(DETAIL_CELLS)}, 5.0).x;
  gl_FragColor = vec4(0.5 + g.x * (0.5 / 0.7), 0.5 + g.yz * 0.25, vn);
}
`;
const BAKE_CLOUD_FRAG = BAKE_NOISE + /* glsl */`
void main() {
  vec2 uv = gl_FragCoord.xy * (1.0 / ${f(CLOUD_TEX_N)});
  float v = 0.0, v3 = 0.0, a = 0.5;
  vec2 d = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    float P = ${f(CLOUD_CELLS)} * exp2(float(k));
    vec3 n = noisedTile(uv * P, P, float(k));
    v += a * n.x; d += a * n.yz * P;
    if (k < 3) v3 += a * n.x;
    a *= 0.5;
  }
  vec2 g = d * ${f(CLOUD_GRAD / CLOUD_TILE)};
  gl_FragColor = vec4(v, 0.5 + g * ${f(0.5 / CLOUD_GRAD_RANGE)}, v3 + 0.03125);
}
`;

// Tiling wave texture for the sea (see GLSL_SEA): a sum of WAVE_COUNT sines with integer wave vectors (so it tiles),
// 2..32 cycles per tile spread around a wind direction (a few cross-sea waves), height amplitude ~ k^-1.5 tapered
// below 5 cycles (the next coarser layer covers those scales, and a few strong long waves would make the tile visible).
// RG = slope / (3 rms), B = height / (3 rms), A = 0.5 |slope|^2 (mipmapped: A - |RG|^2 is the filtered-away variance).
const WAVE_N = 256, WAVE_COUNT = 96;
const BAKE_WAVE_FRAG = BAKE_NOISE + /* glsl */`
void main() {
  vec2 uv = gl_FragCoord.xy * (1.0 / ${f(WAVE_N)});
  vec2 s = vec2(0.0);
  float h = 0.0, s2 = 0.0, h2 = 0.0;
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    float fi = float(i);
    float r1 = hash2(vec2(fi, 3.0)), r2 = hash2(vec2(fi, 11.0)), r3 = hash2(vec2(fi, 23.0)), r4 = hash2(vec2(fi, 37.0));
    float kr = 2.0 * exp2(r1 * 4.0);
    float ang = 0.5 + (r2 - 0.5) * (r4 > 0.8 ? 6.28 : 2.6);
    vec2 k = floor(vec2(cos(ang), sin(ang)) * kr + 0.5);
    if (dot(k, k) < 1.0) k = vec2(1.0, 1.0);
    float amp = pow(dot(k, k), -0.75) * smoothstep(1.5, 5.0, length(k));   // band-pass: few long waves per tile
    float ph = 6.2831853 * (dot(k, uv) + r3);
    h += amp * sin(ph);
    s += (amp * 6.2831853) * k * cos(ph);
    s2 += 0.5 * amp * amp * 39.478418 * dot(k, k);
    h2 += 0.5 * amp * amp;
  }
  vec2 sn = clamp(s / (3.0 * sqrt(s2)), -1.0, 1.0);
  gl_FragColor = vec4(0.5 + 0.5 * sn, clamp(0.5 + h / (6.0 * sqrt(h2)), 0.0, 1.0), 0.5 * dot(sn, sn));
}
`;

// ---------------------------------------------------------------------------- SEA SURFACE
// Shared by the terrain draw (which renders the sea surface itself, see TERRAIN_FRAG) and the water mesh (underwater
// camera only). defines: WATER (2..4 wave normal layers), FOAM (0/1), REFL (terrain reflection taps, 0 = off)
//  - Waves: scrolling, rotated layers of the baked wave-slope texture (uWaves, see BAKE_WAVE_FRAG; each layer holds a
//    4-octave directional spectrum), with the wind roughness varied by the cloud-coverage field (rougher water under
//    the cloud bands, drifting with them; reuses the cloud-shadow fetch and breaks up the tiling).
//  - Specular: Beckmann lobe whose roughness is the slope variance the mip chain filtered away (A channel minus the
//    squared mean slope) plus the variance of the layers this tier does not draw, so distant water turns into a broad
//    glitter path instead of shimmering, and low tiers keep the same overall sun streak.
//  - Reflection: sky LUT + the cloud layer along the reflected ray, and (REFL > 0) a short exponential heightfield march
//    on the max-filtered height mips for reflected terrain (soft hit, hazed by the same height fog as the scene).
//  - Body: seabed seen through a Beer-Lambert water column (view path refracted), so shallows read turquoise over sand
//    and deep water blue; shoreline foam bands drift toward the beach.
const GLSL_SEA = /* glsl */`
uniform sampler2D uWaves;          // tiling wave texture: RG = slope / (3 rms), B = height, A = 0.5 |RG|^2
#if REFL >= 7
const float REFL_S0 = 60.0, REFL_MUL = 2.6;  // 7 taps: 60 m to 18 km
#elif REFL >= 5
const float REFL_S0 = 100.0, REFL_MUL = 3.4; // 5 taps: 100 m to 13 km
#else
const float REFL_S0 = 160.0, REFL_MUL = 4.5; // 3 taps: 160 m to 3.2 km (nearby shores and islands)
#endif
const float WT1 = 1.0 / 251.0, WT2 = 1.0 / 67.0, WT3 = 1.0 / 19.3, WT4 = 1.0 / 6.1;   // layer tile frequencies (1/m)
const mat2 WR1 = mat2(0.906, 0.423, -0.423, 0.906), WR2 = mat2(0.276, -0.961, 0.961, 0.276);
const mat2 WR3 = mat2(-0.588, 0.809, -0.809, -0.588), WR4 = mat2(0.978, 0.208, -0.208, 0.978);
const float WK1 = 0.30, WK2 = 0.22, WK3 = 0.13, WK4 = 0.07;                        // slope gain per layer
// slope variance of the layers a tier leaves out (the texture holds about 1/9 mean-square in normalized units)
#if WATER >= 4
const float WVAR_REST = 0.0;
#elif WATER == 3
const float WVAR_REST = WK4 * WK4 * 0.11;
#else
const float WVAR_REST = (WK3 * WK3 + WK4 * WK4) * 0.11;
#endif
// one wave layer: adds the world-space slope to g, the sub-texel (filtered-away) slope variance to v; returns height
float waveLayer(vec2 uv, mat2 M, float k, inout vec2 g, inout float v) {
  vec4 a = texture(uWaves, uv);
  vec2 s = a.rg * 2.0 - 1.0;
  g += (s * M) * k;                          // s * M = transpose(M) * s: texture-space slope back to world axes
  v += max(2.0 * a.a - dot(s, s), 0.0) * (k * k);
  return a.b - 0.5;
}
// unfogged radiance of the sea surface (y = 0) at p; V = unit vector toward the camera, dist = distance to it
vec3 seaSurface(vec2 p, float dist, vec3 V) {
  float t = uTime;
  float depth = -heightLin(p);
  // cloud shadow, and the wind roughness field from the same cloud-coverage fetch (gusty, rougher water under the
  // cloud bands; drifts with the clouds and breaks up the tiling of the wave layers)
  vec2 sp = p + uSunDir.xz * (uCloudAlt / max(uSunDir.y, 0.05));
  float cA = texture(uCloudTex, sp * CLOUD_INV_TILE + uCloudOff).a;
  float cs = 1.0 - 0.52 * smoothstep(uCloudCut, uCloudCut + 0.3, cA);   // softened: open water scatters light in
  float rough = 0.6 + 0.8 * smoothstep(0.3, 0.6, cA);
  vec2 g = vec2(0.0);
  float var = WVAR_REST;
  float wh = waveLayer((WR1 * p) * WT1 + t * vec2(0.0060, 0.0011), WR1, WK1, g, var);
  wh += waveLayer((WR2 * p) * WT2 + g * 0.3 + t * vec2(-0.0102, 0.0182), WR2, WK2, g, var);   // warped by layer 1
#if WATER >= 3
  waveLayer((WR3 * p) * WT3 + t * vec2(0.0420, -0.0311), WR3, WK3, g, var);
#endif
#if WATER >= 4
  waveLayer((WR4 * p) * WT4 + t * vec2(-0.0905, -0.0604), WR4, WK4, g, var);
#endif
  g *= rough; var *= rough * rough;
  var += 0.0016 + dist * 8e-7;               // capillary floor + extra blur far out (no glint shimmer at range)
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  float cosV = max(dot(V, N), 0.02);
  float fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);                            // back-facing micro normals at grazing angles: fold the ray up
  R = normalize(R + vec3(0.0, 0.015, 0.0));
  vec3 skyR = skyLut(R) * 0.85;              // (a touch under a mirror: keeps sun-side water from washing out)
  vec3 refl = skyR;
#if REFL > 0
  // cloud layer seen in the water (coverage only; the mip chosen from the ray footprint blurs it like real chop)
  float tC = (uCloudAlt) / max(R.y, 0.04);
  float cv = texture(uCloudTex, (p + R.xz * tC) * CLOUD_INV_TILE + uCloudOff).r;
  float cov = smoothstep(uCloudCut - 0.05, uCloudCut + 0.35, cv) * (1.0 - smoothstep(18000.0, 42000.0, tC));
  vec3 cloudC = (uSkyAmb * 0.55 + uGroundAmb * 0.45 + uSunColor * 0.22) * uCloudTint;   // cloud underside, as in cloudLayer
  refl = mix(refl, mix(skyR, cloudC, 0.75), cov);
  // reflected terrain: exponential march on the max-filtered height mips (skipped where the ray climbs too steeply to
  // meet any terrain, or the Fresnel term makes the reflection negligible). The march runs along the view azimuth with
  // the wave-perturbed elevation: neighbouring pixels fetch neighbouring texels (cache friendly) and reflections smear
  // vertically, as they do on real chop.
  float rs = R.y / max(length(R.xz), 1e-3);
  if (rs < 0.5 && fres > 0.06) {
    vec2 rd = -V.xz / max(length(V.xz), 1e-4);
    float occ = 0.0, hitS = 1.0, hitH = 0.0, s = REFL_S0;
    for (int i = 0; i < REFL; i++) {
      float th = textureLod(uHeightLin, hmUV(p + rd * s), clamp(log2(s * (0.06 * HM_INV_STEP)), 0.0, 7.0)).r;
      float o = clamp((th - s * rs) / (0.04 * s), 0.0, 1.0);
      if (o > occ) { occ = o; hitS = s; hitH = th; }
      s *= REFL_MUL;
    }
    if (occ > 0.0) {
      float hh = max(hitH, 0.0);
      vec3 alb = mix(vec3(0.075, 0.105, 0.045), vec3(0.20, 0.18, 0.15), smoothstep(500.0, 1300.0, hh));
      alb = mix(alb, vec3(0.75, 0.78, 0.82), smoothstep(1650.0, 1900.0, hh));
      alb = mix(vec3(0.42, 0.37, 0.26), alb, smoothstep(4.0, 25.0, hh));
      vec3 land = alb * (uSunColor * 0.35 + uSkyAmb * 0.9 + uGroundAmb * 0.3);
      float Tr = exp(-(odepth(0.0, hh * 0.5, hitS, 1.0 / 1200.0, uFogMie) + odepth(0.0, hh * 0.5, hitS, 1.0 / 8000.0, uFogRay)));
      refl = mix(refl, land * Tr + skyR * (1.0 - Tr), occ);
    }
  }
#endif

  // body: seabed through the water column (light down + view path refracted up), Beer-Lambert per channel
  vec3 lightIn = uSunColor * (max(uSunDir.y, 0.0) * cs) + uSkyAmb;
  float cosR = sqrt(1.0 - (1.0 - cosV * cosV) * 0.5625);
  float dpos = max(depth, 0.0);
  vec3 Tw = exp(-vec3(0.42, 0.085, 0.05) * (dpos * (1.0 + 1.0 / cosR)));
  vec3 bed = vec3(0.40, 0.36, 0.25) * (0.85 + 0.3 * wh);
  vec3 deepC = vec3(0.006, 0.030, 0.056);
  vec3 body = (bed * Tw + deepC * (1.0 - Tw)) * lightIn * uWaterTint;
  // light scattered through wave crests toward the camera (back-lit by a low sun)
  float back = pow(max(dot(-V.xz, uSunDir.xz) * 0.5 + 0.5, 0.0), 3.0);
  body += vec3(0.02, 0.09, 0.08) * uSunColor * (max(wh + 0.1, 0.0) * back * cs * 0.35);
  body = mix(vec3(0.36, 0.30, 0.21) * lightIn, body, smoothstep(-1.0, 0.6, depth));
  vec3 col = mix(body, refl, fres);

  // sun specular: Beckmann (mean-square slope = var), Schlick Fresnel at the half vector, clamped HDR peak
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 1e-3);
  float nh2 = nh * nh;
  float m2 = var;
  float D = exp((nh2 - 1.0) / (nh2 * m2)) / (3.14159 * m2 * nh2 * nh2);
  float fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  float spec = min(D * fh / (4.0 * cosV), 60.0) * smoothstep(0.0, 0.06, uSunDir.y);
  col += uSunColor * (spec * cs * uSpecK);

#if FOAM
  // shoreline foam (coherent branch: open water skips it): a soft edge line plus bands drifting toward the beach
  if (depth < 7.0) {
    float fade = clamp(1.0 - dist * (1.0 / 9000.0), 0.0, 1.0);
    float depthF = -heightLin(p + g * 90.0);
    float n = wh * 2.0;
    float fd = depthF + n * 1.4;
    float edge = smoothstep(1.6, 0.1, fd);
    float band = 0.5 + 0.5 * sin(fd * 1.6 + t * 1.3 + n * 2.0);
    band = smoothstep(0.55, 0.95, band) * smoothstep(5.5, 1.0, fd);
    float foam = max(edge, band * 0.75) * smoothstep(0.25, 0.65, 0.5 + n * 0.6 + edge * 0.4);
    foam *= smoothstep(-1.2, 0.3, depth) * (0.35 + 0.65 * fade);
    col = mix(col, vec3(0.85, 0.88, 0.9) * (uSkyAmb + uSunColor * (max(uSunDir.y, 0.0) * 1.2 * cs)), foam * 0.8);
  }
#endif
  return col;
}
`;

// ---------------------------------------------------------------------------- CLOUD LAYER SHADING
// Shared by the sky (camera below the layer: clouds are composited into the sky pixel, no blended layer) and the
// cloud mesh (camera above the layer: clouds lie over terrain/water and must be blended).
const GLSL_CLOUD = /* glsl */`
// (unfogged colour, alpha) of the cloud layer at plane point p; dist = distance to the camera, V = toward the camera
vec4 cloudLayer(vec2 p, float dist, vec3 V) {
  vec4 cv = texture(uCloudTex, p * CLOUD_INV_TILE + uCloudOff);
  float cov = smoothstep(uCloudCut, uCloudCut + 0.2, cv.r);
  cov *= smoothstep(uCloudAlt + 100.0, uCloudAlt - 450.0, heightLin(p));
  float thick = smoothstep(uCloudCut - 0.05, uCloudCut + 0.45, cv.r);
  float alpha = cov * (0.95 + 0.05 * thick);
  alpha *= smoothstep(25.0, 160.0, abs(cameraPosition.y - uCloudAlt));
  alpha *= 1.0 - smoothstep(32000.0, 46000.0, dist);
  if (alpha < 0.002) return vec4(0.0);
  vec2 gr = (cv.gb - 0.5) * ${f(2 * CLOUD_GRAD_RANGE)};
  vec3 N = normalize(vec3(-gr.x, 1.0, -gr.y));
  float ndl = dot(N, uSunDir);
  float above = smoothstep(-150.0, 150.0, cameraPosition.y - uCloudAlt);
  vec3 top = uSunColor * ((0.3 + 0.7 * max(ndl, 0.0)) * (0.8 + 0.2 * thick) * 0.95) + uSkyAmb * 0.8;
  float fwd = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  vec3 bottom = (uSkyAmb * 0.55 + uGroundAmb * 0.45) * (1.05 - 0.55 * thick) + uSunColor * ((0.22 + 0.35 * fwd) * (1.0 - thick));
  return vec4(mix(bottom, top, above) * uCloudTint, alpha);
}
`;

// ---------------------------------------------------------------------------- SKY
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#ifdef FAR_PLANE
  gl_Position = p.xyww;   // depth = 1: drawn after the opaque world, shaded only where nothing else wrote depth
#else
  gl_Position = p;
#endif
}
`;
const SKY_FRAG = GLSL_COMMON + GLSL_LIGHT + GLSL_CLOUD + /* glsl */`
uniform vec3 uSunDiscCol;
uniform float uSkyClouds;      // 1: camera below the cloud layer, composite the layer here
uniform float uStars;          // star field strength (night presets; 0 = skipped, a uniform branch)
varying vec3 vDir;
// sparse hashed stars on a cube map grid (even density), ~1.3 px soft dots sized from the screen-space derivative
vec3 starField(vec3 dir) {
  vec3 a = abs(dir);
  vec2 q; float face;
  if (a.x > a.y && a.x > a.z) { q = dir.zy / a.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y > a.z) { q = dir.xz / a.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
  else { q = dir.xy / a.z; face = dir.z > 0.0 ? 4.0 : 5.0; }
  vec2 g = q * 150.0 + 160.0;
  vec2 cell = floor(g), o = vec2(face * 400.0, 0.0);
  float h = hash2(cell + o);
  if (h < 0.991) return vec3(0.0);
  vec2 c = vec2(hash2(cell + o + vec2(0.0, 401.0)), hash2(cell + o + vec2(0.0, 977.0))) * 0.7 + 0.15;
  float px = max(length(fwidth(g)), 1e-4);
  float d = length(g - cell - c) / (1.1 * px);
  float m = (h - 0.991) * (1.0 / 0.009);
  float mag = 0.01 + 0.12 * m * m * m * m;
  vec3 tint = mix(vec3(0.86, 0.92, 1.0), vec3(1.0, 0.93, 0.84), hash2(cell + o + vec2(0.0, 1601.0)));
  return tint * (mag * exp(-d * d * 2.2) * min(1.0, 0.5 / px));
}
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyLut(dir);
  if (uStars > 0.0 && dir.y > 0.0) col += starField(dir) * (uStars * smoothstep(0.02, 0.3, dir.y));
  col += uSunDiscCol * (smoothstep(SUN_COS, SUN_COS + 0.00003, dot(dir, uSunDir)) * step(0.0, dir.y));
  if (uSkyClouds > 0.5) {
    float tHit = (uCloudAlt - cameraPosition.y) / max(dir.y, 1e-3);
    vec3 pc = cameraPosition + dir * tHit;
    vec4 c = cloudLayer(pc.xz, tHit, -dir);
    float T = fogT(uCloudAlt, tHit);
    col = mix(col, c.rgb * T + col * (1.0 - T), c.a * step(0.0, dir.y));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------- TERRAIN (+ sea surface)
// defines: NLEV, CELL0, LHALF_INIT (half cell count per level), DETAIL, WATER, FOAM
const TERRAIN_VERT = GLSL_COMMON + /* glsl */`
uniform vec2 uOrigins[NLEV];
uniform vec4 uCull[5];          // world-space frustum planes (left/right/bottom/top/near), inside: dot(n,p) + w > 0
uniform vec3 uCullCfg;          // x: culling on, y/z: terrain height range (m)
varying vec3 vWorld;            // terrain point (true height, may be < 0)
varying vec3 vHaze;             // in-scattered haze colour toward this vertex
varying float vFogT;            // aerial-perspective transmittance
const float LHALF[NLEV] = float[NLEV](LHALF_INIT);
const float LLOD[NLEV] = float[NLEV](LLOD_INIT);   // height footprint per level (< 0.5: exact bilinear, matches getHeight)
float heightAt(vec2 xz, float lod) { return lod < 0.5 ? sampleHeight(xz) : textureLod(uHeightLin, hmUV(xz), lod).r; }
void main() {
  int li = int(position.z + 0.5);
  float cell = CELL0 * exp2(position.z);
  float hm = LHALF[li];
  vec2 g = position.xy;
  vec2 xz = uOrigins[li] + (g - hm) * cell;
  // Frustum cull: a vertex whose whole height column lies more than 1.5 cells outside one plane only belongs to
  // triangles entirely outside that plane, so it skips the heightmap/sky work and is parked outside the same plane.
  if (uCullCfg.x > 0.5) {
    for (int i = 0; i < 5; i++) {
      vec4 P = uCull[i];
      if (dot(P.xz, xz) + P.w + max(P.y * uCullCfg.y, P.y * uCullCfg.z) < -1.5 * cell) {
        vWorld = vec3(0.0); vHaze = vec3(0.0); vFogT = 1.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, 0.5 * (uCullCfg.y + uCullCfg.z), xz.y, 1.0);
        return;
      }
    }
  }
  float lod = LLOD[li];
  float h = heightAt(xz, lod);
  // near the ring's outer edge morph toward the parent level (odd vertices onto the parent's edges, all vertices onto
  // the parent's height footprint), so the levels nest without cracks
  vec2 par = mod(g, 2.0);
  float dmax = max(abs(g.x - hm), abs(g.y - hm));
  float m = smoothstep(hm - 18.0, hm - 6.0, dmax);
  if (li < NLEV - 1 && m > 0.0) {
    float lodP = LLOD[li + 1];
    float hc;
    if (par.x > 0.5 || par.y > 0.5) {
      vec2 d = (par.x > 0.5) ? ((par.y > 0.5) ? vec2(cell, cell) : vec2(cell, 0.0)) : vec2(0.0, cell);
      hc = 0.5 * (heightAt(xz - d, lodP) + heightAt(xz + d, lodP));
    } else {
      hc = (lodP == lod) ? h : heightAt(xz, lodP);
    }
    h = mix(h, hc, m);
  }
  // With the camera above water the sea surface is drawn by this mesh: heights are clamped to the water plane, so
  // there is no hidden seabed layer under a separate water plane (and no depth fighting between the two).
  float hr = (cameraPosition.y > 0.5) ? max(h, 0.0) : h;
  vWorld = vec3(xz.x, h, xz.y);
  vec3 toP = vec3(xz.x, hr, xz.y) - cameraPosition;
  float dist = max(length(toP), 1e-3);
  vFogT = fogT(hr, dist);
  vHaze = skyLut(toP / dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, hr, xz.y, 1.0);
}
`;
const TERRAIN_FRAG = GLSL_COMMON + GLSL_LIGHT + GLSL_SEA + /* glsl */`
uniform sampler2D uAux;
varying vec3 vWorld;
varying vec3 vHaze;
varying float vFogT;
const float S1 = 0.021 * DINV, S3 = 0.055 * DINV, S2 = 0.13 * DINV, S4 = 0.33 * DINV;
void main() {
  float h = vWorld.y;
  vec2 xz = vWorld.xz;
  if (h < 0.0 && cameraPosition.y > 0.5) {
    // Sea surface. The interpolated mesh height crosses 0 exactly where a separate water plane would intersect the
    // terrain, so the coastline is unchanged; the clamped geometry is the water plane itself.
    vec3 toCam = cameraPosition - vec3(xz.x, 0.0, xz.y);
    float dist = length(toCam);
    vec3 col = seaSurface(xz, dist, toCam / dist);
    float T = vFogT * (1.0 - smoothstep(30000.0, 48000.0, dist));
    gl_FragColor = vec4(col * T + vHaze * (1.0 - T), 1.0);
    return;
  }
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec4 aux = texture(uAux, hmUV(xz));
  vec3 N = vec3(aux.r * 2.0 - 1.0, 0.0, aux.g * 2.0 - 1.0);
  N.y = sqrt(max(1.0 - dot(N.xz, N.xz), 0.0));
  float shadow = aux.b;
  float ao = aux.a;

  // detail from the tiling noise texture (R = value, GB = d/dp); mip filtering fades it with distance
  vec4 t1 = texture(uDetail, xz * S1);
  float d1 = (t1.r - 0.5) * 0.98;
  float bigv = texture(uBiome, xz * ${f(1 / (2 * HM_HALF))} + 0.5).r;
  float f1 = clamp(1.0 - dist * (1.0 / 7000.0), 0.0, 1.0);
  vec2 grad = (t1.gb - 0.5) * (4.0 * 0.021 * 5.0 * f1);
  float d3 = 0.0, d2 = 0.0, f3 = 0.0, f2 = 0.0;
#if DETAIL >= 2
  vec4 t3 = texture(uDetail, xz * S3 + vec2(0.13, 0.71));
  f3 = clamp(1.0 - dist * (1.0 / 4000.0), 0.0, 1.0);
  d3 = (t3.r - 0.5) * 0.98;
  grad += (t3.gb - 0.5) * (4.0 * 0.055 * 2.0 * f3);
#endif
#if DETAIL >= 3
  vec4 t2 = texture(uDetail, xz * S2 + vec2(0.83, 0.29));
  f2 = clamp(1.0 - dist * (1.0 / 1800.0), 0.0, 1.0);
  d2 = t2.r - 0.5;
  grad += (t2.gb - 0.5) * (4.0 * 0.13 * 0.8 * f2);
#endif
#if DETAIL >= 4
  vec4 t4 = texture(uDetail, xz * S4 + vec2(0.57, 0.43));
  float f4 = clamp(1.0 - dist * (1.0 / 700.0), 0.0, 1.0);
  grad += (t4.gb - 0.5) * (4.0 * 0.33 * 0.3 * f4);
  d2 += (t4.r - 0.5) * 0.5 * f4;
#endif
  vec3 Nd = normalize(N + vec3(-grad.x, 0.0, -grad.y));

  // biome weights
  float steep = smoothstep(0.86, 0.60, N.y + 0.06 * d1);
  float snowLine = 1750.0 + 260.0 * (bigv - 0.5) + 90.0 * d1;
  float wSnow = smoothstep(snowLine - 160.0, snowLine + 120.0, h) * smoothstep(0.52, 0.80, N.y + 0.1 * d1);
  float treeLine = 1500.0 + 240.0 * (bigv - 0.5);
  float forestPatch = smoothstep(0.30, 0.58, bigv + 0.25 * d1);
  float wForest = smoothstep(treeLine + 120.0, treeLine - 300.0, h) * smoothstep(0.55, 0.78, N.y) * smoothstep(3.0, 20.0, h) * forestPatch;
  float wSand = smoothstep(9.0, 2.0, h + 6.0 * d1);
  float wSea = smoothstep(1.0, -8.0, h);

  // albedos (linear)
  vec3 meadow = mix(vec3(0.13, 0.21, 0.05), vec3(0.26, 0.25, 0.08), bigv) * (1.0 + 0.22 * d1 + 0.2 * d3 * f3 + 0.2 * d2 * f2);
  meadow = mix(meadow, vec3(0.28, 0.25, 0.19), smoothstep(treeLine - 100.0, treeLine + 500.0, h) * 0.6);
  vec3 forest = vec3(0.028, 0.055, 0.022) * (1.0 + 0.5 * d1 + 0.5 * d3 * f3 + (0.9 * max(d2, 0.0) + 0.3 * d2) * f2);
  vec3 rock = mix(vec3(0.16, 0.14, 0.13), vec3(0.30, 0.27, 0.24), 0.5 + 0.5 * sin(h * 0.045 + d1 * 4.0)) * (1.0 + 0.3 * d1);
  vec3 snow = vec3(0.86, 0.88, 0.93) * (1.0 - 0.12 * d1 * f1);
  vec3 sand = vec3(0.46, 0.40, 0.28) * (1.0 + 0.2 * d1);
  vec3 seabed = vec3(0.22, 0.24, 0.17);
  vec3 alb = meadow;
  alb = mix(alb, forest, wForest);
  alb = mix(alb, rock, steep);
  alb = mix(alb, snow, wSnow * (1.0 - 0.8 * steep));
  alb = mix(alb, sand, wSand * (1.0 - steep));
  alb = mix(alb, seabed, wSea);

  // lighting
  float ndl = max(dot(Nd, uSunDir), 0.0);
  float selfSh = smoothstep(-0.1, 0.25, dot(N, uSunDir));
  float cs = cloudShadow(xz, h);
  vec3 direct = uSunColor * (ndl * shadow * selfSh * cs);
  vec3 amb = mix(uGroundAmb, uSkyAmb, Nd.y * 0.5 + 0.5) * ao * (1.0 - 0.3 * wForest);
  vec3 col = alb * (direct + amb);
  vec3 Hv = normalize(uSunDir + V);
  float spec = pow(max(dot(Nd, Hv), 0.0), 24.0) * (wSnow * 0.35 + wSand * 0.12) * shadow * cs;
  col += uSunColor * spec;

  // aerial perspective (per vertex)
  gl_FragColor = vec4(col * vFogT + vHaze * (1.0 - vFogT), 1.0);
}
`;

// ---------------------------------------------------------------------------- WATER MESH (underwater camera only)
const WATER_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;
const WATER_FRAG = GLSL_COMMON + GLSL_LIGHT + GLSL_SEA + /* glsl */`
varying vec3 vWorld;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 col = seaSurface(vWorld.xz, dist, V);
  float T = fogT(0.0, dist) * (1.0 - smoothstep(30000.0, 48000.0, dist));
  gl_FragColor = vec4(col * T + skyLut(-V) * (1.0 - T), 1.0);
}
`;

// ---------------------------------------------------------------------------- CLOUD LAYER MESH (camera above the layer)
const CLOUD_FRAG = GLSL_COMMON + GLSL_LIGHT + GLSL_CLOUD + /* glsl */`
varying vec3 vWorld;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec4 c = cloudLayer(vWorld.xz, dist, V);
  if (c.a < 0.002) discard;   // clear sky: skip the blend (no depth write, so early-z is unaffected)
  float T = fogT(vWorld.y, dist);
  gl_FragColor = vec4(c.rgb * T + skyLut(-V) * (1.0 - T), c.a);
}
`;

// ---------------------------------------------------------------------------- CLOUD PUFFS (instanced billboards)
const PUFF_CELL = 1400;
const PUFF_VERT = GLSL_COMMON + GLSL_LIGHT + /* glsl */`
uniform vec2 uCamCell;
uniform float uPuffG;
varying vec2 vUv;
varying float vVis;
varying vec2 vSeed;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
varying vec3 vHaze;
varying float vFogT;
void main() {
  float id = float(gl_InstanceID);
  vec2 cell = uCamCell + vec2(mod(id, uPuffG), floor(id / uPuffG)) - floor(uPuffG * 0.5);
  float h1 = hash2(cell), h2 = hash2(cell + 7.0), h3 = hash2(cell + 19.0), h4 = hash2(cell + 31.0);
  vec2 cxz = (cell + vec2(h1, h2)) * ${f(PUFF_CELL)};
  float size = 420.0 + 520.0 * h3;
  vec3 center = vec3(cxz.x, uCloudAlt + (h4 - 0.5) * 260.0, cxz.y);
  float cov = textureLod(uCloudTex, cxz * CLOUD_INV_TILE + uCloudOff, 0.0).r;
  float vis = smoothstep(uCloudCut + 0.03, uCloudCut + 0.25, cov);
  vec3 toC = center - cameraPosition;
  float dist = length(toC);
  float reach = ${f(PUFF_CELL * 0.5)} * uPuffG;
  vis *= smoothstep(reach, reach * 0.7, dist);
  vis *= smoothstep(size * 0.35, size * 0.9, dist);
  vis *= smoothstep(uCloudAlt + 100.0, uCloudAlt - 450.0, heightLin(cxz));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float ang = h3 * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = position.xy;
  vec2 qr = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);
  float sz = (vis > 0.002) ? size : 0.0;
  vec3 world = center + (right * qr.x + up * qr.y) * sz;
  vUv = uv;
  vVis = vis;
  vSeed = vec2(h1 * 10.0 + h2 * 100.0, h2 * 10.0 + h1 * 100.0);
  vRight = right * ca + up * sa;
  vUp = up * ca - right * sa;
  vBack = back;
  vFogT = fogT(center.y, dist);
  vHaze = skyLut(toC / max(dist, 1.0)) * (1.0 - vFogT);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
const PUFF_FRAG = GLSL_COMMON + GLSL_LIGHT + /* glsl */`
varying vec2 vUv;
varying float vVis;
varying vec2 vSeed;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
varying vec3 vHaze;
varying float vFogT;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0 || vVis < 0.002) discard;
  vec2 pp = (q * 2.1 + vSeed) * DINV;
  vec4 na = texture(uDetail, pp);
  vec4 nb = texture(uDetail, pp * 2.1 + vec2(0.37, 0.11));
  float n = 0.5 * na.a + 0.25 * nb.a + 0.125 * na.r + 0.0625 * nb.r;
  float shape = (1.0 - r2) * (0.45 + 1.2 * n) - 0.3;
  float alpha = smoothstep(0.0, 0.28, shape) * vVis * 0.92;
  vec3 Nl = vec3(q * 0.9, sqrt(max(0.0, 1.0 - r2 * 0.81)));
  vec3 Nw = normalize(vRight * Nl.x + vUp * Nl.y + vBack * Nl.z);
  float ndl = clamp(dot(Nw, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 lit = uSunColor * (0.1 + 0.8 * ndl * ndl) + uSkyAmb * 0.6 + uGroundAmb * 0.2;
  vec3 col = lit * (0.85 + 0.3 * n) * (uCloudTint * uPuffK);
  gl_FragColor = vec4(col * vFogT + vHaze, alpha);
}
`;

// ---------------------------------------------------------------------------- GROUND LIGHTS (night presets)
// Settlement and harbour lights: one Points draw of static sprites on low, gentle land (World._buildGroundLights), only
// visible while NIGHT_FX.uGround > 0. Hazed by the same height fog as the terrain; additive HDR, depth tested.
const GLIGHT_VERT = GLSL_COMMON + /* glsl */`
attribute float aSeed;
uniform float uGround;
uniform float uViewportH;
varying vec3 vCol;
void main() {
  vec3 toP = position - cameraPosition;
  float dist = max(length(toP), 1.0);
  float raw = uViewportH * 5.0 / dist;                    // a ~5 m glow
  float sz = clamp(raw, 1.7, 4.5);
  float warm = step(0.55, fract(aSeed * 7.13));
  vec3 c = mix(vec3(1.0, 0.82, 0.55), vec3(1.0, 0.5, 0.16), warm);   // warm white / sodium
  float I = uGround * (0.7 + 0.9 * fract(aSeed * 3.71)) * clamp(raw / 1.7, 0.45, 1.0);
  I *= fogT(position.y, dist) * (1.0 - smoothstep(15000.0, 24000.0, dist));
  vCol = c * (2.2 * I);
  gl_PointSize = sz;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
const GLIGHT_FRAG = /* glsl */`
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * exp(-r2 * 3.5), 1.0);
}
`;

// ============================================================================
// GEOMETRY BUILDERS
// ============================================================================
// All clipmap levels in ONE geometry. Vertex attribute = (i, j, level). Level L has levels[L] cells per side of size
// CELL0*2^L; its centre hole (L > 0) is the previous level's footprint minus a 2-cell overlap where the inner level is
// fully morphed. Cells are emitted level by level in concentric square rings around the camera, so the whole terrain
// draws roughly front-to-back and early-z rejects most hidden fragments.
function buildClipmapGeometry(levels) {
  const NL = levels.length;
  let maxV = 0, maxC = 0;
  for (let L = 0; L < NL; L++) { maxV += (levels[L] + 1) * (levels[L] + 1); maxC += levels[L] * levels[L]; }
  const pos = new Float32Array(maxV * 3);
  const idx = new Uint32Array(maxC * 6);
  let nv = 0, ni = 0;
  for (let L = 0; L < NL; L++) {
    const M = levels[L], V = M + 1, c = M / 2;
    const hh = L > 0 ? levels[L - 1] / 4 - 2 : 0;          // hole half-width (cells of this level)
    const map = new Int32Array(V * V).fill(-1);
    const vert = (i, j) => {
      const k = j * V + i;
      if (map[k] < 0) { map[k] = nv; pos[nv * 3] = i; pos[nv * 3 + 1] = j; pos[nv * 3 + 2] = L; nv++; }
      return map[k];
    };
    const cell = (ci, cj) => {
      const p00 = vert(ci, cj), p10 = vert(ci + 1, cj), p01 = vert(ci, cj + 1), p11 = vert(ci + 1, cj + 1);
      idx[ni++] = p00; idx[ni++] = p01; idx[ni++] = p11;
      idx[ni++] = p00; idx[ni++] = p11; idx[ni++] = p10;
    };
    for (let r = hh; r < c; r++) {                          // ring r = boundary of the square [c-1-r, c+r]^2
      const lo = c - 1 - r, hi = c + r;
      for (let ci = lo; ci <= hi; ci++) cell(ci, lo);
      for (let cj = lo + 1; cj <= hi; cj++) cell(hi, cj);
      for (let ci = hi - 1; ci >= lo; ci--) cell(ci, hi);
      for (let cj = hi - 1; cj > lo; cj--) cell(lo, cj);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, nv * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(idx.slice(0, ni), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return geo;
}

// Flat disc in the XZ plane with exponentially spaced rings (dense near the center).
function buildDiscGeometry(r0, ratio, rMax, segs) {
  const radii = [];
  for (let r = r0; r < rMax; r *= ratio) radii.push(r);
  radii.push(rMax);
  const nr = radii.length;
  const pos = new Float32Array((1 + nr * segs) * 3);
  const idx = new Uint32Array((segs + (nr - 1) * segs * 2) * 3);
  let p = 3;
  for (let k = 0; k < nr; k++) {
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos[p++] = Math.cos(a) * radii[k]; pos[p++] = 0; pos[p++] = Math.sin(a) * radii[k];
    }
  }
  let n = 0;
  for (let s = 0; s < segs; s++) { const s1 = (s + 1) % segs; idx[n++] = 0; idx[n++] = 1 + s1; idx[n++] = 1 + s; }
  for (let k = 0; k < nr - 1; k++) {
    const b0 = 1 + k * segs, b1 = b0 + segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx[n++] = b0 + s; idx[n++] = b1 + s1; idx[n++] = b1 + s;
      idx[n++] = b0 + s; idx[n++] = b0 + s1; idx[n++] = b1 + s1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax * 2);
  return geo;
}

// Renders a fullscreen pass into a new RGBA8 render target (mipmapped; repeat-wrapped unless `wrap` says otherwise) once.
function bakeTexture(renderer, size, fragmentShader, anisotropy, wrap = THREE.RepeatWrapping, existing = null) {
  const rt = existing || new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: wrap, wrapT: wrap,
    generateMipmaps: true, depthBuffer: false, stencilBuffer: false,
  });
  try { rt.texture.anisotropy = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()); } catch (e) { /* optional */ }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);           // three generates the mip chain when the pass ends
  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAuto;
  geo.dispose(); mat.dispose();
  return rt;
}

// ============================================================================
// WORLD
// ============================================================================
const _camPos = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const CULL_PLANES = [0, 1, 2, 3, 5];      // THREE.Frustum planes: right, left, bottom, top, (far skipped), near
const _fex = [0, 0, 0];
const _bakeV = new THREE.Vector3(), _prepV = new THREE.Vector3();
const lutKey = (sy) => Math.round(sy * 1e6);   // sky table cache key: the sun height
const _vpS = new THREE.Vector2();
const SUN_DEFAULT_KEY = '22/35';           // setLighting key of SUN_DIR_DEFAULT (elevation / azimuth, degrees)

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;
    this.cloudAltitude = 2400;
    this.sunDirection = new THREE.Vector3(SUN_DIR_DEFAULT[0], SUN_DIR_DEFAULT[1], SUN_DIR_DEFAULT[2]).normalize();
    this.quality = null;
    this.cullTerrain = true;              // vertex-shader frustum culling of the terrain grid (planes from the rendering camera)

    // ---- heightfield + aux (normals / baked sun shadow / cavity)
    const t0 = performance.now();
    this._height = generateHeightfield();
    this._aux = new Uint8Array(HM_N * HM_N * 4);
    generateAux(this._height, this._aux, [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z]);
    this.generationTime = performance.now() - t0;
    let hMin = Infinity, hMax = -Infinity;
    for (let i = 0; i < this._height.length; i++) { const h = this._height[i]; if (h < hMin) hMin = h; if (h > hMax) hMax = h; }

    const heightTex = new THREE.DataTexture(this._height, HM_N, HM_N, THREE.RedFormat, THREE.FloatType);
    heightTex.magFilter = THREE.NearestFilter; heightTex.minFilter = THREE.NearestFilter;
    heightTex.wrapS = THREE.ClampToEdgeWrapping; heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.generateMipmaps = false; heightTex.needsUpdate = true;
    this.heightTexture = heightTex;
    // half-float copy with hardware bilinear filtering (one fetch instead of four for water depth / cloud masks) and
    // max-filtered mips for the coarse clipmap levels
    const heightLin = new THREE.DataTexture(this._height, HM_N, HM_N, THREE.RedFormat, THREE.FloatType);
    heightLin.internalFormat = 'R16F';
    heightLin.mipmaps = buildMaxMips(this._height);
    heightLin.magFilter = THREE.LinearFilter; heightLin.minFilter = THREE.LinearMipmapLinearFilter;
    heightLin.wrapS = THREE.ClampToEdgeWrapping; heightLin.wrapT = THREE.ClampToEdgeWrapping;
    heightLin.generateMipmaps = false; heightLin.needsUpdate = true;
    this._heightLinTex = heightLin;
    const auxTex = new THREE.DataTexture(this._aux, HM_N, HM_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    auxTex.magFilter = THREE.LinearFilter; auxTex.minFilter = THREE.LinearMipmapLinearFilter;
    auxTex.wrapS = THREE.ClampToEdgeWrapping; auxTex.wrapT = THREE.ClampToEdgeWrapping;
    auxTex.generateMipmaps = true;
    try { auxTex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); } catch (e) { /* optional */ }
    auxTex.needsUpdate = true;
    this.auxTexture = auxTex;

    // ---- sky lookup table (rebuilt by setSunDirection)
    this._skyLutData = new Float32Array(SKY_LUT_W * SKY_LUT_H * 4);
    const skyLut = new THREE.DataTexture(this._skyLutData, SKY_LUT_W, SKY_LUT_H, THREE.RGBAFormat, THREE.FloatType);
    skyLut.internalFormat = 'RGBA16F';
    skyLut.magFilter = THREE.LinearFilter; skyLut.minFilter = THREE.LinearFilter;
    skyLut.wrapS = THREE.ClampToEdgeWrapping; skyLut.wrapT = THREE.ClampToEdgeWrapping;
    skyLut.generateMipmaps = false;
    this._skyLutTex = skyLut;

    // ---- tiling noise textures, baked once on the GPU
    this._detailRT = bakeTexture(renderer, DETAIL_N, BAKE_DETAIL_FRAG, 2);
    this._cloudRT = bakeTexture(renderer, CLOUD_TEX_N, BAKE_CLOUD_FRAG, 4);
    this._biomeRT = bakeTexture(renderer, BIOME_N, BAKE_BIOME_FRAG, 1, THREE.ClampToEdgeWrapping);
    this._waveRT = bakeTexture(renderer, WAVE_N, BAKE_WAVE_FRAG, 1);

    // ---- shared uniforms (objects are shared between materials: set once, everyone sees it)
    const U = this.uniforms = {
      uHeight: { value: heightTex },
      uHeightLin: { value: heightLin },
      uAux: { value: auxTex },
      uSkyLut: { value: skyLut },
      uDetail: { value: this._detailRT.texture },
      uCloudTex: { value: this._cloudRT.texture },
      uBiome: { value: this._biomeRT.texture },
      uWaves: { value: this._waveRT.texture },
      uSunDir: { value: this.sunDirection },
      uSunE: { value: 0 },
      uSunFade: { value: 0 },
      uSkyScale: { value: 0.25 },
      uSunDisc: { value: 40.0 },
      uSunDiscCol: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Vector3(2.7, 1.75, 1.0) },     // linear sun irradiance (warm golden hour)
      uSkyAmb: { value: new THREE.Vector3(0.20, 0.29, 0.48) },      // sky ambient (linear)
      uGroundAmb: { value: new THREE.Vector3(0.18, 0.13, 0.09) },   // ground bounce (linear)
      uFogMie: { value: 8.0e-5 },                                   // sea-level haze extinction (1/m), scale height 1200 m
      uFogRay: { value: 0.7e-5 },                                   // blue component (1/m), scale height 8000 m
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(CLOUD_WIND[0], CLOUD_WIND[1]) },
      uCloudAlt: { value: this.cloudAltitude },
      uCloudCut: { value: 0.49 },
      uCloudTint: { value: new THREE.Vector3(1, 1, 1) },
      uWaterTint: { value: new THREE.Vector3(1, 1, 1) },
      uSpecK: { value: 1 },
      uPuffK: { value: 1 },
      uStars: { value: 0 },
      uGround: NIGHT_FX.uGround,
      uViewportH: { value: 1080 },
      uCloudOff: { value: new THREE.Vector2(0, 0) },
      uCamCell: { value: new THREE.Vector2(0, 0) },
      uPuffG: { value: 8 },
      uSkyClouds: { value: 0 },
      uOrigins: { value: [] },
      uCull: { value: [] },
      uCullCfg: { value: new THREE.Vector3(0, hMin - 5, hMax + 5) },
    };
    this._origins = [];
    for (let L = 0; L < MAX_LEVELS; L++) this._origins.push(new THREE.Vector2(0, 0));
    U.uOrigins.value = this._origins;
    for (let i = 0; i < 5; i++) U.uCull.value.push(new THREE.Vector4(0, 0, 0, 1));
    this._envDiscCol = new THREE.Vector3();
    this._skyGrade = null;                 // time-of-day sky grade (setLighting); null = the analytic day sky as is
    this._discK = 1; this._discTint = [1, 1, 1];
    this._envIntensity = 1;
    this._shadowCache = new Map();         // baked terrain shadow channel per light direction (setLighting)
    this._lutBase = new Map();             // ungraded sky table per sun height (gradeSkyLut makes the graded one)
    { const n = HM_N * HM_N, ch = new Uint8Array(n), aux = this._aux; for (let i = 0; i < n; i++) ch[i] = aux[i * 4 + 2]; this._shadowCache.set(SUN_DEFAULT_KEY, ch); }
    this._bakeQueue = []; this._bakeJob = null; this._bakeTimer = 0;   // idle-time lighting bakes (queueLighting)
    this._envInto = null; this._envVar = null; this._envDefer = 0;     // environment targets (_buildEnvironment)
    this._shadowKey = null; this._shadowPrev = null; this._shadowWait = 0;   // a shadow change deferred to the next frame
    this._lightingKey = '';
    this._updateSky();
    { const warm = new Float32Array(SKY_LUT_W * SKY_LUT_H * 4), G = { tint: [1, 0.9, 0.8], sat: 0.9, base: [0, 0, 0] };   // (JIT: the first
      for (let i = 0; i < 3; i++) gradeSkyLut(warm, this._skyLutData, 1, G); }                                                // red sky step)

    // ---- sky dome: drawn LAST among opaque objects, at the far plane with depth test (only uncovered pixels shade)
    this._skyMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, defines: { FAR_PLANE: 1 },
      side: THREE.BackSide, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth, fog: false,
    });
    this._skyGeo = new THREE.SphereGeometry(50000, 32, 16);
    this.sky = new THREE.Mesh(this._skyGeo, this._skyMat);
    this.sky.renderOrder = 1000; this.sky.frustumCulled = false; this.sky.matrixAutoUpdate = true;
    scene.add(this.sky);

    // ---- terrain (all clipmap levels in ONE geometry / draw call); geometry + defines set by setQuality
    this._terrainGeo = null; this._gridKey = '';
    this._cell0 = 8;
    this._terrainMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, fog: false,
      defines: { NLEV: 1, CELL0: '8.0', LHALF_INIT: '64.0', LLOD_INIT: '0.0', DETAIL: 3, WATER: 3, FOAM: 1, REFL: 7 },
    });
    this._terrainGeo = new THREE.BufferGeometry();
    this.terrain = new THREE.Mesh(this._terrainGeo, this._terrainMat);
    this.terrain.frustumCulled = false; this.terrain.matrixAutoUpdate = false;
    this.terrain.renderOrder = 1;      // after the jets (0), before the sky; also draws the sea surface (camera above water)
    this.terrain.onBeforeRender = (r, s, camera) => this._setCullPlanes(camera);
    scene.add(this.terrain);

    // ---- water disc (follows camera in XZ). Only drawn while the camera is below the surface: otherwise the terrain
    //      draw renders the sea surface itself (no hidden seabed layer under the water).
    this._waterGeo = buildDiscGeometry(24, 1.28, 49000, 96);
    this._waterMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, side: THREE.DoubleSide, fog: false,
      defines: { WATER: 3, FOAM: 1, REFL: 7 },
    });
    this.water = new THREE.Mesh(this._waterGeo, this._waterMat);
    this.water.frustumCulled = false; this.water.renderOrder = 2;
    scene.add(this.water);

    // ---- cloud layer disc
    this._cloudGeo = buildDiscGeometry(300, 1.45, 46000, 64);
    this._cloudMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: WATER_VERT, fragmentShader: CLOUD_FRAG, side: THREE.DoubleSide,
      transparent: true, depthWrite: false, fog: false,
    });
    this.clouds = new THREE.Mesh(this._cloudGeo, this._cloudMat);
    this.clouds.frustumCulled = false; this.clouds.renderOrder = 10;
    scene.add(this.clouds);

    // ---- cloud puffs (positions are generated in the vertex shader from gl_InstanceID)
    this._puffGeo = new THREE.PlaneGeometry(1, 1);
    this._puffMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, side: THREE.DoubleSide,
      transparent: true, depthWrite: false, fog: false,
    });
    this.puffs = new THREE.InstancedMesh(this._puffGeo, this._puffMat, MAX_PUFF_G * MAX_PUFF_G);
    this.puffs.frustumCulled = false; this.puffs.renderOrder = 11;
    scene.add(this.puffs);

    // ---- lights for standard materials (aircraft)
    this.sunLight = new THREE.DirectionalLight(0xffd3a0, 3.0);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(5000);
    scene.add(this.sunLight);
    this.hemiLight = new THREE.HemisphereLight(0x9cc0ea, 0x6f5e46, 0.6);
    scene.add(this.hemiLight);

    // ---- fog for standard materials: haze colour 90° from the sun at the horizon, density tuned for ~800 m altitude
    this.hazeColor = new THREE.Color();
    scene.fog = new THREE.FogExp2(this.hazeColor, U.uFogMie.value * Math.exp(-800 / 1200) + U.uFogRay.value * Math.exp(-800 / 8000));
    this._updateFogColor();

    // ---- environment map from the sky (PMREM)
    this._envRT = null;
    this._buildEnvironment();

    this.setQuality('high');
    this.update(0, null, 0);
  }

  // Recompute the sun-dependent sky terms and rebuild the sky lookup table.
  _updateSky() {
    const U = this.uniforms, s = this.sunDirection;
    U.uSunE.value = sunIntensity(s.y);
    U.uSunFade.value = Math.min(1, Math.max(0, Math.pow(1 - s.y, 5)));
    const sk = this._skyGrade ? this._skyGrade.k : 1, t = this._discTint;
    gradeSkyLut(this._skyLutData, this._skyBase(s.y), U.uSkyScale.value * sk, this._skyGrade);
    this._skyLutTex.needsUpdate = true;
    skyExtinction(s.y, _fex);
    const k = U.uSunDisc.value * U.uSkyScale.value * this._discK;
    U.uSunDiscCol.value.set(_fex[0] * k * t[0], _fex[1] * k * t[1], _fex[2] * k * t[2]);
    this._envDiscCol.copy(U.uSunDiscCol.value).multiplyScalar(0.6 / 40);   // tame disc for reflections
  }

  _updateFogColor() {
    const U = this.uniforms;
    const sd = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const hl = Math.hypot(sd[0], sd[2]) || 1;
    const hz = skyRadianceJS([-sd[2] / hl, 0.0, sd[0] / hl], sd, U.uSunE.value, U.uSkyScale.value * (this._skyGrade ? this._skyGrade.k : 1), this._skyGrade);
    this.hazeColor.setRGB(hz[0], hz[1], hz[2], THREE.LinearSRGBColorSpace);
    if (this.scene.fog && this.scene.fog.color) this.scene.fog.color.copy(this.hazeColor);
  }

  // One-time (per sun change) PMREM environment so the metallic aircraft get sky reflections.
  // The generator, sky material and scene are kept (built once): a time-of-day change re-renders the environment without
  // compiling anything, into the same target: scene.environment keeps its texture, so three never re-keys the programs
  // of every environment-lit material (a new texture there costs a program lookup per material on the next frame).
  // `into` = 'variant' renders a spare target instead (prepareEnvVariant).
  _buildEnvironment(into = null) {
    try {
      const U = this.uniforms;
      if (!this._pmrem) {
        this._pmrem = new THREE.PMREMGenerator(this.renderer);
        // fromScene allocates a new target per call (r170): hand it the kept one instead (sizes never change here)
        const gen = this._pmrem, alloc = gen._allocateTargets, world = this;
        gen._allocateTargets = function () { return world._envInto || alloc.call(this); };
        this._envMat = new THREE.ShaderMaterial({
          uniforms: { uSkyLut: U.uSkyLut, uSunDir: U.uSunDir, uSunDiscCol: { value: this._envDiscCol }, uSkyClouds: { value: 0 } },
          vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
        });
        this._envScene = new THREE.Scene();
        this._envGeo = new THREE.SphereGeometry(50, 24, 12);
        this._envScene.add(new THREE.Mesh(this._envGeo, this._envMat));
      }
      if (into === 'variant') {
        this._envInto = this._envVar ? this._envVar.rt : null;
        const rt = this._pmrem.fromScene(this._envScene, 0, 1, 1000);
        this._envInto = null;
        return rt;
      }
      this._envInto = this._envRT;
      const rt = this._pmrem.fromScene(this._envScene, 0, 1, 1000);
      this._envInto = null;
      if (rt !== this._envRT) {
        if (this._envRT) { if (this.scene.environment === this._envRT.texture) this.scene.environment = null; this._envRT.dispose(); }
        this._envRT = rt;
      }
      this.scene.environment = rt.texture;
      if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = this._envIntensity;
    } catch (e) { this._envInto = null; /* continue without an environment map */ }
    return null;
  }
  /** The environment for lighting key `key`: copied from the prepared variant when it matches (a framebuffer blit on the
   *  GPU, no PMREM passes), else rendered. */
  _refreshEnv(key) {
    const V = this._envVar;
    this._envDefer = 0; this._envStale = false;
    if (V && V.valid && V.key === key && this._envRT) {
      // a framebuffer blit (copyTextureToTexture's copyTexSubImage2D took ~0.5 s on its first float copy on ANGLE/Mesa)
      try {
        const r = this.renderer, gl = r.getContext(), P = r.properties, st = r.state, a = V.rt, b = this._envRT;
        const fa = P.get(a).__webglFramebuffer, fb = P.get(b).__webglFramebuffer;
        if (fa && fb && a.width === b.width && a.height === b.height) {
          st.bindFramebuffer(gl.READ_FRAMEBUFFER, fa); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
          gl.blitFramebuffer(0, 0, a.width, a.height, 0, 0, b.width, b.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
          st.bindFramebuffer(gl.READ_FRAMEBUFFER, null); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          return;
        }
      } catch (e) { /* render it instead */ }
    }
    this._buildEnvironment();
  }
  /**
   * Render now, into a spare target, the environment of preset P, so that a later setLighting(P) copies it instead of
   * running PMREM: the Glassfall's fully red end state (js/glassfall.js prepare, at mission load) and the next INFINITY
   * round's preset (during the intermission). The light direction and sky table are swapped in for the render and
   * restored before returning (nothing is drawn in between). One spare target: the latest call wins.
   */
  prepareEnvVariant(P) {
    const key = this._lightingKeyFor(P);
    if (this._envVar && this._envVar.key === key && this._envVar.valid) return true;
    const dir = this.sunDirection, keep = _prepV.copy(dir), sameDir = key.split('|')[0] === this._lightingKey.split('|')[0];
    const grade = this._skyGrade, dk = this._discK, dt = this._discTint;
    if (!sameDir) this._sunVec(P.sun, dir);   // (uSunDir shares this vector)
    this._skyGrade = this._isDaySky(P.sky) ? null : P.sky; this._discK = P.disc.k; this._discTint = P.disc.tint;
    this._updateSky();
    const rt = this._buildEnvironment('variant');
    dir.copy(keep);
    this._skyGrade = grade; this._discK = dk; this._discTint = dt;
    this._updateSky();
    if (!rt) return false;
    this._envVar = { key, rt, valid: true };
    return true;
  }
  /** Spend up to `ms` on the queued lighting bakes now (the INFINITY intermission, where idle callbacks may not come). */
  bakeTick(ms) { if (this._bakeJob || this._bakeQueue.length) this._bakeStep(performance.now() + ms); }
  /** Bring a stale environment (setLighting env = false) up to date now. */
  refreshEnvironment() { if (this._envStale) this._refreshEnv(this._lightingKey); }
  _isDaySky(g) { return g.k === 1 && g.sat === 1 && !g.base[0] && !g.base[1] && !g.base[2] && g.tint[0] === 1 && g.tint[1] === 1 && g.tint[2] === 1; }
  _lightingKeyFor(P) { return P.sun.elev + '/' + P.sun.az + '|' + JSON.stringify(P.sky) + '|' + JSON.stringify(P.disc); }

  // ---- idle-time lighting bakes: the terrain shadow and the ungraded sky table of each time-of-day light direction,
  // a few rows at a time while the browser is idle (title screen, menus, spare frame time), so the first use of a preset
  // (a mission load, an INFINITY round, M15's or M20's sky) copies cached data instead of baking for 80-250 ms. A use
  // before its bake finished completes the remaining rows at once.
  /** Queue the bakes for a light direction { elev, az } (degrees), as a preset names it. */
  queueLighting(sun, first = false) {
    const key = sun.elev + '/' + sun.az;
    if (this._shadowCache.has(key) && this._lutBase.has(lutKey(this._sunY(sun)))) return;
    if (this._bakeJob && this._bakeJob.key === key) return;
    const i = this._bakeQueue.findIndex((q) => q.key === key);
    if (i >= 0) { if (!first) return; this._bakeQueue.splice(i, 1); }
    if (first) this._bakeQueue.unshift({ key, sun }); else this._bakeQueue.push({ key, sun });
    this._scheduleBake();
  }
  _sunVec(sun, out) {
    const el = sun.elev * Math.PI / 180, az = sun.az * Math.PI / 180;
    return out.set(-Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
  }
  _sunY(sun) { return this._sunVec(sun, _bakeV).y; }
  _scheduleBake() {
    if (this._bakeTimer || (!this._bakeJob && !this._bakeQueue.length)) return;
    const run = (deadline) => {
      this._bakeTimer = 0;
      // idle callback: its remaining idle time (less a margin); a timed-out one or the setTimeout fallback: 2 ms
      const left = deadline && !deadline.didTimeout ? deadline.timeRemaining() - 1 : 2;
      if (left > 0.5) this._bakeStep(performance.now() + Math.min(left, 8));
      this._scheduleBake();
    };
    this._bakeTimer = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 50);
  }
  /** Bake until `until` (performance.now()); true when nothing is left. */
  _bakeStep(until) {
    for (;;) {
      let J = this._bakeJob;
      if (!J) {
        const q = this._bakeQueue.shift();
        if (!q) return true;
        const d = this._sunVec(q.sun, _bakeV), sy = d.y;
        J = this._bakeJob = { key: q.key, sy, shadow: this._shadowCache.has(q.key) ? null : shadowJob([d.x, d.y, d.z]),
          lut: this._lutBase.has(lutKey(sy)) ? null : new Float32Array(SKY_LUT_W * SKY_LUT_H * 4), row: 0 };
      }
      if (J.shadow && shadowJobStep(this._height, J.shadow, until)) { this._shadowCache.set(J.key, J.shadow.ch); J.shadow = null; }
      while (!J.shadow && J.lut && performance.now() <= until) {
        const sunE = sunIntensity(J.sy), fade = Math.min(1, Math.max(0, Math.pow(1 - J.sy, 5)));
        buildSkyLutRows(J.lut, sunE, fade, J.row, J.row + 1);
        if (++J.row >= SKY_LUT_H) { this._setLutBase(J.sy, J.lut); J.lut = null; }
      }
      if (J.shadow || J.lut) return false;
      this._bakeJob = null;
      if (performance.now() > until) return !this._bakeQueue.length;
    }
  }
  /** Finish the in-progress bake now if it is for light direction `key` (a use before its idle bake completed). */
  _finishBake(key) {
    const J = this._bakeJob;
    if (!J || J.key !== key || !J.shadow) return;
    shadowJobStep(this._height, J.shadow, Infinity);
    this._shadowCache.set(J.key, J.shadow.ch); J.shadow = null;
    if (!J.lut) this._bakeJob = null;
  }
  _setLutBase(sy, lut) {
    if (this._lutBase.size >= 12) this._lutBase.delete(this._lutBase.keys().next().value);   // (setSunDirection: any height)
    this._lutBase.set(lutKey(sy), lut);
  }
  /** Ungraded sky table for sun height sy: cached, else built now. */
  _skyBase(sy) {
    let b = this._lutBase.get(lutKey(sy));
    if (b) return b;
    const J = this._bakeJob;
    if (J && lutKey(J.sy) === lutKey(sy) && J.lut) {   // the idle bake is on it: finish its rows
      const sunE = sunIntensity(sy), fade = Math.min(1, Math.max(0, Math.pow(1 - sy, 5)));
      buildSkyLutRows(J.lut, sunE, fade, J.row, SKY_LUT_H); b = J.lut; J.lut = null; J.row = SKY_LUT_H;
      if (!J.shadow) this._bakeJob = null;
    } else {
      b = new Float32Array(SKY_LUT_W * SKY_LUT_H * 4);
      buildSkyLutRows(b, this.uniforms.uSunE.value, this.uniforms.uSunFade.value);
    }
    this._setLutBase(sy, b);
    return b;
  }

  // World-space frustum planes of the camera that is about to draw the terrain (vertex-shader culling).
  _setCullPlanes(camera) {
    const U = this.uniforms;
    U.uCullCfg.value.x = this.cullTerrain && camera && camera.isPerspectiveCamera ? 1 : 0;
    if (!U.uCullCfg.value.x) return;
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    for (let i = 0; i < 5; i++) {
      const pl = _frustum.planes[CULL_PLANES[i]];
      U.uCull.value[i].set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant);
    }
  }

  /**
   * Rendering quality: 'low' | 'medium' | 'high' | 'ultra'. Callable at any time (shader variants recompile once and
   * are cached by three; the terrain grid is rebuilt when its density changes). `overrides` (optional, for testing)
   * replaces individual preset fields: { levels, cell0, detail, water, foam, refl, puffG }.
   */
  setQuality(q, overrides = null) {
    if (!QUALITY[q] || (q === this.quality && !overrides)) return;
    const cfg = overrides ? Object.assign({}, QUALITY[q], overrides) : QUALITY[q];
    this.quality = q;
    const key = cfg.levels.join(',') + '/' + cfg.cell0;
    if (key !== this._gridKey) {
      const old = this._terrainGeo;
      this._terrainGeo = buildClipmapGeometry(cfg.levels);
      this.terrain.geometry = this._terrainGeo;
      if (old) old.dispose();
      this._gridKey = key;
      this._cell0 = cfg.cell0;
    }
    const td = this._terrainMat.defines;
    const lods = cfg.levels.map((m, L) => f(cfg.peaks ? +Math.max(-1, Math.log2(cfg.cell0 * (1 << L) / HM_STEP) + MAXMIP_BIAS).toFixed(3) : -1));
    Object.assign(td, { NLEV: cfg.levels.length, CELL0: f(cfg.cell0), LHALF_INIT: cfg.levels.map((m) => f(m / 2)).join(','),
      LLOD_INIT: lods.join(','), DETAIL: cfg.detail, WATER: cfg.water, FOAM: cfg.foam, REFL: cfg.refl });
    this._terrainMat.needsUpdate = true;
    Object.assign(this._waterMat.defines, { WATER: cfg.water, FOAM: cfg.foam, REFL: cfg.refl });
    this._waterMat.needsUpdate = true;
    this.puffs.count = cfg.puffG * cfg.puffG;
    this.uniforms.uPuffG.value = cfg.puffG;
  }

  // Re-center everything on the camera, advance animation.
  update(dt, camera, time) {
    if (typeof time === 'number' && isFinite(time)) this.time = time; else this.time += (dt || 0);
    const U = this.uniforms;
    U.uTime.value = this.time;
    if (camera) camera.getWorldPosition(_camPos); else _camPos.set(0, 800, 0);
    if (this._shadowKey) { if (--this._shadowWait <= 0) this._flushShadow(); }   // (setLighting ran this frame: wait one)
    else if (this._envDefer > 0 && --this._envDefer === 0) this._refreshEnv(this._lightingKey);
    this.sky.position.copy(_camPos);
    for (let L = 0; L < MAX_LEVELS; L++) {
      const q = 2 * this._cell0 * (1 << L);
      this._origins[L].set(Math.floor(_camPos.x / q + 0.5) * q, Math.floor(_camPos.z / q + 0.5) * q);
    }
    this.water.position.set(_camPos.x, SEA_LEVEL, _camPos.z);
    this.water.visible = _camPos.y <= 0.5;                 // above water the terrain draw renders the sea surface
    this.clouds.position.set(_camPos.x, this.cloudAltitude, _camPos.z);
    // below the layer the sky shader composites the clouds (they can only be seen against the sky from there);
    // above it the cloud mesh blends them over the terrain
    const below = _camPos.y < this.cloudAltitude;
    U.uSkyClouds.value = below ? 1 : 0;
    this.clouds.visible = !below;
    U.uCloudAlt.value = this.cloudAltitude;
    // cloud drift as a wrapped texture offset (keeps texture coordinates small for long sessions)
    const ox = CLOUD_WIND[0] * this.time / CLOUD_TILE, oz = CLOUD_WIND[1] * this.time / CLOUD_TILE;
    U.uCloudOff.value.set(ox - Math.floor(ox), oz - Math.floor(oz));
    U.uCamCell.value.set(Math.floor(_camPos.x / PUFF_CELL), Math.floor(_camPos.z / PUFF_CELL));
  }

  // Terrain height (m) at world XZ — bilinear on the same data the GPU draws.
  getHeight(x, z) { return sampleHeightCPU(this._height, x, z); }

  // Terrain normal at world XZ (finite differences of getHeight), written to `out`.
  getNormal(x, z, out) {
    const e = HM_STEP * 0.5;
    const dx = this.getHeight(x - e, z) - this.getHeight(x + e, z);
    const dz = this.getHeight(x, z - e) - this.getHeight(x, z + e);
    return out.set(dx, 2 * e, dz).normalize();
  }

  // Rough cloud density 0..1 (same coverage field the GPU draws; vertical falloff ±260 m around the layer).
  cloudDensityAt(x, y, z) {
    const dy = (y - this.cloudAltitude) / 260;
    const vert = 1 - dy * dy;
    if (vert <= 0) return 0;
    const c = cloudFbmCPU(x, z, this.time);
    const cut = this.uniforms.uCloudCut.value;
    const t = Math.min(1, Math.max(0, (c - cut) / 0.32));
    return t * t * (3 - 2 * t) * vert;
  }

  // Move the sun. Updates sky LUT/lights/fog/environment; re-bakes the terrain shadow channel (~100 ms) unless rebake=false.
  /** After a WebGL context loss + restore: GPU-baked textures and the environment map must be rendered again. */
  restoreGPU() {
    try {
      const r = this.renderer;
      bakeTexture(r, DETAIL_N, BAKE_DETAIL_FRAG, 2, THREE.RepeatWrapping, this._detailRT);
      bakeTexture(r, CLOUD_TEX_N, BAKE_CLOUD_FRAG, 4, THREE.RepeatWrapping, this._cloudRT);
      bakeTexture(r, BIOME_N, BAKE_BIOME_FRAG, 1, THREE.ClampToEdgeWrapping, this._biomeRT);
      bakeTexture(r, WAVE_N, BAKE_WAVE_FRAG, 1, THREE.RepeatWrapping, this._waveRT);
      if (this._envVar) this._envVar.valid = false;   // (its contents went with the context)
      this._buildEnvironment();
    } catch (e) { console.warn('world GPU restore failed', e); }
  }
  setSunDirection(dir, rebake = true) {
    this.sunDirection.copy(dir).normalize();
    this._updateSky();
    this._updateFogColor();
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(5000);
    if (rebake) {
      bakeSunShadow(this._height, this._aux, [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z]);
      this.auxTexture.needsUpdate = true;
      this._buildEnvironment();
    }
  }

  /**
   * Time-of-day lighting (js/timeofday.js preset): light direction and colours, ambient, sky grade, sun / moon disc,
   * stars, fog, cloud coverage and tint, sea tint and sun-path strength, aircraft lights and environment intensity,
   * ground lights. Values only, nothing per frame. When the light direction changes the terrain shadow channel is
   * swapped in (cached per direction; queueLighting bakes the presets' directions in idle time, else it bakes here) and
   * the environment map is re-rendered into the same target; when only the sky grade changes, the sky table is re-graded
   * from the cached ungraded one (no scattering model) and the environment follows. The day preset reproduces the
   * defaults.
   * env: true re-renders the environment (or copies a matching prepareEnvVariant) now; 'defer' moves the terrain shadow
   * swap to the next frame and the environment two frames after that (an INFINITY round change: the round's spawns,
   * the shadow upload and the environment land on different frames); false leaves it
   * stale until a later call with env = true (the Glassfall's intermediate sky steps).
   */
  setLighting(P, env = true) {
    const U = this.uniforms, v3 = (u, a) => u.value.set(a[0], a[1], a[2]);
    v3(U.uSunColor, P.sunColor); v3(U.uSkyAmb, P.skyAmb); v3(U.uGroundAmb, P.groundAmb);
    U.uFogMie.value = 8.0e-5 * P.fog; U.uFogRay.value = 0.7e-5 * P.fog;
    if (this.scene.fog) this.scene.fog.density = U.uFogMie.value * Math.exp(-800 / 1200) + U.uFogRay.value * Math.exp(-800 / 8000);
    U.uCloudCut.value = P.clouds.cut; v3(U.uCloudTint, P.clouds.tint); U.uPuffK.value = P.clouds.puff;
    v3(U.uWaterTint, P.water.tint); U.uSpecK.value = P.water.spec;
    U.uStars.value = P.stars;
    this.sunLight.color.setHex(P.light.color); this.sunLight.intensity = P.light.intensity;
    this.hemiLight.color.setHex(P.hemi.sky); this.hemiLight.groundColor.setHex(P.hemi.ground); this.hemiLight.intensity = P.hemi.intensity;
    this._envIntensity = P.env;
    if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = P.env;
    if (P.lights.ground > 0 && !this.groundLights) this._buildGroundLights();
    if (this.groundLights) this.groundLights.visible = P.lights.ground > 0;

    const el = P.sun.elev * Math.PI / 180, az = P.sun.az * Math.PI / 180;
    const dirKey = P.sun.elev + '/' + P.sun.az;
    const g = P.sky, isDay = this._isDaySky(g);
    const key = this._lightingKeyFor(P);
    if (key === this._lightingKey) { if (env === true && this._envStale) this._refreshEnv(key); else if (env === 'defer' && this._envStale) this._envDefer = 2; return; }
    const prevDir = this._lightingKey ? this._lightingKey.split('|')[0] : SUN_DEFAULT_KEY, dirChanged = prevDir !== dirKey;
    this._lightingKey = key;
    this._skyGrade = isDay ? null : g;
    this._discK = P.disc.k; this._discTint = P.disc.tint;
    const t0 = performance.now();
    if (dirChanged) {
      this.sunDirection.set(-Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
      this.sunLight.position.copy(this.sunDirection).multiplyScalar(5000);
      this._flushShadow();                 // (a still-deferred change first: aux must hold prevDir's channel)
      if (env === 'defer') { this._shadowKey = dirKey; this._shadowPrev = prevDir; this._shadowWait = 2; }   // next frame
      else this._applyShadow(dirKey, prevDir);
    }
    const t1 = performance.now();
    this._updateSky();
    this._updateFogColor();
    const t2 = performance.now();
    // env: true renders (or copies) the environment now, 'defer' two frames later (World.update: the shadow and sky
    // uploads and the environment passes land on different frames), false leaves it stale until a later call
    this._envStale = true; this._envDefer = 0;
    if (env === 'defer') this._envDefer = 2;
    else if (env) this._refreshEnv(key);
    this.lightingMs = { shadow: +(t1 - t0).toFixed(1), sky: +(t2 - t1).toFixed(1), env: +(performance.now() - t2).toFixed(1) };
  }
  _flushShadow() { if (this._shadowKey) { const k = this._shadowKey; this._shadowKey = null; this._applyShadow(k, this._shadowPrev); } }
  /** Terrain shadow channel for the current light direction: from the cache, else baked (~100 ms) and cached. */
  _applyShadow(dirKey, prevDir) {
    const aux = this._aux, n = HM_N * HM_N, C = this._shadowCache;
    if (!C.has(prevDir)) { const keep = new Uint8Array(n); for (let i = 0; i < n; i++) keep[i] = aux[i * 4 + 2]; C.set(prevDir, keep); }
    this._finishBake(dirKey);
    let ch = C.get(dirKey);
    if (!ch) {
      const job = shadowJob([this.sunDirection.x, this.sunDirection.y, this.sunDirection.z]);
      shadowJobStep(this._height, job, Infinity);
      C.set(dirKey, ch = job.ch);
    }
    for (let i = 0; i < n; i++) aux[i * 4 + 2] = ch[i];
    this.auxTexture.needsUpdate = true;
  }
  /** Settlement / harbour lights (night presets): static sprites on low, gentle land, clustered by a noise field and
   *  thickest near the coast. Built once on first use, ~2-3k points, one draw call while visible. */
  _buildGroundLights() {
    const pts = [], seeds = [], STEP = 80, MAX = 3200;
    for (let z = -WORLD_HALF; z <= WORLD_HALF && pts.length < MAX * 3; z += STEP) {
      for (let x = -WORLD_HALF; x <= WORLD_HALF; x += STEP) {
        const r = ihash(Math.round(x / STEP) + 4000, Math.round(z / STEP) + 9000);
        const jx = x + (r - 0.5) * STEP * 0.9, jz = z + (((r * 7919) % 1) - 0.5) * STEP * 0.9;
        const h = this.getHeight(jx, jz);
        if (h < 2.5 || h > 420) continue;
        const slope = Math.abs(this.getHeight(jx + 30, jz) - this.getHeight(jx - 30, jz)) + Math.abs(this.getHeight(jx, jz + 30) - this.getHeight(jx, jz - 30));
        if (slope > 16) continue;
        const town = gnoise(jx / 2600 + 41.3, jz / 2600 - 17.9) + 0.45 * gnoise(jx / 600 - 3.3, jz / 600 + 8.1);
        const coast = h < 40 ? 0.3 : 0;
        const dens = sstep(0.42, 0.85, town + coast);
        if (((r * 104729) % 1) > dens * 0.8) continue;
        pts.push(jx, h + 3, jz); seeds.push((r * 31337) % 1);
      }
    }
    let n = pts.length / 3;
    if (n > MAX) { n = MAX; pts.length = MAX * 3; seeds.length = MAX; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: GLIGHT_VERT, fragmentShader: GLIGHT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const pl = new THREE.Points(geo, mat);
    pl.name = 'groundLights'; pl.frustumCulled = false; pl.renderOrder = 12; pl.matrixAutoUpdate = false;
    pl.onBeforeRender = (r) => { const rt = r.getRenderTarget(); this.uniforms.uViewportH.value = rt ? rt.height : r.getDrawingBufferSize(_vpS).y; };
    this.groundLights = pl; this._glGeo = geo; this._glMat = mat;
    this.groundLightCount = n;
    this.scene.add(pl);
  }

  dispose() {
    const s = this.scene;
    if (this.groundLights) { s.remove(this.groundLights); this._glGeo.dispose(); this._glMat.dispose(); this.groundLights = null; }
    for (const m of [this.sky, this.terrain, this.water, this.clouds, this.puffs]) s.remove(m);
    s.remove(this.sunLight); s.remove(this.hemiLight);
    for (const g of [this._skyGeo, this._terrainGeo, this._waterGeo, this._cloudGeo, this._puffGeo]) if (g) g.dispose();
    for (const m of [this._skyMat, this._terrainMat, this._waterMat, this._cloudMat, this._puffMat]) m.dispose();
    this.heightTexture.dispose(); this._heightLinTex.dispose(); this.auxTexture.dispose(); this._skyLutTex.dispose();
    this._detailRT.dispose(); this._cloudRT.dispose(); this._biomeRT.dispose(); this._waveRT.dispose();
    if (this.puffs.dispose) this.puffs.dispose();
    if (this._envRT) { if (s.environment === this._envRT.texture) s.environment = null; this._envRT.dispose(); this._envRT = null; }
    if (this._envVar) { this._envVar.rt.dispose(); this._envVar = null; }
    if (this._bakeTimer) { (typeof requestIdleCallback === 'function' ? cancelIdleCallback : clearTimeout)(this._bakeTimer); this._bakeTimer = 0; }
    this._bakeQueue.length = 0; this._bakeJob = null;
    if (this._pmrem) { this._pmrem.dispose(); this._envMat.dispose(); this._envGeo.dispose(); this._pmrem = null; }
    if (s.fog) s.fog = null;
  }
}
