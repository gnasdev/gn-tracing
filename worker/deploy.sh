#!/usr/bin/env bash
#
# Deploys the GN Tracing multi-issuer OAuth token-exchange Worker to Cloudflare.
#
# Holds client secrets for Google and Dropbox and proxies token exchange so the
# extension never ships secrets.
#
# Reads configuration from the process environment. Optionally sources the repo
# root `.env` when present (git-ignored).

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

if ! command -v wrangler >/dev/null 2>&1 && [ ! -x "$SCRIPT_DIR/node_modules/.bin/wrangler" ]; then
  echo "wrangler CLI not found. Install deps with: cd worker && npm install"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment."
  exit 1
fi

# At least one provider must be fully configured (id + secret).
HAS_GOOGLE=0
HAS_DROPBOX=0
GOOGLE_WORKER_CLIENT_ID="${GOOGLE_WEB_CLIENT_ID:-${GOOGLE_CLIENT_ID:-}}"
[ -n "$GOOGLE_WORKER_CLIENT_ID" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ] && HAS_GOOGLE=1
[ -n "${DROPBOX_CLIENT_ID:-}" ] && [ -n "${DROPBOX_CLIENT_SECRET:-}" ] && HAS_DROPBOX=1

if [ "$HAS_GOOGLE" -eq 0 ] && [ "$HAS_DROPBOX" -eq 0 ]; then
  echo "No provider fully configured. Set at least one pair of CLIENT_ID + CLIENT_SECRET:"
  echo "  Google:   (GOOGLE_WEB_CLIENT_ID or GOOGLE_CLIENT_ID) + GOOGLE_CLIENT_SECRET"
  echo "  Dropbox:  DROPBOX_CLIENT_ID + DROPBOX_CLIENT_SECRET"
  exit 1
fi

ALLOWED_ORIGINS="${WORKER_ALLOWED_EXTENSION_ORIGINS:-}"
if [ -z "$ALLOWED_ORIGINS" ] && [ -n "${CHROME_EXTENSION_ID:-}" ]; then
  # Firefox mints a random moz-extension://<uuid> per profile and per install, so
  # there is no stable origin to pin the way CHROME_EXTENSION_ID is pinned. The
  # `moz-extension://*` sentinel accepts that scheme; PKCE plus redirect_uri
  # validation remain the controls for those requests. Set
  # WORKER_ALLOWED_EXTENSION_ORIGINS to override (omit the sentinel to keep the
  # Worker Chromium-only).
  ALLOWED_ORIGINS="chrome-extension://${CHROME_EXTENSION_ID},moz-extension://*"
fi

case "$ALLOWED_ORIGINS" in
  *"moz-extension://*"*)
    echo "Note: allow-list accepts any moz-extension:// origin (Firefox support)."
    ;;
  *)
    echo "Note: allow-list has no moz-extension:// entry — Firefox OAuth will 403."
    ;;
esac

if [ -z "$ALLOWED_ORIGINS" ]; then
  echo "Warning: no WORKER_ALLOWED_EXTENSION_ORIGINS or CHROME_EXTENSION_ID set."
  echo "The Worker will accept any extension-scheme origin. Set one for production."
fi

cd "$SCRIPT_DIR"

put_secret() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    return 0
  fi
  echo "Setting secret $name on the Worker..."
  printf '%s' "$value" | npx wrangler secret put "$name"
}

put_secret "GOOGLE_CLIENT_SECRET" "${GOOGLE_CLIENT_SECRET:-}"
put_secret "DROPBOX_CLIENT_SECRET" "${DROPBOX_CLIENT_SECRET:-}"
put_secret "GITHUB_FEEDBACK_TOKEN" "${GITHUB_FEEDBACK_TOKEN:-}"

VAR_FLAGS=(
  --var "GOOGLE_CLIENT_ID:${GOOGLE_CLIENT_ID:-}"
  --var "GOOGLE_WEB_CLIENT_ID:${GOOGLE_WEB_CLIENT_ID:-}"
  --var "DROPBOX_CLIENT_ID:${DROPBOX_CLIENT_ID:-}"
  --var "ALLOWED_EXTENSION_ORIGINS:${ALLOWED_ORIGINS}"
  --var "GITHUB_REPO_OWNER:${GITHUB_REPO_OWNER:-gnasdev}"
  --var "GITHUB_REPO_NAME:${GITHUB_REPO_NAME:-gn-tracing}"
  --var "GITHUB_FEEDBACK_LABELS:${GITHUB_FEEDBACK_LABELS:-feedback}"
)

echo "Deploying gn-tracing-oauth-proxy Worker (google=$HAS_GOOGLE dropbox=$HAS_DROPBOX)..."
DEPLOY_OUT="$(npx wrangler deploy "${VAR_FLAGS[@]}" 2>&1)"
echo "$DEPLOY_OUT"

# Best-effort extract workers.dev URL from deploy output.
WORKER_URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -Eo 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || true)"
if [ -z "$WORKER_URL" ]; then
  WORKER_URL="https://gn-tracing-oauth-proxy.<your-subdomain>.workers.dev"
fi

echo ""
PRODUCT_VERSION="$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo '?')"

echo "Deploy complete."
echo "Health (legacy):   curl ${WORKER_URL}/health"
echo "Health (versioned): curl ${WORKER_URL}/${PRODUCT_VERSION}/health"
echo ""
echo "Point extension env to the Worker *origin* (then rebuild)."
echo "The extension build joins /{package.json version}/token automatically:"
echo "  GOOGLE_TOKEN_PROXY_URL=${WORKER_URL}"
echo "  DROPBOX_TOKEN_PROXY_URL=${WORKER_URL}"
echo "  FEEDBACK_PROXY_URL=${WORKER_URL}  # optional; derived from OAuth proxy origin when unset"
echo "  # Baked paths: /${PRODUCT_VERSION}/token , /${PRODUCT_VERSION}/token/dropbox , /${PRODUCT_VERSION}/feedback"
echo "Legacy unversioned paths (/token, /feedback) remain accepted for older clients."
if [ -z "${GITHUB_FEEDBACK_TOKEN:-}" ]; then
  echo ""
  echo "Note: GITHUB_FEEDBACK_TOKEN was empty — POST /feedback will return 503 until you set the secret."
fi
