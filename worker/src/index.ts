/**
 * GN Tracing multi-issuer OAuth token-exchange proxy (Cloudflare Worker).
 *
 * Entry point only — routing and zone handlers live under `app.ts` and `zones/`.
 *
 * Routes:
 *   POST /  | /token | /token/google   → Google
 *   POST /token/dropbox | /dropbox     → Dropbox
 *   POST /feedback                     → create GitHub issue (opt-in product feedback)
 *   POST /mcp                          → remote MCP (hosted recordings only)
 *   GET  /health                       → readiness (no secret required)
 *
 * The extension keeps PKCE end-to-end (code_verifier). This Worker only pins
 * client_id + client_secret and never stores tokens or returns secrets.
 */

import { handleRequest } from "./app";
import type { Env } from "./env";
import { isFeedbackOriginAllowed } from "./middleware/origin";
import {
  buildFeedbackIssueTitle,
  formatFeedbackIssueBody,
  isFeedbackPath,
} from "./zones/feedback/handler";
import { resolveProviderFromPath } from "./zones/oauth/routes";

export type { Env };
export {
  buildFeedbackIssueTitle,
  formatFeedbackIssueBody,
  isFeedbackOriginAllowed,
  isFeedbackPath,
  resolveProviderFromPath,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
