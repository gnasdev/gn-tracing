import type { MessageResponse } from "../types/messages";

const GOOGLE_CLIENT_ID = "95916347176-ulk25djm5l4g6ebq7vftjik8iv9a11vf.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const EDGE_ACCESS_TOKEN_KEY = "gn_tracing_edge_access_token";

/**
 * Google Drive Auth using chrome.identity.getAuthToken()
 * No client_secret required - Chrome handles token management internally
 */
export class GoogleDriveAuth {
  private normalizeChromeToken(
    tokenResult: string | chrome.identity.GetAuthTokenResult | undefined | null,
  ): string | null {
    if (typeof tokenResult === "string") {
      return tokenResult;
    }
    return tokenResult?.token ?? null;
  }

  private async revokeAccessToken(token: string): Promise<void> {
    const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      throw new Error(`Token revoke failed with status ${response.status}`);
    }
  }

  private async removeCachedAuthToken(token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
        } else {
          resolve();
        }
      });
    });
  }

  private async clearChromeIdentityState(): Promise<void> {
    if (typeof chrome.identity.clearAllCachedAuthTokens === "function") {
      await chrome.identity.clearAllCachedAuthTokens();
    }
  }

  private isEdgeBrowser(): boolean {
    return navigator.userAgent.includes("Edg/");
  }

  private async getStoredEdgeToken(): Promise<string | null> {
    const result = await chrome.storage.local.get(EDGE_ACCESS_TOKEN_KEY);
    return (result[EDGE_ACCESS_TOKEN_KEY] as string | undefined) ?? null;
  }

  private async setStoredEdgeToken(token: string): Promise<void> {
    await chrome.storage.local.set({ [EDGE_ACCESS_TOKEN_KEY]: token });
  }

  private async clearStoredEdgeToken(): Promise<void> {
    await chrome.storage.local.remove(EDGE_ACCESS_TOKEN_KEY);
  }

  private async verifyToken(token: string): Promise<boolean> {
    const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  }

  /**
   * Initialize - no-op since Chrome manages token state
   */
  async initialize(): Promise<void> {
    // Chrome.identity manages tokens automatically
  }

  /**
   * Get valid auth token. Chrome handles refresh automatically.
   */
  async getAuthToken(): Promise<string | null> {
    if (this.isEdgeBrowser()) {
      try {
        const token = await this.getStoredEdgeToken();
        if (!token) {
          return null;
        }

        if (await this.verifyToken(token)) {
          return token;
        }

        await this.clearStoredEdgeToken();
        return null;
      } catch {
        return null;
      }
    }

    try {
      const token = await chrome.identity.getAuthToken({ interactive: false });
      const tokenStr = this.normalizeChromeToken(token);
      return tokenStr;
    } catch (e) {
      return null;
    }
  }

  /**
   * Launch OAuth flow interactively. Chrome handles the entire flow.
   */
  async launchOAuthFlow(): Promise<MessageResponse> {
    if (this.isEdgeBrowser()) {
      try {
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

        await this.setStoredEdgeToken(accessToken);
        return { ok: true, message: "Google Drive connected successfully" };
      } catch (e) {
        console.error("[GoogleDriveAuth] Edge OAuth flow error:", e);
        return { ok: false, error: (e as Error).message };
      }
    }

    try {
      const tokenResult = await chrome.identity.getAuthToken({
        interactive: true,
        scopes: [DRIVE_SCOPE],
      });

      const tokenStr = this.normalizeChromeToken(tokenResult);

      if (!tokenStr) {
        return { ok: false, error: "No token received" };
      }

      if (!(await this.verifyToken(tokenStr))) {
        await this.removeCachedAuthToken(tokenStr);
        return { ok: false, error: "Authentication failed. Please try again." };
      }

      return { ok: true, message: "Google Drive connected successfully" };
    } catch (e) {
      console.error("[GoogleDriveAuth] OAuth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Disconnect from Google Drive and revoke token.
   */
  async disconnect(): Promise<MessageResponse> {
    if (this.isEdgeBrowser()) {
      const token = await this.getStoredEdgeToken();
      try {
        if (token) {
          await this.revokeAccessToken(token);
        }
      } catch (e) {
        console.error("[GoogleDriveAuth] Edge disconnect error:", e);
      } finally {
        await this.clearStoredEdgeToken();
      }

      return { ok: true, message: "Disconnected from Google Drive" };
    }

    const token = await this.getAuthToken();
    try {
      if (token) {
        try {
          await this.revokeAccessToken(token);
        } catch (e) {
          console.warn("[GoogleDriveAuth] Token revoke failed during disconnect:", e);
        }

        try {
          await this.removeCachedAuthToken(token);
        } catch (e) {
          console.warn("[GoogleDriveAuth] Cached token removal failed during disconnect:", e);
        }
      }

      await this.clearChromeIdentityState();
      return { ok: true, message: "Disconnected from Google Drive" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Disconnect error:", e);
      if (token) {
        try {
          await this.removeCachedAuthToken(token);
        } catch {
          // Ignore follow-up cache cleanup failures after the main disconnect path already failed.
        }
      }

      try {
        await this.clearChromeIdentityState();
      } catch {
        // Ignore clear-all failures and still return a success-style response for already-invalid auth state.
      }

      return { ok: true, message: "Disconnected from Google Drive" };
    }
  }

  /**
   * Check connection status.
   */
  async getStatus(): Promise<{ isConnected: boolean }> {
    try {
      const token = await this.getAuthToken();

      if (!token) {
        return { isConnected: false };
      }

      return { isConnected: await this.verifyToken(token) };
    } catch {
      return { isConnected: false };
    }
  }
}
