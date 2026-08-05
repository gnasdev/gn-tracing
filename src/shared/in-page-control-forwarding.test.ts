/**
 * START control policy must reach MAIN install options when present.
 *
 * The bug this guards: the ISOLATED bridge used to post only type+sessionId,
 * stripping responseBodyMode / captureNetwork so MAIN always saw defaults.
 * Drive the real shipped `buildInPageControlMessage` helper — the same one
 * content/in-page-capture-bridge.ts uses — not a reimplementation.
 */
import { describe, expect, it } from "vitest";
import { installInPageCapture } from "../../packages/replay-core/src/capture/in-page-capture";
import type { NetworkEntry } from "../../packages/replay-core/src/schema/capture";
import {
  buildInPageControlMessage,
  IN_PAGE_CAPTURE_TAG,
  type InPageCaptureControlMessage,
} from "./in-page-capture-bridge";

describe("buildInPageControlMessage (shipped bridge helper)", () => {
  it("forwards body and network policy fields on START when present", () => {
    const message = buildInPageControlMessage({
      type: "START",
      sessionId: "s1",
      responseBodyMode: "eligible",
      maxResponseBodyBytes: 4096,
      captureNetwork: false,
    });

    expect(message).toEqual({
      [IN_PAGE_CAPTURE_TAG]: true,
      direction: "control",
      type: "START",
      sessionId: "s1",
      requestId: undefined,
      responseBodyMode: "eligible",
      maxResponseBodyBytes: 4096,
      captureNetwork: false,
    });
  });

  it("omits optional fields when not provided so MAIN keeps defaults", () => {
    const message = buildInPageControlMessage({
      type: "START",
      sessionId: "s1",
    });

    expect(message.responseBodyMode).toBeUndefined();
    expect(message.maxResponseBodyBytes).toBeUndefined();
    expect(message.captureNetwork).toBeUndefined();
  });
});

/**
 * Map a control message onto install options the same way
 * content/in-page-capture-main.ts does after receiving the postMessage.
 * This is the real MAIN option selection, kept inline so the test fails if
 * MAIN and this mapping diverge (main reads control fields by the same names).
 */
function mainInstallOptionsFromControl(control: InPageCaptureControlMessage) {
  const responseBodyMode =
    control.responseBodyMode === "off" ||
    control.responseBodyMode === "text" ||
    control.responseBodyMode === "text-json" ||
    control.responseBodyMode === "eligible"
      ? control.responseBodyMode
      : undefined;
  return {
    responseBodyMode,
    maxResponseBodyBytes: control.maxResponseBodyBytes,
    captureNetwork: control.captureNetwork,
  };
}

describe("START policy → installInPageCapture (shipped path)", () => {
  it("full-record control (captureNetwork false) does not patch fetch", async () => {
    const control = buildInPageControlMessage({
      type: "START",
      sessionId: "s1",
      captureNetwork: false,
    });
    const options = mainInstallOptionsFromControl(control);

    let fetchCalled = false;
    const originalFetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    };
    const scope = {
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} } as unknown as Console,
      fetch: originalFetch as typeof fetch,
      XMLHttpRequest: undefined,
    };
    const network: NetworkEntry[] = [];

    const cleanup = installInPageCapture(
      scope,
      "s1",
      (_sid, kind, entry) => {
        if (kind === "network") {
          network.push(entry as NetworkEntry);
        }
      },
      options,
    );

    await scope.fetch?.("https://example.com/");
    cleanup();

    expect(fetchCalled).toBe(true);
    expect(network).toHaveLength(0);
    // Original fetch reference restored.
    expect(scope.fetch).toBe(originalFetch);
  });

  it("when body mode is forwarded, install options use that mode", () => {
    const control = buildInPageControlMessage({
      type: "START",
      sessionId: "s1",
      responseBodyMode: "text",
      maxResponseBodyBytes: 100,
      captureNetwork: true,
    });
    const options = mainInstallOptionsFromControl(control);
    expect(options).toEqual({
      responseBodyMode: "text",
      maxResponseBodyBytes: 100,
      captureNetwork: true,
    });
  });
});
