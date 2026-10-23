#!/usr/bin/env bash
# Build, then render-check the unbundled dev page and the bundled standalone page with the mission auto-started.
# usage: tools/integration.sh [seconds] [which: dev|dist|both]
cd "$(dirname "$0")/.."
SECS="${1:-8}"; WHICH="${2:-both}"
OUT="${WINGNUT_TMP:-${TMPDIR:-/tmp}/wingnut}"; mkdir -p "$OUT"
node tools/build.mjs --min || exit 1
# After load: wait 1.5 s, then press Enter (starts the mission), hold the gun for 1 s at t=3 s, fire a missile at t=4 s, hold RB briefly at 5 s.
SCRIPT='setTimeout(()=>{const k=(t,c,k)=>window.dispatchEvent(new KeyboardEvent(t,{code:c,key:k,bubbles:true}));k("keydown","Enter","Enter");k("keyup","Enter","Enter");
 setTimeout(()=>{k("keydown","Space"," ");setTimeout(()=>k("keyup","Space"," "),1000);},1500);
 setTimeout(()=>{k("keydown","KeyF","f");k("keyup","KeyF","f");},2500);
 setTimeout(()=>{k("keydown","Tab","Tab");setTimeout(()=>k("keyup","Tab","Tab"),120);},3500);
 setTimeout(()=>{k("keydown","KeyS","s");setTimeout(()=>k("keyup","KeyS","s"),700);},4000);
 setTimeout(()=>{const g=window.__wingnut; if(g) console.log("STATE", g.state, "alt", g.player.position.y.toFixed(0), "spd", g.player.speed.toFixed(0), "enemies", g.enemies.filter(e=>e.alive).length, "missiles", g.weapons.missiles.length, "calls", g.renderer.info.render.calls, "tris", g.renderer.info.render.triangles, "ema", g.frameEma.toFixed(1));},5500);
},1500);'
if [ "$WHICH" = dev ] || [ "$WHICH" = both ]; then echo "== dev.html =="; node tools/check.mjs "http://127.0.0.1:8765/dev.html" "$OUT/int_dev.png" "$SECS" 1280 720 "$SCRIPT"; fi
if [ "$WHICH" = dist ] || [ "$WHICH" = both ]; then echo "== dist/wingnut_local.html =="; node tools/check.mjs "http://127.0.0.1:8765/dist/wingnut_local.html" "$OUT/int_dist.png" "$SECS" 1280 720 "$SCRIPT"; fi
