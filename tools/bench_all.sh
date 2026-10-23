#!/usr/bin/env bash
# Benchmark every quality tier on the real GPU and print one summary table.
# usage: tools/bench_all.sh [label] [size=1920x1080] [dur=12]
cd "$(dirname "$0")/.."
LABEL="${1:-run}"; SIZE="${2:-1920x1080}"; DUR="${3:-12}"
OUT="${WINGNUT_TMP:-${TMPDIR:-/tmp}/wingnut}"; mkdir -p "$OUT"
node tools/build.mjs >/dev/null || exit 1
for q in low medium high ultra; do
  node tools/perf.mjs --size "$SIZE" --dur "$DUR" --query "q=$q" --out "bench_${LABEL}_$q" >/dev/null 2>&1 || echo "bench $q failed"
done
node -e '
const fs = require("fs"); const [out, label] = process.argv.slice(1);
const rows = [];
for (const q of ["low","medium","high","ultra"]) {
  let r; try { r = JSON.parse(fs.readFileSync(`${out}/bench_${label}_${q}.json`, "utf8")); } catch { rows.push(`${q.padEnd(7)} (no result)`); continue; }
  const P = r.gpuPass, f = (s) => s ? s.mean.toFixed(2) : "-";
  rows.push(`${q.padEnd(7)} ${r.internal.join("x").padEnd(10)} msaa${String(r.msaa).padEnd(2)} scale ${String(r.scale).padEnd(5)} | GPU total ${f(P.__total).padStart(6)} p95 ${(P.__total ? P.__total.p95.toFixed(2) : "-").padStart(6)} | scene ${f(P.scene).padStart(6)} bloom ${f(P.bloom).padStart(5)} comp ${f(P.composite).padStart(5)} | draws ${r.drawCalls}`);
}
console.log(`== ${label} ==\n` + rows.join("\n"));
' "$OUT" "$LABEL"
