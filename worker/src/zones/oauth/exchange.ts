/**
 * Pure OAuth grant relay: whitelist fields, pin client credentials, call provider.
 */

import type { Env } from "../../env";
import { readFormParams } from "../../http/body";
import { jsonResponse, passthroughUpstream } from "../../http/response";
import { getOAuthProvider, type OAuthProviderId } from "./providers";
import { isAllowedExtensionOAuthRedirectUri } from "./redirect-uri";

const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
// Fields the extension may forward. client_id / client_secret are injected.
const FORWARDED_FIELDS = [
  "grant_type",
  "code",
  "code_verifier",
  "redirect_uri",
  "refresh_token",
  "scope",
] as const;

export async function handleTokenExchange(
  request: Request,
  env: Env,
  origin: string | null,
  providerId: OAuthProviderId,
): Promise<Response> {
  const provider = getOAuthProvider(providerId);
  const { clientId, clientSecret } = provider.resolveCredentials(env);

  if (!clientId) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: `Worker is missing ${provider.label} client id for provider "${providerId}".`,
      },
      500,
      origin,
      env,
      "oauth",
    );
  }
  if (provider.requiresSecret && !clientSecret) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: `Worker is missing ${provider.label} client secret for confidential provider "${providerId}".`,
      },
      500,
      origin,
      env,
      "oauth",
    );
  }

  const parsed = await readFormParams(request);
  if (!parsed.ok) {
    if (parsed.reason === "too_large") {
      return jsonResponse(
        { error: "invalid_request", error_description: "Request body is too large." },
        413,
        origin,
        env,
        "oauth",
      );
    }
    return jsonResponse(
      { error: "invalid_request", error_description: "Malformed request body." },
      400,
      origin,
      env,
      "oauth",
    );
  }

  const grantType = parsed.params.get("grant_type") ?? "";
  if (!ALLOWED_GRANT_TYPES.has(grantType)) {
    return jsonResponse(
      {
        error: "unsupported_grant_type",
        error_description: `grant_type must be one of: ${[...ALLOWED_GRANT_TYPES].join(", ")}.`,
      },
      400,
      origin,
      env,
      "oauth",
    );
  }

  // Google OAuth domain policy: never exchange codes for non-extension redirects.
  // refresh_token grants omit redirect_uri and are unchanged.
  if (grantType === "authorization_code") {
    const redirectUri = parsed.params.get("redirect_uri") ?? "";
    const redirectCheck = isAllowedExtensionOAuthRedirectUri(redirectUri);
    if (!redirectCheck.ok) {
      return jsonResponse(
        {
          error: "invalid_request",
          error_description: redirectCheck.error,
        },
        400,
        origin,
        env,
        "oauth",
      );
    }
  }

  const upstream = new URLSearchParams();
  for (const field of FORWARDED_FIELDS) {
    const value = parsed.params.get(field);
    if (value) {
      upstream.set(field, value);
    }
  }
  // Pin client_id from the Worker (ignore any client-supplied values).
  upstream.set("client_id", clientId);
  if (clientSecret) {
    upstream.set("client_secret", clientSecret);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(provider.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: upstream,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      { error: "upstream_unreachable", error_description: detail },
      502,
      origin,
      env,
      "oauth",
    );
  }

  const payloadText = await upstreamResponse.text();
  return passthroughUpstream(payloadText, upstreamResponse, origin, env, "oauth");
}
