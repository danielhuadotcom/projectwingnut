#!/usr/bin/env bash
cd "$(dirname "$0")/.."
[ -f .serve.pid ] && kill "$(cat .serve.pid)" 2>/dev/null; rm -f .serve.pid; echo stopped
