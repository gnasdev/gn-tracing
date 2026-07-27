/**
 * Remote MCP endpoint tests, run inside the real `workerd` runtime.
 *
 * The interesting cases are the ones where the remote transport must behave
 * *differently* from the local one: it refuses local paths and passwords, caps
 * package size, and answers arbitrary origins without inheriting the OAuth
 * origin allow-list.
 *
 * Upstream package downloads are stubbed, so no test touches the network.
 */

import { describe, expect, it, vi } from "vitest";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import worker, { type Env } from "./index";
import { isMcpEnabled, isMcpPath } from "./mcp-route";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    ...overrides,
  };
}

/** Serves the sample package for any /api/* request, honouring Range. */
function stubPackageFetch(bytes: Uint8Array) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/api/")) {
      throw new Error(`unexpected upstream request: ${url}`);
    }
    const range = new Headers(init?.headers as HeadersInit).get("range") ?? "";
    const suffix = /^bytes=-(\d+)$/.exec(range);
    const explicit = /^bytes=(\d+)-(\d+)$/.exec(range);
    let start = 0;
    let end = bytes.length;
    if (suffix) {
      start = Math.max(0, bytes.length - Number(suffix[1]));
    } else if (explicit) {
      start = Number(explicit[1]);
      end = Math.min(bytes.length, Number(explicit[2]) + 1);
    } else {
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }
    return new Response(new Uint8Array(bytes.subarray(start, end)), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end - 1}/${bytes.length}` },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mcpRequest(body: unknown, origin = "https://example.com"): Request {
  return new Request("https://proxy.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env = makeEnv(),
): Promise<Record<string, never>> {
  const response = await worker.fetch(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    env,
  );
  const payload = (await response.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(payload.result.content[0].text);
}

describe("route matching", () => {
  it("matches /mcp with or without a trailing slash", () => {
    expect(isMcpPath("/mcp")).toBe(true);
    expect(isMcpPath("/mcp/")).toBe(true);
    expect(isMcpPath("/mcpx")).toBe(false);
    expect(isMcpPath("/token")).toBe(false);
  });

  it("is enabled unless explicitly turned off", () => {
    expect(isMcpEnabled({})).toBe(true);
    expect(isMcpEnabled({ MCP_ENABLED: "true" })).toBe(true);
    expect(isMcpEnabled({ MCP_ENABLED: "false" })).toBe(false);
    expect(isMcpEnabled({ MCP_ENABLED: "0" })).toBe(false);
  });
});

describe("POST /mcp", () => {
  it("completes the handshake for any origin", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const payload = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(payload.result.serverInfo.name).toBe("gn-tracing-remote");
  });

  it("lists the same tools as the local server", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      makeEnv(),
    );
    const payload = (await response.json()) as { result: { tools: unknown[] } };
    expect(payload.result.tools).toHaveLength(13);
  });

  it("answers preflight without the OAuth origin allow-list", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://unrelated.example" },
      }),
      makeEnv(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects a non-POST method", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", { method: "GET" }),
      makeEnv(),
    );
    expect(response.status).toBe(405);
  });

  it("returns 202 with no body for a notification", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      makeEnv(),
    );
    expect(response.status).toBe(202);
  });

  it("reports the endpoint in /health", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/health", { method: "GET" }),
      makeEnv(),
    );
    expect((await response.json()) as { mcp: boolean }).toMatchObject({ mcp: true });
  });

  it("can be disabled per deployment", async () => {
    const response = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      makeEnv({ MCP_ENABLED: "false" }),
    );
    expect(response.status).toBe(404);
  });
});

describe("reading a recording remotely", () => {
  it("opens a hosted recording through the download proxy and summarizes it", async () => {
    const bytes = await buildSamplePackage();
    const fetchMock = stubPackageFetch(bytes);

    const opened = await callTool("open_recording", {
      source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
    });
    expect(opened).toMatchObject({ recordingId: "gdrive:1AbCdEfGhIjKlMnOp" });

    const overview = await callTool("get_overview", {
      recordingId: "gdrive:1AbCdEfGhIjKlMnOp",
    });
    expect(overview).toMatchObject({ counts: { errors: 2, networkFailed: 1 } });

    // Every upstream call went to the player's proxy, never to a provider host.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("https://tracing.gnas.dev/api/drive");
    }
    vi.unstubAllGlobals();
  });

  it("refuses a local file path", async () => {
    const result = await callTool("open_recording", { source: "/etc/passwd.zip" });
    expect(result).toMatchObject({ error: { code: "INVALID_SOURCE" } });
  });

  it("refuses a Dropbox id that is not a relative shared link", async () => {
    const result = await callTool("open_recording", {
      source: "https://tracing.gnas.dev/dropbox/https://evil.example/payload.zip",
    });
    expect(result).toMatchObject({ error: {} });
  });

  it("ignores a password argument instead of forwarding it", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    stubPackageFetch(bytes);

    const result = await callTool("open_recording", {
      source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
      password: "hunter2",
    });

    expect(result).toMatchObject({ error: { code: "PACKAGE_ENCRYPTED" } });
    vi.unstubAllGlobals();
  });

  it("refuses an oversized request body before parsing it", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": String(10 * 1024 * 1024) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("answers unparseable JSON with a parse error", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32700 },
    });
  });
});
