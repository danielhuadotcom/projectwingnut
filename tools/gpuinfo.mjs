import puppeteer from 'puppeteer-core';
const args = ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', ...(process.argv.slice(2))];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args, env: { ...process.env, GALLIUM_DRIVER: 'd3d12' }, dumpio: false });
try {
  const page = await browser.newPage();
  await page.goto('chrome://gpu', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  const text = await page.evaluate(() => {
    const host = document.querySelector('info-view');
    const root = host && host.shadowRoot ? host.shadowRoot : document;
    return root.body ? root.body.innerText : (root.innerText || root.textContent || '');
  });
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const keep = lines.filter(l => /WebGL|Canvas|Rasterization|GPU process|crash|ANGLE|GL_RENDERER|GL_VENDOR|Disabled|Software only|Hardware accelerated|Problems|ERROR|error|EGL|context|Lost/i.test(l));
  console.log(keep.slice(0, 60).join('\n'));
} catch (e) { console.log('error', e.message); }
finally { await browser.close().catch(() => {}); }
