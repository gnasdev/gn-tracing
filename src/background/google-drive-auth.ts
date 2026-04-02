import type { MessageResponse } from "../types/messages";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * Google Drive Auth using chrome.identity.getAuthToken()
 * No client_secret required - Chrome handles token management internally
 */
export class GoogleDriveAuth {
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
    try {
      const token = await chrome.identity.getAuthToken({ interactive: false });
      console.log('[GoogleDriveAuth] getAuthToken raw result:', token, typeof token);
      // Token might be string or object depending on Chrome version
      const tokenStr = typeof token === 'string' ? token : (token?.token ?? null);
      return tokenStr;
    } catch (e) {
      console.error('[GoogleDriveAuth] getAuthToken error:', e);
      // No cached token available
      return null;
    }
  }

  /**
   * Launch OAuth flow interactively. Chrome handles the entire flow.
   */
  async launchOAuthFlow(): Promise<MessageResponse> {
    try {
      // Get token - this may trigger OAuth popup if needed
      const tokenResult = await chrome.identity.getAuthToken({
        interactive: true,
        scopes: [DRIVE_SCOPE],
      });

      // Extract token string
      let tokenStr: string | undefined;
      if (typeof tokenResult === 'string') {
        tokenStr = tokenResult;
      } else if (tokenResult && typeof tokenResult === 'object') {
        tokenStr = tokenResult.token;
      }

      if (!tokenStr) {
        return { ok: false, error: "No token received" };
      }

      // Verify token works with Drive API (list files with limit 1)
      const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
        headers: { Authorization: `Bearer ${tokenStr}` },
      });

      if (!response.ok) {
        // Token invalid, remove and fail
        await new Promise<void>((resolve) => {
          chrome.identity.removeCachedAuthToken({ token: tokenStr }, () => resolve());
        });
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
    try {
      // Get current token to revoke
      const tokenResult = await chrome.identity.getAuthToken({ interactive: false });
      console.log('[GoogleDriveAuth] disconnect raw token:', tokenResult, typeof tokenResult);

      // Token might be string or object depending on Chrome version
      const token = typeof tokenResult === 'string' ? tokenResult : (tokenResult?.token ?? null);
      console.log('[GoogleDriveAuth] extracted token:', token ? token.substring(0, 20) + '...' : null);

      if (token) {
        // Revoke on Google side
        console.log('[GoogleDriveAuth] revoking token...');
        const revokeRes = await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`);
        console.log('[GoogleDriveAuth] revoke response:', revokeRes.status);

        // Remove from Chrome's cache - use callback style for compatibility
        console.log('[GoogleDriveAuth] removing cached token...');
        await new Promise<void>((resolve, reject) => {
          chrome.identity.removeCachedAuthToken({ token }, () => {
            const err = chrome.runtime.lastError;
            console.log('[GoogleDriveAuth] removeCachedAuthToken callback, lastError:', err);
            if (err) {
              reject(new Error(err.message));
            } else {
              resolve();
            }
          });
        });
        console.log('[GoogleDriveAuth] token removed from cache');
      } else {
        console.log('[GoogleDriveAuth] no token to revoke');
      }

      return { ok: true, message: "Disconnected from Google Drive" };
    } catch (e) {
      console.error("[GoogleDriveAuth] Disconnect error:", e);
      // Still return success if token was already invalid
      return { ok: true, message: "Disconnected from Google Drive" };
    }
  }

  /**
   * Check connection status.
   */
  async getStatus(): Promise<{ isConnected: boolean }> {
    try {
      const tokenResult = await chrome.identity.getAuthToken({ interactive: false });
      const token = typeof tokenResult === 'string' ? tokenResult : (tokenResult?.token ?? null);

      if (!token) {
        return { isConnected: false };
      }

      // Verify token works with Drive API
      const response = await fetch("https://www.googleapis.com/drive/v3/files?pageSize=1", {
        headers: { Authorization: `Bearer ${token}` },
      });

      return { isConnected: response.ok };
    } catch {
      return { isConnected: false };
    }
  }
}
