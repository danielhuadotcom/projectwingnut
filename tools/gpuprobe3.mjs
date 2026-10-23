import puppeteer from 'puppeteer-core';
const args = ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', ...process.argv.slice(2)];
for (let run = 0; run < 2; run++) {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args, env: { ...process.env, GALLIUM_DRIVER: 'd3d12' } });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<p>warm</p>');
    const seq = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 8; i++) {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const gl = c.getContext('webgl2', { antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
        out.push(gl && !gl.isContextLost() ? 'ok' : 'X');
        if (gl) { const l = gl.getExtension('WEBGL_lose_context'); l && l.loseContext(); }
        await new Promise(r => setTimeout(r, 250));
      }
      return out.join('');
    });
    console.log(`run ${run} [${process.argv.slice(2).join(' ')}] sequence: ${seq}`);
  } catch (e) { console.log('error', e.message.slice(0, 100)); }
  finally { await browser.close().catch(() => {}); }
}
