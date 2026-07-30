/**
 * Application facade: route request to the correct capability zone.
 *
 * Trust models differ per zone (see middleware/origin and zones/mcp CORS).
 * This file only dispatches; domain logic lives under zones/.
 */

import type { Env } from "./env";
import { emptyResponse, jsonResponse } from "./http/response";
import type { CorsZone } from "./middleware/cors";
import {
  isExtensionOriginAllowed,
  isFeedbackOriginAllowed,
  isOriginAllowListMisconfigured,
} from "./middleware/origin";
import { oauthRateLimiter } from "./middleware/rate-limit";
import { handleFeedback, isFeedbackPath } from "./zones/feedback/handler";
import { handleHealth, isHealthPath } from "./zones/health/handler";
import { handleMcpRequest, isMcpPath, mcpCorsHeaders } from "./zones/mcp/handler";
import { handleTokenExchange } from "./zones/oauth/exchange";
import { resolveProviderFromPath } from "./zones/oauth/routes";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const feedbackRoute = isFeedbackPath(url.pathname);
  const mcpRoute = isMcpPath(url.pathname);
  const corsZone: CorsZone = feedbackRoute ? "feedback" : "oauth";

  // MCP owns its own CORS and method rules: arbitrary MCP clients, not extension.
  if (mcpRoute) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: mcpCorsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Use POST with a JSON-RPC message." },
        }),
        { status: 405, headers: { "Content-Type": "application/json", ...mcpCorsHeaders() } },
      );
    }
    return handleMcpRequest(request, env);
  }

  if (request.method === "GET" && isHealthPath(url.pathname)) {
    return handleHealth(origin, env);
  }

  if (request.method === "OPTIONS") {
    const allowed = feedbackRoute
      ? isFeedbackOriginAllowed(origin, env)
      : isExtensionOriginAllowed(origin, env);
    if (!allowed) {
      return new Response(null, { status: 403 });
    }
    return emptyResponse(204, origin, env, corsZone);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "method_not_allowed", error_description: "Use POST." },
      405,
      origin,
      env,
      corsZone,
    );
  }

  if (feedbackRoute) {
    if (!isFeedbackOriginAllowed(origin, env)) {
      return jsonResponse(
        { error: "forbidden_origin", error_description: "Origin is not allowed." },
        403,
        origin,
        env,
        "feedback",
      );
    }
    return handleFeedback(request, env, origin);
  }

  if (isOriginAllowListMisconfigured(env)) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: "STRICT_ORIGIN is enabled but ALLOWED_EXTENSION_ORIGINS is empty.",
      },
      500,
      origin,
      env,
      "oauth",
    );
  }

  if (!isExtensionOriginAllowed(origin, env)) {
    return jsonResponse(
      { error: "forbidden_origin", error_description: "Origin is not allowed." },
      403,
      origin,
      env,
      "oauth",
    );
  }

  const providerId = resolveProviderFromPath(url.pathname);
  if (!providerId) {
    return jsonResponse(
      {
        error: "not_found",
        error_description:
          "Unknown endpoint. Use /token (Google), /token/dropbox, /feedback, or /mcp.",
      },
      404,
      origin,
      env,
      "oauth",
    );
  }

  const rate = await oauthRateLimiter.consume(request);
  if (!rate.allowed) {
    return jsonResponse(
      {
        error: "rate_limited",
        error_description: "Too many token exchange requests. Please try again later.",
      },
      429,
      origin,
      env,
      "oauth",
    );
  }

  return handleTokenExchange(request, env, origin, providerId);
}
