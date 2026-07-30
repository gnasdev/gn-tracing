/**
 * Load a recording package from a ZIP blob or multi-file cloud index.
 */

import type {
  ConsoleEntry,
  NetworkEntry,
  StorageArtifact,
  WebSocketEntry,
} from "../../../packages/replay-core/src/schema/capture";
import type { PackageMetadata } from "../../../packages/replay-core/src/schema/package";
import { t } from "../i18n";
import {
  proxyDownloadUrl,
  resolveReplayRecordingRef,
  type StorageRecordingRef,
} from "../lib/recording-ref";
import { parseJsonBytes, unzipPackage } from "../lib/zip-open";
import { resetSession, session, setError, setPhase, setSession } from "../store/session";

function findFile(files: Map<string, Uint8Array>, name: string): Uint8Array | undefined {
  if (files.has(name)) {
    return files.get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of files) {
    if (key.toLowerCase() === lower || key.endsWith(`/${name}`)) {
      return value;
    }
  }
  return undefined;
}

function parseJsonFile<T>(files: Map<string, Uint8Array>, name: string): T | null {
  const bytes = findFile(files, name);
  if (!bytes) {
    return null;
  }
  try {
    return parseJsonBytes<T>(bytes);
  } catch {
    return null;
  }
}

async function hydrateFromZipFiles(files: Map<string, Uint8Array>): Promise<void> {
  const metadata =
    parseJsonFile<PackageMetadata>(files, "metadata.json") ||
    parseJsonFile<PackageMetadata>(files, "meta.json");

  const consoleLogs =
    parseJsonFile<ConsoleEntry[]>(files, "console.json") ||
    parseJsonFile<{ entries: ConsoleEntry[] }>(files, "console.json")?.entries ||
    [];

  const networkRaw = parseJsonFile<NetworkEntry[] | { requests: NetworkEntry[] }>(
    files,
    "network.json",
  );
  const networkRequests = Array.isArray(networkRaw)
    ? networkRaw
    : networkRaw && "requests" in networkRaw
      ? networkRaw.requests
      : [];

  const webSockets =
    parseJsonFile<WebSocketEntry[]>(files, "websocket.json") ||
    parseJsonFile<WebSocketEntry[]>(files, "websockets.json") ||
    [];

  const storageArtifact = parseJsonFile<StorageArtifact>(files, "storage.json");
  const userEvents =
    parseJsonFile<unknown[]>(files, "events.json") ||
    parseJsonFile<{ events: unknown[] }>(files, "events.json")?.events ||
    [];
  const report = parseJsonFile(files, "report.json");
  const privacy = parseJsonFile(files, "privacy.json");

  let videoUrl: string | null = null;
  for (const candidate of ["video.webm", "recording.webm", "tab.webm", "video.mp4"]) {
    const bytes = findFile(files, candidate);
    if (bytes) {
      const type = candidate.endsWith(".mp4") ? "video/mp4" : "video/webm";
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      videoUrl = URL.createObjectURL(new Blob([copy], { type }));
      break;
    }
  }

  const screenshotUrls: string[] = [];
  for (const [name, bytes] of files) {
    if (/\.(jpe?g|png|webp)$/i.test(name) && /screenshot|still|image/i.test(name)) {
      const mime = name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      screenshotUrls.push(URL.createObjectURL(new Blob([copy], { type: mime })));
    }
  }

  const pageUrl =
    (metadata as { url?: string } | null)?.url ||
    (report as { url?: string } | null)?.url ||
    session.pageUrl ||
    "";

  setSession({
    phase: "player",
    metadata,
    consoleLogs: Array.isArray(consoleLogs) ? consoleLogs : [],
    networkRequests: Array.isArray(networkRequests) ? networkRequests : [],
    webSockets: Array.isArray(webSockets) ? webSockets : [],
    storageArtifact,
    userEvents: Array.isArray(userEvents) ? userEvents : [],
    report,
    privacy,
    videoUrl,
    screenshotUrls,
    pageUrl,
    errorMessage: "",
    selectedPanel: report ? "report" : consoleLogs.length ? "console" : "network",
  });
}

export async function openZipBlob(blob: Blob, password?: string): Promise<void> {
  setPhase("loading");
  setSession("loadingMessage", t("loading.message"));
  const result = await unzipPackage(blob, { password });
  if (!result.ok) {
    if (result.code === "PASSWORD_REQUIRED" || result.code === "PASSWORD_INVALID") {
      setSession({
        phase: "password",
        passwordMessage: result.message,
      });
      return;
    }
    setError(result.message);
    return;
  }
  await hydrateFromZipFiles(result.files);
}

export async function openLocalFile(file: File, password?: string): Promise<void> {
  resetSession();
  setSession("pageUrl", file.name);
  await openZipBlob(file, password);
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.blob();
}

/**
 * Load package for the current location (Drive/Dropbox index or single ZIP).
 */
export async function loadFromLocation(password?: string): Promise<void> {
  const ref = resolveReplayRecordingRef();
  if (!ref) {
    setPhase("intro");
    return;
  }

  resetSession();
  setSession({
    phase: "loading",
    loadingMessage: t("loading.message"),
    provider: ref.provider,
    recordingId: ref.fileId,
  });

  try {
    const url = proxyDownloadUrl(ref);
    const blob = await fetchBlob(url);
    const contentType = blob.type || "";

    // Single ZIP package
    if (contentType.includes("zip") || contentType.includes("octet-stream") || blob.size > 0) {
      // Try as ZIP first; if index JSON, fall through.
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      const isZip = head[0] === 0x50 && head[1] === 0x4b;
      if (isZip) {
        await openZipBlob(blob, password);
        return;
      }
    }

    // Multi-file index (JSON list of Drive files) — simplified: treat as single file package id
    try {
      const text = await blob.text();
      const json = JSON.parse(text) as unknown;
      if (Array.isArray(json)) {
        const zipEntry = json.find(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof (item as { name?: string }).name === "string" &&
            String((item as { name: string }).name).endsWith(".zip"),
        ) as { id?: string; name?: string } | undefined;
        if (zipEntry?.id) {
          const zipRef: StorageRecordingRef = { provider: ref.provider, fileId: zipEntry.id };
          const zipBlob = await fetchBlob(proxyDownloadUrl(zipRef));
          await openZipBlob(zipBlob, password);
          return;
        }
      }
      // index object with files array
      if (json && typeof json === "object" && Array.isArray((json as { files?: unknown }).files)) {
        const files = (json as { files: Array<{ id?: string; name?: string }> }).files;
        const zipEntry = files.find((f) => f.name?.endsWith(".zip"));
        if (zipEntry?.id) {
          const zipBlob = await fetchBlob(
            proxyDownloadUrl({ provider: ref.provider, fileId: zipEntry.id }),
          );
          await openZipBlob(zipBlob, password);
          return;
        }
      }
    } catch {
      // not JSON
    }

    // Last resort: try zip open on original blob
    await openZipBlob(blob, password);
  } catch (error) {
    setError(error instanceof Error ? error.message : t("error.loadFailed") || "Load failed");
  }
}
