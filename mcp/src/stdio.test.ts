/**
 * Transport tests: the server is driven exactly as a client drives it.
 *
 * Handshake, framing, and path safety are the parts that fail in the field
 * rather than in unit tests — a client sends two messages in one chunk, or a
 * tool argument tries to read outside the allow-listed directory.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ByteRangeSource, createBytesSource } from "../../packages/replay-core/src/index";
import { buildSamplePackage } from "../../packages/replay-core/src/testing/fixture";
import {
  DEFAULT_PROTOCOL_VERSION,
  handleMessage,
  type JsonRpcResponse,
  type ToolDefinition,
} from "./protocol";
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
function createCapture(): {
  stream: Writable;
  text: () => string;
  lines: () => JsonRpcResponse[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const text = () => chunks.join("");
  return {
    stream,
    text,
    lines: () =>
      text()
        .split("\n")
        .filter(Boolean)
        // Written by JSON.stringify of a JsonRpcResponse a few lines upstream.
        .map((line) => JSON.parse(line) as JsonRpcResponse),
  };
}

/**
 * Drives the server with the exact chunk boundaries given.
 *
 * Chunking is the point of most of these tests: real stdin delivers `Buffer`s
 * that split wherever the pipe felt like splitting, not one whole message at a
 * time.
 */
async function runChunks(
  chunks: Array<string | Uint8Array>,
): Promise<{ text: string; lines: JsonRpcResponse[] }> {
  const bytes = await buildSamplePackage();
  const store = createRecordingStore({
    openSource: async (): Promise<ByteRangeSource> => createBytesSource(bytes),
  });
  const capture = createCapture();

  await runStdioServer(store, {
    // Object mode keeps each element one chunk; a byte stream would recoalesce them.
    input: Readable.from(chunks, { objectMode: true }),
    output: capture.stream,
  });

  return { text: capture.text(), lines: capture.lines() };
}

async function runSession(input: string): Promise<JsonRpcResponse[]> {
  return (await runChunks([input])).lines;
}

/** Narrows a tools/list result instead of asserting a shape onto it. */
function toolsOf(response: JsonRpcResponse): ToolDefinition[] {
  const result = response.result;
  if (!result || typeof result !== "object" || !("tools" in result)) {
    throw new Error(`Not a tools/list result: ${JSON.stringify(response)}`);
  }
  const { tools } = result;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list did not return an array.");
  }
  return tools as ToolDefinition[];
}

function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

/** Temp directories the tests created, removed once at the end. */
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("stdio transport", () => {
  it("completes the MCP handshake and lists tools", async () => {
    const responses = await runSession(
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
    );

    // The notification gets no reply, by spec.
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: DEFAULT_PROTOCOL_VERSION, serverInfo: { name: "gn-tracing" } },
    });
    expect(responses[1].id).toBe(2);

    // No pinned count: the number changes whenever a reader lands, and the
    // contract a client depends on is that each advertised tool is complete
    // enough to call — a name, a description, and an object input schema.
    const listed = toolsOf(responses[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const tool of listed) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(new Set(listed.map((tool) => tool.name)).size).toBe(listed.length);
  });

  it("routes every tool it advertises", async () => {
    // The failure this catches: a definition added to TOOL_DEFINITIONS without a
    // matching case in the dispatcher. Such a tool lists fine and then reports
    // `Unknown tool` the first time the model calls it.
    const listed = toolsOf(
      (await runSession(frame({ jsonrpc: "2.0", id: 1, method: "tools/list" })))[0],
    );

    const calls = listed.map((tool, index) =>
      frame({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: tool.name } }),
    );
    const responses = await runSession(calls.join(""));

    expect(responses).toHaveLength(listed.length);
    for (const [index, response] of responses.entries()) {
      // Called with no arguments, so each is expected to fail — but on a missing
      // argument or recording, never on the tool name itself.
      expect(JSON.stringify(response)).not.toContain("Unknown tool");
      expect(response.id).toBe(index);
    }
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

describe("stdio framing", () => {
  it("decodes Buffer chunks, which is what real stdin delivers", async () => {
    // Every other test feeds strings; only this one exercises the TextDecoder path.
    const { lines } = await runChunks([
      Buffer.from(frame({ jsonrpc: "2.0", id: 1, method: "ping" }), "utf8"),
      Buffer.from(frame({ jsonrpc: "2.0", id: 2, method: "ping" }), "utf8"),
    ]);

    expect((lines as Array<{ id: number }>).map((line) => line.id)).toEqual([1, 2]);
  });

  it("holds a message that arrives without its newline until the newline lands", async () => {
    const message = frame({ jsonrpc: "2.0", id: 1, method: "ping" });
    const { lines } = await runChunks([
      Buffer.from(message.slice(0, 12), "utf8"),
      Buffer.from(message.slice(12, 25), "utf8"),
      Buffer.from(message.slice(25), "utf8"),
    ]);

    expect(lines).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("answers both messages when they share one chunk", async () => {
    const { lines } = await runChunks([
      frame({ jsonrpc: "2.0", id: 1, method: "ping" }) +
        frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);

    expect((lines as Array<{ id: number }>).map((line) => line.id)).toEqual([1, 2]);
  });

  it("answers the first message of a chunk that ends mid-second-message", async () => {
    const second = frame({ jsonrpc: "2.0", id: 2, method: "ping" });
    const { lines } = await runChunks([
      frame({ jsonrpc: "2.0", id: 1, method: "ping" }) + second.slice(0, 15),
      second.slice(15),
    ]);

    expect((lines as Array<{ id: number }>).map((line) => line.id)).toEqual([1, 2]);
  });

  it("reassembles a multi-byte character split across a chunk boundary", async () => {
    // Why the decoder is called with `{ stream: true }`. Without it, the split
    // sequence decodes to U+FFFD — and the line still parses as JSON, so only an
    // assertion on a value echoed back through the response catches the damage.
    const method = "ping→ошибка";
    const encoded = Buffer.from(frame({ jsonrpc: "2.0", id: 1, method }), "utf8");
    const split = encoded.indexOf(Buffer.from("→", "utf8")) + 1;

    const { lines } = await runChunks([encoded.subarray(0, split), encoded.subarray(split)]);

    expect(lines).toHaveLength(1);
    const [response] = lines as Array<{ id: number; error: { message: string } }>;
    expect(response.id).toBe(1);
    expect(response.error.message).toBe(`Unknown method: ${method}`);
  });

  it("ignores blank and whitespace-only lines without answering them", async () => {
    const { lines } = await runChunks([
      `\n   \n\t\n${frame({ jsonrpc: "2.0", id: 1, method: "ping" })}\n\n`,
    ]);

    expect(lines).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("drops a trailing partial message rather than answering a truncated one", async () => {
    const { lines } = await runChunks([
      frame({ jsonrpc: "2.0", id: 1, method: "ping" }),
      '{"jsonrpc":"2.0","id":2,"method":"pi',
    ]);

    expect(lines).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("writes protocol frames to stdout and nothing else", async () => {
    // The invariant from the file header: a stray write here corrupts the stream
    // for every client, so assert on the raw bytes rather than the parsed lines.
    const { text } = await runChunks([
      frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      frame({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "not json\n",
      frame({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "open_recording",
          arguments: { source: "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp" },
        },
      }),
    ]);

    expect(text.endsWith("\n")).toBe(true);
    const written = text.split("\n").slice(0, -1);
    expect(written).toHaveLength(3);
    for (const line of written) {
      const message = JSON.parse(line) as { jsonrpc: string; id: unknown };
      expect(message.jsonrpc).toBe("2.0");
      expect(Object.keys(message).sort()).toEqual(expect.arrayContaining(["id", "jsonrpc"]));
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

  it("accepts the allowed directory itself, not only children of it", () => {
    expect(assertAllowedPath("/data/recordings", ["/data/recordings"])).toBe("/data/recordings");
  });

  it("refuses a sibling whose whole name shares the prefix", () => {
    // No separator follows the allowed prefix, so a plain `startsWith` would pass.
    expect(() => assertAllowedPath("/data/recordings-secret", ["/data/recordings"])).toThrow(
      /outside/,
    );
  });

  it("resolves a relative path against the process cwd before checking it", () => {
    const inside = join(process.cwd(), "downloads", "a.zip");

    expect(assertAllowedPath(join("downloads", "a.zip"), [join(process.cwd(), "downloads")])).toBe(
      inside,
    );
    expect(() => assertAllowedPath(join("downloads", "a.zip"), ["/data/recordings"])).toThrow(
      /outside/,
    );
  });

  it("accepts a path from any one of several allowed directories", () => {
    expect(assertAllowedPath("/b/a.zip", ["/a", "/b", "/c"])).toBe("/b/a.zip");
    // The hint names every allowed directory so the agent can retry with a real one.
    expect(() => assertAllowedPath("/d/a.zip", ["/a", "/b", "/c"])).toThrowError(
      expect.objectContaining({ code: "INVALID_SOURCE", hint: "Allowed: /a, /b, /c" }),
    );
  });
});

describe("local file source", () => {
  it("opens a package written to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "recording.zip");
    await writeFile(path, await buildSamplePackage());

    const store = createLocalRecordingStore({ allowedDirectories: [directory] });
    const opened = await store.open(path);

    expect(opened.recordingId).toBe(`file:${path}`);
    expect((await opened.session.summary()).counts.errors).toBe(2);
  });

  it("reports a missing file instead of throwing a raw fs error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    temporaryDirectories.push(directory);
    await expect(createFileSource(join(directory, "missing.zip"))).rejects.toMatchObject({
      code: "PACKAGE_NOT_FOUND",
    });
  });

  it("refuses a directory the same way it refuses a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    temporaryDirectories.push(directory);

    await expect(createFileSource(directory)).rejects.toMatchObject({
      code: "PACKAGE_NOT_FOUND",
    });
  });
});

describe("local file ranged reads", () => {
  const content = "0123456789";
  let path = "";

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "gn-tracing-mcp-"));
    temporaryDirectories.push(directory);
    path = join(directory, "bytes.bin");
    await writeFile(path, content);
  });

  it("reads an interior range", async () => {
    const source = await createFileSource(path);

    expect(decodeBytes(await source.read(2, 5))).toBe("234");
  });

  it("clamps a range that runs past the end of the file", async () => {
    const source = await createFileSource(path);

    expect(decodeBytes(await source.read(7, 999))).toBe("789");
  });

  it("returns an empty array for a zero-length or inverted range", async () => {
    const source = await createFileSource(path);

    expect(await source.read(4, 4)).toEqual(new Uint8Array(0));
    expect(await source.read(6, 2)).toEqual(new Uint8Array(0));
    expect(await source.read(50, 60)).toEqual(new Uint8Array(0));
  });

  it("reports the tail with its absolute start offset", async () => {
    const source = await createFileSource(path);
    const tail = await source.readTail(4);

    expect(decodeBytes(tail.bytes)).toBe("6789");
    expect(tail.start).toBe(6);
    expect(tail.totalSize).toBe(content.length);
  });

  it("clamps a tail request larger than the file to the whole file", async () => {
    // The zip directory probe asks for a fixed tail size, so a package smaller
    // than that must come back whole and start at 0, not at a negative offset.
    const source = await createFileSource(path);
    const tail = await source.readTail(4096);

    expect(decodeBytes(tail.bytes)).toBe(content);
    expect(tail.start).toBe(0);
    expect(tail.totalSize).toBe(content.length);
  });

  it("reports itself as not fully buffered so callers keep using ranges", async () => {
    const source = await createFileSource(path);

    expect(source.isFullyBuffered?.()).toBe(false);
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
