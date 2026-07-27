/**
 * Recording package fixtures.
 *
 * Tests across four contexts (core, SDK, MCP, worker) need the same believable
 * package bytes. This file used to carry its own ZIP writer — its own CRC
 * table, its own ZipCrypto keystream, its own header layout — described in its
 * own docstring as "a faithful, minimal mirror" of the extension packager. A
 * mirror is exactly what a fixture must not be: the day it stopped matching,
 * every test would still pass while real packages broke.
 *
 * It now builds through `../write`, the same code every producer ships. A
 * fixture that the reader can open is therefore evidence about production, not
 * about the fixture.
 *
 * Test-only: not exported from the package entrypoint.
 */

import { EXTENSION_CAPABILITIES } from "../schema";
import type { InstantReplayArtifact, ScreenshotArtifact } from "../schema/annotation";
import type { AttachableArtifactId } from "../schema/package";
import {
  buildRecordingPackage,
  buildZipArchive,
  concatChunks,
  encodeJsonArtifact,
  type ZipInputEntry,
} from "../write";

/**
 * Big enough that the 64 KB zip-directory tail read cannot reach the video
 * payload — the "artifacts are read without downloading the video" test would
 * be vacuous with a toy-sized part.
 */
const VIDEO_PART_BYTES = 256 * 1024;

/** Fixed so fixture bytes stay byte-for-byte reproducible across runs. */
const FIXTURE_MODIFIED_AT = new Date("2026-01-01T00:00:00Z");

/** Deterministic ZipCrypto salt; production uses `crypto.getRandomValues`. */
const fixtureSalt = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);

export interface FixtureEntry {
  name: string;
  /** JSON value (serialized), a string, or raw bytes. */
  content: unknown;
  /** Force a compression method instead of the writer's size heuristic. */
  method?: 0 | 8;
}

export interface BuildPackageOptions {
  password?: string;
  /** Fixed timestamp so fixture bytes stay deterministic. */
  modifiedAt?: Date;
}

function toBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  return encodeJsonArtifact(content);
}

/**
 * Writes an arbitrary entry list. Used by the reader's own tests, which need to
 * construct packages the package writer would never produce.
 */
export async function buildFixturePackage(
  entries: FixtureEntry[],
  options: BuildPackageOptions = {},
): Promise<Uint8Array> {
  const zipEntries: ZipInputEntry[] = entries.map((entry) => ({
    name: entry.name,
    bytes: toBytes(entry.content),
    compression: entry.method === 0 ? "store" : entry.method === 8 ? "deflate" : "auto",
  }));

  return concatChunks(
    await buildZipArchive(zipEntries, {
      modifiedAt: options.modifiedAt ?? FIXTURE_MODIFIED_AT,
      password: options.password,
      randomBytes: fixtureSalt,
    }),
  );
}

/** Artifacts for a small but realistic recording (one error + one 500). */
export interface SampleRecordingOptions {
  startTime?: number;
  withConsole?: boolean;
  withNetwork?: boolean;
  withEvents?: boolean;
  withPrivacy?: boolean;
  withWebsocket?: boolean;
  agentSummary?: unknown;
  password?: string;
  /** Attach an annotated screenshot set (with a matching image entry). */
  withScreenshots?: boolean;
  /** Attach a small pre-bug instant-replay buffer. */
  withInstantReplay?: boolean;
}

export function buildSampleArtifacts(options: SampleRecordingOptions = {}) {
  const startTime = options.startTime ?? 1_760_000_000_000;

  const metadata = {
    timestamp: new Date(startTime).toISOString(),
    duration: 120_000,
    url: "https://shop.example.com/checkout",
    startTime,
    extension: "gn-tracing",
    version: "1.0.0",
    storage: { provider: "google-drive", folderId: "folder-1", package: "gn-tracing-test.zip" },
    video: { mimeType: "video/webm", totalBytes: VIDEO_PART_BYTES, partCount: 1 },
  };

  const consoleLogs = [
    {
      source: "console-api",
      level: "log",
      timestamp: startTime + 1000,
      message: "cart loaded",
    },
    {
      source: "exception",
      level: "error",
      timestamp: startTime + 62_000,
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
      stackTrace: [
        {
          functionName: "applyCoupon",
          url: "https://shop.example.com/assets/app.min.js",
          lineNumber: 4,
          columnNumber: 1200,
          originalSource: "src/checkout/cart.ts",
          originalLine: 128,
          originalColumn: 17,
          sourceSnippet: {
            source: "src/checkout/cart.ts",
            startLine: 126,
            line: 128,
            lines: ["const id = cart.item.id;"],
          },
        },
      ],
    },
    {
      source: "exception",
      level: "error",
      timestamp: startTime + 63_000,
      message: "TypeError: Cannot read properties of undefined (reading 'id')",
      stackTrace: [
        {
          functionName: "applyCoupon",
          url: "https://shop.example.com/assets/app.min.js",
          lineNumber: 4,
          columnNumber: 1200,
          originalSource: "src/checkout/cart.ts",
          originalLine: 128,
          originalColumn: 17,
        },
      ],
    },
    {
      source: "console-api",
      level: "warning",
      timestamp: startTime + 30_000,
      message: "deprecated coupon API",
    },
  ];

  const network = {
    schemaVersion: 2,
    entries: [
      {
        requestId: "req-1",
        url: "https://api.example.com/cart",
        method: "GET",
        requestHeaders: { accept: "application/json" },
        timestamp: (startTime + 5_000) / 1000,
        wallTime: (startTime + 5_000) / 1000,
        resourceType: "xhr",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        mimeType: "application/json",
        timing: { receiveHeadersEnd: 120 },
        encodedDataLength: 512,
        error: null,
        responseBody: { body: '{"items":[]}', base64Encoded: false },
      },
      {
        requestId: "req-2",
        url: "https://api.example.com/cart/apply",
        method: "POST",
        requestHeaders: { "content-type": "application/json" },
        postData: '{"coupon":"SUMMER"}',
        timestamp: (startTime + 61_800) / 1000,
        wallTime: (startTime + 61_800) / 1000,
        resourceType: "xhr",
        status: 500,
        statusText: "Internal Server Error",
        responseHeaders: { "content-type": "application/json" },
        mimeType: "application/json",
        timing: { receiveHeadersEnd: 2400 },
        encodedDataLength: 64,
        error: null,
      },
    ],
  };

  const websocket = [
    {
      requestId: "ws-1",
      url: "wss://api.example.com/live",
      closed: true,
      frames: [
        { direction: "sent", timestamp: 12345.5, opcode: 1, payloadData: "ping" },
        { direction: "received", timestamp: 12346.5, opcode: 1, payloadData: "pong" },
      ],
    },
  ];

  const events = {
    schemaVersion: 1,
    events: [
      { type: "navigation", timestamp: startTime, url: "https://shop.example.com/checkout" },
      {
        type: "click",
        timestamp: startTime + 61_200,
        selector: "button#apply",
        text: "Apply coupon",
      },
    ],
  };

  const privacy = {
    schemaVersion: 1,
    policyVersion: 1,
    profile: "balanced",
    createdAt: new Date(startTime).toISOString(),
    artifactFlags: {
      video: true,
      screenshot: false,
      report: true,
      events: true,
      console: true,
      network: true,
      websocket: true,
      requestBodies: true,
      responseBodies: false,
      websocketPayloads: false,
      sourceSnippets: true,
      storage: false,
      dom: false,
    },
    counts: [{ artifact: "headers", class: "credential", action: "redacted", count: 3 }],
    limitations: ["Response bodies were not captured."],
  };

  const screenshots: ScreenshotArtifact = {
    schemaVersion: 1,
    screenshots: [
      {
        id: "shot-1",
        capturedAt: startTime + 61_500,
        url: "https://shop.example.com/checkout",
        title: "Checkout",
        viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
        source: { kind: "image", path: "screenshots/shot-1.png", mimeType: "image/png" },
        caption: "Total shows $0 after applying the coupon",
        annotations: [
          {
            id: "a1",
            createdAt: startTime + 61_600,
            type: "arrow",
            from: { x: 0.3, y: 0.7 },
            to: { x: 0.72, y: 0.24 },
          },
          {
            id: "a2",
            createdAt: startTime + 61_700,
            type: "text",
            at: { x: 0.7, y: 0.3 },
            text: "should be $42",
          },
          {
            id: "a3",
            createdAt: startTime + 61_800,
            type: "redact",
            rect: { x: 0.05, y: 0.05, width: 0.25, height: 0.06 },
            applied: "blur",
          },
        ],
      },
    ],
  };

  const instantReplay: InstantReplayArtifact = {
    schemaVersion: 1,
    windowMs: 120_000,
    coveredMs: 4_200,
    droppedFrames: 12,
    frames: [
      {
        capturedAt: startTime + 57_300,
        relativeMs: 0,
        documentUrl: "https://shop.example.com/checkout",
        viewport: { width: 1440, height: 900 },
        root: { nodeType: 1, nodeName: "HTML" },
      },
      {
        capturedAt: startTime + 61_500,
        relativeMs: 4_200,
        documentUrl: "https://shop.example.com/checkout",
        viewport: { width: 1440, height: 900 },
        root: { nodeType: 1, nodeName: "HTML" },
      },
    ],
  };

  const report = {
    schemaVersion: 1,
    title: "Coupon apply fails",
    source: "extension",
    createdAt: new Date(startTime).toISOString(),
    page: { url: "https://shop.example.com/checkout", title: "Checkout" },
    environment: {
      extensionVersion: "1.7.2",
      userAgent: "Mozilla/5.0",
      language: "en-US",
      timezone: "Asia/Ho_Chi_Minh",
      browserName: "Chrome",
      browserVersion: "141",
      viewport: { width: 1512, height: 857, devicePixelRatio: 2 },
    },
  };

  return {
    metadata,
    console: options.withConsole === false ? undefined : consoleLogs,
    network: options.withNetwork === false ? undefined : network,
    websocket: options.withWebsocket === false ? undefined : websocket,
    events: options.withEvents === false ? undefined : events,
    privacy: options.withPrivacy === false ? undefined : privacy,
    report,
    screenshots: options.withScreenshots ? screenshots : undefined,
    instantReplay: options.withInstantReplay ? instantReplay : undefined,
  };
}

/**
 * Builds a complete sample package through the production writer: the same
 * index documents, entry ordering, and container an extension upload produces.
 */
export async function buildSamplePackage(
  options: SampleRecordingOptions = {},
): Promise<Uint8Array> {
  const sample = buildSampleArtifacts(options);
  const artifacts: Partial<Record<AttachableArtifactId, Uint8Array>> = {};

  const attach = (id: AttachableArtifactId, content: unknown): void => {
    if (content !== undefined) {
      artifacts[id] = encodeJsonArtifact(content);
    }
  };

  attach("report", sample.report);
  attach("events", sample.events);
  attach("privacy", sample.privacy);
  attach("console", sample.console);
  attach("network", sample.network);
  attach("websocket", sample.websocket);
  attach("agentSummary", options.agentSummary);
  attach("screenshots", sample.screenshots);
  attach("instantReplay", sample.instantReplay);

  const built = await buildRecordingPackage({
    producer: "extension",
    capabilities: EXTENSION_CAPABILITIES,
    packagedAt: sample.metadata.timestamp,
    zipFilename: "gn-tracing-test.zip",
    duration: sample.metadata.duration,
    url: sample.metadata.url,
    startTime: sample.metadata.startTime,
    storage: { provider: "google-drive", folderId: "folder-1" },
    video: {
      mimeType: "video/webm",
      totalBytes: VIDEO_PART_BYTES,
      parts: [{ bytes: new Uint8Array(VIDEO_PART_BYTES).fill(7) }],
    },
    artifacts,
    // The screenshot artifact references this path, so the two must ship
    // together or the reader resolves a dangling entry.
    extraEntries: sample.screenshots
      ? [{ name: "screenshots/shot-1.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]
      : [],
    password: options.password,
    modifiedAt: FIXTURE_MODIFIED_AT,
    randomBytes: fixtureSalt,
  });

  return concatChunks(built.chunks);
}
