import { describe, expect, it } from "vitest";
import {
  detectNetworkFilterFromUrlAndMime,
  getNetworkFilterType,
  type NetworkFilterBucket,
} from "./network-filter-type";

describe("getNetworkFilterType — DevTools-like matrix", () => {
  const cases: Array<{
    name: string;
    input: { resourceType?: string; url?: string; mimeType?: string };
    expected: NetworkFilterBucket;
  }> = [
    // Canonical script
    {
      name: "Script + .js URL",
      input: {
        resourceType: "Script",
        url: "https://cdn.example.com/app.js",
        mimeType: "application/javascript",
      },
      expected: "js",
    },
    {
      name: "script lowercase + .mjs",
      input: { resourceType: "script", url: "https://x.test/a.mjs" },
      expected: "js",
    },
    {
      name: "script + .cjs",
      input: { resourceType: "Script", url: "https://x.test/a.cjs" },
      expected: "js",
    },
    // Other + JS refine (the main bug)
    {
      name: "Other + JS mime → js",
      input: {
        resourceType: "Other",
        url: "https://cdn.example.com/app.chunk.js",
        mimeType: "application/javascript",
      },
      expected: "js",
    },
    {
      name: "Other + .js URL only → js",
      input: { resourceType: "Other", url: "https://cdn.example.com/bundle.js" },
      expected: "js",
    },
    {
      name: "empty type + JS mime → js",
      input: { resourceType: "", url: "https://x.test/x", mimeType: "text/javascript" },
      expected: "js",
    },
    {
      name: "empty type + .js URL → js",
      input: { url: "https://x.test/vendor.js?v=1#frag" },
      expected: "js",
    },
    // XHR/Fetch must stay fetch even when URL/mime looks like JS
    {
      name: "XHR + .js URL stays fetch",
      input: {
        resourceType: "XHR",
        url: "https://api.example.com/module.js",
        mimeType: "application/javascript",
      },
      expected: "fetch",
    },
    {
      name: "Fetch + JS mime stays fetch",
      input: {
        resourceType: "Fetch",
        url: "https://api.example.com/code",
        mimeType: "application/javascript",
      },
      expected: "fetch",
    },
    {
      name: "xhr + JSON API → fetch",
      input: {
        resourceType: "xhr",
        url: "https://api.example.com/items",
        mimeType: "application/json",
      },
      expected: "fetch",
    },
    {
      name: "preflight → fetch",
      input: { resourceType: "Preflight", url: "https://api.example.com/items" },
      expected: "fetch",
    },
    {
      name: "eventsource → fetch",
      input: { resourceType: "EventSource", url: "https://api.example.com/sse" },
      expected: "fetch",
    },
    // Other resource types
    {
      name: "Stylesheet → css",
      input: {
        resourceType: "Stylesheet",
        url: "https://x.test/a.css",
        mimeType: "text/css",
      },
      expected: "css",
    },
    {
      name: "Image → img",
      input: { resourceType: "Image", url: "https://x.test/a.png", mimeType: "image/png" },
      expected: "img",
    },
    {
      name: "Font → font",
      input: { resourceType: "Font", url: "https://x.test/a.woff2", mimeType: "font/woff2" },
      expected: "font",
    },
    {
      name: "Media → media",
      input: { resourceType: "Media", url: "https://x.test/a.mp4", mimeType: "video/mp4" },
      expected: "media",
    },
    {
      name: "Document → doc",
      input: {
        resourceType: "Document",
        url: "https://x.test/index.html",
        mimeType: "text/html",
      },
      expected: "doc",
    },
    {
      name: "WebSocket → ws",
      input: { resourceType: "WebSocket", url: "wss://x.test/socket" },
      expected: "ws",
    },
    {
      name: "Other + image mime → img",
      input: {
        resourceType: "Other",
        url: "https://x.test/photo",
        mimeType: "image/webp",
      },
      expected: "img",
    },
    {
      name: "Other + .css URL → css",
      input: { resourceType: "Other", url: "https://x.test/theme.css" },
      expected: "css",
    },
    {
      name: "Other + .woff2 → font",
      input: { resourceType: "Other", url: "https://x.test/f.woff2" },
      expected: "font",
    },
    {
      name: "empty + .html → doc",
      input: { url: "https://x.test/page.html" },
      expected: "doc",
    },
    // .map is not JS
    {
      name: ".map source map → other (not js)",
      input: {
        resourceType: "Other",
        url: "https://cdn.example.com/app.js.map",
        mimeType: "application/json",
      },
      expected: "other",
    },
    {
      name: "empty type + .map → other",
      input: { url: "https://cdn.example.com/chunk.js.map" },
      expected: "other",
    },
    // Known noise
    {
      name: "Ping → other",
      input: { resourceType: "Ping", url: "https://x.test/ping" },
      expected: "other",
    },
    {
      name: "unknown type without mime/url signal → other",
      input: { resourceType: "WeirdType", url: "https://x.test/api/v1/data" },
      expected: "other",
    },
  ];

  for (const row of cases) {
    it(row.name, () => {
      expect(getNetworkFilterType(row.input)).toBe(row.expected);
    });
  }
});

describe("detectNetworkFilterFromUrlAndMime", () => {
  it("detects JS from mime and extension", () => {
    expect(detectNetworkFilterFromUrlAndMime("https://x/a", "application/javascript")).toBe("js");
    expect(detectNetworkFilterFromUrlAndMime("https://x/a.mjs", "")).toBe("js");
  });

  it("does not treat .map as js", () => {
    expect(detectNetworkFilterFromUrlAndMime("https://x/a.js.map", "application/json")).toBe(
      "other",
    );
  });
});
