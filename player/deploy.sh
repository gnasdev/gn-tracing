#!/usr/bin/env bash
#
# Deploys the hosted GN Tracing replay player to Cloudflare Pages.
#
# Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and optional overrides
# from the process environment. When present, also sources the repo root
# `.env` (git-ignored) so local deploys pick up the same Worker URLs as the
# extension build without requiring a second export step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  echo "Loading env from $ROOT_DIR/.env"
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-gn-tracing-player}"
PLAYER_HOST_URL="${PLAYER_HOST_URL:-https://tracing.gnas.dev/}"
VITE_BASE_PATH="${VITE_BASE_PATH:-/}"

# Hosted player feedback posts to the multi-issuer Worker /feedback route.
# Prefer explicit VITE_FEEDBACK_PROXY_URL / FEEDBACK_PROXY_URL; otherwise derive
# from the OAuth proxy origin (same rule as esbuild.config.mjs for the extension).
normalize_proxy_url() {
  local value
  value="$(printf '%s' "${1:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's|/*$||')"
  printf '%s' "$value"
}

origin_of_url() {
  local raw
  raw="$(normalize_proxy_url "${1:-}")"
  if [ -z "$raw" ]; then
    return 1
  fi
  # Strip path/query so .../token/dropbox → https://host
  printf '%s' "$raw" | sed -E 's|(https?://[^/]+).*|\1|'
}

# Same pure join as esbuild / Worker: packages/replay-core/src/route-version.mjs
if ! VITE_FEEDBACK_PROXY_URL="$(
  cd "$ROOT_DIR" &&
    node --experimental-strip-types scripts/resolve-feedback-proxy-url.mjs
)"; then
  echo "error: could not resolve VITE_FEEDBACK_PROXY_URL for the hosted player." >&2
  echo "Set VITE_FEEDBACK_PROXY_URL or FEEDBACK_PROXY_URL to the Worker origin," >&2
  echo "or set GOOGLE_TOKEN_PROXY_URL / DROPBOX_TOKEN_PROXY_URL so the origin can be derived." >&2
  exit 1
fi

export VITE_BASE_PATH
export VITE_FEEDBACK_PROXY_URL

echo "Deploying GN Tracing Player to Cloudflare Pages..."
echo "  feedbackProxyUrl (baked at build): ${VITE_FEEDBACK_PROXY_URL}"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI not found. Install it with: npm i -g wrangler"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment."
  exit 1
fi

echo "Building standalone player..."
# Pass VITE_* into the nested task so the Cloudflare build bakes the same URL.
VITE_BASE_PATH="$VITE_BASE_PATH" \
  VITE_FEEDBACK_PROXY_URL="$VITE_FEEDBACK_PROXY_URL" \
  task -d .. player:build:cloudflare

# Production custom domain (tracing.gnas.dev) tracks the Pages production
# branch (`main`). Wrangler otherwise tags the deploy with the current git
# branch (often `dev`) and ships a Preview that the custom domain never sees.
PRODUCTION_BRANCH="${CLOUDFLARE_PAGES_PRODUCTION_BRANCH:-main}"

echo "Publishing dist/ to project ${PROJECT_NAME} (branch ${PRODUCTION_BRANCH})..."
npx wrangler pages deploy dist \
  --project-name="${PROJECT_NAME}" \
  --branch "${PRODUCTION_BRANCH}" \
  --commit-dirty=true

echo "Deploy complete."
echo "Player host: ${PLAYER_HOST_URL}"
echo "Feedback:    ${VITE_FEEDBACK_PROXY_URL}"
