/**
 * Cross-producer conformance.
 *
 * Every producer in this repository is run through the same contract, and the
 * contract is evaluated by the shipped reader. This test lives at the repo root
 * rather than inside a package because it is the one place that may import both
 * producers: `packages/sdk` depends on `packages/replay-core`, so the core
 * cannot import the SDK back without inverting that dependency.
 *
 * Adding a producer means adding a case here. If it cannot pass, the player and
 * the MCP tools cannot read it, and shipping it would fragment the format.
 */

import { describe, expect, it } from "vitest";
import { EXTENSION_CAPABILITIES, SDK_CAPABILITIES } from "../packages/replay-core/src/schema";
import {
  type ConformanceExpectations,
  checkPackageConformance,
} from "../packages/replay-core/src/testing/conformance";
import { buildSamplePackage } from "../packages/replay-core/src/testing/fixture";
import {
  buildRecordingPackage,
  concatChunks,
  encodeJsonArtifact,
} from "../packages/replay-core/src/write";
import { RecordingSession } from "../packages/sdk/src/session";

interface ProducerCase {
  name: string;
  build: () => Promise<Uint8Array>;
  expectations: ConformanceExpectations;
}

/** Minimal window surface the SDK session instruments. */
function createFakeWindow(): Window & { console: Console } {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    console: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
    },
    fetch: async () => new Response("{}", { status: 200 }),
    performance: { now: () => 0 },
    document: { cookie: "", title: "Checkout" },
    location: { href: "https://shop.test/checkout" },
    innerWidth: 390,
    innerHeight: 844,
    scrollX: 0,
    scrollY: 0,
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as Window & { console: Console };
}

async function buildSdkPackage(password?: string): Promise<Uint8Array> {
  const win = createFakeWindow();
  const session = new RecordingSession({ window: win, password });
  session.start();
  win.console.error("checkout failed");
  await win.fetch("https://shop.test/api/coupon");
  const result = await session.stop();
  return concatChunks(result.package.chunks);
}

/** An SDK package that also carries an annotated DOM-snapshot screenshot. */
async function buildSdkScreenshotPackage(): Promise<Uint8Array> {
  const win = createFakeWindow();
  const session = new RecordingSession({ window: win });
  session.start();
  const id = session.captureScreenshot({ caption: "Total is wrong" });
  session.annotateScreenshot(id, [
    {
      id: "a1",
      createdAt: 1_700_000_000_000,
      type: "arrow",
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.7, y: 0.4 },
    },
  ]);
  const result = await session.stop();
  return concatChunks(result.package.chunks);
}

const CASES: ProducerCase[] = [
  {
    name: "extension packager (video + full artifact set)",
    build: () => buildSamplePackage(),
    expectations: {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata", "console", "network", "websocket", "events", "privacy"],
      expectVideo: true,
    },
  },
  {
    name: "extension packager (password protected)",
    build: () => buildSamplePackage({ password: "correct horse" }),
    expectations: {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata", "console", "network"],
      expectVideo: true,
      password: "correct horse",
    },
  },
  {
    name: "extension packager (console-only session)",
    build: () =>
      buildSamplePackage({
        withNetwork: false,
        withWebsocket: false,
        withEvents: false,
      }),
    expectations: {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata", "console"],
      expectVideo: true,
    },
  },
  {
    name: "extension screenshot report (annotated, no video)",
    build: () => buildSamplePackage({ withScreenshots: true, withInstantReplay: true }),
    expectations: {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata", "screenshots", "instantReplay"],
      expectVideo: true,
      expectScreenshots: true,
    },
  },
  {
    name: "browser SDK (no video)",
    build: () => buildSdkPackage(),
    expectations: {
      producer: "sdk",
      capabilities: SDK_CAPABILITIES,
      requiredArtifacts: ["metadata", "console", "network", "privacy"],
      expectVideo: false,
    },
  },
  {
    name: "browser SDK (password protected)",
    build: () => buildSdkPackage("hunter2"),
    expectations: {
      producer: "sdk",
      capabilities: SDK_CAPABILITIES,
      requiredArtifacts: ["metadata", "console", "privacy"],
      expectVideo: false,
      password: "hunter2",
    },
  },
];

describe("recording package conformance", () => {
  for (const producer of CASES) {
    it(`${producer.name} writes a conforming package`, async () => {
      const bytes = await producer.build();
      const report = await checkPackageConformance(bytes, producer.expectations);
      expect(report.violations).toEqual([]);
    });
  }

  it("browser SDK (annotated DOM-snapshot screenshot) writes a conforming package", async () => {
    const bytes = await buildSdkScreenshotPackage();
    const report = await checkPackageConformance(bytes, {
      producer: "sdk",
      capabilities: SDK_CAPABILITIES,
      requiredArtifacts: ["metadata", "screenshots", "dom"],
      expectVideo: false,
      expectScreenshots: true,
    });

    expect(report.violations).toEqual([]);
  });

  it("rejects a package whose declared capabilities do not match its contents", async () => {
    // The SDK package carries no video, so asserting the extension's contract
    // against it must fail — otherwise the contract asserts nothing.
    const bytes = await buildSdkPackage();
    const report = await checkPackageConformance(bytes, {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata"],
      expectVideo: true,
    });

    expect(report.violations.join(" ")).toMatch(/metadata\.producer is sdk/);
    expect(report.violations.join(" ")).toMatch(/capability "video" is missing/);
    expect(report.violations.join(" ")).toMatch(/expected video parts, found 0/);
  });

  it("rejects a screenshot whose redaction was never applied to the pixels", async () => {
    // Hand-built rather than produced: no shipping producer can emit this, and
    // the contract has to fail it if one ever regresses into doing so.
    const screenshot = {
      id: "shot-leak",
      capturedAt: 1_700_000_000_000,
      viewport: { width: 800, height: 600 },
      source: { kind: "image" as const, path: "screenshots/shot-leak.png", mimeType: "image/png" },
      annotations: [
        {
          id: "r1",
          createdAt: 1_700_000_000_000,
          type: "redact" as const,
          rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
          applied: "pending" as const,
        },
      ],
    };

    const built = await buildRecordingPackage({
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      packagedAt: "2026-01-01T00:00:00.000Z",
      zipFilename: "leaky.zip",
      artifacts: {
        screenshots: encodeJsonArtifact({ schemaVersion: 1, screenshots: [screenshot] }),
      },
      extraEntries: [{ name: "screenshots/shot-leak.png", bytes: new Uint8Array([1, 2, 3]) }],
      modifiedAt: new Date(0),
    });

    const report = await checkPackageConformance(concatChunks(built.chunks), {
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
      requiredArtifacts: ["metadata", "screenshots"],
      expectVideo: false,
      expectScreenshots: true,
    });

    expect(report.violations.join(" ")).toMatch(/pending redaction/);
    expect(report.violations.join(" ")).toMatch(/still readable/);
  });
});
