#!/usr/bin/env bash
# Start (once) a static server for local testing on :8765. Idempotent. Stop with tools/stop.sh
cd "$(dirname "$0")/.."
if [ -f .serve.pid ] && kill -0 "$(cat .serve.pid)" 2>/dev/null; then echo "server already running (pid $(cat .serve.pid))"; exit 0; fi
nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
echo $! > .serve.pid; sleep 0.5; echo "server started pid $(cat .serve.pid) at http://127.0.0.1:8765/"
