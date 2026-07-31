/**
 * Extension adapter for the shared product-version API.
 *
 * Candidates (first valid core semver wins):
 * 1. `__APP_VERSION__` — esbuild define from root package.json
 * 2. `chrome.runtime.getManifest().version` — live extension when define missing
 *
 * Emit paths use {@link getProductVersion} (throws if none valid).
 * Package metadata may use {@link getProductVersionOrDefault}.
 */

import {
  pickProductVersion,
  productVersionOrDefault,
  requireProductVersion,
} from "../../packages/replay-core/src/product-version";

declare const __APP_VERSION__: string | undefined;

function readBuildDefine(): string | undefined {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined;
  } catch {
    // Symbol not injected by bundler / test harness.
    return undefined;
  }
}

function readManifestVersion(): string | undefined {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.getManifest) {
      return undefined;
    }
    return chrome.runtime.getManifest().version;
  } catch {
    return undefined;
  }
}

/** Collect extension version candidates for tests and diagnostics. */
export function collectExtensionVersionCandidates(): unknown[] {
  return [readBuildDefine(), readManifestVersion()];
}

/**
 * Product version for extension emit (replay URLs) and strict call sites.
 */
export function getProductVersion(): string {
  const picked = pickProductVersion(...collectExtensionVersionCandidates());
  return requireProductVersion(picked, "extension");
}

/**
 * Soft read for package metadata / fixtures when no candidate is available.
 */
export function getProductVersionOrDefault(fallback = "0.0.0"): string {
  return productVersionOrDefault(
    pickProductVersion(...collectExtensionVersionCandidates()),
    fallback,
  );
}
