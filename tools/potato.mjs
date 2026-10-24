#!/usr/bin/env node
// Budget-tablet simulation: per quality tier, CPU and GPU frame times in a few heavy scenes at a forced 1280x800 viewport,
// DPR 1, with the renderer main thread CPU-throttled through CDP (Emulation.setCPUThrottlingRate).
// usage: node tools/potato.mjs [--tiers low,verylow] [--throttle 1,4,6] [--warm 6] [--secs 10] [--shots dir] [--scenes m1,..]
//        [--sw2d] (software Canvas2D: --disable-accelerated-2d-canvas, a proxy for Firefox for Android) [--query a=1&b=2]
// GPU times come from EXT_disjoint_timer_query_webgl2 (pass mode). The render scale is pinned to each tier's floor
// (where dynamic resolution sits on a slow GPU). Prints one row per (tier, throttle, scene) and saves JSON to $WINGNUT_TMP.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { acquireChromeLock, launchWarm, WINGNUT_TMP } from './lock.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const tiers = arg('tiers', 'low,verylow').split(','), throttles = arg('throttle', '1,4,6').split(',').map(Number);
const warm = Number(arg('warm', 6)), secs = Number(arg('secs', 10)), shots = arg('shots', '');
const FLOOR = { verylow: 0.45, low: 0.5, medium: 0.6, high: 0.7, ultra: 0.9 };
const SCENES = {
  m1: `g.applySetting('difficulty','normal'); g.loadMission(0);`,
  m6merc: `g.applySetting('difficulty','mercenary'); g.loadMission(5);`,
  m15event: `g.applySetting('difficulty','normal'); g.loadMission(14); for (const e of g.enemies) e.kill(); g.ground.clear(); g.nextPhase();`,
  inf20: `g.applySetting('difficulty','normal'); g.startInfinity(); for (const e of g.enemies) e.kill(); g.ground.clear(); g.infinity.round = 19; g.nextRound();`,
};
const sw2d = process.argv.includes('--sw2d'), extra = arg('query', '');
const only = arg('scenes', Object.keys(SCENES).join(',')).split(',');
const rows = [];
for (const tier of tiers) for (const thr of throttles) {
  const url = `http://127.0.0.1:8765/dev.html?q=${tier}&scale=${FLOOR[tier]}&dpr=1${extra ? '&' + extra : ''}`;
  const release = await acquireChromeLock('potato ' + url);
  const { browser, page } = await launchWarm(puppeteer, 1280, 800, sw2d ? ['--disable-accelerated-2d-canvas'] : []);
  const killer = setTimeout(() => { try { browser.process()?.kill('SIGKILL'); } catch {} release(); process.exit(2); }, 15 * 60 * 1000);
  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.log('[pageerror] ' + String(e.message || e).slice(0, 300)));
    await page.goto(url, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => window.__wingnut && window.__wingnut.menu, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: thr });
    for (const sc of only) {
      await page.evaluate((code) => { const g = window.__wingnut; g.profiler.cpuOn = true; g.hud.prof = {}; if (g.menu.open && g.menu.hide) g.menu.hide(); (new Function('g', code))(g); g.player.immortal = true; }, SCENES[sc]);
      await new Promise((r) => setTimeout(r, warm * 1000));
      await page.evaluate(() => window.__wingnut.profiler.reset());
      await new Promise((r) => setTimeout(r, secs * 1000));
      const res = await page.evaluate(() => { const g = window.__wingnut, s = g.profiler.summary();
        return { s, internal: [g.post.renderWidth, g.post.renderHeight], quality: g.quality, enemies: g.enemies.filter((e) => e.alive).length,
          draws: g.drawCalls, tris: g.triangles, state: g.state, gpu: g.gpuName, hudBuild: g.hudBuildMs, hudDraw: g.hudDrawMs, hudK: g.hud.k, sprites: g.hud.spriteText, hp: g.hud.prof }; });
      const C = res.s.cpu, sum = (k) => ['logic', 'world', 'render', 'hud'].reduce((a, l) => a + ((C[l] && C[l][k]) || 0), 0);
      const G = res.s.gpuPass.__total || { mean: 0, p95: 0 };
      const row = { tier, thr, scene: sc, internal: res.internal.join('x'), cpuMean: +sum('mean').toFixed(2), cpuP95: +sum('p95').toFixed(2),
        logic: C.logic ? C.logic.mean : 0, render: C.render ? C.render.mean : 0, gpuMean: G.mean, gpuP95: G.p95,
        scene3d: res.s.gpuPass.scene ? res.s.gpuPass.scene.mean : 0, bloom: res.s.gpuPass.bloom ? res.s.gpuPass.bloom.mean : 0,
        comp: res.s.gpuPass.composite ? res.s.gpuPass.composite.mean : 0, frame: res.s.frame.mean, frameP95: res.s.frame.p95,
        enemies: res.enemies, draws: res.draws, tris: res.tris, state: res.state, hud: C.hud ? C.hud.mean : 0, hudBuild: res.hudBuild, hudDraw: res.hudDraw, hudK: res.hudK, hp: res.hp };
      rows.push(row);
      console.log(`${tier.padEnd(8)} x${thr} ${sc.padEnd(9)} ${row.internal.padEnd(8)} | CPU ${row.cpuMean.toFixed(2).padStart(6)} p95 ${row.cpuP95.toFixed(2).padStart(6)} (logic ${row.logic.toFixed(2)} render ${row.render.toFixed(2)}) | GPU ${G.mean.toFixed(2).padStart(5)} p95 ${G.p95.toFixed(2).padStart(5)} (scene ${row.scene3d.toFixed(2)} bloom ${row.bloom.toFixed(2)} comp ${row.comp.toFixed(2)}) | frame ${row.frame.toFixed(1)} p95 ${row.frameP95.toFixed(1)} | en ${row.enemies} draws ${row.draws} | HUD ${row.hud.toFixed(2)} (build ${(res.hudBuild || 0).toFixed(2)} draw ${(res.hudDraw || 0).toFixed(2)} @${res.hudK}${res.sprites ? ' spr' : ''}) ${res.state}`);
      if (shots && thr === throttles[0]) {
        const data = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; const x = c.getContext('2d');
          for (const cv of document.querySelectorAll('canvas')) { if (cv === c) continue; const r = cv.getBoundingClientRect(); if (r.width > 0) try { x.drawImage(cv, r.left, r.top, r.width, r.height); } catch {} }
          resolve(c.toDataURL('image/png')); }))));
        writeFileSync(`${shots}/${sc}_${tier}.png`, Buffer.from(data.split(',')[1], 'base64'));
      }
    }
  } catch (e) { console.log('[potato] error ' + e.message); }
  finally { clearTimeout(killer); await browser.close().catch(() => {}); release(); }
}
writeFileSync(`${WINGNUT_TMP}/potato.json`, JSON.stringify(rows, null, 1));
console.log(`saved ${WINGNUT_TMP}/potato.json`);
