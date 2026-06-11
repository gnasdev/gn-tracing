/**
 * Handles Google Drive OAuth token acquisition across Chromium-based browsers.
 *
 * Uses a strategy pattern to support both Chrome's native identity API and the
 * standard web auth flow for other Chromium browsers (Edge, Brave, Vivaldi, etc).
 */
import type { MessageResponse } from "../types/messages";

declare const __GOOGLE_CLIENT_ID__: string;

const GOOGLE_CLIENT_ID = __GOOGLE_CLIENT_ID__;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const WEB_AUTH_TOKEN_KEY = "gn_tracing_webauth_token";
const LEGACY_EDGE_TOKEN_KEY = "gn_tracing_edge_access_token";
const AUTH_STRATEGY_KEY = "gn_tracing_auth_strategy";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const MIGRATED_TOKEN_EXPIRY_MS = 55 * 60_000;

type AuthStrategy = "chrome" | "web";

interface CachedWebToken {
  accessToken: string;
  expiresAt: number;
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

  private async revokeToken(token: string): Promise<void> {
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    );
    if (!response.ok) {
      throw new Error(`Token revoke failed with status ${response.status}`);
    }
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

  private async verifyToken(token: string): Promise<boolean> {
    const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  }
}

class WebAuthFlowProvider implements TokenProvider {
  async getAuthToken(): Promise<string | null> {
    const cached = await this.getCachedToken();
    if (!cached) return null;
    if (Date.now() >= cached.expiresAt) {
      await this.clearCachedToken();
      return null;
    }
    return cached.accessToken;
  }

  async launchInteractive(): Promise<MessageResponse> {
    try {
      if (!GOOGLE_CLIENT_ID) {
        return {
          ok: false,
          error: "Google OAuth client id is not configured. Set GOOGLE_CLIENT_ID and rebuild.",
        };
      }

      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        `?client_id=${GOOGLE_CLIENT_ID}` +
        "&response_type=token" +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(DRIVE_SCOPE)}` +
        "&prompt=consent";

      const resultUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true,
      });

      if (!resultUrl) {
        return { ok: false, error: "No redirect URL received" };
      }

      const hash = new URL(resultUrl).hash;
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get("access_token");

      if (!accessToken) {
        return { ok: false, error: "No access token" };
      }

      if (!(await this.verifyToken(accessToken))) {
        return { ok: false, error: "Authentication failed. Please try again." };
      }

      const expiresIn = Number.parseInt(params.get("expires_in") || "3600", 10);
      const expiresAt = Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_BUFFER_MS;
      await this.setCachedToken({ accessToken, expiresAt });

      return { ok: true, message: "Google Drive connected successfully" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Web auth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async disconnect(): Promise<MessageResponse> {
    const cached = await this.getCachedToken();
    try {
      if (cached) {
        await this.revokeToken(cached.accessToken);
      }
    } catch (e) {
      console.error("[GoogleDriveAuth] Web auth disconnect revoke error:", e);
    } finally {
      await this.clearCachedToken();
    }
    return { ok: true, message: "Disconnected from Google Drive" };
  }

  async isConnected(): Promise<boolean> {
    const token = await this.getAuthToken();
    return token !== null;
  }

  private async getCachedToken(): Promise<CachedWebToken | null> {
    try {
      const result = await chrome.storage.local.get(WEB_AUTH_TOKEN_KEY);
      const stored = result[WEB_AUTH_TOKEN_KEY];
      if (
        stored &&
        typeof stored === "object" &&
        typeof (stored as CachedWebToken).accessToken === "string" &&
        typeof (stored as CachedWebToken).expiresAt === "number"
      ) {
        return stored as CachedWebToken;
      }
    } catch {
      // Ignore storage read errors.
    }
    return null;
  }

  private async setCachedToken(token: CachedWebToken): Promise<void> {
    await chrome.storage.local.set({ [WEB_AUTH_TOKEN_KEY]: token });
  }

  private async clearCachedToken(): Promise<void> {
    await chrome.storage.local.remove(WEB_AUTH_TOKEN_KEY);
  }

  private async revokeToken(token: string): Promise<void> {
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    );
    if (!response.ok) {
      throw new Error(`Token revoke failed with status ${response.status}`);
    }
  }

  private async verifyToken(token: string): Promise<boolean> {
    const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
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
      const result = await chrome.storage.local.get(LEGACY_EDGE_TOKEN_KEY);
      const legacyToken = result[LEGACY_EDGE_TOKEN_KEY] as string | undefined;
      if (legacyToken) {
        const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
          headers: { Authorization: `Bearer ${legacyToken}` },
        });
        if (response.ok) {
          await chrome.storage.local.set({
            [WEB_AUTH_TOKEN_KEY]: {
              accessToken: legacyToken,
              expiresAt: Date.now() + MIGRATED_TOKEN_EXPIRY_MS,
            } satisfies CachedWebToken,
          });
        }
        await chrome.storage.local.remove(LEGACY_EDGE_TOKEN_KEY);
      }
    } catch {
      // Best-effort migration; do not block initialization.
    } finally {
      this.migrationDone = true;
    }
  }

  private resolveStrategy(): Promise<AuthStrategy> {
    if (this.strategy) return Promise.resolve(this.strategy);
    if (this.strategyPromise) return this.strategyPromise;

    const pending = (async (): Promise<AuthStrategy> => {
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

      const detected: AuthStrategy = this.detectGoogleChrome() ? "chrome" : "web";
      this.strategy = detected;
      return detected;
    })();

    this.strategyPromise = pending;
    return pending;
  }

  private detectGoogleChrome(): boolean {
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
      const result = await this.chromeProvider.launchInteractive();
      if (result.ok) return result;
      // Chrome interactive failed; fall back to web auth flow.
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
        await chrome.storage.local.remove(WEB_AUTH_TOKEN_KEY);
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
    this.strategy = null;
    this.strategyPromise = null;

    return result;
  }

  async getStatus(): Promise<{ isConnected: boolean }> {
    const strategy = await this.resolveStrategy();

    if (strategy === "web") {
      // Web auth flow tokens carry local expiry; no network verification needed.
      const token = await this.webProvider.getAuthToken();
      return { isConnected: token !== null };
    }

    return { isConnected: await this.chromeProvider.isConnected() };
  }
}
