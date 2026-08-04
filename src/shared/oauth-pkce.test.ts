/**
 * RFC 7636 / Google native-app PKCE — drives shipped helpers only.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  buildGoogleAuthorizationUrl,
  buildPkceAuthorizationCodeTokenParams,
  buildRefreshTokenParams,
  createPkcePair,
  generateCodeChallengeS256,
  generateCodeVerifier,
  generateOAuthState,
  grantedScopesInclude,
  isValidCodeVerifier,
  PKCE_CODE_CHALLENGE_METHOD_S256,
  parseOAuthAuthorizationRedirect,
} from "./oauth-pkce";

describe("PKCE code_verifier (Google native-app Step 1)", () => {
  it("produces 43–128 unreserved characters", () => {
    for (let i = 0; i < 20; i += 1) {
      const v = generateCodeVerifier();
      expect(isValidCodeVerifier(v)).toBe(true);
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("rejects short or charset-invalid verifiers", () => {
    expect(isValidCodeVerifier("short")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(43)}+`)).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(43)}/`)).toBe(false);
  });
});

describe("PKCE S256 code_challenge (RFC 7636 Appendix B)", () => {
  it("matches the official test vector", async () => {
    // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(isValidCodeVerifier(verifier)).toBe(true);
    const challenge = await generateCodeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("createPkcePair returns matching S256 pair", async () => {
    const pair = await createPkcePair();
    expect(pair.codeChallengeMethod).toBe(PKCE_CODE_CHALLENGE_METHOD_S256);
    const again = await generateCodeChallengeS256(pair.codeVerifier);
    expect(again).toBe(pair.codeChallenge);
  });
});

describe("Google authorization URL (Step 2)", () => {
  it("includes required native-app PKCE query parameters", async () => {
    const pair = await createPkcePair();
    const state = generateOAuthState();
    const url = buildGoogleAuthorizationUrl({
      clientId: "client.apps.googleusercontent.com",
      redirectUri: "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
      scope: "https://www.googleapis.com/auth/drive.file",
      codeChallenge: pair.codeChallenge,
      state,
      prompt: "consent",
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(parsed.searchParams.get("code_challenge")).toBe(pair.codeChallenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(state);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
    expect(parsed.searchParams.get("scope")).toContain("drive.file");
    // Must never put verifier on the authorize URL.
    expect(url).not.toContain(pair.codeVerifier);
    expect(parsed.searchParams.get("code_verifier")).toBeNull();
  });
});

describe("parse OAuth redirect (Step 4)", () => {
  it("accepts matching state and code", () => {
    const result = parseOAuthAuthorizationRedirect(
      "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/?state=abc&code=4/P7q7W91",
      "abc",
    );
    expect(result).toEqual({ ok: true, code: "4/P7q7W91", state: "abc" });
  });

  it("rejects state mismatch and access_denied", () => {
    expect(
      parseOAuthAuthorizationRedirect("https://ext.chromiumapp.org/?state=wrong&code=x", "abc").ok,
    ).toBe(false);
    const denied = parseOAuthAuthorizationRedirect(
      "https://ext.chromiumapp.org/?error=access_denied",
      "abc",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error).toMatch(/access_denied/);
      expect(denied.error).toMatch(/Authorization error/);
    }
  });
});

describe("token exchange body (Step 5)", () => {
  it("sends code_verifier and omits client_secret", async () => {
    const pair = await createPkcePair();
    const body = buildPkceAuthorizationCodeTokenParams({
      clientId: "client.apps.googleusercontent.com",
      code: "auth-code",
      codeVerifier: pair.codeVerifier,
      redirectUri: "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
    });
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe(pair.codeVerifier);
    expect(body.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(body.get("redirect_uri")).toContain("chromiumapp.org");
    expect(body.get("client_secret")).toBeNull();
  });

  it("refresh body uses grant_type=refresh_token without verifier", () => {
    const body = buildRefreshTokenParams({
      clientId: "client.apps.googleusercontent.com",
      refreshToken: "1//refresh",
    });
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("1//refresh");
    expect(body.get("code_verifier")).toBeNull();
  });
});

describe("granted scopes (Step 6)", () => {
  it("requires all listed scopes to be present", () => {
    const granted =
      "https://www.googleapis.com/auth/drive.file openid https://www.googleapis.com/auth/userinfo.email";
    expect(grantedScopesInclude(granted, ["https://www.googleapis.com/auth/drive.file"])).toBe(
      true,
    );
    expect(
      grantedScopesInclude(granted, [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive",
      ]),
    ).toBe(false);
    expect(grantedScopesInclude(undefined, ["https://www.googleapis.com/auth/drive.file"])).toBe(
      false,
    );
  });
});

describe("base64UrlEncode", () => {
  it("encodes without padding and uses URL-safe alphabet", () => {
    // SHA-256 of empty string known digest starts with e3b0c442...
    const emptyShaPrefix = Uint8Array.from([0xe3, 0xb0, 0xc4, 0x42]);
    const encoded = base64UrlEncode(emptyShaPrefix);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
