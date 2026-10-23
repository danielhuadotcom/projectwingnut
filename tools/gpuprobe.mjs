// Probe which WebGL renderer headless Chrome gets with various flags, plus a crude fill-rate test.
import puppeteer from 'puppeteer-core';
const configs = {
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  'angle-gl-egl': ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu'],
  'angle-gl': ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu'],
  'angle-vulkan': ['--use-angle=vulkan', '--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE', '--ignore-gpu-blocklist', '--enable-gpu'],
};
const pick = process.argv[2];
const html = `<canvas id=c width=1280 height=720></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
if (!gl) { console.log('NO_WEBGL2'); } else {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  console.log('RENDERER ' + (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)));
  console.log('TIMER_QUERY ' + !!gl.getExtension('EXT_disjoint_timer_query_webgl2') + ' FLOAT_RT ' + !!gl.getExtension('EXT_color_buffer_float'));
  const vs = '#version 300 es\\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}';
  const fs = '#version 300 es\\nprecision highp float;out vec4 o;uniform float t;void main(){vec2 u=gl_FragCoord.xy*.01;float a=0.;for(int i=0;i<64;i++){a+=sin(u.x*float(i)+t)*cos(u.y*float(i));}o=vec4(a*.01);}';
  const mk=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))console.log(gl.getShaderInfoLog(s));return s;};
  const p=gl.createProgram();gl.attachShader(p,mk(gl.VERTEX_SHADER,vs));gl.attachShader(p,mk(gl.FRAGMENT_SHADER,fs));gl.linkProgram(p);gl.useProgram(p);
  gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();
  const t0=performance.now();for(let i=0;i<20;i++){gl.uniform1f(gl.getUniformLocation(p,'t'),i);gl.drawArrays(gl.TRIANGLES,0,3);}gl.finish();
  console.log('FILL_MS_PER_PASS ' + ((performance.now()-t0)/20).toFixed(2) + ' (1280x720, 64-iter trig shader)');
}</script>`;
for (const [name, args] of Object.entries(configs)) {
  if (pick && pick !== name) continue;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...args],
      env: { ...process.env, GALLIUM_DRIVER: 'd3d12' } });
    const page = await browser.newPage();
    const lines = [];
    page.on('console', m => lines.push(m.text()));
    await page.goto('data:text/html,' + encodeURIComponent(html), { timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    console.log(`[${name}] ${lines.join(' | ')}`);
  } catch (e) { console.log(`[${name}] error ${e.message.slice(0, 120)}`); }
  finally { if (browser) await browser.close().catch(() => {}); }
}
