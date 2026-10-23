// Cross-process lock so only one headless Chrome runs at a time (clean GPU timings, bounded memory).
// The lock lives in $WINGNUT_TMP (default: <os tmpdir>/wingnut); the dev tools also write their outputs there.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const WINGNUT_TMP = process.env.WINGNUT_TMP || path.join(os.tmpdir(), 'wingnut');
mkdirSync(WINGNUT_TMP, { recursive: true });
const LOCK = path.join(WINGNUT_TMP, 'chrome.lock');
// TRANSITIONAL (remove once no older checkout of this file is still running): earlier versions kept the lock in a
// per-session dev scratch directory. Also hold that location (derived from the environment, never hard-coded) so a
// process running the old code and one running this code can never both have Chrome up. Locks are taken in a fixed
// order, so processes running this version cannot deadlock each other.
const legacyLock = () => {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid || typeof process.getuid !== 'function') return null;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(os.tmpdir(), `claude-${process.getuid()}`, root.replaceAll('/', '-'), sid, 'scratchpad', 'chrome.lock');
};
const LOCKS = [...new Set([LOCK, legacyLock()].filter(Boolean).map((p) => path.resolve(p)))].sort();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function acquireOne(lock, label, t0) {
  let warned = false;
  for (;;) {
    try { mkdirSync(lock); writeFileSync(lock + '/pid', String(process.pid)); return; }
    catch (e) {
      if (e.code === 'ENOENT') { mkdirSync(path.dirname(lock), { recursive: true }); continue; }
      let pid = 0; try { pid = Number(readFileSync(lock + '/pid', 'utf8')); } catch {}
      if (pid && !alive(pid)) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (!warned && Date.now() - t0 > 2000) { console.log(`[lock] waiting for another headless Chrome run to finish (${label})`); warned = true; }
      if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('chrome lock wait timeout');
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
const releaseOne = (lock) => { try { if (Number(readFileSync(lock + '/pid', 'utf8')) === process.pid) rmSync(lock, { recursive: true, force: true }); } catch {} };
export async function acquireChromeLock(label = '') {
  const t0 = Date.now(), held = [];
  const release = () => { while (held.length) releaseOne(held.pop()); };
  try { for (const lock of LOCKS) { await acquireOne(lock, label, t0); held.push(lock); } }
  catch (e) { release(); throw e; }
  process.on('exit', release);
  return release;
}
// Chrome flags: hardware GPU by default; WINGNUT_SW=1 forces SwiftShader (software rendering).
export function chromeArgs(w, h) {
  const gpu = process.env.WINGNUT_SW === '1'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
  return ['--no-sandbox', '--disable-dev-shm-usage', ...gpu, '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${w},${h}`];
}
// GALLIUM_DRIVER=d3d12 selects Mesa's D3D12 backend, which is what exposes the GPU under WSL2.
export const chromeEnv = () => ({ ...process.env, GALLIUM_DRIVER: 'd3d12' });

// Launch Chrome and warm up the GPU process: on the WSL2 D3D12 path the first WebGL context after startup can fail.
export async function launchWarm(puppeteer, w, h, extraArgs = []) {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [...chromeArgs(w, h), ...extraArgs], env: chromeEnv() });
  if (process.env.WINGNUT_SW !== '1') {
    // Throwaway tab on a different origin absorbs the failing first context (Chrome blocks WebGL per origin after a failure)
    const warm = await browser.newPage();
    await warm.goto('data:text/html,<title>warm</title>');
    await warm.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('canvas'); c.width = 16; c.height = 16;
        const gl = c.getContext('webgl2');
        if (gl && !gl.isContextLost()) return;
        await new Promise(r => setTimeout(r, 400));
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    await warm.close().catch(() => {});
  }
  const page = await browser.newPage();
  return { browser, page };
}
