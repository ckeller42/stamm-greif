#!/usr/bin/env bash
# Serve the production standalone build exactly the way the Dockerfile does: the traced server
# bundle needs .next/static and public/ copied inside it (next start does NOT serve
# output:'standalone' builds — it silently falls back to the regular server).
# Used by Playwright's CI webServer (playwright.config.ts). Run `pnpm build` first.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .next/standalone ] || { echo "no .next/standalone — run pnpm build first" >&2; exit 1; }
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
exec node .next/standalone/server.js
