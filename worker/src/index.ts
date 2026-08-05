/**
 * GN Tracing multi-issuer OAuth token-exchange proxy (Cloudflare Worker).
 *
 * Entry point only — routing and zone handlers live under `app.ts` and `zones/`.
 *
 * Routes (optional `/{productVersion}` prefix, e.g. `/1.7.5/token`):
 *   POST /  | /token | /token/google   → Google
 *   POST /token/dropbox | /dropbox     → Dropbox
 *   POST /feedback                     → create GitHub issue (opt-in product feedback)
 *   POST /mcp                          → remote MCP (hosted recordings only; unversioned)
 *   GET  /health                       → readiness (no secret required)
 *
 * The extension keeps PKCE end-to-end (code_verifier). This Worker only pins
 * client_id + client_secret and never stores tokens or returns secrets.
 */

import { handleRequest } from "./app";
import type { Env } from "./env";

// Named non-handler exports break wrangler/workerd (it treats every named export
// as a Durable Object / ExportedHandler). Re-export helpers only from their own
// modules for tests/importers — not from this entry.

export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
