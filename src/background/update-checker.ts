/**
 * Extension update checking via GitHub Releases API.
 */
import type { MessageResponse } from "../types/messages";

const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/gnasdev/gn-tracing/releases/latest";

export async function checkForExtensionUpdate(): Promise<MessageResponse> {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return { ok: false, error: `GitHub release check failed (${response.status}).` };
    }

    const latestRelease = (await response.json()) as {
      tag_name?: unknown;
      name?: unknown;
      html_url?: unknown;
      assets?: Array<{
        name?: unknown;
        browser_download_url?: unknown;
      }>;
    };
    const latestVersion = normalizeReleaseVersion(
      typeof latestRelease.tag_name === "string"
        ? latestRelease.tag_name
        : typeof latestRelease.name === "string"
          ? latestRelease.name
          : "",
    );

    if (!latestVersion) {
      return { ok: false, error: "Latest GitHub release does not include a valid version." };
    }

    const comparison = compareVersions(currentVersion, latestVersion);
    const downloadUrl = getReleaseDownloadUrl(latestRelease);
    const update = {
      currentVersion,
      latestVersion,
      isUpdateAvailable: comparison < 0,
      downloadUrl,
    };
    if (comparison < 0) {
      return {
        ok: true,
        message: `New version ${latestVersion} is available. Current ${currentVersion}.`,
        update,
      };
    }
    if (comparison > 0) {
      return {
        ok: true,
        message: `Current ${currentVersion} is newer than GitHub release ${latestVersion}.`,
        update,
      };
    }
    return { ok: true, message: `GN Tracing is up to date (${currentVersion}).`, update };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function getReleaseDownloadUrl(release: {
  html_url?: unknown;
  assets?: Array<{
    name?: unknown;
    browser_download_url?: unknown;
  }>;
}): string | undefined {
  const extensionZip = release.assets?.find((asset) => {
    const name = typeof asset.name === "string" ? asset.name : "";
    return /^gn-tracing-extension-.+\.zip$/i.test(name);
  });
  const assetUrl = extensionZip?.browser_download_url;
  if (typeof assetUrl === "string" && assetUrl.trim()) {
    return assetUrl;
  }
  return typeof release.html_url === "string" && release.html_url.trim()
    ? release.html_url
    : undefined;
}

function normalizeReleaseVersion(version: string): string {
  const normalized = version.trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : "";
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const currentParts = parseVersionParts(currentVersion);
  const latestParts = parseVersionParts(latestVersion);
  for (let index = 0; index < Math.max(currentParts.length, latestParts.length); index += 1) {
    const currentPart = currentParts[index] || 0;
    const latestPart = latestParts[index] || 0;
    if (currentPart !== latestPart) {
      return currentPart > latestPart ? 1 : -1;
    }
  }
  return 0;
}

function parseVersionParts(version: string): number[] {
  return normalizeReleaseVersion(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}
