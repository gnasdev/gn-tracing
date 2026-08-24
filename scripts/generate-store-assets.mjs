import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { buildReplayFixturePackage } from "./lib/build-replay-fixture.mjs";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const outDir = path.join(rootDir, "store-assets");
const capturesDir = path.join(outDir, "captures");
const screenshotsDir = path.join(outDir, "screenshots");
const extensionDir = path.join(rootDir, "dist", "chrome");
const playerPublicDir = path.join(rootDir, "player", "public");

const FIXTURE_REPLAY_ID = "gn-tracing-store-assets-fixture";

const colors = {
  bg0: "#07111f",
  bg1: "#11203a",
  bg2: "#102f34",
  panel: "#0e1a2d",
  line: "#2c4167",
  white: "#f8fbff",
  muted: "#c7d2e8",
  dim: "#95a8c5",
  blue: "#4361ee",
  teal: "#2ec4b6",
  green: "#36d399",
  amber: "#f6c453",
};

const storeShots = [
  {
    file: "01-popup-recording-controls.png",
    capture: "popup-recording.png",
    title: ["Record tab", "with context"],
    copy: ["Actual popup recording state:", "live timer, audio, and stats."],
    badge: "Extension popup",
    screenshot: { x: 560, y: 72, w: 374, h: 650 },
  },
  {
    file: "02-popup-privacy-and-drive-settings.png",
    capture: "popup-privacy.png",
    title: ["Privacy controls", "before upload"],
    copy: ["Redaction is on by default —", "headers, params, and values masked."],
    badge: "Capture settings",
    screenshot: { x: 560, y: 72, w: 374, h: 650 },
  },
  {
    file: "03-player-introduction-page.png",
    capture: "player-intro.png",
    title: ["Player", "intro page"],
    copy: ["Actual hosted player root page.", "Shown before a replay link opens."],
    badge: "Player landing",
    screenshot: { x: 72, y: 280, w: 1136, h: 420 },
  },
  {
    file: "04-player-replay-inspector.png",
    capture: "player-replay.png",
    title: ["Replay", "inspector"],
    copy: ["Actual player UI with video,", "console, network, and filters."],
    badge: "Replay player",
    screenshot: { x: 72, y: 280, w: 1136, h: 420 },
  },
  {
    file: "05-upload-history-page.png",
    capture: "history-page.png",
    title: ["Upload", "history"],
    copy: ["Popup history dialog for replay", "links and previous uploads."],
    badge: "Upload history",
    screenshot: { x: 560, y: 72, w: 374, h: 650 },
  },
];

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(x, y, value, size, fill = colors.white, weight = 700, extra = "") {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${esc(value)}</text>`;
}

function lines(
  x,
  y,
  values,
  size,
  fill = colors.white,
  gap = Math.round(size * 1.25),
  weight = 750,
) {
  return values.map((line, index) => text(x, y + index * gap, line, size, fill, weight)).join("");
}

function rect(x, y, w, h, fill, radius = 12, stroke = "none", sw = 1, extra = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
}

function svgRoot(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.bg0}"/>
        <stop offset="50%" stop-color="${colors.bg1}"/>
        <stop offset="100%" stop-color="${colors.bg2}"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.blue}"/>
        <stop offset="100%" stop-color="${colors.teal}"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000814" flood-opacity="0.34"/>
      </filter>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${body}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Capture stage: drives the real built extension (dist/chrome) in Playwright
// Chromium, the same technique e2e/record-evidence.spec.ts uses. Screenshots
// come from the real popup/player DOM and real (seeded) app state — never
// from hand-authored HTML fixtures — so they cannot drift from the real UI
// the way a hardcoded fixture script can.
// ---------------------------------------------------------------------------

async function assertExtensionBuilt() {
  try {
    await fs.access(path.join(extensionDir, "manifest.json"));
  } catch {
    throw new Error(
      `Built extension not found at ${path.relative(rootDir, extensionDir)}. Run: npm run build`,
    );
  }
}

async function launchExtensionContext(profileDir) {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
}

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) {
    return existing;
  }
  return context.waitForEvent("serviceworker", { timeout: 20_000 });
}

/** Reads the extension's real default popup state (installed fresh into a clean profile). */
async function readBaseState(serviceWorker) {
  const result = await serviceWorker.evaluate(() => chrome.storage.session.get("gn_tracing_state"));
  return result.gn_tracing_state;
}

/** Writes narrative-overridden state back to the real storage key the popup reads on load. */
async function seedState(serviceWorker, state) {
  await serviceWorker.evaluate(
    (value) => chrome.storage.session.set({ gn_tracing_state: value }),
    state,
  );
}

/**
 * Seeds real upload history into `chrome.storage.local` (the key the service
 * worker's `getUploadHistory()` actually reads). Must run before the first
 * popup opens: the popup's `GET_SETTINGS` reply carries the service worker's
 * own in-memory cache of this list, which is loaded (and then cached) on its
 * first read — seeding `chrome.storage.session` state alone is not enough,
 * since that reply overwrites the session-state paint moments after load.
 */
async function seedUploadHistory(serviceWorker, entries) {
  await serviceWorker.evaluate(
    (value) => chrome.storage.local.set({ gn_tracing_upload_history: value }),
    entries,
  );
}

/**
 * Mocks the popup's cloud-connection status check at the message boundary
 * (`STORAGE_STATUS`) so the popup renders a "connected" cloud UI without a
 * real OAuth token. Every other message passes through to the real service
 * worker untouched.
 */
async function addConnectedStorageMock(page) {
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const message = args[0];
      if (
        message &&
        (message.action === "STORAGE_STATUS" || message.action === "GOOGLE_DRIVE_STATUS")
      ) {
        const response = { ok: true, isConnected: true };
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          callback(response);
          return undefined;
        }
        return Promise.resolve(response);
      }
      return original(...args);
    };
  });
}

async function openPopup(context, extensionId, { mockConnectedStorage = false } = {}) {
  const page = await context.newPage();
  if (mockConnectedStorage) {
    await addConnectedStorageMock(page);
  }
  await page.setViewportSize({ width: 380, height: 1000 });
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#app", { state: "attached" });
  // Let initPopup() finish its async bootstrap (storage reads, GET_SETTINGS,
  // storage status refresh) before painting.
  await page.waitForTimeout(400);
  return page;
}

async function screenshotPopup(page, outPath) {
  // Not fullPage: fullPage's scroll-and-stitch can fight the popup dialogs'
  // own internal scroll position, so a plain viewport screenshot (after any
  // scrollIntoViewIfNeeded calls) is what actually matches what's on screen.
  const buffer = await page.screenshot();
  await sharp(buffer).png({ compressionLevel: 9 }).toFile(outPath);
}

async function capturePopupRecording(context, extensionId, serviceWorker, baseState) {
  const now = Date.now();
  const elapsedMs = 138_000; // 02:18
  await seedState(serviceWorker, {
    ...baseState,
    recording: {
      phase: "recording",
      sessionId: "store-assets-demo-session",
      isRecording: true,
      tabId: 1,
      startTime: now - elapsedMs,
      stopTime: null,
      tabUrl: "https://shop.example.com/checkout",
      elapsedMs,
      elapsedUpdatedAt: now,
      consoleLogCount: 18,
      networkRequestCount: 124,
    },
    sessions: [
      {
        id: "store-assets-demo-session",
        phase: "recorded",
        startTime: now - elapsedMs,
        stopTime: null,
        elapsedMs,
        tabUrl: "https://shop.example.com/checkout",
        consoleLogCount: 18,
        networkRequestCount: 124,
        hasLocalSnapshot: true,
        progress: 0,
        uploadedBytes: 0,
        totalBytes: 0,
        message: "",
        items: [],
        recordingUrl: null,
        recordingFolderId: null,
        indexFileId: null,
        error: null,
      },
    ],
    storage: { provider: "google-drive", isConnected: true },
    googleDrive: { isConnected: true },
  });

  const page = await openPopup(context, extensionId, { mockConnectedStorage: true });
  await screenshotPopup(page, path.join(capturesDir, "popup-recording.png"));
  await page.close();
}

async function capturePopupPrivacy(context, extensionId, serviceWorker, baseState) {
  await seedState(serviceWorker, {
    ...baseState,
    storage: { provider: "google-drive", isConnected: true },
    googleDrive: { isConnected: true },
  });

  const page = await openPopup(context, extensionId, { mockConnectedStorage: true });
  await page.click("#settings-page-btn");
  await page.waitForSelector("#settings-dialog:not(.hidden)");
  // Redaction is on by default (see popup/popup.html), so no interaction is
  // needed to demonstrate it — just scroll the real Privacy & Redaction
  // section into view.
  // scrollIntoViewIfNeeded only scrolls the minimum distance (the section
  // heading ends up right at the viewport edge); align it to the top instead
  // so the actual redaction toggles are comfortably in frame.
  await page
    .locator("#redact-sensitive-headers-input")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);

  await screenshotPopup(page, path.join(capturesDir, "popup-privacy.png"));
  await page.close();
}

async function capturePopupHistory(context, extensionId, serviceWorker, baseState) {
  await seedState(serviceWorker, {
    ...baseState,
    storage: { provider: "google-drive", isConnected: true },
    googleDrive: { isConnected: true },
  });

  const page = await openPopup(context, extensionId, { mockConnectedStorage: true });
  await page.click("#upload-history-page-btn");
  await page.waitForSelector("#upload-history-dialog:not(.hidden)");
  // Move off the just-clicked button so no hover/focus ring is in the shot.
  await page.mouse.move(40, 40);
  await page.waitForTimeout(200);
  await screenshotPopup(page, path.join(capturesDir, "history-page.png"));
  await page.close();
}

/** Minimal static file server for `player/public`, mirroring the e2e loopback pattern. */
function startStaticServer(rootPath) {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const relPath = url.pathname === "/" ? "/player.html" : url.pathname;
      const filePath = path.join(rootPath, decodeURIComponent(relPath));
      if (!filePath.startsWith(rootPath)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "content-type": contentTypes[ext] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function capturePlayerIntro(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const { server, url } = await startStaticServer(playerPublicDir);
  try {
    await page.goto(`${url}/player.html`, { waitUntil: "load" });
    await page.waitForSelector("#intro-state:not(.hidden)", { timeout: 10_000 });
    const buffer = await page.screenshot();
    await sharp(buffer)
      .png({ compressionLevel: 9 })
      .toFile(path.join(capturesDir, "player-intro.png"));
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function capturePlayerReplay(browser, replayZip) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const { server, url } = await startStaticServer(playerPublicDir);
  try {
    // Standalone player.html (no drive-adapter) fetches Drive downloads
    // directly rather than through a same-origin `/api/drive` proxy.
    await page.route("https://drive.usercontent.google.com/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.get("id") === FIXTURE_REPLAY_ID) {
        await route.fulfill({ status: 200, contentType: "application/zip", body: replayZip });
        return;
      }
      await route.continue();
    });

    await page.goto(`${url}/player.html?id=${FIXTURE_REPLAY_ID}`, { waitUntil: "load" });
    await page.waitForSelector("#player-state:not(.hidden)", { timeout: 20_000 });
    await page.click("#console-tab");

    // Console/network entries reveal progressively up to the current playback
    // position, so drag the real progress bar near the end (a real seek, not
    // a direct `video.currentTime` write) to reveal the seeded entries.
    const progressBox = await page.locator("#progress-wrapper").boundingBox();
    const seekX = progressBox.x + progressBox.width * 0.85;
    const seekY = progressBox.y + progressBox.height / 2;
    await page.mouse.move(progressBox.x, seekY);
    await page.mouse.down();
    await page.mouse.move(seekX, seekY, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const video = document.querySelector("#video-player");
      return Boolean(video) && !video.seeking;
    });
    await page.waitForTimeout(800);
    // Move off the progress bar so its hover tooltip isn't in the shot.
    await page.mouse.move(40, 40);

    const buffer = await page.screenshot();
    await sharp(buffer)
      .png({ compressionLevel: 9 })
      .toFile(path.join(capturesDir, "player-replay.png"));
  } finally {
    await page.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function buildCaptures() {
  await assertExtensionBuilt();

  // A real (not ephemeral) profile directory: seeding storage.local requires
  // restarting the extension so its service worker re-reads it fresh (see
  // seedUploadHistory's doc comment), which means closing and reopening the
  // browser against the same on-disk profile — same as a real restart.
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "gn-tracing-store-assets-"));

  const seedContext = await launchExtensionContext(profileDir);
  const seedServiceWorker = await waitForServiceWorker(seedContext);

  const now = Date.now();
  await seedUploadHistory(seedServiceWorker, [
    {
      id: "hist-1",
      uploadedAt: now - 2 * 60 * 60 * 1000,
      pageUrl: "https://shop.example.com/checkout",
      recordingUrl: "https://tracing.gnas.dev/gdrive/demo-checkout-bug",
      recordingFolderId: "demo-folder-1",
      targetFolderId: "demo-folder-1",
      durationMs: 161_000,
      provider: "google-drive",
    },
    {
      id: "hist-2",
      uploadedAt: now - 26 * 60 * 60 * 1000,
      pageUrl: "https://app.example.com/settings/websockets",
      recordingUrl: "https://tracing.gnas.dev/gdrive/demo-ws-reconnect",
      recordingFolderId: "demo-folder-1",
      targetFolderId: "demo-folder-1",
      durationMs: 98_000,
      provider: "google-drive",
    },
    {
      id: "hist-3",
      uploadedAt: now - 9 * 24 * 60 * 60 * 1000,
      pageUrl: "https://shop.example.com/pricing",
      recordingUrl: "https://tracing.gnas.dev/gdrive/demo-pricing-slow-api",
      recordingFolderId: "demo-folder-1",
      targetFolderId: "demo-folder-1",
      durationMs: 192_000,
      provider: "google-drive",
    },
  ]);

  // Close and reopen against the same on-disk profile so the extension's
  // next service worker starts fresh and reads the seeded history from
  // scratch, instead of the first worker's already-cached (empty) read.
  await seedContext.close();

  const extensionContext = await launchExtensionContext(profileDir);
  try {
    const serviceWorker = await waitForServiceWorker(extensionContext);
    const extensionId = new URL(serviceWorker.url()).host;
    const baseState = await readBaseState(serviceWorker);

    await capturePopupRecording(extensionContext, extensionId, serviceWorker, baseState);
    await capturePopupPrivacy(extensionContext, extensionId, serviceWorker, baseState);
    await capturePopupHistory(extensionContext, extensionId, serviceWorker, baseState);
  } finally {
    await extensionContext.close();
    await fs.rm(profileDir, { recursive: true, force: true });
  }

  const browser = await chromium.launch();
  try {
    const replayZip = await buildReplayFixturePackage();
    await capturePlayerIntro(browser);
    await capturePlayerReplay(browser, replayZip);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Compose stage: unchanged from the previous pipeline. Frames each real
// capture with the marketing background, badge, title, and copy.
// ---------------------------------------------------------------------------

async function renderStoreScreenshot(config) {
  const width = 1280;
  const height = 800;
  const capPath = path.join(capturesDir, config.capture);
  const shot = config.screenshot;
  const captureBuffer = await sharp(capPath)
    .resize({ width: shot.w, height: shot.h, fit: "cover", position: "top" })
    .png()
    .toBuffer();

  const isTallCapture = shot.h > 560;
  const bg = svgRoot(
    width,
    height,
    `
    ${rect(70, 72, Math.min(320, config.badge.length * 10 + 46), 34, "rgba(46,196,182,0.18)", 17)}
    ${text(92, 94, config.badge, 15, "#9ff5ec", 800)}
    ${
      isTallCapture
        ? `${lines(70, 160, config.title, 52, colors.white, 62, 850)}
         ${lines(72, 318, config.copy, 23, colors.muted, 33, 650)}`
        : `${text(70, 172, config.title.join(" "), 56, colors.white, 850)}
         ${lines(72, 218, config.copy, 22, colors.muted, 31, 650)}`
    }
    ${rect(shot.x - 18, shot.y - 18, shot.w + 36, shot.h + 36, colors.panel, 24, colors.line, 1, 'filter="url(#shadow)"')}
    ${rect(shot.x - 10, shot.y - 10, shot.w + 20, shot.h + 20, "#091427", 18, "#385176", 1)}
  `,
  );

  await sharp(Buffer.from(bg))
    .composite([{ input: captureBuffer, left: shot.x, top: shot.y }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(screenshotsDir, config.file));
}

async function renderPromoAssets() {
  const popup = await sharp(path.join(capturesDir, "popup-recording.png"))
    .resize({ width: 150 })
    .png()
    .toBuffer();
  const player = await sharp(path.join(capturesDir, "player-replay.png"))
    .resize({ width: 470, height: 294, fit: "cover", position: "top" })
    .png()
    .toBuffer();

  const small = svgRoot(
    440,
    280,
    `
    ${rect(28, 28, 384, 224, "rgba(10,20,37,0.82)", 24, colors.line, 1)}
    ${rect(52, 52, 150, 34, "url(#accent)", 17)}
    ${text(72, 74, "GN Tracing", 15, colors.bg0, 850)}
    ${lines(52, 126, ["Bug reports", "with evidence", "teams need"], 29, colors.white, 33, 850)}
    ${text(54, 232, "Video + console + network replay", 15, colors.muted, 700)}
  `,
  );
  await sharp(Buffer.from(small))
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, "small-promo-440x280.png"));

  const marquee = svgRoot(
    1400,
    560,
    `
    ${rect(74, 80, 346, 34, "rgba(46,196,182,0.18)", 17)}
    ${text(92, 102, "Chrome/Edge debugging recorder", 15, "#9ff5ec", 800)}
    ${lines(74, 166, ["Share the full bug story,", "not just the screen."], 58, colors.white, 68, 850)}
    ${lines(76, 318, ["Capture one tab with video, console logs, network traffic,", "WebSocket activity, and a Drive-backed replay link."], 24, colors.muted, 34, 650)}
    ${rect(74, 452, 286, 34, "rgba(67,97,238,0.22)", 17)}
    ${text(92, 474, "Uses real UI screenshots", 15, "#dbe4ff", 800)}
    ${rect(786, 82, 560, 386, colors.panel, 24, colors.line, 1, 'filter="url(#shadow)"')}
    ${rect(808, 104, 516, 342, "#091427", 16, "#385176", 1)}
  `,
  );
  await sharp(Buffer.from(marquee))
    .composite([
      { input: player, left: 832, top: 128 },
      { input: popup, left: 746, top: 122 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, "marquee-promo-1400x560.png"));
}

async function writeReadme() {
  const readme = `# Chrome Web Store Assets

Generated by \`npm run store:assets\`.

The screenshots in this folder are real captures of the built extension
(\`dist/chrome\`) and the hosted player, driven by Playwright Chromium — the
same technique \`e2e/record-evidence.spec.ts\` uses. Popup screenshots open the
real \`popup.html\` inside the loaded extension and seed real app state
(\`chrome.storage.session\`) on top of the extension's own real defaults; the
player-replay screenshot loads a real recording package built through the
production package writer (\`packages/replay-core/src/write\`), served by
mocking only the \`/api/drive\` download endpoint. No hand-authored HTML
fixtures or DOM state scripts are involved, so these screenshots cannot drift
from the real UI silently.

Requires \`npm run build\` (produces \`dist/chrome\`) and
\`npx playwright install chromium\` before running \`npm run store:assets\`.

## Upload Files

- \`icon-128.png\` - Store icon.
- \`small-promo-440x280.png\` - Small promo tile.
- \`marquee-promo-1400x560.png\` - Optional marquee promo tile.
- \`screenshots/01-popup-recording-controls.png\`
- \`screenshots/02-popup-privacy-and-drive-settings.png\` (filename historical; content is privacy + cloud storage settings)
- \`screenshots/03-player-introduction-page.png\`
- \`screenshots/04-player-replay-inspector.png\`
- \`screenshots/05-upload-history-page.png\`

Raw page captures are kept in \`captures/\` for review.
`;
  await fs.writeFile(path.join(outDir, "README.md"), readme, "utf8");
}

async function verifyImage(file, width, height) {
  const meta = await sharp(file).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(
      `${path.relative(rootDir, file)} rendered as ${meta.width}x${meta.height}, expected ${width}x${height}`,
    );
  }
  return { file: path.relative(outDir, file), width: meta.width, height: meta.height };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(path.join(outDir, "sources"), { recursive: true, force: true });
  await fs.rm(capturesDir, { recursive: true, force: true });
  await fs.rm(screenshotsDir, { recursive: true, force: true });
  await fs.mkdir(capturesDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });

  await fs.copyFile(path.join(rootDir, "icons", "icon128.png"), path.join(outDir, "icon-128.png"));
  await buildCaptures();

  for (const shot of storeShots) {
    await renderStoreScreenshot(shot);
  }
  await renderPromoAssets();
  await writeReadme();

  const rendered = [
    await verifyImage(path.join(outDir, "icon-128.png"), 128, 128),
    await verifyImage(path.join(outDir, "small-promo-440x280.png"), 440, 280),
    await verifyImage(path.join(outDir, "marquee-promo-1400x560.png"), 1400, 560),
  ];
  for (const shot of storeShots) {
    rendered.push(await verifyImage(path.join(screenshotsDir, shot.file), 1280, 800));
  }
  console.table(rendered);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
