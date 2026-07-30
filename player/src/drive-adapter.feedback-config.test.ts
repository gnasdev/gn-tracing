/**
 * Guards the hosted-player config merge: Drive adapter setup must not drop
 * feedbackProxyUrl that main.ts baked from VITE_FEEDBACK_PROXY_URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("setupDriveAdapter config merge", () => {
  beforeEach(() => {
    vi.resetModules();
    // Minimal window shape for the adapter module.
    (globalThis as { window?: unknown }).window = globalThis;
    window.GN_TRACING_CONFIG = {
      mode: "standalone",
      driveApiKey: undefined,
      feedbackProxyUrl: "https://example-worker.test/feedback",
    };
    delete window.GN_DRIVE_ADAPTER;
  });

  afterEach(() => {
    delete window.GN_DRIVE_ADAPTER;
    delete (globalThis as { window?: unknown }).window;
  });

  it("preserves feedbackProxyUrl when installing the Drive adapter", async () => {
    const { setupDriveAdapter } = await import("./drive-adapter");
    setupDriveAdapter();

    expect(window.GN_DRIVE_ADAPTER).toBeDefined();
    expect(window.GN_TRACING_CONFIG.mode).toBe("standalone");
    expect(window.GN_TRACING_CONFIG.feedbackProxyUrl).toBe("https://example-worker.test/feedback");
  });
});
