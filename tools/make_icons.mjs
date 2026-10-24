#!/usr/bin/env node
// Home-screen icons: renders icons/*.png from inline SVG in headless Chrome (no external assets). The PNGs are committed,
// so CI never needs Chrome; rerun this only when the art changes. usage: node tools/make_icons.mjs
// Art: the title screen's jet silhouette (test_menu.html's stand-in scene uses the same path), climbing to the upper
// right inside a HUD reticle with corner brackets, in the cockpit palette of src/page.html (--bg #04070d, --hud #9cebff,
// --pale #eafbff). Outputs:
//   icon-192.png, icon-512.png   purpose "any": rounded square, transparent corners
//   icon-maskable-512.png        purpose "maskable": full bleed, all art inside the central 80% safe-zone circle
//   apple-touch-icon.png         180x180, full bleed and opaque (iOS applies its own mask; transparency turns black)
// Also writes a preview sheet to $WINGNUT_TMP/icons_preview.png showing each icon, the maskable one under circle and
// squircle masks, and the safe-zone circle.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireChromeLock, WINGNUT_TMP } from './lock.mjs';

const JET = 'M2 21 L46 17 L60 4 L67 4 L62 17 L96 16 L112 7 L117 8 L111 19 L118 21 L111 23 L117 32 L112 33 L96 25 L62 24 L67 37 L60 37 L46 24 L2 21 Z';

// One 512-unit SVG. `art` scales the emblem about the centre (maskable shrinks it into the safe zone); `radius` rounds the
// background square (0 = full bleed).
function svg({ art = 1, radius = 0 }) {
  const bracket = (x, y, dx, dy) => `<path d="M${x} ${y + dy * 64} V${y} H${x + dx * 64}"/>`;
  const C = 72, D = 512 - C; // bracket corners at art = 1
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#12304a"/><stop offset="0.55" stop-color="#081422"/><stop offset="1" stop-color="#04070d"/>
    </radialGradient>
    <linearGradient id="jet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.12" stop-color="#ffffff"/><stop offset="0.58" stop-color="#d6f4ff"/><stop offset="1" stop-color="#8fd9ff"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feColorMatrix in="b" values="0 0 0 0 0.61  0 0 0 0 0.92  0 0 0 0 1  0 0 0 0.75 0"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${art}) translate(-256 -256)">
    <!-- HUD reticle: ring, tick marks and a horizon line -->
    <g fill="none" stroke="#9cebff" stroke-linecap="round">
      <circle cx="256" cy="256" r="150" stroke-opacity="0.32" stroke-width="5"/>
      <circle cx="256" cy="256" r="118" stroke-opacity="0.16" stroke-width="3" stroke-dasharray="6 14"/>
      <path d="M256 92 V118 M256 394 V420 M92 256 H118 M394 256 H420" stroke-opacity="0.7" stroke-width="7"/>
      <path d="M140 300 H200 M312 300 H372" stroke-opacity="0.3" stroke-width="4"/>
    </g>
    <!-- jet: viewBox 120x40, nose at x=2 (the needle); rotate so it climbs toward the upper right -->
    <g filter="url(#glow)" transform="translate(256 258) rotate(135) scale(2.9) translate(-60 -20.5)">
      <path d="${JET}" fill="url(#jet)"/>
    </g>
  </g>
  <!-- corner brackets (HUD panel corners); scaled with the art so maskable keeps them in the safe zone -->
  <g fill="none" stroke="#9cebff" stroke-width="9" stroke-linecap="square" transform="translate(256 256) scale(${art}) translate(-256 -256)">
    ${bracket(C, C, 1, 1)}${bracket(D, C, -1, 1)}${bracket(C, D, 1, -1)}${bracket(D, D, -1, -1)}
  </g>
</svg>`.replace(/<!--[^]*?-->/g, '');
}

// The bracket corners sit 184 units from the centre on each axis (260 on the diagonal) at art = 1. The maskable safe
// zone is a circle of radius 0.4 * 512 = 204.8, so art = 0.74 puts them at ~193 plus half the stroke: just inside it.
const ICONS = [
  { file: 'icon-192.png', size: 192, opts: { radius: 96 } },
  { file: 'icon-512.png', size: 512, opts: { radius: 96 } },
  { file: 'icon-maskable-512.png', size: 512, opts: { art: 0.74 } },
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
];

mkdirSync('icons', { recursive: true });
const release = await acquireChromeLock('make_icons');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const shot = async (html, w, h) => {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}</style>${html}`, { waitUntil: 'load' });
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  };
  for (const { file, size, opts } of ICONS) {
    const png = await shot(svg(opts).replace('width="512" height="512"', `width="${size}" height="${size}"`), size, size);
    writeFileSync(path.join('icons', file), png);
    console.log(`icons/${file} ${size}x${size} ${(png.length / 1024).toFixed(1)} KB`);
  }
  // Preview sheet: each icon at its size, then the maskable icon under a circle and a squircle mask with the safe zone.
  const img = (f, s, style = '') => `<figure><img src="file://${path.resolve('icons', f)}" width="${s}" height="${s}" style="${style}"><figcaption>${f}</figcaption></figure>`;
  const sheet = `<style>body{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-end;padding:24px;background:#5a6470!important;font:12px monospace;color:#fff}
    figure{margin:0;text-align:center}.safe{position:relative;display:inline-block}.safe::after{content:"";position:absolute;inset:10%;border:2px dashed #ff7a1f;border-radius:50%}</style>
    ${img('icon-192.png', 192)}${img('icon-512.png', 256)}${img('apple-touch-icon.png', 180, 'border-radius:22%')}
    <figure><span class="safe"><img src="file://${path.resolve('icons/icon-maskable-512.png')}" width="256" height="256"></span><figcaption>maskable + safe zone</figcaption></figure>
    ${img('icon-maskable-512.png', 192, 'border-radius:50%')}${img('icon-maskable-512.png', 192, 'border-radius:28%')}${img('icon-192.png', 48)}`;
  const out = path.join(WINGNUT_TMP, 'icons_preview.png'), sheetFile = path.join(WINGNUT_TMP, 'icons_preview.html');
  writeFileSync(sheetFile, `<!doctype html>${sheet}`);
  await page.setViewport({ width: 1180, height: 600, deviceScaleFactor: 1 });
  await page.goto(`file://${sheetFile}`, { waitUntil: 'load' });
  writeFileSync(out, await page.screenshot());
  console.log(`preview ${out}`);
} finally { await browser.close().catch(() => {}); release(); }
