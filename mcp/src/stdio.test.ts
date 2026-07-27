/**
 * Transport tests: the server is driven exactly as a client drives it.
 *
 * Handshake, framing, and path safety are the parts that fail in the field
 * rather than in unit tests — a client sends two messages in one chunk, or a
 * tool argument tries to read outside the allow-listed directory.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type ByteRangeSource, createBytesSource } from "../../packages/replay-core/src/index";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import { DEFAULT_PROTOCOL_VERSION, handleMessage } from "./protocol";
import { createRecordingStore } from "./resolver";
import {
  assertAllowedPath,
  createFileSource,
  createLocalRecordingStore,
  runStdioServer,
  SERVER_INFO,
} from "./stdio";
import { createToolRegistry } from "./tools";

/** Collects the newline-delimited responses the server writes to stdout. */
function createCapture(): { stream: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
  };
}

async function runSession(input: string): Promise<unknown[]> {
  const bytes = await buildSamplePackage();
  const store = createRecordingStore({
    openSource: async (): Promise<ByteRangeSource> => createBytesSource(bytes),
  });
  const capture = createCapture();

  await runStdioServer(store, {
    input: Readable.from([input]),
    output: capture.stream,
  });

  return capture.lines();
}

describe("stdio transport", () => {
  it("completes the MCP handshake and lists tools", async () => {
    const responses = (await runSession(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: {} },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "",
      ].join("\n"),
    )) as Array<{ id: number; result: Record<string, never> }>;

    // The notification gets no reply, by spec.
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: DEFAULT_PROTOCOL_VERSION, serverInfo: { name: "gn-tracing" } },
    });
    expect(responses[1].id).toBe(2);
    expect((responses[1].result as unknown as { tools: unknown[] }).tools).toHaveLength(13);
  });

  it("echoes back an older protocol version the client asked for", async () => {
    const responses = (await runSession(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      })}\n`,
    )) as Array<{ result: { protocolVersion: string } }>;

    expect(responses[0].result.protocolVersion).toBe("2024-11-05");
  });

  it("handles several messages arriving in one chunk", async () => {
    const responses = await runSession(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        "",
      ].join("\n"),
    );

    expect(responses).toHaveLength(2);
  });

  it("answers a malformed line with a parse error rather than dying", async () => {
    const responses = (await runSession(
      `not json\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
    )) as Array<{ error?: { code: number } }>;

    expect(responses[0].error?.code).toBe(-32700);
    expect(responses[1]).toMatchObject({ id: 1, result: {} });
  });

  it("reports an unknown method with the JSON-RPC code for it", async () => {
    const responses = (await runSession(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" })}\n`,
    )) as Array<{ error?: { code: number } }>;

    expect(responses[0].error?.code).toBe(-32601);
  });

  it("runs a full open → overview conversation", async () => {
    const responses = (await runSession(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "open_recording",
            arguments: { source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_overview",
            arguments: { recordingId: "gdrive:1AbCdEfGhIjKlMnOp" },
          },
        }),
        "",
      ].join("\n"),
    )) as Array<{ result: { content: Array<{ text: string }> } }>;

    expect(responses).toHaveLength(2);
    const overview = JSON.parse(responses[1].result.content[0].text) as {
      counts: { errors: number };
    };
    expect(overview.counts.errors).toBe(2);
  });

  it("keeps every tool response inside a sane size budget", async () => {
    const responses = (await runSession(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "open_recording",
            arguments: { source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_overview",
            arguments: { recordingId: "gdrive:1AbCdEfGhIjKlMnOp" },
          },
        }),
        "",
      ].join("\n"),
    )) as Array<{ result: { content: Array<{ text: string }> } }>;

    for (const response of responses) {
      // ~4 chars per token: 32k chars is well inside a single tool result.
      expect(response.result.content[0].text.length).toBeLessThan(32_000);
    }
  });
});

describe("assertAllowedPath", () => {
  it("refuses every path when local reading is disabled", () => {
    expect(() => assertAllowedPath("/tmp/x.zip", [])).toThrow(/disabled/);
  });

  it("accepts a file inside an allowed directory", () => {
    expect(assertAllowedPath("/data/recordings/a.zip", ["/data/recordings"])).toBe(
      "/data/recordings/a.zip",
    );
  });

  it("refuses traversal out of an allowed directory", () => {
    expect(() =>
      assertAllowedPath("/data/recordings/../../etc/passwd", ["/data/recordings"]),
    ).toThrow(/outside/);
  });

  it("refuses a sibling directory that merely shares a prefix", () => {
    expect(() => assertAllowedPath("/data/recordings-secret/a.zip", ["/data/recordings"])).toThrow(
      /outside/,
    );
  });
});

describe("local file source", () => {
  it("opens a package written to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    const path = join(directory, "recording.zip");
    await writeFile(path, await buildSamplePackage());

    const store = createLocalRecordingStore({ allowedDirectories: [directory] });
    const opened = await store.open(path);

    expect(opened.recordingId).toBe(`file:${path}`);
    expect((await opened.session.summary()).counts.errors).toBe(2);
  });

  it("reports a missing file instead of throwing a raw fs error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    await expect(createFileSource(join(directory, "missing.zip"))).rejects.toMatchObject({
      code: "PACKAGE_NOT_FOUND",
    });
  });
});

describe("server info", () => {
  it("ships instructions to the model on initialize", async () => {
    const bytes = await buildSamplePackage();
    const store = createRecordingStore({
      openSource: async (): Promise<ByteRangeSource> => createBytesSource(bytes),
    });
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      createToolRegistry(store),
      SERVER_INFO,
    );

    expect((response?.result as { instructions: string }).instructions).toContain("untrusted");
  });
});
