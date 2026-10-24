#!/usr/bin/env node
// Unit checks for js/quality.js: guessTier on real WebGL renderer strings (as Chrome reports them on Android, desktop
// and with ANGLE), the StepDown rule with forced slow frames, and the preset table. usage: node tools/quality_check.mjs
import { guessTier, StepDown, PRESETS, TIERS, CHOICES } from '../js/quality.js';

let fails = 0, n = 0;
const check = (name, ok, info) => { n++; if (!ok) { fails++; console.log('FAIL ' + name + (info !== undefined ? ' :: ' + JSON.stringify(info) : '')); } };

const TABLE = [
  // budget Android: the weakest start on VERY LOW
  ['PowerVR Rogue GE8320', 'verylow'], ['PowerVR Rogue GE8322', 'verylow'], ['PowerVR Rogue GE8300', 'verylow'],
  ['PowerVR Rogue GE8100', 'verylow'], ['PowerVR SGX 544MP', 'verylow'],
  ['ANGLE (Imagination Technologies, PowerVR Rogue GE8320, OpenGL ES 3.2)', 'verylow'],
  ['Mali-G52', 'verylow'], ['Mali-G52 MC1', 'verylow'], ['Mali-G57', 'verylow'], ['Mali-G57 MC1', 'verylow'],
  ['Mali-G31 MC2', 'verylow'], ['Mali-G51', 'verylow'], ['Mali-G51 MP4', 'verylow'],
  ['Mali-T830', 'verylow'], ['Mali-T720', 'verylow'], ['Mali-T860 MP2', 'verylow'], ['Mali-450 MP', 'verylow'],
  ['Adreno (TM) 308', 'verylow'], ['Adreno (TM) 306', 'verylow'], ['Adreno (TM) 405', 'verylow'], ['Adreno (TM) 505', 'verylow'],
  ['Vivante GC7000UL', 'verylow'],
  ['Google SwiftShader', 'verylow'], ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'verylow'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'verylow'],
  ['ANGLE (ARM, Mali-G57, OpenGL ES 3.2)', 'verylow'], ['ARM, Mali-G57, OpenGL ES 3.2', 'verylow'],
  // Firefox for Android: sanitized buckets
  ['Mali-G51, or similar', 'verylow'], ['Mali-T, or similar', 'verylow'], ['PowerVR SGX 540, or similar', 'verylow'],
  ['Adreno (TM) 610, or similar', 'low'], ['Adreno (TM) 540, or similar', 'low'], ['Adreno (TM) 650, or similar', 'medium'],
  ['Mali-G76, or similar', 'medium'], ['Apple M1, or similar', 'high'], ['Intel(R) HD Graphics 400, or similar', 'medium'],
  ['Mali-400 MP, or similar', 'verylow'],
  // slightly better budget chips: LOW
  ['Mali-G52 MC2', 'low'], ['Mali-G57 MC2', 'low'], ['Mali-G57 MC3', 'low'], ['Mali-G52 MC3', 'low'],
  ['ANGLE (ARM, Mali-G52 MC2, OpenGL ES 3.2)', 'low'],
  ['ANGLE (ARM, Vulkan 1.1.177 (Mali-G57 MC2 (0x74021000)), Mali-G57 MC2)', 'low'],
  ['PowerVR Rogue GM9446', 'low'], ['PowerVR Rogue GX6250', 'low'], ['PowerVR B-Series BXE-4-32', 'low'],
  ['Adreno (TM) 610', 'low'], ['Adreno (TM) 612', 'low'], ['Adreno (TM) 613', 'low'], ['Adreno (TM) 506', 'low'],
  ['Adreno (TM) 508', 'low'], ['Adreno (TM) 512', 'low'], ['Adreno (TM) 540', 'low'], ['Adreno (TM) 418', 'low'],
  ['Adreno (TM) 616', 'low'], ['ANGLE (Qualcomm, Adreno (TM) 610, OpenGL ES 3.2)', 'low'],
  // better mobile GPUs stay on MEDIUM
  ['Mali-G72', 'medium'], ['Mali-G72 MP3', 'medium'], ['Mali-G76 MC4', 'medium'], ['Mali-G77 MC9', 'medium'],
  ['Mali-G78 MP20', 'medium'], ['Mali-G68 MC4', 'medium'], ['Mali-G610 MC6', 'medium'], ['Mali-G710 MC10', 'medium'],
  ['Immortalis-G715', 'medium'],
  ['Adreno (TM) 618', 'medium'], ['Adreno (TM) 619', 'medium'], ['Adreno (TM) 640', 'medium'], ['Adreno (TM) 650', 'medium'],
  ['Adreno (TM) 660', 'medium'], ['Adreno (TM) 730', 'medium'], ['Adreno (TM) 740', 'medium'], ['Adreno (TM) 830', 'medium'],
  ['ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', 'medium'],
  ['Apple GPU', 'medium'],
  // desktop, unchanged
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['D3D12 (Intel(R) Iris(R) Xe Graphics)', 'medium'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['Apple M1', 'high'], ['', 'high'],
];
for (const [s, want] of TABLE) { const got = guessTier(s); check(`guessTier(${JSON.stringify(s)}) = ${want}`, got === want, got); }

// presets
check('TIERS lowest first, VERY LOW below LOW', TIERS.join() === 'verylow,low,medium,high,ultra', TIERS);
check('CHOICES', CHOICES.join() === 'auto,verylow,low,medium,high,ultra', CHOICES);
for (const t of TIERS) check(`preset ${t}`, PRESETS[t] && PRESETS[t].scaleMin <= PRESETS[t].scaleMax && PRESETS[t].sub === t, PRESETS[t]);
check('VERY LOW: label, no MSAA, pixel ratio 1, scale 0.45-0.6', PRESETS.verylow.label === 'VERY LOW' && PRESETS.verylow.samples === 0 && PRESETS.verylow.dprCap === 1 && PRESETS.verylow.scaleMin === 0.45 && PRESETS.verylow.scaleMax === 0.6);

// StepDown: simulate frames (dt = clamped game step, ms = raw interval)
function run(sd, seconds, ms, atMin = true) { let t = 0, fired = -1; while (t < seconds) { const dt = Math.min(ms, 50) / 1000; if (sd.update(dt, ms, atMin) && fired < 0) fired = t; t += ms / 1000; } return fired; }
{ const sd = new StepDown(); const f = run(sd, 20, 40); check('slow frames (40 ms) at min scale step down after grace + ~4 s', f > 6 + 4 && f < 6 + 4 + 2.5, f); }
{ const sd = new StepDown(); check('25 ms frames never step down', run(sd, 30, 25) < 0); }
{ const sd = new StepDown(); check('slow frames above the min scale never step down', run(sd, 30, 40, false) < 0); }
{ const sd = new StepDown(); check('nothing inside the grace period', run(sd, 6, 60) < 0); }
{ const sd = new StepDown(); run(sd, 7, 16); let f = -1, t = 0;   // after grace: 3 s slow, 1 s fast, 3 s slow: no trigger
  for (const [secs, ms] of [[3, 40], [1, 16], [3, 40]]) { const g = run(sd, secs, ms); if (g >= 0 && f < 0) f = t + g; t += secs; }
  check('slow spells shorter than 4 s do not step down', f < 0, f); }
{ const sd = new StepDown(); run(sd, 7, 16); let fired = false;     // single load hitches (> 250 ms) are ignored
  for (let k = 0; k < 40; k++) { fired = sd.update(0.05, 900, true) || fired; for (let j = 0; j < 5; j++) fired = sd.update(0.016, 16, true) || fired; }
  check('isolated long hitches never step down', !fired); }
{ const sd = new StepDown(); run(sd, 20, 40); sd.reset(); check('reset re-arms the grace period', run(sd, 5, 40) < 0); }

console.log(fails ? `QUALITY_FAIL ${fails}/${n}` : `QUALITY_OK ${n} checks (${TABLE.length} renderer strings)`);
process.exit(fails ? 1 : 0);
