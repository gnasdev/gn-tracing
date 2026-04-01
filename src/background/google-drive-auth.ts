import type { MessageResponse } from "../types/messages";

// TODO: Replace with your Google OAuth Client ID and Secret
// 1. Go to https://console.cloud.google.com/apis/credentials
// 2. Create a new OAuth 2.0 Client ID (Application type: Web application)
// 3. Add authorized redirect URIs: https://<your-extension-id>.chromiumapp.org/
// 4. Copy the Client ID and Client Secret here
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

interface GoogleAuthState {
  accessToken: string | null;
  accessTokenExpiry: number | null;
  refreshToken: string | null;
}

// PKCE helpers
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCodePoint(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return hash;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return btoa(String.fromCodePoint(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export class GoogleDriveAuth {
  #state: GoogleAuthState = {
    accessToken: null,
    accessTokenExpiry: null,
    refreshToken: null,
  };

  async initialize(): Promise<void> {
    const stored = await chrome.storage.session.get(["googleAccessToken", "googleAccessTokenExpiry", "googleRefreshToken"]);
    this.#state.accessToken = stored.googleAccessToken ?? null;
    this.#state.accessTokenExpiry = stored.googleAccessTokenExpiry ?? null;
    this.#state.refreshToken = stored.googleRefreshToken ?? null;
  }

  async getAuthToken(): Promise<string | null> {
    // Check if current token is still valid (with 5 min buffer)
    if (this.#state.accessToken && this.#state.accessTokenExpiry) {
      const now = Date.now();
      if (now < this.#state.accessTokenExpiry - 5 * 60 * 1000) {
        return this.#state.accessToken;
      }
    }

    // Token expired or missing, need to get new one
    return await this.#getNewAuthToken();
  }

  async #getNewAuthToken(): Promise<string | null> {
    // If we have a refresh token, use it to get new access token
    if (this.#state.refreshToken) {
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: this.#state.refreshToken,
            grant_type: "refresh_token",
          }),
        });

        if (response.ok) {
          const data = await response.json();
          this.#state.accessToken = data.access_token;
          this.#state.accessTokenExpiry = Date.now() + (data.expires_in * 1000);
          await this.#persistState();
          return this.#state.accessToken;
        }
      } catch (e) {
        console.error("[GoogleDriveAuth] Failed to refresh token:", e);
      }
    }

    // No valid token - user needs to re-authenticate
    return null;
  }

  async launchOAuthFlow(): Promise<MessageResponse> {
    try {
      const redirectUri = chrome.identity.getRedirectURL();
      console.log("[GoogleDriveAuth] Redirect URI:", redirectUri);
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = base64UrlEncode(await sha256(codeVerifier));

      // Store code verifier for later exchange
      await chrome.storage.session.set({ googleCodeVerifier: codeVerifier });

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", DRIVE_SCOPE);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
      });

      if (!redirectUrl) {
        return { ok: false, error: "OAuth flow cancelled" };
      }

      // Extract authorization code from redirect URL
      const url = new URL(redirectUrl);
      const code = url.searchParams.get("code");

      if (!code) {
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        return { ok: false, error: errorDesc || error || "No authorization code received" };
      }

      // Exchange code for tokens using PKCE
      return await this.#exchangeCodeForToken(code, codeVerifier);

    } catch (e) {
      console.error("[GoogleDriveAuth] OAuth flow error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async #exchangeCodeForToken(code: string, codeVerifier: string): Promise<MessageResponse> {
    try {
      const redirectUri = chrome.identity.getRedirectURL();

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { ok: false, error: errorData.error_description || "Token exchange failed" };
      }

      const data = await response.json();
      this.#state.accessToken = data.access_token;
      this.#state.refreshToken = data.refresh_token || this.#state.refreshToken;
      this.#state.accessTokenExpiry = Date.now() + (data.expires_in * 1000);

      await this.#persistState();

      // Clean up code verifier
      await chrome.storage.session.remove("googleCodeVerifier");

      return { ok: true, message: "Google Drive connected successfully" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Token exchange error:", e);
      return { ok: false, error: (e as Error).message };
    }
  }

  async disconnect(): Promise<MessageResponse> {
    // Revoke token on Google side
    if (this.#state.accessToken) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${this.#state.accessToken}`);
      } catch (e) {
        console.error("[GoogleDriveAuth] Token revocation error:", e);
      }
    }

    // Clear local state
    this.#state = {
      accessToken: null,
      accessTokenExpiry: null,
      refreshToken: null,
    };

    await chrome.storage.session.remove(["googleAccessToken", "googleAccessTokenExpiry", "googleRefreshToken"]);

    return { ok: true, message: "Disconnected from Google Drive" };
  }

  async getStatus(): Promise<{ isConnected: boolean; email?: string }> {
    const hasToken = !!(this.#state.refreshToken || this.#state.accessToken);

    if (!hasToken) {
      return { isConnected: false };
    }

    // Try to get user email if token is valid
    try {
      const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo?fields=email", {
        headers: {
          Authorization: `Bearer ${this.#state.accessToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        return { isConnected: true, email: data.email };
      }
    } catch {
      // Token might be expired, but we have refresh token
      if (this.#state.refreshToken) {
        return { isConnected: true };
      }
    }

    return { isConnected: hasToken };
  }

  async #persistState(): Promise<void> {
    await chrome.storage.session.set({
      googleAccessToken: this.#state.accessToken,
      googleAccessTokenExpiry: this.#state.accessTokenExpiry,
      googleRefreshToken: this.#state.refreshToken,
    });
  }
}
