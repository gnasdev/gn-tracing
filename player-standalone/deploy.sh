#!/usr/bin/env bash
#
# Deploys the hosted GN Tracing replay player to Cloudflare Pages.

set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-gn-tracing-player}"
PLAYER_HOST_URL="${PLAYER_HOST_URL:-https://tracing.gnas.dev/}"
VITE_BASE_PATH="${VITE_BASE_PATH:-/}"
export VITE_BASE_PATH

echo "Deploying GN Tracing Player to Cloudflare Pages..."

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI not found. Install it with: npm i -g wrangler"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set."
  exit 1
fi

echo "Building standalone player..."
task -d .. player:build:cloudflare

echo "Publishing dist/ to project ${PROJECT_NAME}..."
npx wrangler pages deploy dist --project-name="${PROJECT_NAME}"

echo "Deploy complete."
echo "Player host: ${PLAYER_HOST_URL}"
