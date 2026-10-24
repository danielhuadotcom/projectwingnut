#!/usr/bin/env node
// Incoming-missile edge arcs (js/hud.js _drawThreats): scripted directions, the flare fade, HUD cost with 0/2/4 inbound.
// usage: node tools/threattest.mjs [outDir] [width=1280] [height=720]
// Starts mission 1 with an immortal player, launches enemy missiles at the player, and pins each one every frame (just
// before buildFrame) at 1.6 km along a camera-relative direction, closing at 600 m/s. Saves one screenshot per case.
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { acquireChromeLock, launchWarm, WINGNUT_TMP } from './lock.mjs';
const [out = WINGNUT_TMP + '/threats', W = '1280', H = '720'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const url = 'http://127.0.0.1:8765/dev.html';
const release = await acquireChromeLock('threattest');
const { browser, page } = await launchWarm(puppeteer, W, H);
const killer = setTimeout(() => { try { browser.process()?.kill('SIGKILL'); } catch {} release(); process.exit(2); }, 6 * 60 * 1000);
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  const data = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; const x = c.getContext('2d');
    for (const cv of document.querySelectorAll('canvas')) { if (cv === c) continue; const r = cv.getBoundingClientRect(); if (r.width > 0) try { x.drawImage(cv, r.left, r.top, r.width, r.height); } catch {} }
    resolve(c.toDataURL('image/png')); }))));
  writeFileSync(`${out}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
}
try {
  await page.setViewport({ width: +W, height: +H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { errors++; console.log('[pageerror] ' + String(e.message || e).slice(0, 300)); });
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__wingnut && window.__wingnut.menu, { timeout: 60000 });
  await sleep(1500);
  await page.evaluate(() => {
    const g = window.__wingnut; if (g.menu.open && g.menu.hide) g.menu.hide();
    g.applySetting('difficulty', 'normal'); g.loadMission(0); if (g._pending && g._pending.length) g.spawnPending(true); g.player.immortal = true;
    for (const e of g.enemies) e.holdFire = true;
    // pinned test missiles: T.dirs[i] = [right, up, fwd] in the camera frame (null: leave the missile alone)
    const T = window.__thr = { ms: [], dirs: [], dist: 1600 };
    const V = g.player.position.constructor, d = new V(), r = new V(), u = new V(), f = new V();
    const orig = g.buildFrame.bind(g);
    g.buildFrame = (dt) => {
      const e = g.camera.matrixWorld.elements; r.set(e[0], e[1], e[2]); u.set(e[4], e[5], e[6]); f.set(-e[8], -e[9], -e[10]);
      for (let i = 0; i < T.ms.length; i++) {
        const m = T.ms[i], q = T.dirs[i]; if (!m || !q || !m.alive) continue;
        d.set(0, 0, 0).addScaledVector(r, q[0]).addScaledVector(u, q[1]).addScaledVector(f, q[2]).normalize();
        m.position.copy(g.player.position).addScaledVector(d, q[3] || T.dist);
        m.velocity.copy(g.player.velocity).addScaledVector(d, -600); m.forward.copy(d).negate(); m.age = 1; m.target = q[4] === false ? null : g.player;
      }
      orig(dt);
    };
    T.set = (dirs) => {
      for (const m of T.ms) if (m && m.alive) { m.alive = false; }
      T.ms.length = 0; T.dirs.length = 0;
      const sh = T.shooter || (T.shooter = { alive: true, isGround: true, team: 'enemy', hitRadius: 4, position: new V(), velocity: new V() });
      sh.position.copy(g.player.position); sh.position.y += 1500;
      for (const q of dirs) { g.weapons._state(sh).missileReady = 0; sh.missiles = 99; const was = sh.holdFire; sh.holdFire = false; const m = g.weapons.fireMissile(sh, g.player); sh.holdFire = was; if (m) { m.life = 1e9; T.ms.push(m); T.dirs.push(q); } }
      return T.ms.length;
    };
  });
  await sleep(3000);
  const CASES = {
    ahead: [[-0.12, 0.05, 1]], left: [[-1, 0, 0.15]], right: [[1, 0, 0.15]], behind: [[0.15, 0.05, -1]],
    above: [[0, 1, 0.1]], below: [[0, -1, 0.1, 300]],
    close_left: [[-1, 0.2, 0.2, 500]],
    four: [[-1, 0.1, 0.1], [0.9, 0.3, -0.2], [0, -0.3, -1, 700], [0.3, 1, 0.3, 2500]],
  };
  const res = {};
  for (const [name, dirs] of Object.entries(CASES)) {
    const n = await page.evaluate((d) => window.__thr.set(d), dirs);
    await sleep(500);
    res[name] = await page.evaluate(() => window.__wingnut.frame.threats.map((t) => ({ angDeg: Math.round(t.ang * 180 / Math.PI), tti: +t.tti.toFixed(2), fade: +t.fade.toFixed(2) })));
    const alive = await page.evaluate(() => window.__thr.ms.filter((m) => m.alive && m.target === window.__wingnut.player).length + (window.__wingnut.frame.warnings.missileIncoming ? ' WARN' : ' nowarn') + ' ' + window.__wingnut.state);
    console.log(name.padEnd(11), 'spawned', n, 'alive', alive, JSON.stringify(res[name]));
    await shot(name);
  }
  // flare / lost track: the missile stops guiding on the player; its arc fades over ~0.3 s
  await page.evaluate(() => window.__thr.set([[-1, 0, 0.15]]));
  await sleep(500);
  const fade = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__wingnut, T = window.__thr, log = [], t0 = performance.now();
    T.dirs[0][4] = false;   // lost track (flare decoys reassign m.target the same way)
    const step = () => { const th = g.frame.threats; log.push([Math.round(performance.now() - t0), th.length ? +th[0].fade.toFixed(2) : 0]); if (performance.now() - t0 < 450) requestAnimationFrame(step); else resolve(log); };
    requestAnimationFrame(step);
  }));
  console.log('fade (ms, fade):', JSON.stringify(fade.filter((_, i) => i % 3 === 0)));
  await page.evaluate(() => { window.__thr.set([[-1, 0, 0.15]]); });
  await sleep(500);
  await page.evaluate(() => { window.__thr.dirs[0][4] = false; });
  await sleep(150); await shot('decoy_mid');
  // HUD cost: render the current frame N times with 0 / 2 / 4 inbound, normal and budget mode
  for (const budget of [false, true]) {
    await page.evaluate((b) => window.__wingnut.hud.setBudget(b ? 0.75 : 1, false, b), budget);
    for (const n of [0, 2, 4]) {
      const dirs = [[-1, 0, 0.1], [1, 0.2, 0], [0, -0.3, -1], [0.3, 1, 0.3]].slice(0, n);
      await page.evaluate((d) => window.__thr.set(d), dirs);
      await sleep(400);
      const ms = await page.evaluate(() => {
        // median of 7 batches of N renders, each flushed with a 1-pixel readback (so GPU raster time counts too)
        const g = window.__wingnut, N = 100, th = g.frame.threats, A = [], B = [];
        const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
        for (let r = 0; r < 7; r++) {
          let t = performance.now();
          for (let i = 0; i < N; i++) g.hud.render(g.frame);
          g.hud.ctx.getImageData(0, 0, 1, 1); A.push((performance.now() - t) / N);
          t = performance.now();
          for (let i = 0; i < N; i++) { if (th.length) g.hud._drawThreats(th); }
          g.hud.ctx.getImageData(0, 0, 1, 1); B.push((performance.now() - t) / N);
        }
        return [med(A), med(B), th.length];
      });
      console.log(`HUD ${budget ? 'budget' : 'normal'} inbound ${ms[2]}: render ${ms[0].toFixed(3)} ms, arcs ${ms[1].toFixed(3)} ms`);
    }
  }
  await page.evaluate(() => window.__wingnut.hud.setBudget(1, false, false));
  // presets: two missiles (left, behind) against golden, night, the red Glassfall
  for (const [tod, glass] of [['golden', 0], ['night', 0], ['day', 1]]) {
    await page.evaluate((a, b) => { const g = window.__wingnut; g.applyTime(a, b); window.__thr.set([[-1, 0.1, 0.1, 1200], [0.2, 0, -1, 1400]]); }, tod, glass);
    await sleep(800);
    console.log('preset', tod, glass, JSON.stringify(await page.evaluate(() => { const g = window.__wingnut, h = g.hud, k = h.k;
      return [g.frame.threats.map((t) => [Math.round(t.ang * 180 / Math.PI), +t.tti.toFixed(2)]), Array.from(h.ctx.getImageData(2 * k, h.h / 2 * k, 1, 1).data)]; })));
    await shot(`tod_${tod}${glass ? '_glass' : ''}`);
  }
} catch (e) { errors++; console.log('[threattest] error ' + e.message); }
finally { clearTimeout(killer); await browser.close().catch(() => {}); release(); }
console.log(`[threattest] shots in ${out}, page errors: ${errors}`);
