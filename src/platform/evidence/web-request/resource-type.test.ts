/**
 * Test all resource-type pairs the player filters by. This table is the
 * majority of the mapping's risk surface, so every pair gets its own row.
 */
import { describe, expect, it } from "vitest";
import { toCdpResourceType } from "./resource-type";

describe("toCdpResourceType", () => {
  const pairs: Array<[string, string]> = [
    ["main_frame", "Document"],
    ["sub_frame", "Document"],
    ["stylesheet", "Stylesheet"],
    ["script", "Script"],
    ["image", "Image"],
    ["imageset", "Image"],
    ["object", "Object"],
    ["object_subrequest", "Object"],
    ["font", "Font"],
    ["xmlhttprequest", "XHR"],
    ["ping", "Ping"],
    ["beacon", "Ping"],
    ["xslt", "XSLT"],
    ["xml_dtd", "XML"],
    ["web_manifest", "Manifest"],
    ["csp_report", "CSPViolationReport"],
    ["websocket", "WebSocket"],
    ["speculative", "Prefetch"],
    ["other", "Other"],
  ];

  it.each(pairs)("%s -> %s", (input, expected) => {
    expect(toCdpResourceType(input)).toBe(expected);
  });

  it("degrades an unknown type to Other instead of throwing", () => {
    expect(toCdpResourceType("some_future_type")).toBe("Other");
    expect(toCdpResourceType("")).toBe("Other");
  });
});
