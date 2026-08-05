/**
 * Google OAuth domain-ownership policy: only platform extension redirect hosts.
 */

import { describe, expect, it } from "vitest";
import {
  computeFirefoxIdentityHash,
  extractFirefoxIdentitySubdomain,
  firefoxAllizomRedirectUriForAddonId,
  firefoxMozoauth2RedirectUriForAddonId,
  resolveValidatedIdentityRedirectUri,
  toFirefoxMozoauth2RedirectUri,
  validateExtensionOAuthRedirectUri,
  validateFirefoxAllizomRedirectUri,
  validateFirefoxMozoauth2RedirectUri,
} from "./oauth-redirect-policy";
import { sha1Hex } from "./sha1";

describe("Firefox identity SHA-1 (matches toolkit ext-identity.js)", () => {
  it("hashes gn-tracing@gnas.dev to the known Firefox mozoauth2 path", () => {
    // Verified against Firefox computeHash(extension.id) + mozoauth2 loopback.
    expect(sha1Hex("gn-tracing@gnas.dev")).toBe("e11893679a6e0e898fdf7bc94c41ea354b335fb7");
    expect(computeFirefoxIdentityHash("gn-tracing@gnas.dev")).toBe(
      "e11893679a6e0e898fdf7bc94c41ea354b335fb7",
    );
    expect(firefoxMozoauth2RedirectUriForAddonId("gn-tracing@gnas.dev")).toBe(
      "http://127.0.0.1/mozoauth2/e11893679a6e0e898fdf7bc94c41ea354b335fb7",
    );
  });
});

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

  it("converts Firefox allizom hash redirects to mozoauth2 loopback", () => {
    const hash = "e11893679a6e0e898fdf7bc94c41ea354b335fb7";
    const uuidStyle = validateExtensionOAuthRedirectUri(`https://${hash}.extensions.allizom.org/`);
    expect(uuidStyle.ok).toBe(true);
    if (uuidStyle.ok) {
      expect(uuidStyle.redirectUri).toBe(`http://127.0.0.1/mozoauth2/${hash}`);
    }
  });

  it("rejects raw email-style mozoauth2 path (must be SHA-1)", () => {
    const emailStyle = validateFirefoxMozoauth2RedirectUri(
      "http://127.0.0.1/mozoauth2/gn-tracing@gnas.dev",
    );
    expect(emailStyle.ok).toBe(false);
  });

  it("accepts Firefox mozoauth2 loopback with SHA-1 path", () => {
    const result = validateFirefoxMozoauth2RedirectUri(
      "http://127.0.0.1/mozoauth2/e11893679a6e0e898fdf7bc94c41ea354b335fb7",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirectUri).toBe(
        "http://127.0.0.1/mozoauth2/e11893679a6e0e898fdf7bc94c41ea354b335fb7",
      );
    }
  });

  it("rejects empty and invalid URLs", () => {
    expect(validateExtensionOAuthRedirectUri("").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("not-a-url").ok).toBe(false);
  });

  it("rejects generic localhost (not mozoauth2)", () => {
    expect(validateExtensionOAuthRedirectUri("http://foo.chromiumapp.org/").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("https://localhost/callback").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("https://127.0.0.1/callback").ok).toBe(false);
    expect(validateExtensionOAuthRedirectUri("http://127.0.0.1/callback").ok).toBe(false);
  });

  it("rejects arbitrary owned product domains as OAuth redirects", () => {
    const homepage = validateExtensionOAuthRedirectUri("https://tracing.gnas.dev/oauth/callback");
    expect(homepage.ok).toBe(false);
    if (!homepage.ok) {
      expect(homepage.error).toMatch(/platform extension domain|mozoauth2/i);
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

  it("rejects credentials and non-443 ports on chromium hosts", () => {
    expect(validateExtensionOAuthRedirectUri("https://user:pass@abc.chromiumapp.org/").ok).toBe(
      false,
    );
    expect(validateExtensionOAuthRedirectUri("https://abc.chromiumapp.org:8443/").ok).toBe(false);
  });
});

describe("extractFirefoxIdentitySubdomain / toFirefoxMozoauth2RedirectUri", () => {
  it("extracts SHA-1 hex subdomains from getRedirectURL shape", () => {
    const hash = "e11893679a6e0e898fdf7bc94c41ea354b335fb7";
    expect(extractFirefoxIdentitySubdomain(`https://${hash}.extensions.allizom.org/`)).toBe(hash);
    expect(extractFirefoxIdentitySubdomain(`https://${hash}.extensions.allizom.org/oauth2`)).toBe(
      hash,
    );
    expect(toFirefoxMozoauth2RedirectUri(`https://${hash}.extensions.allizom.org`)).toBe(
      `http://127.0.0.1/mozoauth2/${hash}`,
    );
  });
});

describe("resolveValidatedIdentityRedirectUri", () => {
  it("validates the value returned by getRedirectURL", () => {
    const ok = resolveValidatedIdentityRedirectUri(
      () => "https://extid1234567890abcdefextid12.chromiumapp.org/",
    );
    expect(ok.ok).toBe(true);

    const hash = "e11893679a6e0e898fdf7bc94c41ea354b335fb7";
    const firefox = resolveValidatedIdentityRedirectUri(
      () => `https://${hash}.extensions.allizom.org/`,
    );
    expect(firefox.ok).toBe(true);
    if (firefox.ok) {
      expect(firefox.redirectUri).toBe(`http://127.0.0.1/mozoauth2/${hash}`);
    }

    const bad = resolveValidatedIdentityRedirectUri(() => "https://evil.example/cb");
    expect(bad.ok).toBe(false);
  });
});

describe("Firefox allizom redirect (Dropbox)", () => {
  const hash = "e11893679a6e0e898fdf7bc94c41ea354b335fb7";

  it("derives the https allizom URI from the addon id", () => {
    // Dropbox refuses http:// on any host but localhost, so the mozoauth2
    // IP-literal form cannot be registered — this https host can.
    expect(firefoxAllizomRedirectUriForAddonId("gn-tracing@gnas.dev")).toBe(
      `https://${hash}.extensions.allizom.org/`,
    );
  });

  it("keeps the allizom form instead of downgrading to mozoauth2", () => {
    const result = validateFirefoxAllizomRedirectUri(`https://${hash}.extensions.allizom.org/`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirectUri).toBe(`https://${hash}.extensions.allizom.org/`);
      expect(result.hostname).toBe(`${hash}.extensions.allizom.org`);
    }
    // The Google-facing validator still rewrites the same input to loopback.
    const google = validateExtensionOAuthRedirectUri(`https://${hash}.extensions.allizom.org/`);
    expect(google.ok).toBe(true);
    if (google.ok) {
      expect(google.redirectUri).toBe(`http://127.0.0.1/mozoauth2/${hash}`);
    }
  });

  it("rejects the raw email-style id and non-allizom hosts", () => {
    expect(
      validateFirefoxAllizomRedirectUri("https://gn-tracing@gnas.dev.extensions.allizom.org/").ok,
    ).toBe(false);
    expect(validateFirefoxAllizomRedirectUri("https://evil.example/cb").ok).toBe(false);
    expect(validateFirefoxAllizomRedirectUri(`http://127.0.0.1/mozoauth2/${hash}`).ok).toBe(false);
    expect(validateFirefoxAllizomRedirectUri("").ok).toBe(false);
  });
});
