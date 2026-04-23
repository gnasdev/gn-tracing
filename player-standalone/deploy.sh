#!/usr/bin/env bash

set -euo pipefail

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-gn-tracing-player}"
PLAYER_HOST_URL="${PLAYER_HOST_URL:-https://tracing.gnas.dev/}"

echo "Deploying GN Tracing Player to Cloudflare Pages..."

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI not found. Install it with: npm i -g wrangler"
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set."
  exit 1
fi

echo "Syncing player assets..."
npm run sync:player

echo "Building standalone player..."
npm run build:cloudflare

echo "Publishing dist/ to project ${PROJECT_NAME}..."
npx wrangler pages deploy dist --project-name="${PROJECT_NAME}"

echo "Deploy complete."
echo "Player host: ${PLAYER_HOST_URL}"
