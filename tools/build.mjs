// Build: bundles js/main.js (Three stays an external CDN import) and produces
//   dist/wingnut.html       — artifact body (no doctype/html/head/body; inline module script)
//   dist/wingnut_local.html — full standalone document with the same inline bundle (for local play/testing)
//   dev.html                — full document loading js/main.js unbundled (fast local iteration)
// The standalone page (the one GitHub Pages serves) also gets the home-screen web app tags: manifest.webmanifest and
// icons/ (made by tools/make_icons.mjs) are copied next to it into dist/. The artifact body stays without them: the
// claude.ai artifact has no such files next to it.
// Streamed audio is copied next to the page too (the page fetches it per mission, relative to itself):
//   dist/assets/dialogue/<id>.mp3     story dialogue clips (tools/build_dialogue.mjs; js/radio.js)
//   dist/assets/music/<track>.opus|mp3  soundtrack tracks other than the embedded theme (js/music_tracks.js)
// Without them (the old single-file artifact) the game still runs: lines play as subtitles, cues keep the embedded theme.
import { buildSync } from 'esbuild'; // devDependency, pinned in package.json (npm ci)
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { MUSIC_TRACKS } from '../js/music_tracks.js';
import { execSync } from 'node:child_process';
mkdirSync('dist', { recursive: true });
const pageArg = process.argv.indexOf('--page');
const page = readFileSync(pageArg > 0 ? process.argv[pageArg + 1] : 'src/page.html', 'utf8');
const skeletonHead = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
const skeletonTail = '</body></html>';
// Home-screen install (Pages build only). Paths are relative so the /projectwingnut/ subpath works. black-translucent
// lets the page draw under the iOS status bar; the page already pads by env(safe-area-inset-*).
const appHead = '<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#04070d">'
  + '<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png"><link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">'
  + '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">'
  + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Wingnut">';
const BLANK_ICON = '<link rel="icon" href="data:,">';
const minify = process.argv.includes('--min');
// build stamp (Settings shows it): the commit's short hash (CI: GITHUB_SHA), '-dirty' for a local build with uncommitted
// changes; dev.html (unbundled) shows 'dev'
function buildStamp() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const h = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim() !== '';
    return h + (dirty ? '-dirty' : '');
  } catch { return 'unknown'; }
}
const BUILD = buildStamp();
const bundle = buildSync({
  entryPoints: ['js/main.js'], bundle: true, format: 'esm', external: ['https://*'], target: 'es2022', logLevel: 'warning',
  minifyWhitespace: minify, minifySyntax: minify, write: false, define: { __WINGNUT_BUILD__: JSON.stringify(BUILD) },
}).outputFiles[0].text;
const inline = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
// replacer function: a replacement *string* would expand $&, $', $`, $$ and $1 occurring in the bundle
const artifact = page.replace('<!--SCRIPT-->', () => `<script type="module">\n${inline}\n</script>`);
writeFileSync('dist/wingnut.html', artifact);
if (!artifact.includes(BLANK_ICON)) throw new Error('src/page.html: expected ' + BLANK_ICON);
// the page's blank favicon would override the real one, so the standalone page drops it
writeFileSync('dist/wingnut_local.html', skeletonHead.replace('</head>', appHead + '</head>') + artifact.replace(BLANK_ICON, '') + skeletonTail);
cpSync('manifest.webmanifest', 'dist/manifest.webmanifest');
cpSync('icons', 'dist/icons', { recursive: true });
rmSync('dist/assets', { recursive: true, force: true });
mkdirSync('dist/assets/dialogue', { recursive: true }); mkdirSync('dist/assets/music', { recursive: true });
let streamed = 0;
for (const f of readdirSync('assets/dialogue')) if (f.endsWith('.mp3')) { cpSync(`assets/dialogue/${f}`, `dist/assets/dialogue/${f}`); streamed++; }
for (const t of Object.values(MUSIC_TRACKS)) for (const u of [t.opusUrl, t.mp3Url]) if (u) { cpSync(u, `dist/${u}`); streamed++; }
writeFileSync('dev.html', skeletonHead + page.replace('<!--SCRIPT-->', '<script type="module" src="js/main.js"></script>') + skeletonTail);
console.log(`build ${BUILD}, bundle ${(bundle.length / 1024).toFixed(0)} KB, artifact ${(artifact.length / 1024).toFixed(0)} KB, ${streamed} streamed audio files in dist/assets/`);
