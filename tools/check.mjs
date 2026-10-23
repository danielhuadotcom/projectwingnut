#!/usr/bin/env node
// Headless render check. usage: node tools/check.mjs <url> <out.png> [seconds=6] [width=1280] [height=720] [script]
// Prints console messages + page errors, counts rAF frames, saves a screenshot. Always closes Chrome.
// Optional [script]: JS evaluated in the page right after load (e.g. to press keys / set globals).
import puppeteer from 'puppeteer-core';
import { acquireChromeLock, launchWarm } from './lock.mjs';
const [url, out = '/tmp/shot.png', secsArg = '6', w = '1280', h = '720', script = ''] = process.argv.slice(2);
const secs = Number(secsArg);
const release = await acquireChromeLock(url);
const { browser, page } = await launchWarm(puppeteer, w, h);
const hardKill = () => { try { browser.process()?.kill('SIGKILL'); } catch {} release(); };
const killer = setTimeout(() => { console.log('[check] global timeout, killing browser'); hardKill(); process.exit(2); }, (secs + 60) * 1000);
process.on('SIGINT', () => { hardKill(); process.exit(130); }); process.on('SIGTERM', () => { hardKill(); process.exit(143); });
try {
  await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
  page.on('console', m => { const t = m.text(); if (!/SwiftShader|software renderer|GPU stall|Failed to load resource/i.test(t)) console.log(`[console.${m.type()}] ${t.slice(0, 500)}`); });
  page.on('pageerror', e => console.log(`[pageerror] ${String(e && e.message || e).slice(0, 800)}`));
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) console.log(`[http ${r.status()}] ${r.url()}`); });
  page.on('requestfailed', r => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  console.log(`[check] loaded in ${Date.now() - t0} ms`);
  if (script) { try { await page.evaluate(script); } catch (e) { console.log('[check] script error: ' + e.message); } }
  await page.evaluate(() => { window.__frames = 0; const f = () => { window.__frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await new Promise(r => setTimeout(r, secs * 1000));
  const frames = await page.evaluate(() => window.__frames);
  console.log(`[check] ${frames} rAF frames in ${secs}s (${process.env.WINGNUT_SW === '1' ? 'SwiftShader' : 'real GPU: Intel Iris Xe via WSL D3D12'})`);
  if (process.env.WINGNUT_SW === '1') await page.screenshot({ path: out });
  else {
    // GPU path: page.screenshot hangs with --disable-frame-rate-limit, so composite the page's canvases in-page right after a frame
    const dataUrl = await Promise.race([
      page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight;
          const ctx = c.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
          for (const cv of document.querySelectorAll('canvas')) {
            if (cv === c) continue; const r = cv.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) try { ctx.drawImage(cv, r.left, r.top, r.width, r.height); } catch {}
          }
          resolve(c.toDataURL('image/png'));
        }));
      })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('canvas capture timeout')), 15000)),
    ]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log(`[check] screenshot ${out}`);
} catch (e) { console.log('[check] error: ' + (e && e.message)); }
finally { clearTimeout(killer); await browser.close().catch(() => {}); release(); }
