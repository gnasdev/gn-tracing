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
import type {
  AttachableArtifactId,
  EvidenceCoverage,
  RecordingCapability,
} from "../schema/package";
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
  /**
   * Replace the default two-frame connection with `count` epoch-stamped frames
   * of `payloadChars` each, for paging and payload-ceiling tests.
   */
  websocketFrames?: { count: number; payloadChars?: number };
  agentSummary?: unknown;
  password?: string;
  /** Attach an annotated screenshot set (with a matching image entry). */
  withScreenshots?: boolean;
  /** Attach a `storage.json` snapshot pair (secret-shaped values on purpose). */
  withStorage?: boolean;
  /** Attach a `dom.json` snapshot pair. */
  withDom?: boolean;
  /** Attach a `diagnostics.json` source-map attempt log. */
  withDiagnostics?: boolean;
  /** Fill the reporter's own bug statement on `report.json`. */
  withReporterFields?: boolean;
  /** Attach captured artifacts whose payload lists are present but empty. */
  withEmptyArtifacts?: boolean;
  /** Attach a small pre-bug instant-replay buffer. */
  withInstantReplay?: boolean;
  /** Declared producer capabilities. Defaults to `EXTENSION_CAPABILITIES`. */
  capabilities?: RecordingCapability[];
  /** Per-session surface coverage recorded by the producer. */
  evidenceCoverage?: EvidenceCoverage;
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

  /**
   * The default frames carry CDP monotonic seconds, as a legacy package does —
   * that is what makes them the fixture for "a frame with no wall-clock
   * anchor". `websocketFrames` swaps in epoch-stamped frames instead.
   */
  const websocket = [
    {
      requestId: "ws-1",
      url: "wss://api.example.com/live",
      closed: true,
      frames: options.websocketFrames
        ? Array.from({ length: options.websocketFrames.count }, (_, index) => ({
            direction: index % 2 === 0 ? "sent" : "received",
            timestamp: startTime + index * 100,
            opcode: 1,
            payloadData: "x".repeat(options.websocketFrames?.payloadChars ?? 4),
          }))
        : [
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

  /**
   * Values are shaped like the secrets they would be in production: the
   * redaction tests assert none of these strings reaches a reader.
   */
  const storage = {
    schemaVersion: 1,
    snapshots: [
      {
        phase: "start",
        capturedAt: startTime,
        localStorage: [{ key: "cart-id", value: "c-1" }],
        sessionStorage: [],
        cookies: [],
      },
      {
        phase: "stop",
        capturedAt: startTime + 120_000,
        localStorage: [
          { key: "cart-id", value: "c-1" },
          { key: "auth_token", value: "eyJhbGciOiJIUzI1NiJ9.SUPERSECRET", redacted: true },
        ],
        sessionStorage: [{ key: "coupon-draft", value: "SUMMER" }],
        cookies: [
          {
            name: "session",
            value: "sid-TOPSECRET",
            domain: ".shop.example.com",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            expires: 1_800_000_000,
            redacted: true,
          },
        ],
      },
    ],
  };

  /**
   * `masked` marks a node the privacy policy blanked; the reader reports the
   * count so a caller can tell a redacted snapshot from a sparse one.
   */
  const dom = {
    schemaVersion: 1,
    snapshots: [
      {
        label: "start",
        capturedAt: startTime,
        documentUrl: "https://shop.example.com/checkout",
        root: {
          nodeType: 1,
          nodeName: "BODY",
          children: [{ nodeType: 3, nodeName: "#text", nodeValue: "Checkout" }],
        },
      },
      {
        label: "stop",
        capturedAt: startTime + 120_000,
        documentUrl: "https://shop.example.com/checkout",
        root: {
          nodeType: 1,
          nodeName: "BODY",
          children: [
            {
              nodeType: 1,
              nodeName: "DIV",
              attributes: { id: "total" },
              children: [
                { nodeType: 3, nodeName: "#text", nodeValue: "$0.00" },
                { nodeType: 1, nodeName: "SPAN", masked: true },
              ],
            },
          ],
        },
      },
    ],
  };

  const diagnostics = {
    schemaVersion: 1,
    generatedAt: new Date(startTime).toISOString(),
    sourceMaps: [
      {
        generatedUrl: "https://shop.example.com/assets/app.min.js",
        sourceMapUrl: "https://shop.example.com/assets/app.min.js.map",
        sourceType: "external",
        targetType: "page",
        status: "success",
        sourcesCount: 42,
        hasSourcesContent: true,
      },
      {
        generatedUrl: "https://shop.example.com/assets/vendor.min.js",
        sourceMapUrl: "https://shop.example.com/assets/vendor.min.js.map",
        sourceType: "external",
        targetType: "page",
        status: "failed",
        reason: "fetch-failed",
        httpStatusCode: 404,
      },
      {
        generatedUrl: "https://cdn.example.com/widget.js",
        sourceMapUrl: "https://cdn.example.com/widget.js.map",
        sourceType: "external",
        targetType: "page",
        status: "failed",
        reason: "fetch-failed",
        httpStatusCode: 404,
      },
      {
        generatedUrl: "https://shop.example.com/assets/inline.js",
        sourceMapUrl: "data:application/json;base64,e30=",
        sourceType: "inline",
        targetType: "page",
        status: "skipped",
        reason: "unsupported-target",
      },
    ],
  };

  const report = {
    schemaVersion: 1,
    title: "Coupon apply fails",
    source: "extension",
    createdAt: new Date(startTime).toISOString(),
    page: { url: "https://shop.example.com/checkout", title: "Checkout" },
    ...(options.withReporterFields
      ? {
          description: "Applying SUMMER zeroes the order total.",
          expected: "Total stays $42.00 with a $5 discount.",
          actual: "Total drops to $0.00 and checkout is blocked.",
          severity: "high",
          reference: "SHOP-4821",
        }
      : {}),
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

  /**
   * `withEmptyArtifacts` overrides the per-artifact flags on purpose: it
   * attaches all three optional artifacts with empty payload lists, which is
   * the only way a test can prove "captured but empty" reads differently from
   * "absent".
   */
  const optional = options.withEmptyArtifacts
    ? {
        storage: { schemaVersion: 1, snapshots: [] },
        dom: { schemaVersion: 1, snapshots: [] },
        diagnostics: {
          schemaVersion: 1,
          generatedAt: new Date(startTime).toISOString(),
          sourceMaps: [],
        },
      }
    : {
        storage: options.withStorage ? storage : undefined,
        dom: options.withDom ? dom : undefined,
        diagnostics: options.withDiagnostics ? diagnostics : undefined,
      };

  return {
    metadata,
    console: options.withConsole === false ? undefined : consoleLogs,
    network: options.withNetwork === false ? undefined : network,
    websocket: options.withWebsocket === false ? undefined : websocket,
    events: options.withEvents === false ? undefined : events,
    privacy: options.withPrivacy === false ? undefined : privacy,
    report,
    ...optional,
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
  attach("storage", sample.storage);
  attach("dom", sample.dom);
  attach("diagnostics", sample.diagnostics);
  attach("agentSummary", options.agentSummary);
  attach("screenshots", sample.screenshots);
  attach("instantReplay", sample.instantReplay);

  const built = await buildRecordingPackage({
    producer: "extension",
    capabilities: options.capabilities ?? EXTENSION_CAPABILITIES,
    evidenceCoverage: options.evidenceCoverage,
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
