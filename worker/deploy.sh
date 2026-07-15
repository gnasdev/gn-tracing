#!/usr/bin/env bash
#
# Deploys the GN Tracing OAuth token-exchange Worker to Cloudflare.
#
# The Worker holds GOOGLE_CLIENT_SECRET and proxies the Google OAuth token
# exchange so the extension (a public client) never ships the secret.
#
# Reads configuration from the process environment (export vars in the shell
# or CI). Does not load a repository .env file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI not found. Install it with: npm i -g wrangler"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment."
  exit 1
fi

if [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
  echo "GOOGLE_CLIENT_ID must be set in the environment."
  exit 1
fi

if [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
  echo "GOOGLE_CLIENT_SECRET must be set in the environment (the OAuth client secret)."
  echo "Find it in Google Cloud Console > APIs & Services > Credentials > your OAuth 2.0 Client."
  exit 1
fi

# Derive the allowed extension origin from CHROME_EXTENSION_ID when an explicit
# list is not provided. This pins the Worker to your extension only.
ALLOWED_ORIGINS="${WORKER_ALLOWED_EXTENSION_ORIGINS:-}"
if [ -z "$ALLOWED_ORIGINS" ] && [ -n "${CHROME_EXTENSION_ID:-}" ]; then
  ALLOWED_ORIGINS="chrome-extension://${CHROME_EXTENSION_ID}"
fi

if [ -z "$ALLOWED_ORIGINS" ]; then
  echo "Warning: no WORKER_ALLOWED_EXTENSION_ORIGINS or CHROME_EXTENSION_ID set."
  echo "The Worker will accept any chrome-extension:// origin. Set one for production."
fi

cd "$SCRIPT_DIR"

echo "Setting GOOGLE_CLIENT_SECRET on the Worker..."
printf '%s' "$GOOGLE_CLIENT_SECRET" | npx wrangler secret put GOOGLE_CLIENT_SECRET

echo "Deploying gn-tracing-oauth-proxy Worker..."
npx wrangler deploy \
  --var "GOOGLE_CLIENT_ID:${GOOGLE_CLIENT_ID}" \
  --var "ALLOWED_EXTENSION_ORIGINS:${ALLOWED_ORIGINS}"

echo "Deploy complete."
echo "Verify with: curl https://<your-worker-subdomain>.workers.dev/health"
