/**
 * OAuth provider strategy registry (Google, Dropbox).
 */

import type { Env } from "../../env";

export type OAuthProviderId = "google" | "dropbox";

export interface OAuthProvider {
  id: OAuthProviderId;
  tokenEndpoint: string;
  label: string;
  /** When true, missing clientSecret is a server misconfiguration. */
  requiresSecret: boolean;
  resolveCredentials(env: Env): { clientId: string | undefined; clientSecret: string | undefined };
}

const googleProvider: OAuthProvider = {
  id: "google",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  label: "Google",
  requiresSecret: true,
  resolveCredentials(env) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  },
};

const dropboxProvider: OAuthProvider = {
  id: "dropbox",
  tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
  label: "Dropbox",
  requiresSecret: true,
  resolveCredentials(env) {
    return { clientId: env.DROPBOX_CLIENT_ID, clientSecret: env.DROPBOX_CLIENT_SECRET };
  },
};

const PROVIDERS: Record<OAuthProviderId, OAuthProvider> = {
  google: googleProvider,
  dropbox: dropboxProvider,
};

export function getOAuthProvider(id: OAuthProviderId): OAuthProvider {
  return PROVIDERS[id];
}
