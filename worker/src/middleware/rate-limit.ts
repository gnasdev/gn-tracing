/**
 * Per-IP hourly rate limit via the Cache API.
 *
 * Best-effort across colos; enough to stop casual abuse. Fail-open when Cache
 * API is unavailable (local dev) so endpoints stay usable.
 */

import { hashToHexPrefix } from "../lib/crypto-hash";

export interface RateLimitConfig {
  /** Logical namespace → distinct cache key host. */
  namespace: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function createRateLimiter(config: RateLimitConfig) {
  return {
    async consume(request: Request): Promise<RateLimitResult> {
      const ip = clientIp(request);
      const hourBucket = Math.floor(Date.now() / config.windowMs);
      const keyHash = await hashToHexPrefix(`${hourBucket}:${ip}`);
      const cacheKey = new Request(`https://${config.namespace}-rate.gn-tracing.local/${keyHash}`);

      try {
        // Cloudflare Workers expose `caches.default`; the DOM CacheStorage type does not.
        const cache = (caches as unknown as { default: Cache }).default;
        const existing = await cache.match(cacheKey);
        const count = existing ? Number.parseInt(await existing.text(), 10) || 0 : 0;
        if (count >= config.limit) {
          return { allowed: false };
        }
        await cache.put(
          cacheKey,
          new Response(String(count + 1), {
            headers: {
              "Content-Type": "text/plain",
              "Cache-Control": `max-age=${Math.ceil(config.windowMs / 1000)}`,
            },
          }),
        );
        return { allowed: true };
      } catch {
        return { allowed: true };
      }
    },
  };
}

export const FEEDBACK_RATE_LIMIT = 5;
export const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;
export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Light OAuth exchange budget (authorization_code + refresh per hour). */
export const OAUTH_RATE_LIMIT = 60;
export const OAUTH_RATE_WINDOW_MS = 60 * 60 * 1000;

export const feedbackRateLimiter = createRateLimiter({
  namespace: "feedback",
  limit: FEEDBACK_RATE_LIMIT,
  windowMs: FEEDBACK_RATE_WINDOW_MS,
});

export const mcpRateLimiter = createRateLimiter({
  namespace: "mcp",
  limit: MCP_RATE_LIMIT,
  windowMs: MCP_RATE_WINDOW_MS,
});

export const oauthRateLimiter = createRateLimiter({
  namespace: "oauth",
  limit: OAUTH_RATE_LIMIT,
  windowMs: OAUTH_RATE_WINDOW_MS,
});
