import puppeteer from 'puppeteer-core';
const base = ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu'];
const variants = {
  base: [],
  vsync: ['--disable-gpu-vsync'],
  ratelimit: ['--disable-frame-rate-limit'],
  misc: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'],
};
const attrs = [
  ['default', '{}'],
  ['game', "{antialias:false,powerPreference:'high-performance',alpha:false,stencil:false}"],
  ['lowpower', "{antialias:false,powerPreference:'low-power',alpha:false,stencil:false}"],
];
for (const [vn, extra] of Object.entries(variants)) {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [...base, ...extra], env: { ...process.env, GALLIUM_DRIVER: 'd3d12' } });
    const page = await browser.newPage();
    const out = [];
    for (const [an, a] of attrs) {
      const r = await page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const gl = c.getContext('webgl2', ${a}); if (!gl) return 'FAIL'; const e = gl.getExtension('WEBGL_debug_renderer_info'); return (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'ok').slice(0, 60); })()`);
      out.push(`${an}=${r}`);
    }
    console.log(`[${vn}] ${out.join(' | ')}`);
  } catch (e) { console.log(`[${vn}] error ${e.message.slice(0, 100)}`); }
  finally { if (browser) await browser.close().catch(() => {}); }
}
