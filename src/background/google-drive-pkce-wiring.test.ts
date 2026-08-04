/**
 * Structural + behavioral wiring: Google Drive web OAuth uses shared native-app PKCE.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  buildPkceAuthorizationCodeTokenParams,
  createPkcePair,
  grantedScopesInclude,
} from "../shared/oauth-pkce";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const googleAuthSource = readFileSync(join(root, "src/background/google-drive-auth.ts"), "utf8");
const dropboxAuthSource = readFileSync(join(root, "src/background/dropbox-auth.ts"), "utf8");

describe("Google Drive native-app PKCE wiring", () => {
  it("imports and uses shared PKCE helpers (not local generateCodeVerifier)", () => {
    expect(googleAuthSource).toMatch(/from ["']\.\.\/shared\/oauth-pkce["']/);
    expect(googleAuthSource).toMatch(/createPkcePair/);
    expect(googleAuthSource).toMatch(/buildGoogleAuthorizationUrl/);
    expect(googleAuthSource).toMatch(/buildPkceAuthorizationCodeTokenParams/);
    expect(googleAuthSource).toMatch(/parseOAuthAuthorizationRedirect/);
    expect(googleAuthSource).toMatch(/grantedScopesInclude/);
    expect(googleAuthSource).not.toMatch(/function generateCodeVerifier/);
    expect(googleAuthSource).toMatch(/code_challenge_method|codeChallengeMethod|S256/);
  });

  it("Dropbox also uses shared PKCE pair + token body helpers", () => {
    expect(dropboxAuthSource).toMatch(/from ["']\.\.\/shared\/oauth-pkce["']/);
    expect(dropboxAuthSource).toMatch(/createPkcePair/);
    expect(dropboxAuthSource).toMatch(/buildPkceAuthorizationCodeTokenParams/);
    expect(dropboxAuthSource).not.toMatch(/function generateCodeVerifier/);
  });

  it("end-to-end pure path: PKCE pair → auth URL → token body (no secret)", async () => {
    const pair = await createPkcePair();
    const redirectUri = "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/";
    const url = buildGoogleAuthorizationUrl({
      clientId: "test.apps.googleusercontent.com",
      redirectUri,
      scope: "https://www.googleapis.com/auth/drive.file",
      codeChallenge: pair.codeChallenge,
      state: "csrf-state",
      prompt: "consent",
    });
    const challenge = new URL(url).searchParams.get("code_challenge");
    expect(challenge).toBe(pair.codeChallenge);

    const body = buildPkceAuthorizationCodeTokenParams({
      clientId: "test.apps.googleusercontent.com",
      code: "4/sample-code",
      codeVerifier: pair.codeVerifier,
      redirectUri,
    });
    expect(body.get("code_verifier")).toBe(pair.codeVerifier);
    expect(body.get("client_secret")).toBeNull();
    expect(
      grantedScopesInclude("https://www.googleapis.com/auth/drive.file", [
        "https://www.googleapis.com/auth/drive.file",
      ]),
    ).toBe(true);
  });
});
