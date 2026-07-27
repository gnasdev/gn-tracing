/**
 * Tests for the packaged `agent-summary.json` artifact.
 *
 * The point of writing the artifact at upload time is that readers get the same
 * answer as if they had computed it themselves — so the assertions here compare
 * the packaged blob against `buildAgentSummary` directly, and check the skip and
 * failure paths never break an upload.
 */

import { describe, expect, it } from "vitest";
import { buildAgentSummary } from "../../packages/replay-core/src/index";
import { buildSampleArtifacts } from "../../packages/replay-core/src/testing/fixture";
import { createAgentSummaryBlob, MAX_AGENT_SUMMARY_INPUT_BYTES } from "./agent-summary";

function toBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}

function sampleInput(overrides: Record<string, unknown> = {}) {
  const artifacts = buildSampleArtifacts();
  return {
    metadata: artifacts.metadata,
    consoleBlob: toBlob(artifacts.console),
    networkBlob: toBlob(artifacts.network),
    websocketBlob: toBlob(artifacts.websocket),
    eventsBlob: toBlob(artifacts.events),
    privacyBlob: toBlob(artifacts.privacy),
    reportBlob: toBlob(artifacts.report),
    availableArtifacts: [
      "metadata",
      "console",
      "network",
      "websocket",
      "events",
      "privacy",
      "report",
    ],
    generatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("createAgentSummaryBlob", () => {
  it("writes the same summary a reader would compute from the artifacts", async () => {
    const artifacts = buildSampleArtifacts();
    const blob = await createAgentSummaryBlob(sampleInput());
    expect(blob).not.toBeNull();

    const packaged = JSON.parse(await (blob as Blob).text());
    const computed = buildAgentSummary({
      metadata: artifacts.metadata,
      console: artifacts.console,
      network: artifacts.network,
      websocket: artifacts.websocket,
      events: artifacts.events,
      privacy: artifacts.privacy,
      report: artifacts.report,
      availableArtifacts: [
        "metadata",
        "console",
        "network",
        "websocket",
        "events",
        "privacy",
        "report",
      ],
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(packaged).toEqual(computed);
    expect(packaged.schemaVersion).toBe(1);
    expect(packaged.counts).toMatchObject({ errors: 2, networkFailed: 1 });
  });

  it("stays small enough to be worth reading before anything else", async () => {
    const blob = await createAgentSummaryBlob(sampleInput());
    expect((blob as Blob).size).toBeLessThan(16 * 1024);
  });

  it("skips the artifact when the source artifacts are too large to re-parse", async () => {
    const oversized = {
      size: MAX_AGENT_SUMMARY_INPUT_BYTES + 1,
      text: async () => {
        throw new Error("must not be parsed");
      },
    } as unknown as Blob;

    expect(await createAgentSummaryBlob(sampleInput({ consoleBlob: oversized }))).toBeNull();
  });

  it("degrades to a partial summary when one artifact is unreadable", async () => {
    const unreadable = {
      size: 10,
      text: async () => {
        throw new Error("blob read failed");
      },
    } as unknown as Blob;

    const blob = await createAgentSummaryBlob(sampleInput({ networkBlob: unreadable }));
    const packaged = JSON.parse(await (blob as Blob).text());

    // Losing one artifact must not cost the others: console errors still land.
    expect(packaged.counts.network).toBe(0);
    expect(packaged.counts.errors).toBe(2);
  });

  it("summarizes a recording that captured nothing but video", async () => {
    const blob = await createAgentSummaryBlob(
      sampleInput({
        consoleBlob: null,
        networkBlob: null,
        websocketBlob: null,
        eventsBlob: null,
        privacyBlob: null,
        reportBlob: null,
        availableArtifacts: ["metadata"],
      }),
    );

    const packaged = JSON.parse(await (blob as Blob).text());
    expect(packaged.counts).toMatchObject({ console: 0, network: 0, events: 0 });
    expect(packaged.capture.artifacts).toEqual(["metadata"]);
  });
});
