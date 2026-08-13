/**
 * Handles Google Drive OAuth token acquisition across Chromium-based browsers.
 *
 * Uses a strategy pattern to support both Chrome's native identity API and the
 * standard web auth flow for other Chromium browsers (Edge, Brave, Vivaldi, etc).
 */
import { getFeatureFlags } from "../platform/detect";
import {
  buildGoogleAuthorizationUrl,
  buildPkceAuthorizationCodeTokenParams,
  buildRefreshTokenParams,
  computeAccessTokenExpiresAt,
  createPkcePair,
  fetchOAuthTokenResponse,
  generateOAuthState,
  grantedScopesInclude,
  parseOAuthAuthorizationRedirect,
} from "../shared/oauth-pkce";
import {
  describeOAuthRedirectDebug,
  resolveRuntimeExtensionRedirectUri,
} from "../shared/oauth-redirect-policy";
import type { MessageResponse } from "../types/messages";

declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_WEB_CLIENT_ID__: string;
declare const __GOOGLE_TOKEN_PROXY_URL__: string;
declare const __APP_ENV__: string;

/** Chrome Extension client — manifest oauth2 + getAuthToken. */
const GOOGLE_CLIENT_ID = __GOOGLE_CLIENT_ID__;
/**
 * Web application client for launchWebAuthFlow + PKCE (and Worker token exchange).
 * Must have Authorized redirect URI = chrome.identity.getRedirectURL().
 * Falls back to GOOGLE_CLIENT_ID when unset at build time.
 */
const GOOGLE_WEB_CLIENT_ID =
  typeof __GOOGLE_WEB_CLIENT_ID__ === "string" && __GOOGLE_WEB_CLIENT_ID__.trim()
    ? __GOOGLE_WEB_CLIENT_ID__.trim()
    : GOOGLE_CLIENT_ID;
// Optional Cloudflare Worker that holds the OAuth client secret and proxies the
// token exchange. Required when the OAuth client is registered as a "Web
// application" (which rejects PKCE-only requests with "client_secret is
// missing"). When empty, token requests go straight to Google, which only works
// for public/installed OAuth clients.
const GOOGLE_TOKEN_PROXY_URL = __GOOGLE_TOKEN_PROXY_URL__;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_SCOPE = DRIVE_SCOPE;
const WEB_AUTH_TOKENS_KEY = "gn_tracing_webauth_tokens";
const LEGACY_WEB_AUTH_TOKEN_KEY = "gn_tracing_webauth_token";
const LEGACY_EDGE_TOKEN_KEY = "gn_tracing_edge_access_token";
const AUTH_STRATEGY_KEY = "gn_tracing_auth_strategy";
const GOOGLE_DRIVE_CONNECTED_KEY = "gn_tracing_google_drive_connected";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Token requests are sent to the Worker proxy when configured, otherwise
// directly to Google. The proxy speaks the same form-encoded token protocol and
// only adds the client_secret server-side, so callers stay identical.
const TOKEN_EXCHANGE_ENDPOINT = GOOGLE_TOKEN_PROXY_URL || GOOGLE_TOKEN_ENDPOINT;
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DRIVE_VERIFY_ENDPOINT = "https://www.googleapis.com/drive/v3/files?pageSize=1";
// Refresh tokens issued by Google for installed/public clients do not expire on
// a fixed schedule. Access-token expiry buffer is applied via
// computeAccessTokenExpiresAt. MIGRATED_TOKEN_EXPIRY_MS is only for the legacy
// short-lived token migration path.
const MIGRATED_TOKEN_EXPIRY_MS = 55 * 60_000;
const REFRESH_LEEWAY_MS = 30_000;
const TOKEN_REFRESH_TIMEOUT_MS = 8_000;

type AuthStrategy = "chrome" | "web";

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

/**
 * Writes a boolean mirror of the latest known Drive connection state into
 * `chrome.storage.local` so popup surfaces can paint the correct auth UI on
 * browser startup before the service worker finishes re-hydrating.
 */
async function mirrorGoogleDriveConnected(isConnected: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [GOOGLE_DRIVE_CONNECTED_KEY]: isConnected });
  } catch (e) {
    console.warn("[GoogleDriveAuth] Failed to mirror Drive connection state:", e);
  }
}

async function verifyDriveAccessToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(DRIVE_VERIFY_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function revokeGoogleToken(token: string): Promise<void> {
  const response = await fetch(`${TOKEN_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`);
  if (!response.ok) {
    throw new Error(`Token revoke failed with status ${response.status}`);
  }
}

interface AuthorizationCodeExchangePayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
}

interface AuthorizationCodeExchangeResult {
  ok: boolean;
  payload?: AuthorizationCodeExchangePayload;
  error?: string;
}

async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<AuthorizationCodeExchangeResult> {
  if (!GOOGLE_WEB_CLIENT_ID) {
    return {
      ok: false,
      error: "Missing GOOGLE_WEB_CLIENT_ID (or GOOGLE_CLIENT_ID) for web OAuth token exchange.",
    };
  }
  let response: Response;
  try {
    // Native-app Step 5: public client + PKCE (no client_secret in the extension).
    // https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code
    // Web flow must use the Web application client id (not Chrome Extension client).
    const body = buildPkceAuthorizationCodeTokenParams({
      clientId: GOOGLE_WEB_CLIENT_ID,
      code: params.code,
      codeVerifier: params.codeVerifier,
      redirectUri: params.redirectUri,
    });
    response = await fetch(TOKEN_EXCHANGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[GoogleDriveAuth] Authorization code exchange network error:", detail);
    return {
      ok: false,
      error: `Token exchange network error: ${detail}. Check that host_permissions include the token endpoint (${new URL(TOKEN_EXCHANGE_ENDPOINT).origin}/).`,
    };
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; error_description?: string };
      if (body.error) detail = `${body.error}: ${body.error_description || response.statusText}`;
    } catch {
      // ignore JSON parse errors, keep the basic status
    }
    console.error("[GoogleDriveAuth] Authorization code exchange HTTP error:", detail);
    return { ok: false, error: `Token exchange failed: ${detail}` };
  }
  try {
    const payload = (await response.json()) as AuthorizationCodeExchangePayload;
    return { ok: true, payload };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Token exchange returned an invalid JSON body: ${detail}` };
  }
}

interface TokenProvider {
  getAuthToken(): Promise<string | null>;
  launchInteractive(): Promise<MessageResponse>;
  disconnect(): Promise<MessageResponse>;
  isConnected(): Promise<boolean>;
}

class ChromeIdentityProvider implements TokenProvider {
  private normalizeToken(
    result: string | chrome.identity.GetAuthTokenResult | undefined | null,
  ): string | null {
    if (typeof result === "string") return result;
    return result?.token ?? null;
  }

  async getAuthToken(): Promise<string | null> {
    try {
      const result = await chrome.identity.getAuthToken({ interactive: false });
      return this.normalizeToken(result);
    } catch {
      return null;
    }
  }

  async launchInteractive(): Promise<MessageResponse> {
    try {
      const result = await chrome.identity.getAuthToken({
        interactive: true,
        scopes: [DRIVE_SCOPE],
      });
      const token = this.normalizeToken(result);
      if (!token) {
        return { ok: false, error: "No token received" };
      }
      if (!(await this.verifyToken(token))) {
        await this.removeCachedToken(token);
        return { ok: false, error: "Authentication failed. Please try again." };
      }
      return { ok: true, message: "Google Drive connected successfully" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Chrome identity OAuth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async disconnect(): Promise<MessageResponse> {
    const token = await this.getAuthToken();
    try {
      if (token) {
        try {
          await this.revokeToken(token);
        } catch (e) {
          console.warn("[GoogleDriveAuth] Token revoke failed during disconnect:", e);
        }
        try {
          await this.removeCachedToken(token);
        } catch (e) {
          console.warn("[GoogleDriveAuth] Cached token removal failed during disconnect:", e);
        }
      }
      await this.clearIdentityState();
      return { ok: true, message: "Disconnected from Google Drive" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Chrome disconnect error:", e);
      if (token) {
        try {
          await this.removeCachedToken(token);
        } catch {
          // Ignore follow-up cache cleanup failures.
        }
      }
      try {
        await this.clearIdentityState();
      } catch {
        // Ignore clear-all failures for already-invalid auth state.
      }
      return { ok: true, message: "Disconnected from Google Drive" };
    }
  }

  async isConnected(): Promise<boolean> {
    const token = await this.getAuthToken();
    if (!token) return false;
    return this.verifyToken(token);
  }

  private async removeCachedToken(token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  private async clearIdentityState(): Promise<void> {
    if (typeof chrome.identity.clearAllCachedAuthTokens === "function") {
      await chrome.identity.clearAllCachedAuthTokens();
    }
  }

  private async revokeToken(token: string): Promise<void> {
    await revokeGoogleToken(token);
  }

  private async verifyToken(token: string): Promise<boolean> {
    return verifyDriveAccessToken(token);
  }
}

class WebAuthFlowProvider implements TokenProvider {
  async getAuthToken(): Promise<string | null> {
    const cached = await this.getCachedTokens();
    if (!cached) return null;
    if (Date.now() < cached.expiresAt - REFRESH_LEEWAY_MS) {
      return cached.accessToken;
    }
    // Token expired or about to expire — try silent refresh via refresh token.
    const refreshed = await this.refreshAccessToken(cached.refreshToken);
    if (!refreshed) {
      await this.clearCachedTokens();
      return null;
    }
    return refreshed.accessToken;
  }

  async launchInteractive(): Promise<MessageResponse> {
    try {
      if (!GOOGLE_WEB_CLIENT_ID) {
        return {
          ok: false,
          error:
            "Google web OAuth client id is not configured. Set GOOGLE_WEB_CLIENT_ID (Web application) or GOOGLE_CLIENT_ID and rebuild.",
        };
      }

      // Google native-app OAuth (PKCE S256): Steps 1–5.
      // https://developers.google.com/identity/protocols/oauth2/native-app
      const pkce = await createPkcePair();
      const state = generateOAuthState();
      // Domain policy: only platform extension redirect hosts.
      // https://developers.google.com/identity/protocols/oauth2/policies#domains
      const redirect = resolveRuntimeExtensionRedirectUri();
      if (!redirect.ok) {
        return {
          ok: false,
          error: `${redirect.error}\n${describeOAuthRedirectDebug({
            webClientId: GOOGLE_WEB_CLIENT_ID,
          })}`,
        };
      }
      const redirectUri = redirect.redirectUri;

      const authUrl = buildGoogleAuthorizationUrl({
        // Must be Web application client — Chrome Extension clients reject redirect_uri.
        clientId: GOOGLE_WEB_CLIENT_ID,
        redirectUri,
        scope: DRIVE_FILE_SCOPE,
        codeChallenge: pkce.codeChallenge,
        state,
        authEndpoint: GOOGLE_AUTH_ENDPOINT,
        accessType: "offline",
        prompt: "consent",
        includeGrantedScopes: true,
      });

      let resultUrl: string | undefined;
      try {
        resultUrl = await chrome.identity.launchWebAuthFlow({
          url: authUrl,
          interactive: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          /redirect_uri_mismatch|redirect_uri|Authorization page could not be loaded/i.test(msg)
        ) {
          return {
            ok: false,
            error:
              `redirect_uri_mismatch (or auth page failed).\n` +
              `In Google Cloud Console open the *Web application* client (not Chrome Extension):\n` +
              `  client_id=${GOOGLE_WEB_CLIENT_ID}\n` +
              `Add this Authorized redirect URI (exact match):\n` +
              `  ${redirectUri}\n` +
              (redirectUri.startsWith("http://127.0.0.1/mozoauth2/")
                ? `Firefox uses the mozoauth2 loopback form (Google rejects email-style *.extensions.allizom.org hosts).\n`
                : `Also try without trailing slash: ${redirectUri.replace(/\/$/, "")}\n`) +
              `Then Save, wait ~1 min, reload the extension, Connect again.\n` +
              describeOAuthRedirectDebug({ webClientId: GOOGLE_WEB_CLIENT_ID }),
          };
        }
        throw e;
      }

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

      // Step 6: when Google returns a scope field, require drive.file.
      if (
        typeof exchanged.payload.scope === "string" &&
        exchanged.payload.scope.trim() &&
        !grantedScopesInclude(exchanged.payload.scope, [DRIVE_FILE_SCOPE])
      ) {
        return {
          ok: false,
          error:
            "Google did not grant the Drive file scope. Reconnect and allow file access for GN Tracing.",
        };
      }

      if (!(await verifyDriveAccessToken(accessToken))) {
        return { ok: false, error: "Authentication failed. Please try again." };
      }

      // Merge with existing refresh token when Google omits one in the exchange
      // response (happens when the user has already granted the scope).
      const existing = await this.getCachedTokens();
      const mergedRefreshToken = refreshToken || existing?.refreshToken;
      if (!mergedRefreshToken) {
        return {
          ok: false,
          error: "Google did not return a refresh token. Please disconnect and reconnect.",
        };
      }

      const expiresIn = Number.parseInt(`${exchanged.payload.expires_in || 3600}`, 10);
      const expiresAt = computeAccessTokenExpiresAt(expiresIn);
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
      await mirrorGoogleDriveConnected(true);

      return { ok: true, message: "Google Drive connected successfully" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Web auth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async disconnect(): Promise<MessageResponse> {
    const cached = await this.getCachedTokens();
    if (cached) {
      // Revoke both tokens; failures are non-fatal because Google may have
      // already invalidated them or the user may be offline.
      await revokeGoogleToken(cached.refreshToken).catch((e) => {
        console.warn("[GoogleDriveAuth] Refresh token revoke failed during disconnect:", e);
      });
      await revokeGoogleToken(cached.accessToken).catch((e) => {
        console.warn("[GoogleDriveAuth] Access token revoke failed during disconnect:", e);
      });
    }
    await this.clearCachedTokens();
    await mirrorGoogleDriveConnected(false);
    return { ok: true, message: "Disconnected from Google Drive" };
  }

  async isConnected(): Promise<boolean> {
    const token = await this.getAuthToken();
    return token !== null;
  }

  private async getCachedTokens(): Promise<WebAuthTokens | null> {
    try {
      const result = await chrome.storage.local.get(WEB_AUTH_TOKENS_KEY);
      const stored = result[WEB_AUTH_TOKENS_KEY];
      if (isWebAuthTokens(stored)) {
        return stored;
      }
    } catch {
      // Ignore storage read errors.
    }
    return null;
  }

  private async setCachedTokens(tokens: WebAuthTokens): Promise<void> {
    await chrome.storage.local.set({ [WEB_AUTH_TOKENS_KEY]: tokens });
  }

  private async clearCachedTokens(): Promise<void> {
    await chrome.storage.local.remove(WEB_AUTH_TOKENS_KEY);
  }

  private async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: number;
  } | null> {
    if (!GOOGLE_WEB_CLIENT_ID) {
      return null;
    }
    try {
      const response = await fetchOAuthTokenResponse({
        url: TOKEN_EXCHANGE_ENDPOINT,
        body: buildRefreshTokenParams({
          clientId: GOOGLE_WEB_CLIENT_ID,
          refreshToken,
        }),
        timeoutMs: TOKEN_REFRESH_TIMEOUT_MS,
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        access_token?: string;
        expires_in?: number | string;
      };
      if (typeof payload.access_token !== "string") {
        return null;
      }
      const expiresIn = Number.parseInt(`${payload.expires_in ?? 3600}`, 10);
      const expiresAt = computeAccessTokenExpiresAt(expiresIn);
      // Persist refreshed tokens, preserving the existing refresh token.
      const current = await this.getCachedTokens();
      if (current) {
        await this.setCachedTokens({
          ...current,
          accessToken: payload.access_token,
          expiresAt,
          obtainedAt: Date.now(),
        });
      }
      return { accessToken: payload.access_token, expiresAt };
    } catch (e) {
      console.warn("[GoogleDriveAuth] Silent token refresh failed:", e);
      return null;
    }
  }
}

/**
 * Google Drive auth facade for Chromium-based browsers.
 *
 * Detects the best auth strategy by capability: Google Chrome uses the native
 * identity API, while other Chromium browsers use the standard web auth flow
 * with a local token cache. Falls back at runtime when brand detection is
 * spoofed (e.g. Vivaldi reporting as Chrome).
 */
export class GoogleDriveAuth {
  private chromeProvider = new ChromeIdentityProvider();
  private webProvider = new WebAuthFlowProvider();
  private strategy: AuthStrategy | null = null;
  private strategyPromise: Promise<AuthStrategy> | null = null;
  private migrationDone = false;

  async initialize(): Promise<void> {
    await this.migrateLegacyEdgeToken();
    await this.resolveStrategy();
  }

  private async migrateLegacyEdgeToken(): Promise<void> {
    if (this.migrationDone) return;
    try {
      const legacyKeys = [LEGACY_EDGE_TOKEN_KEY, LEGACY_WEB_AUTH_TOKEN_KEY];
      const result = await chrome.storage.local.get(legacyKeys);

      const legacyEdgeToken = result[LEGACY_EDGE_TOKEN_KEY] as string | undefined;
      if (legacyEdgeToken) {
        const ok = await verifyDriveAccessToken(legacyEdgeToken);
        if (ok) {
          // The legacy implicit-flow token has no refresh token. Grant it a
          // short window so the popup stays connected during the same session
          // but the user is asked to reconnect after the implicit token
          // expires — at which point the auth flow will issue a refresh token.
          await chrome.storage.local.set({
            [WEB_AUTH_TOKENS_KEY]: {
              accessToken: legacyEdgeToken,
              // Placeholder; the legacy token has no refresh token, so silent
              // refresh will fail and the user will be asked to reconnect.
              refreshToken: "",
              expiresAt: Date.now() + MIGRATED_TOKEN_EXPIRY_MS,
              obtainedAt: Date.now(),
            } satisfies WebAuthTokens,
          });
          await mirrorGoogleDriveConnected(true);
        }
        await chrome.storage.local.remove(LEGACY_EDGE_TOKEN_KEY);
      }

      // The legacy web auth token cache (single accessToken, no refresh token)
      // is unusable with the new auth code + PKCE flow. Drop it so the user is
      // forced to reconnect once and receive a refresh token.
      const legacyWebToken = result[LEGACY_WEB_AUTH_TOKEN_KEY];
      if (legacyWebToken !== undefined) {
        await chrome.storage.local.remove(LEGACY_WEB_AUTH_TOKEN_KEY);
        if (!isWebAuthTokens(await this.getRawCachedTokens())) {
          await mirrorGoogleDriveConnected(false);
        }
      }
    } catch {
      // Best-effort migration; do not block initialization.
    } finally {
      this.migrationDone = true;
    }
  }

  private async getRawCachedTokens(): Promise<unknown> {
    try {
      const result = await chrome.storage.local.get(WEB_AUTH_TOKENS_KEY);
      return result[WEB_AUTH_TOKENS_KEY];
    } catch {
      return undefined;
    }
  }

  private resolveStrategy(): Promise<AuthStrategy> {
    if (this.strategy) return Promise.resolve(this.strategy);
    if (this.strategyPromise) return this.strategyPromise;

    const pending = (async (): Promise<AuthStrategy> => {
      // Dev/watch builds mint a distinct extension id (esbuild.config.mjs,
      // CHROME_EXTENSION_PUBLIC_KEY_DEV) so unpacked dev doesn't collide with an
      // installed production extension. The "Chrome extension" OAuth client
      // (GOOGLE_CLIENT_ID) is bound to the production id only, so
      // chrome.identity.getAuthToken() always fails there — force PKCE.
      // Checked against "development" specifically (not `!== "production"`) so
      // the vitest sentinel value "test" (see vitest.config.ts) still exercises
      // the normal persisted/detected strategy branches below.
      if (__APP_ENV__ === "development") {
        this.strategy = "web";
        return "web";
      }

      try {
        const stored = await chrome.storage.local.get(AUTH_STRATEGY_KEY);
        const persisted = stored[AUTH_STRATEGY_KEY];
        if (persisted === "chrome" || persisted === "web") {
          this.strategy = persisted;
          return persisted;
        }
      } catch {
        // Ignore storage read errors and fall through to detection.
      }

      // Edge / Opera / Firefox packages never use getAuthToken (Chrome extension
      // OAuth client only). Chrome may use getAuthToken when brand detection says
      // Google Chrome; otherwise force web PKCE so store builds do not depend on
      // brand UA alone.
      const flags = getFeatureFlags();
      const detected: AuthStrategy =
        flags.chromeIdentityGetAuthToken && this.detectGoogleChrome() ? "chrome" : "web";
      this.strategy = detected;
      return detected;
    })();

    this.strategyPromise = pending;
    return pending;
  }

  private detectGoogleChrome(): boolean {
    // Service-worker / Node test contexts may lack `navigator` (e.g. CI unit runs).
    if (typeof navigator === "undefined") return false;

    const uaData = (
      navigator as Navigator & {
        userAgentData?: { brands: Array<{ brand: string }>; mobile: boolean };
      }
    ).userAgentData;

    if (uaData?.brands) {
      const brands = uaData.brands.map((b) => b.brand);
      const hasChrome = brands.includes("Google Chrome");
      const hasOtherBrand = brands.some(
        (b) =>
          b !== "Google Chrome" &&
          b !== "Chromium" &&
          b !== "Not.A/Brand" &&
          b !== "Not_A Brand" &&
          b !== "Not?A_Brand",
      );
      return hasChrome && !hasOtherBrand;
    }

    const ua = navigator.userAgent;
    return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
  }

  private async persistStrategy(strategy: AuthStrategy): Promise<void> {
    this.strategy = strategy;
    try {
      await chrome.storage.local.set({ [AUTH_STRATEGY_KEY]: strategy });
    } catch {
      // Ignore persistence failures.
    }
  }

  async getAuthToken(): Promise<string | null> {
    const strategy = await this.resolveStrategy();

    if (strategy === "chrome") {
      const token = await this.chromeProvider.getAuthToken();
      if (token) return token;
      // Chrome provider failed; fall back to web auth flow at runtime.
      await this.persistStrategy("web");
      return this.webProvider.getAuthToken();
    }

    return this.webProvider.getAuthToken();
  }

  async launchOAuthFlow(): Promise<MessageResponse> {
    const strategy = await this.resolveStrategy();

    if (strategy === "chrome") {
      // Chrome Extension OAuth client + getAuthToken (no redirect_uri).
      const result = await this.chromeProvider.launchInteractive();
      if (result.ok) return result;

      // Only fall back to web PKCE when a *separate* Web application client is
      // configured. Using the Chrome Extension client_id with launchWebAuthFlow
      // always yields redirect_uri_mismatch.
      const hasSeparateWebClient =
        Boolean(GOOGLE_WEB_CLIENT_ID) &&
        Boolean(GOOGLE_CLIENT_ID) &&
        GOOGLE_WEB_CLIENT_ID !== GOOGLE_CLIENT_ID;

      if (!hasSeparateWebClient) {
        return {
          ok: false,
          error:
            `Chrome identity sign-in failed: ${result.error || "unknown error"}.\n` +
            `Fix Chrome Extension OAuth client in Google Cloud Console:\n` +
            `  • Client type: Chrome extension\n` +
            `  • Item ID must equal this extension id: ${chrome.runtime?.id || "(reload extension)"}\n` +
            `  • Client ID must match GOOGLE_CLIENT_ID in .env and rebuild.\n` +
            `Or set GOOGLE_WEB_CLIENT_ID to a Web application client and add redirect URI:\n` +
            `  https://${chrome.runtime?.id || "YOUR_EXTENSION_ID"}.chromiumapp.org/`,
        };
      }

      console.warn(
        "[GoogleDriveAuth] Chrome identity flow failed, falling back to web auth flow:",
        result.error,
      );
      const webResult = await this.webProvider.launchInteractive();
      if (webResult.ok) {
        await this.persistStrategy("web");
      }
      return webResult;
    }

    return this.webProvider.launchInteractive();
  }

  async disconnect(): Promise<MessageResponse> {
    const strategy = await this.resolveStrategy();
    const result =
      strategy === "chrome"
        ? await this.chromeProvider.disconnect()
        : await this.webProvider.disconnect();

    // Clear any residual state from the other provider.
    try {
      if (strategy === "chrome") {
        await chrome.storage.local.remove(WEB_AUTH_TOKENS_KEY);
      } else {
        await this.chromeProvider.disconnect();
      }
    } catch {
      // Best-effort cleanup of residual provider state.
    }

    try {
      await chrome.storage.local.remove(AUTH_STRATEGY_KEY);
    } catch {
      // Ignore storage cleanup errors.
    }
    await mirrorGoogleDriveConnected(false);
    this.strategy = null;
    this.strategyPromise = null;

    return result;
  }

  async getStatus(): Promise<{ isConnected: boolean }> {
    const strategy = await this.resolveStrategy();

    if (strategy === "web") {
      // Web auth flow tokens carry local expiry; silent refresh may extend
      // them without UI prompting, so trust the provider's verdict.
      const token = await this.webProvider.getAuthToken();
      const isConnected = token !== null;
      await mirrorGoogleDriveConnected(isConnected);
      return { isConnected };
    }

    const isConnected = await this.chromeProvider.isConnected();
    await mirrorGoogleDriveConnected(isConnected);
    return { isConnected };
  }

  /**
   * Returns the last known connection state from `chrome.storage.local` so the
   * popup can paint the correct UI before the service worker re-hydrates.
   */
  static async getMirroredConnectionState(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(GOOGLE_DRIVE_CONNECTED_KEY);
      return Boolean(result[GOOGLE_DRIVE_CONNECTED_KEY]);
    } catch {
      return false;
    }
  }
}
