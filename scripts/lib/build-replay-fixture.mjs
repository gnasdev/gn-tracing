/**
 * Builds an in-memory "recording.zip" package for the player-replay store
 * screenshot, through the same production writer every real producer
 * (extension/SDK) ships — so the player reads it exactly as it would read a
 * real upload, with no player.js changes needed.
 *
 * The video part is a real, decodable WebM: Playwright itself records a short
 * clip of a static "checkout" mockup page. No system ffmpeg dependency, no
 * checked-in binary fixture — everything is produced fresh at capture time.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import * as esbuild from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * `packages/replay-core` uses extensionless internal imports (bundler-only),
 * so this script bundles the writer with esbuild — the same technique
 * `scripts/build-player-core-vendor.mjs` uses for the player — instead of
 * importing the raw `.ts` files directly.
 */
async function loadPackageWriter() {
  const result = await esbuild.build({
    entryPoints: [path.join(scriptDir, "replay-package-writer.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const bundlePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "gn-tracing-fixture-writer-")),
    "replay-package-writer.bundle.mjs",
  );
  await fs.writeFile(bundlePath, result.outputFiles[0].text, "utf8");
  try {
    return await import(bundlePath);
  } finally {
    await fs.rm(path.dirname(bundlePath), { recursive: true, force: true });
  }
}

const VIDEO_SIZE = { width: 960, height: 600 };
// The player reveals console/network entries progressively up to the current
// playback position, and clamps reachable position to the real video's
// length regardless of the claimed session `duration` — so every seeded
// event timestamp below must land inside this window.
const VIDEO_RECORD_MS = 9_000;

const CHECKOUT_MOCKUP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .stage { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
  .card { width:74%; height:62%; border-radius:14px; background:linear-gradient(#eef3fb,#f8fafc);
    box-shadow:inset 0 0 0 1px #d9e3f2; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; }
  .title { width:52%; height:34px; border-radius:10px; background:#dfe7f3; }
  .line { width:68%; height:14px; border-radius:8px; background:#c5d0df; transition:opacity 1.2s ease; }
  .btn { width:46%; height:46px; border-radius:10px; background:#4361ee; color:#fff;
    display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; }
  .pulse { animation:pulse 1.3s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.55; } }
</style></head>
<body>
  <div class="stage">
    <div class="card">
      <div class="title"></div>
      <div class="line pulse"></div>
      <div class="btn">Checkout</div>
    </div>
  </div>
</body></html>`;

/** Records a short, real, decodable WebM clip via Playwright's own video recorder. */
async function recordMockupVideo() {
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), "gn-tracing-fixture-video-"));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIDEO_SIZE,
      recordVideo: { dir: videoDir, size: VIDEO_SIZE },
    });
    const page = await context.newPage();
    await page.setContent(CHECKOUT_MOCKUP_HTML);
    await page.waitForTimeout(VIDEO_RECORD_MS);
    const video = page.video();
    await context.close();
    const videoPath = await video?.path();
    if (!videoPath) {
      throw new Error("Playwright did not produce a video file for the fixture clip.");
    }
    return await fs.readFile(videoPath);
  } finally {
    await browser.close();
    await fs.rm(videoDir, { recursive: true, force: true });
  }
}

/**
 * Builds the full recording.zip bytes for the "Checkout bug replay" fixture
 * session shown in the player-replay-inspector store screenshot.
 */
export async function buildReplayFixturePackage() {
  const startTime = new Date("2026-05-12T10:18:00Z").getTime();
  const durationMs = VIDEO_RECORD_MS;
  const pageUrl = "https://shop.example.com/checkout";

  const metadataStub = {
    timestamp: new Date(startTime).toISOString(),
    duration: durationMs,
    url: pageUrl,
    startTime,
  };

  const consoleLogs = [
    {
      source: "console-api",
      level: "log",
      timestamp: startTime + 900,
      message: "cart loaded in 321ms",
    },
    {
      source: "console-api",
      level: "warning",
      timestamp: startTime + 2_400,
      message: "retrying /api/tax after timeout",
    },
    {
      source: "exception",
      level: "error",
      timestamp: startTime + 5_800,
      message: "payment validation failed: missing billing country",
      stackTrace: [
        {
          functionName: "validateBillingAddress",
          url: "https://shop.example.com/assets/checkout.min.js",
          lineNumber: 12,
          columnNumber: 44,
          originalSource: "src/checkout.ts",
          originalLine: 141,
          originalColumn: 9,
        },
      ],
    },
    {
      source: "console-api",
      level: "log",
      timestamp: startTime + 7_200,
      message: "checkout state synchronized",
    },
  ];

  const network = {
    schemaVersion: 2,
    entries: [
      {
        requestId: "req-1",
        url: "https://shop.example.com/assets/app.js",
        method: "GET",
        requestHeaders: { accept: "*/*" },
        timestamp: (startTime + 2_000) / 1000,
        wallTime: (startTime + 2_000) / 1000,
        resourceType: "script",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/javascript" },
        mimeType: "application/javascript",
        timing: { receiveHeadersEnd: 42 },
        encodedDataLength: 43_008,
        error: null,
      },
      {
        requestId: "req-2",
        url: "https://shop.example.com/api/checkout",
        method: "POST",
        requestHeaders: { "content-type": "application/json" },
        postData: '{"coupon":"SUMMER"}',
        timestamp: (startTime + 5_600) / 1000,
        wallTime: (startTime + 5_600) / 1000,
        resourceType: "fetch",
        status: 422,
        statusText: "Unprocessable Entity",
        responseHeaders: { "content-type": "application/json" },
        mimeType: "application/json",
        timing: { receiveHeadersEnd: 2_800 },
        encodedDataLength: 2_867,
        error: null,
        responseBody: { body: '{"error":"missing billing country"}', base64Encoded: false },
      },
      {
        requestId: "req-3",
        url: "https://shop.example.com/api/products",
        method: "GET",
        requestHeaders: { accept: "application/json" },
        timestamp: (startTime + 4_000) / 1000,
        wallTime: (startTime + 4_000) / 1000,
        resourceType: "fetch",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        mimeType: "application/json",
        timing: { receiveHeadersEnd: 88 },
        encodedDataLength: 18_432,
        error: null,
      },
      {
        requestId: "req-4",
        url: "https://shop.example.com/styles/main.css",
        method: "GET",
        requestHeaders: { accept: "text/css" },
        timestamp: (startTime + 1_000) / 1000,
        wallTime: (startTime + 1_000) / 1000,
        resourceType: "stylesheet",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "text/css" },
        mimeType: "text/css",
        timing: { receiveHeadersEnd: 21 },
        encodedDataLength: 9_216,
        error: null,
      },
    ],
  };

  const websocket = [
    {
      requestId: "ws-1",
      url: "wss://shop.example.com/events",
      closed: false,
      frames: [
        { direction: "sent", timestamp: 12_000, opcode: 1, payloadData: "subscribe:cart" },
        { direction: "received", timestamp: 12_100, opcode: 1, payloadData: "ack" },
      ],
    },
  ];

  const events = {
    schemaVersion: 1,
    events: [
      { type: "navigation", timestamp: startTime, url: pageUrl },
      {
        type: "click",
        timestamp: startTime + 5_500,
        selector: "button#apply",
        text: "Apply coupon",
      },
    ],
  };

  const report = {
    schemaVersion: 1,
    title: "Checkout bug replay",
    source: "extension",
    createdAt: new Date(startTime).toISOString(),
    page: { url: pageUrl, title: "Checkout" },
    environment: {
      extensionVersion: "1.7.15",
      userAgent: "Mozilla/5.0",
      language: "en-US",
      timezone: "UTC",
      browserName: "Chrome",
      browserVersion: "141",
      viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
    },
  };

  const [
    videoBytes,
    { buildRecordingPackage, encodeJsonArtifact, concatChunks, EXTENSION_CAPABILITIES },
  ] = await Promise.all([recordMockupVideo(), loadPackageWriter()]);

  const artifacts = {
    report: encodeJsonArtifact(report),
    events: encodeJsonArtifact(events),
    console: encodeJsonArtifact(consoleLogs),
    network: encodeJsonArtifact(network),
    websocket: encodeJsonArtifact(websocket),
  };

  const built = await buildRecordingPackage({
    producer: "extension",
    capabilities: EXTENSION_CAPABILITIES,
    packagedAt: metadataStub.timestamp,
    zipFilename: "checkout-bug-replay.zip",
    version: "1.7.15",
    duration: metadataStub.duration,
    url: metadataStub.url,
    startTime: metadataStub.startTime,
    storage: { provider: "google-drive", folderId: "store-assets-fixture" },
    video: {
      mimeType: "video/webm",
      totalBytes: videoBytes.byteLength,
      parts: [{ bytes: videoBytes }],
    },
    artifacts,
  });

  return Buffer.from(concatChunks(built.chunks));
}
