#!/bin/bash
# Deploy script for GN Tracing Player

set -e

echo "🚀 Deploying GN Tracing Player..."

# Sync assets first
echo "📦 Syncing assets..."
npm run sync:player

# Build
echo "🔨 Building..."
npm run build

# Deploy (customize based on your hosting)
echo "📤 Deploying..."
cd dist

# Option 1: Cloudflare Pages with Wrangler
# npx wrangler pages deploy . --project-name=gn-tracing-player

# Option 2: Vercel
# npx vercel --prod

# Option 3: GitHub Pages (gh-pages branch)
# git init
# git add .
# git commit -m "deploy"
# git push -f origin gh-pages

echo "✅ Deployment complete!"
echo "URL: https://tracing.gnas.dev/player/"
