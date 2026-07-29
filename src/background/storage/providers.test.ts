/**
 * StorageProvider adapters: parse/build/upload/share under mocked network.
 * Auth is injected; fetch/XHR mocked only at the I/O boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropboxAuth } from "../dropbox-auth";
import type { GoogleDriveAuth } from "../google-drive-auth";
import { DropboxProvider } from "./dropbox-provider";
import { GoogleDriveProvider } from "./google-drive-provider";

function mockAuth(): GoogleDriveAuth {
  return {
    launchOAuthFlow: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => ({ ok: true })),
    getAuthToken: vi.fn(async () => "drive-token"),
    getStatus: vi.fn(async () => ({ isConnected: true })),
  } as unknown as GoogleDriveAuth;
}

function mockDropboxAuth(): DropboxAuth {
  return {
    launchOAuthFlow: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => ({ ok: true })),
    getAuthToken: vi.fn(async () => "dropbox-token"),
    getStatus: vi.fn(async () => ({ isConnected: true })),
  } as unknown as DropboxAuth;
}

/**
 * Minimal XMLHttpRequest for Node: upload paths use XHR for progress events.
 * Response body/status are configurable via the last constructed instance.
 */
function installXhrMock(response: { status: number; body: string }): {
  openCalls: Array<{ method: string; url: string }>;
  headers: Record<string, string>;
} {
  const openCalls: Array<{ method: string; url: string }> = [];
  const headers: Record<string, string> = {};

  class FakeXHR {
    status = 0;
    responseText = "";
    upload = {
      addEventListener: (_type: string, _listener: EventListener) => {},
    };
    onerror: ((ev?: unknown) => void) | null = null;
    onload: ((ev?: unknown) => void) | null = null;

    open(method: string, url: string): void {
      openCalls.push({ method, url });
    }
    setRequestHeader(name: string, value: string): void {
      headers[name.toLowerCase()] = value;
    }
    send(_body?: unknown): void {
      this.status = response.status;
      this.responseText = response.body;
      queueMicrotask(() => this.onload?.(null));
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return { openCalls, headers };
}

describe("GoogleDriveProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses folder input and builds a namespaced replay URL", () => {
    const provider = new GoogleDriveProvider(mockAuth());
    const parsed = provider.parseFolderInput("/gn-tracing");
    expect(parsed.folderPath.length).toBeGreaterThan(0);
    const url = provider.buildReplayUrl("file-abc");
    expect(url).toMatch(/file-abc/);
    expect(url).toMatch(/gdrive|google|tracing/i);
  });

  it("uploadPackage posts multipart and returns file id", async () => {
    const xhr = installXhrMock({
      status: 200,
      body: JSON.stringify({ id: "drive-file-1" }),
    });

    const provider = new GoogleDriveProvider(mockAuth(), Number.MAX_SAFE_INTEGER);
    const result = await provider.uploadPackage({
      authToken: "tok",
      folderId: "folder-1",
      filename: "gn-tracing-test.zip",
      blob: new Blob(["zip-bytes"]),
      onProgress: () => {},
    });
    expect(result.fileId).toBe("drive-file-1");
    expect(xhr.openCalls.some((c) => c.url.includes("upload"))).toBe(true);
    expect(xhr.headers.authorization).toBe("Bearer tok");
  });

  it("makePublicReadable hard-fails when share permission is denied", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "forbidden" } }),
    });
    const provider = new GoogleDriveProvider(mockAuth());
    await expect(provider.makePublicReadable("tok", "file-1")).rejects.toThrow(/forbidden|403/i);
  });

  it("makePublicReadable returns replayId equal to Drive file id on success", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const provider = new GoogleDriveProvider(mockAuth());
    const result = await provider.makePublicReadable("tok", "file-xyz");
    expect(result.replayId).toBe("file-xyz");
  });

  it("connect/disconnect/isConnected delegate to auth", async () => {
    const auth = mockAuth();
    const provider = new GoogleDriveProvider(auth);
    await expect(provider.connect()).resolves.toEqual({ ok: true });
    await expect(provider.disconnect()).resolves.toEqual({ ok: true });
    await expect(provider.isConnected()).resolves.toBe(true);
    await expect(provider.getAuthToken()).resolves.toBe("drive-token");
  });
});

describe("DropboxProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses folder input and builds dropbox replay URL", () => {
    const provider = new DropboxProvider(mockDropboxAuth());
    const parsed = provider.parseFolderInput("/Apps/gn-tracing");
    expect(Array.isArray(parsed.folderPath)).toBe(true);
    const url = provider.buildReplayUrl("shared-id-1");
    expect(url).toMatch(/shared-id-1/);
    expect(url).toMatch(/dropbox/i);
  });

  it("uploadPackage uses Dropbox content API and returns path as fileId", async () => {
    const xhr = installXhrMock({
      status: 200,
      body: JSON.stringify({
        path_display: "/gn-tracing/pkg.zip",
        path_lower: "/gn-tracing/pkg.zip",
        id: "id:abc",
      }),
    });

    const provider = new DropboxProvider(mockDropboxAuth(), Number.MAX_SAFE_INTEGER);
    const result = await provider.uploadPackage({
      authToken: "dbx-tok",
      folderId: "/gn-tracing",
      filename: "pkg.zip",
      blob: new Blob(["data"]),
      onProgress: () => {},
    });
    expect(result.fileId).toMatch(/pkg\.zip/);
    expect(xhr.openCalls.some((c) => c.url.includes("files/upload"))).toBe(true);
    expect(xhr.headers.authorization).toBe("Bearer dbx-tok");
  });

  it("makePublicReadable returns shared-link replay id from Dropbox API", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://www.dropbox.com/s/abc123xyz/pkg.zip?dl=0",
      }),
    });
    const provider = new DropboxProvider(mockDropboxAuth());
    const result = await provider.makePublicReadable("tok", "/gn-tracing/pkg.zip");
    expect(result.replayId.length).toBeGreaterThan(0);
    // Replay id is derived from the shared link, not the raw path.
    expect(result.replayId).not.toBe("/gn-tracing/pkg.zip");
  });

  it("makePublicReadable throws when share fails", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error_summary: "shared_link_already_exists/..." }),
      text: async () => "conflict",
    });
    const provider = new DropboxProvider(mockDropboxAuth());
    // Implementation may retry create/list; force consistent failure.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error_summary: "server_error" }),
      text: async () => "err",
    });
    await expect(provider.makePublicReadable("tok", "/path/file.zip")).rejects.toThrow();
  });
});
