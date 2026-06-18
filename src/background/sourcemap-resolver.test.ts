/**
 * Unit tests for the pure source-map resolver used during stop-time stack-frame
 * enrichment. The module is Chrome-free, so these tests build small but valid
 * source-map documents (base64-VLQ mappings and section maps) and assert the
 * decode → store → resolve pipeline, the resolve status reasons, URL key
 * derivation, and the bounded source-snippet builder.
 */
import { describe, expect, it } from "vitest";
import type { SourceMapRaw } from "../types/recording";
import { getSourceMapUrlKeys, SourceMapResolver } from "./sourcemap-resolver";

// "AAAA" decodes to a single segment [genCol=0, srcFile=0, srcLine=0, srcCol=0].
// "CAAC" advances genCol by 1 and srcCol by 1 → [1, 0, 0, 1]. Together they give
// generated line 0 two ordered segments so the column binary search has choices.
const TWO_SEGMENT_MAP: SourceMapRaw = {
  version: 3,
  sources: ["original.ts"],
  sourcesContent: ["line0\nline1\nline2\nline3\nline4\nline5\nline6\n"],
  names: [],
  mappings: "AAAA,CAAC",
};

describe("getSourceMapUrlKeys", () => {
  it("returns an empty list for an empty url", () => {
    expect(getSourceMapUrlKeys("")).toEqual([]);
  });

  it("includes the raw url and a hash-stripped variant", () => {
    const keys = getSourceMapUrlKeys("https://example.com/app.js#sourceMappingURL=x");
    expect(keys).toContain("https://example.com/app.js#sourceMappingURL=x");
    expect(keys).toContain("https://example.com/app.js");
  });

  it("includes a query-stripped variant when a query string is present", () => {
    const keys = getSourceMapUrlKeys("https://example.com/app.js?v=2");
    expect(keys).toContain("https://example.com/app.js?v=2");
    expect(keys).toContain("https://example.com/app.js");
  });

  it("strips the fragment from a non-url string via the catch path", () => {
    const keys = getSourceMapUrlKeys("app.js#frag");
    expect(keys).toContain("app.js#frag");
    expect(keys).toContain("app.js");
  });
});

describe("SourceMapResolver.addMap", () => {
  it("accepts a valid v3 mappings map", () => {
    const resolver = new SourceMapResolver();
    expect(resolver.addMap("https://example.com/app.js", TWO_SEGMENT_MAP)).toBe(true);
    expect(resolver.size).toBeGreaterThan(0);
  });

  it("rejects a map whose version is not 3", () => {
    const resolver = new SourceMapResolver();
    expect(resolver.addMap("https://example.com/app.js", { version: 2, mappings: "AAAA" })).toBe(
      false,
    );
    expect(resolver.size).toBe(0);
  });

  it("rejects a map with neither mappings nor sections", () => {
    const resolver = new SourceMapResolver();
    expect(resolver.addMap("https://example.com/app.js", { version: 3 })).toBe(false);
  });

  it("accepts a sectioned (index) source map", () => {
    const resolver = new SourceMapResolver();
    const sectioned: SourceMapRaw = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sources: ["a.ts"],
            sourcesContent: ["alpha\nbeta\n"],
            names: [],
            mappings: "AAAA",
          },
        },
      ],
    };
    expect(resolver.addMap("https://example.com/bundle.js", sectioned)).toBe(true);
    expect(resolver.resolve("https://example.com/bundle.js", 0, 0)?.source).toBe("a.ts");
  });
});

describe("SourceMapResolver.resolveWithStatus", () => {
  const build = (): SourceMapResolver => {
    const resolver = new SourceMapResolver();
    resolver.addMap("https://example.com/app.js", TWO_SEGMENT_MAP);
    return resolver;
  };

  it("maps a generated location to its original source location", () => {
    const result = build().resolveWithStatus("https://example.com/app.js", 0, 0);
    expect(result.status).toBe("mapped");
    expect(result.location?.source).toBe("original.ts");
    expect(result.location?.line).toBe(0);
    expect(result.location?.sourceSnippet?.lines.length).toBeGreaterThan(0);
  });

  it("selects the closest segment at or before the requested column", () => {
    const result = build().resolveWithStatus("https://example.com/app.js", 0, 5);
    expect(result.status).toBe("mapped");
    // The second segment starts at generated column 1 and maps to src column 1.
    expect(result.location?.column).toBe(1);
  });

  it("reports no-map-for-generated-url for an unknown url", () => {
    expect(build().resolveWithStatus("https://other.com/x.js", 0, 0).status).toBe(
      "no-map-for-generated-url",
    );
  });

  it("reports no-generated-line when the line is out of range", () => {
    expect(build().resolveWithStatus("https://example.com/app.js", 99, 0).status).toBe(
      "no-generated-line",
    );
  });

  it("reports no-segment-for-column when no segment precedes the column", () => {
    const resolver = new SourceMapResolver();
    // ";CAAC" → line 0 has no segments, line 1 has one starting at column 1.
    resolver.addMap("https://example.com/app.js", {
      version: 3,
      sources: ["o.ts"],
      names: [],
      mappings: ";CAAC",
    });
    expect(resolver.resolveWithStatus("https://example.com/app.js", 0, 0).status).toBe(
      "no-segment-for-column",
    );
    expect(resolver.resolveWithStatus("https://example.com/app.js", 1, 0).status).toBe(
      "no-segment-for-column",
    );
  });

  it("reports no-original-segment for a single-field (generated-only) segment", () => {
    const resolver = new SourceMapResolver();
    // "A" → one segment carrying only the generated column, no source fields.
    resolver.addMap("https://example.com/app.js", {
      version: 3,
      sources: ["o.ts"],
      names: [],
      mappings: "A",
    });
    expect(resolver.resolveWithStatus("https://example.com/app.js", 0, 0).status).toBe(
      "no-original-segment",
    );
  });
});

describe("SourceMapResolver.resolve / size / clear", () => {
  it("returns null (not a status object) when resolution fails", () => {
    const resolver = new SourceMapResolver();
    expect(resolver.resolve("https://unknown.com/x.js", 0, 0)).toBeNull();
  });

  it("clear() empties the stored maps", () => {
    const resolver = new SourceMapResolver();
    resolver.addMap("https://example.com/app.js", TWO_SEGMENT_MAP);
    expect(resolver.size).toBeGreaterThan(0);
    resolver.clear();
    expect(resolver.size).toBe(0);
  });
});
