#!/usr/bin/env bash
# Full local quality gate only (typecheck / check / tests).
#
# Does NOT publish immutable Player or Worker artifacts; release publication is manual.
#
# Skip this gate: SKIP_HOOKS=1 git push
# Optional e2e:  RUN_E2E=1 git push  (requires Playwright browsers)
set -euo pipefail

if [ "${SKIP_HOOKS:-}" = "1" ] || [ "${SKIP_HOOKS:-}" = "true" ]; then
  echo "SKIP_HOOKS set — skipping pre-push quality gate."
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> version:check"
npm run version:check

echo "==> typecheck:all"
if command -v task >/dev/null 2>&1; then
  task typecheck:all
else
  npm run typecheck
  (cd packages/replay-core && npx tsc --noEmit)
  (cd packages/sdk && npx tsc --noEmit)
  (cd mcp && npx tsc --noEmit)
  (cd player && npx tsc --noEmit)
  (cd worker && npx tsc --noEmit)
fi

echo "==> check (biome + docs + version + mcp)"
npm run check

echo "==> test:all (root + player + worker)"
if command -v task >/dev/null 2>&1; then
  task test:all
else
  npm run test
  (cd player && npm run test)
  (cd worker && npm run test)
fi

# Knip is advisory until deadcode is fully clean (same as former CI).
echo "==> deadcode (advisory)"
npm run deadcode || {
  echo "WARNING: knip reported issues (not blocking push)." >&2
}

if [ "${RUN_E2E:-}" = "1" ] || [ "${RUN_E2E:-}" = "true" ]; then
  echo "==> e2e player (RUN_E2E=1)"
  npm run vendor:player-core
  npm run test:e2e:player
fi

echo "✓ pre-push quality gate passed (no deploy — publish immutable releases manually when shipping edge)"
