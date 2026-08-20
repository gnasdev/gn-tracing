#!/usr/bin/env bash
# Fast quality gate for every commit (Biome staged, docs, version, related tests).
# Does NOT publish immutable Player/Worker artifacts; release publication is always manual.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if git status --short | grep --quiet '^MM'; then
  printf '%s\n' "ERROR: Some staged files have unstaged changes" >&2
  exit 1
fi

npm exec -- biome check --write --staged --files-ignore-unknown=true --no-errors-on-unmatched
npm run docs:check
npm run version:check
git update-index --again

# Root extension context only — player/worker own their own runners on pre-push.
staged_ts="$(
  git diff --cached --name-only --diff-filter=ACMR -- '*.ts' \
    | grep -Ev '^(player|worker)/' \
    || true
)"

if [ -n "$staged_ts" ]; then
  if ! npm exec -- vitest --version >/dev/null 2>&1; then
    printf '%s\n' "ERROR: Unable to execute vitest. Run 'npm install' and try again." >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  npm exec -- vitest related --run --passWithNoTests $staged_ts
fi
