import { describe, expect, it } from "vitest";
import {
  assertAppendOnlyReleaseRegistry,
  getReleaseByVersion,
  parseReleaseRegistry,
  ReleaseRegistryError,
} from "./index";

const release111 = {
  version: "1.7.11",
  sourceCommit: "a123456",
  player: {
    r2Prefix: "player/1.7.11/",
    sha256: `sha256:${"a".repeat(64)}`,
    builtAt: "2026-08-19T00:00:00.000Z",
  },
  worker: {
    serviceName: "gn-tracing-oauth-proxy-v1-7-11",
    bindingName: "WORKER_1_7_11",
    sourceCommit: "a123456",
  },
};

function registry(releases = [release111]) {
  return { schemaVersion: 1, releases };
}

describe("release registry", () => {
  it("parses valid versioned Player and Worker artifacts", () => {
    const parsed = parseReleaseRegistry(registry());
    expect(parsed.releases).toEqual([release111]);
    expect(getReleaseByVersion(parsed, "1.7.11")).toEqual(release111);
    expect(getReleaseByVersion(parsed, "1.7.12")).toBeUndefined();
  });

  it("rejects invalid version, duplicate version, and incorrect immutable artifact mappings", () => {
    expect(() => parseReleaseRegistry(registry([{ ...release111, version: "latest" }]))).toThrow(
      ReleaseRegistryError,
    );
    expect(() => parseReleaseRegistry(registry([release111, release111]))).toThrow(
      /duplicate version/,
    );
    expect(() =>
      parseReleaseRegistry(
        registry([{ ...release111, player: { ...release111.player, r2Prefix: "player/latest/" } }]),
      ),
    ).toThrow(/r2Prefix/);
    expect(() =>
      parseReleaseRegistry(
        registry([
          { ...release111, worker: { ...release111.worker, bindingName: "WORKER_OTHER" } },
        ]),
      ),
    ).toThrow(/bindingName/);
  });

  it("allows only append-only registry updates", () => {
    const release112 = {
      ...release111,
      version: "1.7.12",
      sourceCommit: "b123456",
      player: {
        ...release111.player,
        r2Prefix: "player/1.7.12/",
        sha256: `sha256:${"b".repeat(64)}`,
      },
      worker: {
        ...release111.worker,
        serviceName: "gn-tracing-oauth-proxy-v1-7-12",
        bindingName: "WORKER_1_7_12",
        sourceCommit: "b123456",
      },
    };
    expect(assertAppendOnlyReleaseRegistry(registry(), registry([release111, release112]))).toEqual(
      registry([release111, release112]),
    );
    expect(() => assertAppendOnlyReleaseRegistry(registry(), registry([]))).toThrow(
      /cannot be removed/,
    );
    expect(() =>
      assertAppendOnlyReleaseRegistry(
        registry(),
        registry([{ ...release111, sourceCommit: "c123456" }]),
      ),
    ).toThrow(/immutable/);
  });
});
