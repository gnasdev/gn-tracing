/**
 * RFC 7636 PKCE (Proof Key for Code Exchange) for installed / extension OAuth.
 *
 * Implements Google's native-app Step 1–5 building blocks:
 * https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier
 *
 * - code_verifier: high-entropy [A-Z a-z 0-9 - . _ ~], length 43–128
 * - code_challenge: BASE64URL(SHA-256(verifier)) with method S256
 */

/** Unreserved characters allowed in code_verifier (RFC 7636 §4.1). */
const VERIFIER_CHARSET = /^[A-Za-z0-9\-._~]+$/;

export const PKCE_CODE_CHALLENGE_METHOD_S256 = "S256" as const;

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof PKCE_CODE_CHALLENGE_METHOD_S256;
};

/** BASE64URL without padding (RFC 7636 / RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a cryptographically random code_verifier.
 * 32 random bytes → 43-char base64url (minimum RFC length).
 */
export function generateCodeVerifier(byteLength = 32): string {
  if (byteLength < 32 || byteLength > 96) {
    throw new Error("code_verifier entropy must be 32–96 random bytes (43–128 base64url chars).");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const verifier = base64UrlEncode(bytes);
  if (!isValidCodeVerifier(verifier)) {
    throw new Error("Generated code_verifier failed RFC 7636 validation.");
  }
  return verifier;
}

export function isValidCodeVerifier(verifier: string): boolean {
  if (typeof verifier !== "string") {
    return false;
  }
  if (verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  return VERIFIER_CHARSET.test(verifier);
}

/** S256 code_challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export async function generateCodeChallengeS256(codeVerifier: string): Promise<string> {
  if (!isValidCodeVerifier(codeVerifier)) {
    throw new Error("code_verifier is invalid (RFC 7636 length/charset).");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Create a full PKCE pair for one authorization request. */
export async function createPkcePair(byteLength = 32): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier(byteLength);
  const codeChallenge = await generateCodeChallengeS256(codeVerifier);
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD_S256,
  };
}

/** Opaque CSRF state (same charset rules as verifier; not a PKCE secret). */
export function generateOAuthState(): string {
  return generateCodeVerifier(32);
}

export type GoogleAuthorizationUrlParams = {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state: string;
  /** Defaults to Google authorize endpoint. */
  authEndpoint?: string;
  accessType?: "online" | "offline";
  prompt?: string;
  includeGrantedScopes?: boolean;
  codeChallengeMethod?: typeof PKCE_CODE_CHALLENGE_METHOD_S256;
};

/**
 * Build Google OAuth 2.0 authorization URL for installed apps (native + extension web flow).
 * Step 2 of the native-app guide.
 */
export function buildGoogleAuthorizationUrl(params: GoogleAuthorizationUrlParams): string {
  if (!params.clientId.trim()) {
    throw new Error("client_id is required.");
  }
  if (!params.redirectUri.trim()) {
    throw new Error("redirect_uri is required.");
  }
  if (!params.codeChallenge.trim()) {
    throw new Error("code_challenge is required.");
  }
  if (!params.state.trim()) {
    throw new Error("state is required.");
  }

  const endpoint = params.authEndpoint || "https://accounts.google.com/o/oauth2/v2/auth";
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scope,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod || PKCE_CODE_CHALLENGE_METHOD_S256,
    state: params.state,
    access_type: params.accessType || "offline",
  });
  if (params.prompt) {
    query.set("prompt", params.prompt);
  }
  if (params.includeGrantedScopes !== false) {
    query.set("include_granted_scopes", "true");
  }
  return `${endpoint}?${query.toString()}`;
}

export type OAuthRedirectParseResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

/**
 * Parse authorization redirect (Step 4). Validates CSRF state.
 */
export function parseOAuthAuthorizationRedirect(
  resultUrl: string,
  expectedState: string,
): OAuthRedirectParseResult {
  if (!resultUrl) {
    return { ok: false, error: "No redirect URL received" };
  }
  let url: URL;
  try {
    url = new URL(resultUrl);
  } catch {
    return { ok: false, error: "OAuth redirect URL is invalid" };
  }

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    const desc = url.searchParams.get("error_description");
    return {
      ok: false,
      error: desc
        ? `Authorization error: ${errorParam} (${desc})`
        : `Authorization error: ${errorParam}`,
    };
  }

  const returnedState = url.searchParams.get("state");
  if (!returnedState || returnedState !== expectedState) {
    return { ok: false, error: "OAuth state mismatch. Please try again." };
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return { ok: false, error: "No authorization code in redirect" };
  }

  return { ok: true, code, state: returnedState };
}

/**
 * Form body for Step 5: exchange authorization code for tokens (public client + PKCE).
 * client_secret is intentionally omitted — installed/extension public clients use PKCE.
 */
export function buildPkceAuthorizationCodeTokenParams(params: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): URLSearchParams {
  if (!isValidCodeVerifier(params.codeVerifier)) {
    throw new Error("code_verifier is invalid for token exchange.");
  }
  return new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
}

/**
 * Step 6: verify granted scopes (space-separated, case-sensitive per Google).
 * Returns true when every required scope appears in the granted set.
 */
export function grantedScopesInclude(
  grantedScopeField: string | undefined | null,
  requiredScopes: string[],
): boolean {
  if (!requiredScopes.length) {
    return true;
  }
  if (!grantedScopeField || typeof grantedScopeField !== "string") {
    // Some Google responses omit scope when unchanged; callers may treat as unknown.
    return false;
  }
  const granted = new Set(
    grantedScopeField
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return requiredScopes.every((scope) => granted.has(scope));
}

/** Form body for refresh_token grant (no PKCE verifier). */
export function buildRefreshTokenParams(params: {
  clientId: string;
  refreshToken: string;
}): URLSearchParams {
  return new URLSearchParams({
    client_id: params.clientId,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });
}

/** OAuth error codes that mean the refresh token is permanently unusable. */
export const OAUTH_REFRESH_AUTH_DEATH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_client",
  "unauthorized_client",
]);

/**
 * Whether a failed token refresh should clear the local token cache.
 * Auth-death (401, or 400 with invalid_grant/etc.) is fatal.
 * Rate limits (429), request timeouts (408), other 4xx/5xx keep the refresh token.
 *
 * `bare400IsFatal`: Dropbox often returns bare 400 for a dead refresh token;
 * Google's path treats any non-OK as soft-fail without this helper.
 */
export function isOAuthRefreshAuthDeath(
  status: number,
  errorCode?: string,
  options: { bare400IsFatal?: boolean } = {},
): boolean {
  const bare400IsFatal = options.bare400IsFatal ?? true;
  if (status === 401) {
    return true;
  }
  if (status === 400) {
    const code = String(errorCode || "")
      .trim()
      .toLowerCase();
    if (!code) {
      return bare400IsFatal;
    }
    return OAUTH_REFRESH_AUTH_DEATH_ERRORS.has(code);
  }
  return false;
}

/** Shared leeway when converting `expires_in` seconds into an absolute expiry. */
export const OAUTH_TOKEN_EXPIRY_BUFFER_MS = 60_000;

export function computeAccessTokenExpiresAt(
  expiresInSeconds: number,
  nowMs = Date.now(),
  bufferMs = OAUTH_TOKEN_EXPIRY_BUFFER_MS,
): number {
  return nowMs + expiresInSeconds * 1000 - bufferMs;
}

/**
 * POST a form body to a token endpoint with an abort timeout.
 * Shared by Drive/Dropbox refresh and exchange paths.
 */
export async function fetchOAuthTokenResponse(input: {
  url: string;
  body: URLSearchParams;
  timeoutMs: number;
  headers?: Record<string, string>;
}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await fetch(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...input.headers,
      },
      body: input.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
