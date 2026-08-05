/**
 * Real end-to-end proof that the GN Tracing extension captures console and
 * network evidence in an actual browser.
 *
 * What this exercises (and what it does not):
 *
 * - The built `dist/chrome` extension is loaded unpacked into a Playwright
 *   Chromium (Chrome for Testing) persistent context. Its MV3 service worker is
 *   the real background bundle, driven through `context.serviceWorkers()`.
 *
 * - `capture-evidence-pipeline` proves the extension's evidence mechanism works
 *   in-browser: from the extension's own service worker it attaches
 *   `chrome.debugger` and enables the same CDP domains `CdpManager` enables
 *   (`Network`, `Runtime`, `Log`), then a real user gesture on a loopback page
 *   emits a known `console.error` and a known `fetch`. The test asserts the
 *   debugger delivered both. This is the exact capability (debugger permission +
 *   CDP `Network.requestWillBeSent` / `Runtime.consoleAPICalled`) the recorder
 *   relies on, and it confirms there is no CDP-client conflict with Playwright.
 *
 * - `full-record-session` drives the extension's own `START_RECORDING` /
 *   `STOP_RECORDING` message flow (what the popup sends) and asserts the
 *   produced session summary counts console + network evidence. On Chromium the
 *   recorder additionally needs `chrome.tabCapture.getMediaStreamId`, which
 *   requires an `activeTab` invocation gesture that headless automation cannot
 *   synthesize; when that gate is closed the test skips itself with the measured
 *   reason rather than failing. It runs fully wherever the gesture is available
 *   (e.g. a headed session where the extension action has been invoked).
 *
 * This Chromium suite does NOT cover the Firefox-specific in-page capture path:
 * Firefox uses MAIN-world content-script bridges (not CDP), Playwright does not
 * support Firefox extension e2e, and `web-ext` would be a separate tool. Treat
 * this as complementary coverage, not a substitute for Firefox verification.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { type BrowserContext, chromium, expect, test, type Worker } from "@playwright/test";

const e2eDir = __dirname;
const extensionPath = path.resolve(e2eDir, "..", "dist", "chrome");

const CONSOLE_MARKER = "GN_TRACING_E2E_CONSOLE_MARKER";
const FETCH_MARKER = "gn-tracing-e2e-endpoint";

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>gn-tracing e2e target</title></head>
  <body>
    <h1>gn-tracing e2e target</h1>
    <button id="emit">emit evidence</button>
    <script>
      document.getElementById("emit").addEventListener("click", () => {
        console.error(${JSON.stringify(CONSOLE_MARKER)});
        fetch("/${FETCH_MARKER}?ts=" + Date.now()).catch(() => {});
      });
    </script>
  </body>
</html>`;

/** Loopback-only test page server (bound to 127.0.0.1, never 0.0.0.0). */
function startLoopbackServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url?.includes(FETCH_MARKER)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ server, url: `http://127.0.0.1:${address.port}/` });
      } else {
        reject(new Error("Failed to bind loopback server."));
      }
    });
  });
}

/**
 * Launch a persistent context with the built extension loaded.
 *
 * `--headless=new` is passed explicitly: Playwright's plain `headless: true`
 * uses the old headless mode, in which the MV3 service worker never registers
 * (measured). Set `HEADED=1` to watch the run in a real window.
 */
async function launchExtensionContext(): Promise<BrowserContext> {
  const headed = process.env.HEADED === "1";
  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];
  if (!headed) {
    args.unshift("--headless=new");
  }
  return chromium.launchPersistentContext("", { headless: false, args });
}

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  if (existing) {
    return existing;
  }
  return context.waitForEvent("serviceworker", { timeout: 20_000 });
}

/** The active tab's id, read from the extension service worker. */
function getActiveTabId(serviceWorker: Worker): Promise<number | null> {
  return serviceWorker.evaluate(async () => {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return active && typeof active.id === "number" ? active.id : null;
  });
}

const browsersInstalled = fs.existsSync(chromium.executablePath());
const extensionBuilt = fs.existsSync(path.join(extensionPath, "manifest.json"));

test.describe.configure({ mode: "serial" });

test.describe("record evidence (chromium extension)", () => {
  test.skip(
    !browsersInstalled,
    "Playwright's Chromium is not installed. Run: npx playwright install chromium",
  );
  test.skip(!extensionBuilt, `Built extension not found at ${extensionPath}. Run: npm run build`);

  let context: BrowserContext;
  let serviceWorker: Worker;
  let server: Server;
  let pageUrl: string;

  test.beforeAll(async () => {
    const loopback = await startLoopbackServer();
    server = loopback.server;
    pageUrl = loopback.url;
    context = await launchExtensionContext();
    serviceWorker = await waitForServiceWorker(context);
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  });

  test("capture-evidence-pipeline: extension debugger captures known console + network entries", async () => {
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "load" });
    const tabId = await getActiveTabId(serviceWorker);
    expect(tabId, "active tab id should resolve").not.toBeNull();

    // Attach + enable the same CDP domains CdpManager uses, inside the
    // extension's own service worker (its real `debugger` permission).
    const attachError = await serviceWorker.evaluate(async (id) => {
      const send = (method: string, params: object = {}) =>
        new Promise<void>((resolve, reject) =>
          chrome.debugger.sendCommand({ tabId: id }, method, params, () =>
            chrome.runtime.lastError
              ? reject(new Error(chrome.runtime.lastError.message))
              : resolve(),
          ),
        );
      try {
        await new Promise<void>((resolve, reject) =>
          chrome.debugger.attach({ tabId: id }, "1.3", () =>
            chrome.runtime.lastError
              ? reject(new Error(chrome.runtime.lastError.message))
              : resolve(),
          ),
        );
        const captured = { console: [] as string[], network: [] as string[] };
        (globalThis as Record<string, unknown>).__gnE2eCaptured = captured;
        chrome.debugger.onEvent.addListener((source, method, params) => {
          if (source.tabId !== id) {
            return;
          }
          const payload = params as Record<string, unknown>;
          if (method === "Runtime.consoleAPICalled") {
            captured.console.push(JSON.stringify(payload.args ?? payload));
          } else if (method === "Log.entryAdded") {
            captured.console.push(JSON.stringify(payload.entry ?? payload));
          } else if (method === "Network.requestWillBeSent") {
            const request = payload.request as { url?: string } | undefined;
            if (request?.url) {
              captured.network.push(request.url);
            }
          }
        });
        await send("Runtime.enable");
        await send("Network.enable");
        await send("Log.enable");
        return null;
      } catch (error) {
        return String((error as Error).message);
      }
    }, tabId as number);

    expect(
      attachError,
      "chrome.debugger.attach + enable should succeed (no CDP conflict with Playwright)",
    ).toBeNull();

    // Real user gesture triggers the known console.error + fetch.
    await page.click("#emit");

    await expect
      .poll(
        () =>
          serviceWorker.evaluate(() => {
            const captured = (globalThis as Record<string, unknown>).__gnE2eCaptured as {
              console: string[];
              network: string[];
            };
            return {
              console: captured.console.join("\n"),
              network: captured.network.join("\n"),
            };
          }),
        { message: "extension should capture console + network evidence", timeout: 10_000 },
      )
      .toEqual(
        expect.objectContaining({
          console: expect.stringContaining(CONSOLE_MARKER),
          network: expect.stringContaining(FETCH_MARKER),
        }),
      );

    await serviceWorker.evaluate(
      (id) =>
        new Promise<void>((resolve) => chrome.debugger.detach({ tabId: id }, () => resolve())),
      tabId as number,
    );
    await page.close();
  });

  test("full-record-session: START_RECORDING → STOP_RECORDING yields evidence counts", async () => {
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "load" });
    const tabId = await getActiveTabId(serviceWorker);
    expect(tabId).not.toBeNull();

    // Gate: the Chromium recorder needs a tabCapture stream id, which requires
    // an activeTab invocation gesture. Probe it; skip with the measured reason
    // when automation cannot supply the gesture.
    const gate = await serviceWorker.evaluate(
      (id) =>
        new Promise<{ ok: boolean; reason: string }>((resolve) =>
          chrome.tabCapture.getMediaStreamId({ targetTabId: id }, (streamId) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, reason: chrome.runtime.lastError.message });
            } else {
              resolve({ ok: Boolean(streamId), reason: "" });
            }
          }),
        ),
      tabId as number,
    );

    test.skip(
      !gate.ok,
      `Recorder video path unavailable to automation: ${gate.reason} ` +
        "chrome.tabCapture.getMediaStreamId needs an activeTab invocation gesture. " +
        "The console/network pipeline itself is proven by capture-evidence-pipeline. " +
        "To run this end to end, launch headed (HEADED=1) and invoke the extension action.",
    );

    // Drive the popup's real messages from an extension page (a same-worker
    // sendMessage would not reach the SW's own onMessage listener).
    const extensionId = new URL(serviceWorker.url()).host;
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/popup/popup.html`, {
      waitUntil: "domcontentloaded",
    });

    const sendToWorker = (message: Record<string, unknown>) =>
      driver.evaluate(
        (msg) =>
          new Promise((resolve) =>
            chrome.runtime.sendMessage(msg, (response) => resolve(response)),
          ),
        message,
      );

    const startResponse = (await sendToWorker({
      action: "START_RECORDING",
      tabId,
    })) as { ok: boolean; error?: string };
    expect(startResponse.ok, startResponse.error).toBeTruthy();

    await page.bringToFront();
    await page.click("#emit");
    await page.waitForTimeout(1000);

    const stopResponse = (await sendToWorker({ action: "STOP_RECORDING" })) as {
      ok: boolean;
      error?: string;
    };
    expect(stopResponse.ok, stopResponse.error).toBeTruthy();

    const sessions = (await sendToWorker({ action: "GET_UPLOAD_STATE" })) as Array<{
      consoleLogCount: number;
      networkRequestCount: number;
    }>;
    expect(sessions.length).toBeGreaterThan(0);
    const latest = sessions[0];
    expect(latest.consoleLogCount).toBeGreaterThan(0);
    expect(latest.networkRequestCount).toBeGreaterThan(0);

    await driver.close();
    await page.close();
  });
});
