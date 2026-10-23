#!/usr/bin/env node
// Real-GPU benchmark: node tools/perf.mjs [--page dev.html] [--size 1920x1080] [--dur 16] [--warm 4] [--query "q=high"] [--out name]
// Loads <page>?bench=1..., waits for BENCH_RESULT, prints a table and saves JSON to $WINGNUT_TMP.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { acquireChromeLock, launchWarm, WINGNUT_TMP } from './lock.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const page_ = arg('page', 'dev.html'), [w, h] = arg('size', '1920x1080').split('x').map(Number);
const dur = Number(arg('dur', 16)), warm = Number(arg('warm', 4)), extra = arg('query', ''), outName = arg('out', 'perf');
const OUT = WINGNUT_TMP; // $WINGNUT_TMP or <os tmpdir>/wingnut (created by lock.mjs)
const url = `http://127.0.0.1:8765/${page_}?bench=1&dur=${dur}&warm=${warm}${extra ? '&' + extra : ''}`;
const release = await acquireChromeLock('perf ' + url);
const { browser, page } = await launchWarm(puppeteer, w, h);
const hardKill = () => { try { browser.process()?.kill('SIGKILL'); } catch {} release(); };
const killer = setTimeout(() => { console.log('[perf] timeout'); hardKill(); process.exit(2); }, (dur + warm + 90) * 1000);
let result = null;
try {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror] ' + String(e.message || e).slice(0, 300)));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('BENCH_RESULT ')) result = JSON.parse(t.slice(13)); else if (/BENCH_START|error|Error/.test(t) && !/Failed to load resource/.test(t)) console.log('[console] ' + t.slice(0, 300)); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const t0 = Date.now();
  while (!result && Date.now() - t0 < (dur + warm + 60) * 1000) await new Promise((r) => setTimeout(r, 500));
} catch (e) { console.log('[perf] error ' + e.message); }
finally { clearTimeout(killer); await browser.close().catch(() => {}); release(); }
if (!result) { console.log('[perf] no BENCH_RESULT'); process.exit(1); }
writeFileSync(`${OUT}/${outName}.json`, JSON.stringify(result, null, 1));
const f = (s) => (s ? `${s.mean.toFixed(2).padStart(6)} ${s.p95.toFixed(2).padStart(6)}` : '     -      -');
console.log(`\n${result.renderer}\ncss ${result.css.join('x')} internal ${result.internal.join('x')} msaa ${result.msaa} scale ${result.scale} quality ${result.quality || '-'} | draws ${result.drawCalls} tris ${result.triangles} | enemies ${result.enemies} state ${result.state} disjoints ${result.disjoints}`);
console.log(`frame interval ms: mean ${result.frame.mean} p50 ${result.frame.p50} p95 ${result.frame.p95}  (~${(1000 / result.frame.mean).toFixed(0)} fps)`);
console.log('\nGPU passes (ms)        mean    p95');
for (const [k, s] of Object.entries(result.gpuPass)) console.log(`  ${k.padEnd(18)} ${f(s)}`);
console.log('GPU objects (ms)       mean    p95');
for (const [k, s] of Object.entries(result.gpuObject).sort((a, b) => b[1].mean - a[1].mean)) console.log(`  ${k.padEnd(18)} ${f(s)}`);
console.log('CPU (ms)               mean    p95');
for (const [k, s] of Object.entries(result.cpu)) console.log(`  ${k.padEnd(18)} ${f(s)}`);
console.log(`\nsaved ${OUT}/${outName}.json`);
