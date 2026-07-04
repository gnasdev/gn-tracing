---
title: "01 - Prerequisites"
description: "Local toolchain and accounts required before scaffolding GN Tracing."
type: build
status: active
tags: ["build", "prerequisites", "setup"]
related:
  - "./02-scaffolding.md"
  - "./README.md"
---

# 01 - Prerequisites

## Meta

- Goal: line up everything you need on your machine before writing the first config file.
- Verification: each step ends with a "You should now have" checkpoint.

## Toolchain

| Tool | Minimum | Why |
| --- | --- | --- |
| Node.js | 18.x or 20.x | runs `esbuild`, `vitest`, `biome`, `wrangler`, all `scripts/*.mjs` |
| npm | bundled with Node | installs dependencies in root, `player-standalone/`, `worker/` |
| git | 2.x | required for `CHROME_EXTENSION_PUBLIC_KEY` key handling and tag-driven releases |
| go-task | 3.x (optional but recommended) | runs every command in `Taskfile.yml`; you can call `node` directly otherwise |
| Chromium browser | Chrome / Edge / Brave 120+ | needed to load `dist/` unpacked; `manifest.json` declares `minimum_chrome_version: 120` |

Confirm your local versions:

```bash
node --version
npm --version
git --version
task --version   # optional
google-chrome --version   # or brave/edge --version
```

## Accounts and External Services

You only need the accounts that match the surfaces you plan to ship:

1. **Google Cloud project** — to create a Google OAuth client.
   - Enable the Google Drive API for the project.
   - Create an **OAuth client ID** of type **"Web application"** (this is the kind that requires a secret, so chapter `08` deploys a Worker that injects the secret).
   - Note the resulting `GOOGLE_CLIENT_ID` (ends in `.apps.googleusercontent.com`).
2. **Chrome Web Store developer account** — only required if you plan to publish, not for local development.
3. **Cloudflare account** — only required if you plan to deploy the hosted player and the OAuth Worker.
   - Create a Cloudflare API token with **Workers Scripts: Edit** and **Cloudflare Pages: Edit** permissions.
   - Find the Account ID in the dashboard URL or under "Workers & Pages > Account details".

## Chrome Extension Keypair

MV3 extensions are uniquely identified by the SHA-256 of their public key. You need a stable keypair so the extension ID and OAuth `key` field stay consistent across builds.

Generate one pair (run once, keep the secrets out of git):

```bash
# Generate a 2048-bit RSA key
openssl genrsa -out chrome-extension.pem 2048
# Extract the public key in base64 DER form (this is what goes into CHROME_EXTENSION_PUBLIC_KEY)
openssl rsa -in chrome-extension.pem -pubout -outform DER | base64 -w0 > chrome-extension.pub.b64
# The private key stays in PKCS#8 PEM form for CHROME_EXTENSION_PRIVATE_KEY
openssl pkcs8 -topk8 -in chrome-extension.pem -nocrypt -out chrome-extension-pkcs8.pem
```

Store the resulting `chrome-extension.pub.b64` and `chrome-extension-pkcs8.pem` somewhere safe. You will paste them into `.env` in chapter `10`.

The extension ID derived from the public key must be added to the OAuth client's "Authorized redirect URIs" or "Authorized JavaScript origins" depending on the flow. For a Web-application OAuth client used only via Chrome identity, register the extension origin `chrome-extension://<derived-id>`.

To compute the extension ID up front (matches `getChromeExtensionId()` in `esbuild.config.mjs`):

```bash
node -e '
const crypto = require("crypto");
const fs = require("fs");
const pub = fs.readFileSync("chrome-extension.pub.b64", "utf8").trim();
const hash = crypto.createHash("sha256").update(Buffer.from(pub, "base64")).digest();
process.stdout.write(Array.from(hash.subarray(0, 16), b =>
  b.toString(16).padStart(2, "0").replace(/[0-9a-f]/g, c =>
    String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))
  )
).join("") + "\n");
'
```

Save that ID — chapter `12` checks it against `CHROME_EXTENSION_ID`.

## You Should Now Have

- Node 18+ reporting the expected version.
- `git` configured with a name/email (required for tags and releases).
- A `chrome-extension.pub.b64` and `chrome-extension-pkcs8.pem` on disk.
- A `GOOGLE_CLIENT_ID` from Google Cloud Console (paste into `.env` in chapter `10`).
- A computed extension ID noted down.

When all of that is true, move on to [02 - Scaffolding](./02-scaffolding.md).
