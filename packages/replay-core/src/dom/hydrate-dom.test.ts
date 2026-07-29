import { describe, expect, it } from "vitest";
import { hydrateDomNodeToHtml } from "./hydrate-dom";

describe("hydrateDomNodeToHtml", () => {
  it("serializes a simple element tree", () => {
    const html = hydrateDomNodeToHtml({
      nodeType: 1,
      nodeName: "DIV",
      attributes: { class: "box" },
      children: [{ nodeType: 3, nodeName: "#text", nodeValue: "Hello <world>" }],
    });
    expect(html).toContain('<div class="box">Hello &lt;world&gt;</div>');
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("script-src 'none'");
  });

  it("strips script tags and event handlers", () => {
    const html = hydrateDomNodeToHtml({
      nodeType: 1,
      nodeName: "DIV",
      children: [
        {
          nodeType: 1,
          nodeName: "SCRIPT",
          children: [{ nodeType: 3, nodeName: "#text", nodeValue: "alert(1)" }],
        },
        {
          nodeType: 1,
          nodeName: "IMG",
          attributes: {
            src: "x",
            onerror: "alert(1)",
            onclick: "alert(2)",
          },
        },
        {
          nodeType: 1,
          nodeName: "A",
          attributes: { href: "javascript:alert(3)" },
          children: [{ nodeType: 3, nodeName: "#text", nodeValue: "x" }],
        },
      ],
    });
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<img src="x">');
  });

  it("injects a safe http(s) base href", () => {
    const html = hydrateDomNodeToHtml(
      { nodeType: 1, nodeName: "P", children: [] },
      { baseHref: "https://example.com/app/" },
    );
    expect(html).toContain('<base href="https://example.com/app/">');
  });

  it("rejects non-http base href", () => {
    const html = hydrateDomNodeToHtml(
      { nodeType: 1, nodeName: "P", children: [] },
      { baseHref: "javascript:alert(1)" },
    );
    expect(html).not.toContain("<base");
  });

  it("renders masked nodes as placeholders", () => {
    const html = hydrateDomNodeToHtml({
      nodeType: 1,
      nodeName: "DIV",
      masked: true,
      children: [],
    });
    expect(html).toContain("data-gn-masked");
    expect(html).toContain("[masked]");
  });

  it("handles document roots with html children", () => {
    const html = hydrateDomNodeToHtml({
      nodeType: 9,
      nodeName: "#document",
      children: [
        {
          nodeType: 1,
          nodeName: "HTML",
          children: [
            {
              nodeType: 1,
              nodeName: "BODY",
              children: [
                {
                  nodeType: 1,
                  nodeName: "H1",
                  children: [{ nodeType: 3, nodeName: "#text", nodeValue: "Title" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain("<h1>Title</h1>");
  });

  it("emits void elements without closing tags", () => {
    const html = hydrateDomNodeToHtml({
      nodeType: 1,
      nodeName: "DIV",
      children: [
        { nodeType: 1, nodeName: "BR", children: [] },
        { nodeType: 1, nodeName: "INPUT", attributes: { type: "text", value: "x" } },
      ],
    });
    expect(html).toContain("<br>");
    expect(html).toContain('<input type="text" value="x">');
    expect(html).not.toContain("</br>");
    expect(html).not.toContain("</input>");
  });
});
