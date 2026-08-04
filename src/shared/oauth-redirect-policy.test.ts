/**
 * Google OAuth domain-ownership policy: only platform extension redirect hosts.
 */

import { describe, expect, it } from "vitest";
import {
  resolveValidatedIdentityRedirectUri,
  validateExtensionOAuthRedirectUri,
} from "./oauth-redirect-policy";

describe("validateExtensionOAuthRedirectUri", () => {
  it("accepts Chromium extension identity redirects", () => {
    const result = validateExtensionOAuthRedirectUri(
      "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostname).toBe("abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org");
    }
  });

  it("accepts Firefox extension identity redirects", () => {
    // Firefox temporary/store redirects look like uuid.extensions.allizom.org
    const uuidStyle = validateExtensionOAuthRedirectUri(
      "https://a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.extensions.allizom.org/",
    );
    expect(uuidStyle.ok).toBe(true);
  });

  it("rejects empty and invalid URLs", () => {
    expect(validateExtensionOAuthRedirectUri("").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("not-a-url").ok).toBe(false);
  });

  it("rejects http and localhost (not owned secure extension domains)", () => {
    expect(validateExtensionOAuthRedirectUri("http://foo.chromiumapp.org/").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("https://localhost/callback").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("https://127.0.0.1/callback").ok).toBe(false);
  });

  it("rejects arbitrary owned product domains as OAuth redirects", () => {
    // Product homepage / privacy live on tracing.gnas.dev — must NOT be redirect URIs.
    const homepage = validateExtensionOAuthRedirectUri("https://tracing.gnas.dev/oauth/callback");
    expect(homepage.ok).toBe(false);
    if (!homepage.ok) {
      expect(homepage.error).toMatch(/platform extension domain/i);
    }

    const workers = validateExtensionOAuthRedirectUri(
      "https://gn-tracing-oauth-proxy.cors-ngosangns.workers.dev/oauth/callback",
    );
    expect(workers.ok).toBe(false);
  });

  it("rejects bare suffix hosts without extension id prefix", () => {
    expect(validateExtensionOAuthRedirectUri("https://chromiumapp.org/").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("https://extensions.allizom.org/").ok).toBe(false);
  });

  it("rejects credentials and non-443 ports", () => {
    expect(validateExtensionOAuthRedirectUri("https://user:pass@abc.chromiumapp.org/").ok).toBe(
      false,
    );
    expect(validateExtensionOAuthRedirectUri("https://abc.chromiumapp.org:8443/").ok).toBe(false);
  });
});

describe("resolveValidatedIdentityRedirectUri", () => {
  it("validates the value returned by getRedirectURL", () => {
    const ok = resolveValidatedIdentityRedirectUri(
      () => "https://extid1234567890abcdefextid12.chromiumapp.org/",
    );
    expect(ok.ok).toBe(true);

    const bad = resolveValidatedIdentityRedirectUri(() => "https://evil.example/cb");
    expect(bad.ok).toBe(false);
  });
});
