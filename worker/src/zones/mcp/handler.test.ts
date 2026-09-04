/**
 * Remote MCP endpoint tests, run inside the real `workerd` runtime.
 *
 * The interesting cases are the ones where the remote transport must behave
 * *differently* from the local one: it refuses local paths and passwords, caps
 * body and batch size, validates the protocol header, and answers arbitrary
 * origins without inheriting the OAuth origin allow-list.
 *
 * Upstream package downloads are stubbed, so no test touches the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_DEFINITIONS } from "../../../../mcp/src/tools";
import {
  buildFixturePackage,
  buildSampleArtifacts,
  buildSamplePackage,
} from "../../../../packages/replay-core/src/testing/fixture";
import { isMcpEnabled } from "../../env";
import worker, { type Env } from "../../index";
import { MCP_RATE_LIMIT } from "../../middleware/rate-limit";
import { isMcpPath, MCP_SERVER_INFO } from "./handler";
import { MAX_BATCH_MESSAGES, MAX_REQUEST_BODY_BYTES } from "./limits";

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

/** Records that an upstream call was attempted without serving anything. */
function stubRefusingFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`unexpected upstream request: ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://proxy.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.com",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown, env: Env = makeEnv()): Promise<Response> {
  return worker.fetch(mcpRequest(body), env);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env = makeEnv(),
): Promise<Record<string, never>> {
  const response = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    env,
  );
  const payload = (await response.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(payload.result.content[0].text);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const payload = (await response.json()) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(payload.result.serverInfo).toEqual({
      name: "gn-tracing-remote",
      version: MCP_SERVER_INFO.version,
    });
  });

  it("exposes exactly the tool surface the local server defines", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const payload = (await response.json()) as { result: { tools: Array<{ name: string }> } };

    expect(payload.result.tools.map((tool) => tool.name)).toEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
    );
  });

  it("echoes a protocol version it supports and falls back for one it does not", async () => {
    const supported = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect((await supported.json()) as { result: { protocolVersion: string } }).toMatchObject({
      result: { protocolVersion: "2024-11-05" },
    });

    const unknown = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((await unknown.json()) as { result: { protocolVersion: string } }).toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
  });

  it("answers ping and reports an unknown method", async () => {
    const ping = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await ping.json()) as { result: unknown }).toMatchObject({ result: {} });

    const unknown = await post({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    expect((await unknown.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32601 },
    });
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

  it("reports the endpoint in /health", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/health", { method: "GET" }),
      makeEnv(),
    );
    expect((await response.json()) as { mcp: boolean }).toMatchObject({ mcp: true });
  });

  it("can be disabled per deployment, still with CORS headers", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      makeEnv({ MCP_ENABLED: "false" }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("transport guards", () => {
  it("refuses a body whose declared length is over the cap", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": String(10 * 1024 * 1024) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("refuses an oversized body that declares no length at all", async () => {
    // A streamed body is sent chunked, so there is no Content-Length to check;
    // the cap has to come from the bytes actually read.
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { pad: "x".repeat(MAX_REQUEST_BODY_BYTES + 1024) },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const request = new Request("https://proxy.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(request.headers.get("content-length")).toBeNull();

    const response = await worker.fetch(request, makeEnv());
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

  it("refuses a CORS-simple content type that would skip preflight", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(415);
    expect((await response.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32600 },
    });
  });

  it("accepts a JSON content type with parameters", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(200);
  });

  it("rejects an unsupported MCP-Protocol-Version and allows a supported or absent one", async () => {
    const unsupported = await worker.fetch(
      mcpRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { "MCP-Protocol-Version": "1999-01-01" },
      ),
      makeEnv(),
    );
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32600 },
    });

    const supported = await worker.fetch(
      mcpRequest(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { "MCP-Protocol-Version": "2025-06-18" },
      ),
      makeEnv(),
    );
    expect(supported.status).toBe(200);

    // Absence is legal: the spec tells the server to assume 2025-03-26.
    const absent = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(absent.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("refuses further calls from one IP once its hourly budget is spent", async () => {
    // The limiter is Cache-API-backed and keyed by hashed IP, so a dedicated IP
    // gets its own bucket without disturbing the other tests.
    const env = makeEnv();
    const spend = async () =>
      worker.fetch(
        mcpRequest(
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { "CF-Connecting-IP": "203.0.113.7" },
        ),
        env,
      );

    for (let call = 0; call < MCP_RATE_LIMIT; call += 1) {
      expect((await spend()).status).toBe(200);
    }

    const refused = await spend();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await refused.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32000 },
    });
  });
});

describe("batches", () => {
  it("answers an array with an array of only the non-notification results", async () => {
    const response = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Array<{ id: number }>;
    expect(payload.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it("returns 202 with no body for a notification, alone or in an array", async () => {
    const single = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(single.status).toBe(202);

    const array = await post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ]);
    expect(array.status).toBe(202);
    expect(await array.text()).toBe("");
  });

  it("refuses a batch that would multiply one rate-limit token into many calls", async () => {
    const oversized = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_unused, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "ping",
    }));

    const response = await post(oversized);
    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await response.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32600 },
    });
  });

  it("accepts a batch at the cap", async () => {
    const atCap = Array.from({ length: MAX_BATCH_MESSAGES }, (_unused, index) => ({
      jsonrpc: "2.0",
      id: index,
      method: "ping",
    }));

    const response = await post(atCap);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown[]).toHaveLength(MAX_BATCH_MESSAGES);
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
  });

  it("downloads through the configured player origin", async () => {
    const bytes = await buildSamplePackage();
    const fetchMock = stubPackageFetch(bytes);

    await callTool(
      "open_recording",
      { source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp" },
      makeEnv({ PLAYER_ORIGIN: "https://staging.player.example" }),
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0]).startsWith("https://staging.player.example/api/drive")).toBe(true);
    }
  });

  it("caps how far a single artifact may inflate inside the isolate", async () => {
    // Compresses to a few KB, so nothing about the request looks large until the
    // reader inflates it. Sized between the remote 8 MB ceiling and replay-core's
    // 32 MB default: without the ceiling wired through, this is simply read.
    const oversizedConsole = JSON.stringify([
      { source: "console-api", level: "log", timestamp: 1, message: "a".repeat(9 * 1024 * 1024) },
    ]);
    const bytes = await buildFixturePackage([
      { name: "metadata.json", content: buildSampleArtifacts().metadata },
      { name: "console.json", content: oversizedConsole, method: 8 },
    ]);
    stubPackageFetch(bytes);

    await callTool("open_recording", {
      source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
    });
    const result = await callTool("list_console", {
      recordingId: "gdrive:1AbCdEfGhIjKlMnOp",
    });

    expect(result).toMatchObject({ error: { code: "ENTRY_TOO_LARGE" } });
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

  it("refuses a local recording id handed straight to a follow-up call", async () => {
    const fetchMock = stubRefusingFetch();

    const result = await callTool("get_overview", { recordingId: "file:/etc/passwd" });

    expect(result).toMatchObject({ error: { code: "INVALID_SOURCE" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a recording id it cannot decode", async () => {
    const fetchMock = stubRefusingFetch();

    const result = await callTool("get_overview", { recordingId: "not-a-recording-id" });

    expect(result).toMatchObject({ error: { code: "UNKNOWN_RECORDING" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates a typed recording id before spending an upstream request", async () => {
    const fetchMock = stubRefusingFetch();

    // Well-formed id, provider ref the download proxy would reject anyway.
    const result = await callTool("get_overview", { recordingId: "gdrive:short" });

    expect(result).toMatchObject({ error: { code: "UNSUPPORTED_PROVIDER" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("package passwords", () => {
  it("ignores a password argument instead of forwarding it", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    stubPackageFetch(bytes);

    const result = await callTool("open_recording", {
      source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
      password: "hunter2",
    });

    expect(result).toMatchObject({ error: { code: "PACKAGE_ENCRYPTED" } });
  });

  it("ignores a password on a follow-up tool too, not just open_recording", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    stubPackageFetch(bytes);

    const result = await callTool("get_overview", {
      recordingId: "gdrive:1AbCdEfGhIjKlMnOp",
      password: "hunter2",
    });

    expect(result).toMatchObject({ error: { code: "PACKAGE_ENCRYPTED" } });
  });

  it("strips the password from the one batch element that carries it", async () => {
    const bytes = await buildSamplePackage({ password: "hunter2" });
    stubPackageFetch(bytes);

    const response = await post([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_recording",
          arguments: {
            source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp",
            password: "hunter2",
          },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);

    const payload = (await response.json()) as Array<{
      id: number;
      result: { content: Array<{ text: string }> };
    }>;
    expect(JSON.parse(payload[0].result.content[0].text)).toMatchObject({
      error: { code: "PACKAGE_ENCRYPTED" },
    });
    expect(payload[1]).toMatchObject({ id: 2, result: {} });
  });
});
