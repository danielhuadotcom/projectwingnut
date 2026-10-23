// Build: bundles js/main.js (Three stays an external CDN import) and produces
//   dist/wingnut.html       — artifact body (no doctype/html/head/body; inline module script)
//   dist/wingnut_local.html — full standalone document with the same inline bundle (for local play/testing)
//   dev.html                — full document loading js/main.js unbundled (fast local iteration)
import { buildSync } from 'esbuild'; // devDependency, pinned in package.json (npm ci)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
const pageArg = process.argv.indexOf('--page');
const page = readFileSync(pageArg > 0 ? process.argv[pageArg + 1] : 'src/page.html', 'utf8');
const skeletonHead = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
const skeletonTail = '</body></html>';
const minify = process.argv.includes('--min');
const bundle = buildSync({
  entryPoints: ['js/main.js'], bundle: true, format: 'esm', external: ['https://*'], target: 'es2022', logLevel: 'warning',
  minifyWhitespace: minify, minifySyntax: minify, write: false,
}).outputFiles[0].text;
const inline = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
// replacer function: a replacement *string* would expand $&, $', $`, $$ and $1 occurring in the bundle
const artifact = page.replace('<!--SCRIPT-->', () => `<script type="module">\n${inline}\n</script>`);
writeFileSync('dist/wingnut.html', artifact);
writeFileSync('dist/wingnut_local.html', skeletonHead + artifact + skeletonTail);
writeFileSync('dev.html', skeletonHead + page.replace('<!--SCRIPT-->', '<script type="module" src="js/main.js"></script>') + skeletonTail);
console.log(`bundle ${(bundle.length / 1024).toFixed(0)} KB, artifact ${(artifact.length / 1024).toFixed(0)} KB`);
