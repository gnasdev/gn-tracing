import { describe, expect, it, vi } from "vitest";
import {
  drainBodyFetchesThenDetach,
  parseContentTypeMime,
  resolveNetworkMimeType,
  resolveNetworkResponseBodyDisplay,
  shouldFetchResponseBody,
  shouldFetchResponseBodyForEntry,
} from "./network-response-body";

describe("parseContentTypeMime", () => {
  it("strips parameters and lowercases", () => {
    expect(parseContentTypeMime("Application/JSON; charset=utf-8")).toBe("application/json");
  });

  it("returns null for empty", () => {
    expect(parseContentTypeMime("")).toBeNull();
    expect(parseContentTypeMime(null)).toBeNull();
  });
});

describe("resolveNetworkMimeType", () => {
  it("prefers entry.mimeType", () => {
    expect(
      resolveNetworkMimeType({
        mimeType: "application/json",
        responseHeaders: { "content-type": "text/plain" },
      }),
    ).toBe("application/json");
  });

  it("falls back to Content-Type header when mimeType is empty", () => {
    expect(
      resolveNetworkMimeType({
        mimeType: null,
        responseHeaders: { "Content-Type": "application/problem+json; charset=utf-8" },
      }),
    ).toBe("application/problem+json");
  });

  it("prefers responseHeadersExtra over responseHeaders", () => {
    expect(
      resolveNetworkMimeType({
        mimeType: "",
        responseHeadersExtra: { "content-type": "application/javascript" },
        responseHeaders: { "content-type": "text/plain" },
      }),
    ).toBe("application/javascript");
  });
});

describe("shouldFetchResponseBody", () => {
  it("returns false when mode is off", () => {
    expect(
      shouldFetchResponseBody({
        mode: "off",
        mimeType: "application/json",
        encodedDataLength: 10,
        maxResponseBodyBytes: null,
      }),
    ).toBe(false);
  });

  it("returns false when mime is empty", () => {
    expect(
      shouldFetchResponseBody({
        mode: "eligible",
        mimeType: null,
        encodedDataLength: 10,
        maxResponseBodyBytes: null,
      }),
    ).toBe(false);
  });

  it("respects maxResponseBodyBytes", () => {
    expect(
      shouldFetchResponseBody({
        mode: "eligible",
        mimeType: "application/json",
        encodedDataLength: 2000,
        maxResponseBodyBytes: 1000,
      }),
    ).toBe(false);
  });

  it("text mode only allows text/*", () => {
    expect(
      shouldFetchResponseBody({
        mode: "text",
        mimeType: "text/plain",
        encodedDataLength: 1,
        maxResponseBodyBytes: null,
      }),
    ).toBe(true);
    expect(
      shouldFetchResponseBody({
        mode: "text",
        mimeType: "application/json",
        encodedDataLength: 1,
        maxResponseBodyBytes: null,
      }),
    ).toBe(false);
  });

  it("text-json allows text and json subtypes", () => {
    expect(
      shouldFetchResponseBody({
        mode: "text-json",
        mimeType: "application/problem+json",
        encodedDataLength: 1,
        maxResponseBodyBytes: null,
      }),
    ).toBe(true);
  });

  it("eligible accepts application/json, +json, javascript, and xml", () => {
    for (const mime of [
      "application/json",
      "application/problem+json",
      "application/graphql+json",
      "application/javascript",
      "text/javascript",
      "application/xml",
      "image/svg+xml",
      "text/html",
    ]) {
      expect(
        shouldFetchResponseBody({
          mode: "eligible",
          mimeType: mime,
          encodedDataLength: 1,
          maxResponseBodyBytes: null,
        }),
        mime,
      ).toBe(true);
    }
  });

  it("eligible rejects binary image/octet-stream", () => {
    expect(
      shouldFetchResponseBody({
        mode: "eligible",
        mimeType: "image/png",
        encodedDataLength: 1,
        maxResponseBodyBytes: null,
      }),
    ).toBe(false);
    expect(
      shouldFetchResponseBody({
        mode: "eligible",
        mimeType: "application/octet-stream",
        encodedDataLength: 1,
        maxResponseBodyBytes: null,
      }),
    ).toBe(false);
  });
});

describe("shouldFetchResponseBodyForEntry", () => {
  it("uses Content-Type fallback for eligibility", () => {
    expect(
      shouldFetchResponseBodyForEntry(
        "eligible",
        {
          mimeType: null,
          encodedDataLength: 42,
          responseHeaders: { "content-type": "application/json" },
        },
        null,
      ),
    ).toBe(true);
  });
});

describe("drainBodyFetchesThenDetach", () => {
  it("waits for body fetches, finalizes, then detaches (never detach-first)", async () => {
    const order: string[] = [];
    let resolveBody!: () => void;
    const bodyPromise = new Promise<void>((resolve) => {
      resolveBody = resolve;
    });

    const finalizePending = vi.fn(() => {
      order.push("finalize");
    });
    const detachDebugger = vi.fn(async () => {
      order.push("detach");
    });

    const run = drainBodyFetchesThenDetach({
      bodyFetches: [
        bodyPromise.then(() => {
          order.push("body-done");
        }),
      ],
      finalizePending,
      detachDebugger,
    });

    // Body still pending: detach must not have run.
    await Promise.resolve();
    expect(detachDebugger).not.toHaveBeenCalled();
    expect(finalizePending).not.toHaveBeenCalled();

    resolveBody();
    await run;

    expect(order).toEqual(["body-done", "finalize", "detach"]);
    expect(detachDebugger).toHaveBeenCalledOnce();
  });

  it("detaches even when a body fetch rejects", async () => {
    const order: string[] = [];
    await drainBodyFetchesThenDetach({
      bodyFetches: [
        Promise.reject(new Error("evicted")).catch(() => {
          order.push("body-failed");
        }),
      ],
      finalizePending: () => order.push("finalize"),
      detachDebugger: async () => {
        order.push("detach");
      },
    });
    expect(order).toEqual(["body-failed", "finalize", "detach"]);
  });
});

describe("resolveNetworkResponseBodyDisplay", () => {
  it("returns missing when there is no stored text", () => {
    expect(resolveNetworkResponseBodyDisplay({ text: "" })).toEqual({
      kind: "missing",
      text: "",
    });
    expect(resolveNetworkResponseBodyDisplay({ text: null })).toEqual({
      kind: "missing",
      text: "",
    });
  });

  it("returns text when plain body is present", () => {
    expect(resolveNetworkResponseBodyDisplay({ text: '{"ok":true}' })).toEqual({
      kind: "text",
      text: '{"ok":true}',
    });
  });

  it("returns binary when base64 cannot be decoded to text", () => {
    expect(
      resolveNetworkResponseBodyDisplay({
        text: "AAAA",
        encoding: "base64",
        decodedText: "",
      }),
    ).toEqual({ kind: "binary", text: "" });
  });

  it("returns decoded text for base64 text payloads", () => {
    expect(
      resolveNetworkResponseBodyDisplay({
        text: "e30=",
        encoding: "base64",
        decodedText: "{}",
      }),
    ).toEqual({ kind: "text", text: "{}" });
  });
});
