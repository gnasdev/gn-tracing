/**
 * Dropbox OAuth via chrome.identity.launchWebAuthFlow + PKCE.
 *
 * Prefer a public Dropbox app client (no secret). When the app requires a
 * client secret, set DROPBOX_TOKEN_PROXY_URL to a **Dropbox-aware** Worker that
 * injects the secret. The existing Google OAuth Worker (`GOOGLE_TOKEN_PROXY_URL`)
 * does **not** support Dropbox grants as-is — confidential Dropbox apps need a
 * dedicated route/issuer (optional P1 follow-up). Tokens are cached under a
 * Dropbox-only storage key so disconnect does not clear Google credentials.
 */
import {
  buildPkceAuthorizationCodeTokenParams,
  buildRefreshTokenParams,
  createPkcePair,
  generateOAuthState,
  parseOAuthAuthorizationRedirect,
} from "../shared/oauth-pkce";
import { resolveRuntimeExtensionRedirectUri } from "../shared/oauth-redirect-policy";
import type { MessageResponse } from "../types/messages";

declare const __DROPBOX_CLIENT_ID__: string;
declare const __DROPBOX_TOKEN_PROXY_URL__: string;

const DROPBOX_CLIENT_ID = typeof __DROPBOX_CLIENT_ID__ === "string" ? __DROPBOX_CLIENT_ID__ : "";
const DROPBOX_TOKEN_PROXY_URL =
  typeof __DROPBOX_TOKEN_PROXY_URL__ === "string" ? __DROPBOX_TOKEN_PROXY_URL__ : "";

const DROPBOX_AUTH_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";
const DROPBOX_TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
const DROPBOX_REVOKE_ENDPOINT = "https://api.dropboxapi.com/2/auth/token/revoke";
const DROPBOX_VERIFY_ENDPOINT = "https://api.dropboxapi.com/2/users/get_current_account";
const TOKEN_EXCHANGE_ENDPOINT = DROPBOX_TOKEN_PROXY_URL || DROPBOX_TOKEN_ENDPOINT;

/** Scoped apps: content write/read + sharing. Full Dropbox apps ignore scope. */
const DROPBOX_SCOPES = [
  "files.content.write",
  "files.content.read",
  "sharing.write",
  "sharing.read",
  "account_info.read",
].join(" ");

const WEB_AUTH_TOKENS_KEY = "gn_tracing_tokens_dropbox";
const DROPBOX_CONNECTED_KEY = "gn_tracing_dropbox_connected";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const REFRESH_LEEWAY_MS = 30_000;
const TOKEN_REFRESH_TIMEOUT_MS = 8_000;

/** OAuth error codes that mean the refresh token is permanently unusable. */
const REFRESH_AUTH_DEATH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_client",
  "unauthorized_client",
]);

/**
 * Whether a failed token refresh should clear the local token cache.
 * Auth-death (401, or 400 with invalid_grant/etc.) → fatal.
 * Rate limits (429), request timeouts (408), other 4xx/5xx → keep refresh token.
 */
export function isDropboxRefreshAuthDeath(status: number, errorCode?: string): boolean {
  if (status === 401) {
    return true;
  }
  if (status === 400) {
    const code = String(errorCode || "")
      .trim()
      .toLowerCase();
    // Bare 400 without a known death code: treat as fatal only if OAuth named it.
    // Missing code often still means invalid_grant from Dropbox — be conservative
    // for 400 (common for dead refresh tokens) but never for 429/408.
    if (!code) {
      return true;
    }
    return REFRESH_AUTH_DEATH_ERRORS.has(code);
  }
  return false;
}

interface WebAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  obtainedAt: number;
}

function isWebAuthTokens(value: unknown): value is WebAuthTokens {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WebAuthTokens>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.obtainedAt === "number"
  );
}

async function mirrorDropboxConnected(isConnected: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [DROPBOX_CONNECTED_KEY]: isConnected });
  } catch (e) {
    console.warn("[DropboxAuth] Failed to mirror connection state:", e);
  }
}

async function verifyDropboxAccessToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(DROPBOX_VERIFY_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface AuthorizationCodeExchangePayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
}

async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ ok: boolean; payload?: AuthorizationCodeExchangePayload; error?: string }> {
  if (!DROPBOX_CLIENT_ID) {
    return { ok: false, error: "Missing DROPBOX_CLIENT_ID" };
  }
  let response: Response;
  try {
    response = await fetch(TOKEN_EXCHANGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildPkceAuthorizationCodeTokenParams({
        clientId: DROPBOX_CLIENT_ID,
        code: params.code,
        codeVerifier: params.codeVerifier,
        redirectUri: params.redirectUri,
      }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Token exchange network error: ${detail}. Check host_permissions for the token endpoint.`,
    };
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; error_description?: string };
      if (body.error) detail = `${body.error}: ${body.error_description || response.statusText}`;
    } catch {
      // ignore
    }
    return { ok: false, error: `Token exchange failed: ${detail}` };
  }
  try {
    const payload = (await response.json()) as AuthorizationCodeExchangePayload;
    return { ok: true, payload };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Token exchange returned invalid JSON: ${detail}` };
  }
}

/**
 * Dropbox auth facade. Always uses web auth flow + local token cache (Dropbox
 * has no chrome.identity.getAuthToken integration).
 */
export class DropboxAuth {
  async getAuthToken(): Promise<string | null> {
    const cached = await this.getCachedTokens();
    if (!cached) return null;
    if (Date.now() < cached.expiresAt - REFRESH_LEEWAY_MS) {
      return cached.accessToken;
    }
    if (!cached.refreshToken) {
      await this.clearCachedTokens();
      await mirrorDropboxConnected(false);
      return null;
    }
    const refreshed = await this.refreshAccessToken(cached.refreshToken);
    if (refreshed.ok) {
      return refreshed.accessToken;
    }
    // Clear tokens only on invalid_grant / 4xx auth failures. Transient network
    // or 5xx keeps the refresh token so a later attempt can succeed.
    if (refreshed.fatal) {
      await this.clearCachedTokens();
      await mirrorDropboxConnected(false);
    }
    return null;
  }

  async launchOAuthFlow(): Promise<MessageResponse> {
    try {
      if (!DROPBOX_CLIENT_ID) {
        return {
          ok: false,
          error: "Dropbox OAuth client id is not configured. Set DROPBOX_CLIENT_ID and rebuild.",
        };
      }

      const pkce = await createPkcePair();
      const state = generateOAuthState();
      // Same domain policy as Google: only platform extension redirect hosts.
      const redirect = resolveRuntimeExtensionRedirectUri();
      if (!redirect.ok) {
        return { ok: false, error: redirect.error };
      }
      const redirectUri = redirect.redirectUri;

      const authQuery = new URLSearchParams({
        client_id: DROPBOX_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
        state,
        token_access_type: "offline",
        scope: DROPBOX_SCOPES,
      });
      const authUrl = `${DROPBOX_AUTH_ENDPOINT}?${authQuery.toString()}`;

      const resultUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true,
      });

      const parsed = parseOAuthAuthorizationRedirect(resultUrl || "", state);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const exchanged = await exchangeAuthorizationCode({
        code: parsed.code,
        codeVerifier: pkce.codeVerifier,
        redirectUri,
      });
      if (!exchanged.ok || !exchanged.payload) {
        return {
          ok: false,
          error: exchanged.error || "Token exchange failed. Please try again.",
        };
      }

      const { access_token: accessToken, refresh_token: refreshToken } = exchanged.payload;
      if (!accessToken) {
        return { ok: false, error: "No access token in exchange response" };
      }

      if (!(await verifyDropboxAccessToken(accessToken))) {
        return { ok: false, error: "Authentication failed. Please try again." };
      }

      const existing = await this.getCachedTokens();
      // Dropbox usually returns a refresh token when token_access_type=offline.
      // If omitted, keep any existing one; fail only when neither is available.
      const mergedRefreshToken = refreshToken || existing?.refreshToken || "";
      if (!mergedRefreshToken) {
        console.warn(
          "[DropboxAuth] No refresh token returned; session will expire with the access token.",
        );
      }

      const expiresIn = Number.parseInt(`${exchanged.payload.expires_in || 14400}`, 10);
      const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;
      const tokens: WebAuthTokens = {
        accessToken,
        refreshToken: mergedRefreshToken,
        expiresAt,
        obtainedAt: Date.now(),
        scope: typeof exchanged.payload.scope === "string" ? exchanged.payload.scope : undefined,
        tokenType:
          typeof exchanged.payload.token_type === "string"
            ? exchanged.payload.token_type
            : undefined,
      };
      await this.setCachedTokens(tokens);
      await mirrorDropboxConnected(true);
      return { ok: true, message: "Dropbox connected successfully" };
    } catch (e) {
      console.error("[DropboxAuth] Web auth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async disconnect(): Promise<MessageResponse> {
    const cached = await this.getCachedTokens();
    if (cached?.accessToken) {
      try {
        await fetch(DROPBOX_REVOKE_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${cached.accessToken}` },
        });
      } catch (e) {
        console.warn("[DropboxAuth] Token revoke failed during disconnect:", e);
      }
    }
    await this.clearCachedTokens();
    await mirrorDropboxConnected(false);
    return { ok: true, message: "Disconnected from Dropbox" };
  }

  async getStatus(): Promise<{ isConnected: boolean }> {
    const token = await this.getAuthToken();
    const isConnected = token !== null;
    await mirrorDropboxConnected(isConnected);
    return { isConnected };
  }

  static async getMirroredConnectionState(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(DROPBOX_CONNECTED_KEY);
      return Boolean(result[DROPBOX_CONNECTED_KEY]);
    } catch {
      return false;
    }
  }

  private async getCachedTokens(): Promise<WebAuthTokens | null> {
    try {
      const result = await chrome.storage.local.get(WEB_AUTH_TOKENS_KEY);
      const stored = result[WEB_AUTH_TOKENS_KEY];
      if (isWebAuthTokens(stored)) {
        return stored;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async setCachedTokens(tokens: WebAuthTokens): Promise<void> {
    await chrome.storage.local.set({ [WEB_AUTH_TOKENS_KEY]: tokens });
  }

  private async clearCachedTokens(): Promise<void> {
    await chrome.storage.local.remove(WEB_AUTH_TOKENS_KEY);
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ ok: true; accessToken: string; expiresAt: number } | { ok: false; fatal: boolean }> {
    if (!DROPBOX_CLIENT_ID || !refreshToken) {
      return { ok: false, fatal: true };
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(TOKEN_EXCHANGE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: buildRefreshTokenParams({
            clientId: DROPBOX_CLIENT_ID,
            refreshToken,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!response.ok) {
        // Only auth-death is fatal (clear cache). Rate limits (429), timeouts
        // (408), and other transient 4xx/5xx keep the refresh token for retry.
        let errorCode = "";
        try {
          const errBody = (await response.clone().json()) as {
            error?: string;
            error_description?: string;
          };
          errorCode = typeof errBody.error === "string" ? errBody.error : "";
        } catch {
          // ignore body parse failures
        }
        const fatal = isDropboxRefreshAuthDeath(response.status, errorCode);
        return { ok: false, fatal };
      }
      const payload = (await response.json()) as {
        access_token?: string;
        expires_in?: number | string;
        refresh_token?: string;
      };
      if (typeof payload.access_token !== "string") {
        return { ok: false, fatal: true };
      }
      const expiresIn = Number.parseInt(`${payload.expires_in ?? 14400}`, 10);
      const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;
      const current = await this.getCachedTokens();
      if (current) {
        await this.setCachedTokens({
          ...current,
          accessToken: payload.access_token,
          // Dropbox may rotate refresh tokens.
          refreshToken:
            typeof payload.refresh_token === "string" && payload.refresh_token
              ? payload.refresh_token
              : current.refreshToken,
          expiresAt,
          obtainedAt: Date.now(),
        });
      }
      return { ok: true, accessToken: payload.access_token, expiresAt };
    } catch (e) {
      console.warn("[DropboxAuth] Silent token refresh failed:", e);
      // Network / abort — non-fatal; keep refresh token.
      return { ok: false, fatal: false };
    }
  }
}
