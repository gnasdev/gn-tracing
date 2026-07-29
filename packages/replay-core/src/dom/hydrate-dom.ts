/**
 * Rebuild a serialized DomNode tree into an HTML document string for iframe
 * `srcdoc` preview (Instant Replay / Elements visual lookback).
 *
 * Capture already drops `<script>` bodies; this hydrator still strips scripts,
 * event-handler attributes, and javascript: URLs so a hostile or stale artifact
 * cannot execute code in the player.
 */

import type { DomNode } from "../schema/capture";

export interface HydrateDomOptions {
  /** Base URL for relative resources (typically frame.documentUrl). */
  baseHref?: string;
  title?: string;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_TYPE_NODE = 10;

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const FORBIDDEN_TAGS = new Set(["script", "noscript", "template"]);

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isJavascriptUrl(value: string): boolean {
  return /^\s*javascript:/i.test(value);
}

function isEventHandlerAttr(name: string): boolean {
  return /^on/i.test(name);
}

function tagNameOf(node: DomNode): string {
  return String(node.nodeName || "").toLowerCase();
}

function serializeAttributes(node: DomNode): string {
  const attrs = node.attributes;
  if (!attrs || typeof attrs !== "object") {
    return "";
  }
  const parts: string[] = [];
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = String(rawName);
    if (!name || isEventHandlerAttr(name)) {
      continue;
    }
    const lower = name.toLowerCase();
    const value = rawValue == null ? "" : String(rawValue);
    if (lower === "href" || lower === "src" || lower === "xlink:href" || lower === "action") {
      if (isJavascriptUrl(value)) {
        continue;
      }
    }
    // Drop inline script-ish attributes that are not classic on* handlers.
    if (lower === "srcdoc") {
      continue;
    }
    parts.push(` ${escapeAttr(name)}="${escapeAttr(value)}"`);
  }
  return parts.join("");
}

function serializeNode(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const dom = node as DomNode;
  const nodeType = typeof dom.nodeType === "number" ? dom.nodeType : ELEMENT_NODE;

  if (nodeType === TEXT_NODE) {
    return escapeHtmlText(dom.nodeValue ?? "");
  }

  if (nodeType === COMMENT_NODE) {
    // Comments cannot nest `--`; neutralize sequences.
    const body = String(dom.nodeValue ?? "").replace(/-->/g, "--&gt;");
    return `<!--${body}-->`;
  }

  if (nodeType === DOCUMENT_TYPE_NODE) {
    return "";
  }

  if (nodeType === DOCUMENT_NODE) {
    const children = Array.isArray(dom.children) ? dom.children : [];
    return children.map((child) => serializeNode(child)).join("");
  }

  // Element (and unknown types treated as elements).
  if (dom.masked) {
    return `<div data-gn-masked="1" style="padding:8px;border:1px dashed #888;color:#666;font:12px sans-serif">[masked]</div>`;
  }

  const tag = tagNameOf(dom);
  if (!tag) {
    return "";
  }
  // Drop the entire subtree for executable / inert capture noise.
  if (FORBIDDEN_TAGS.has(tag)) {
    return "";
  }

  const attrs = serializeAttributes(dom);
  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrs}>`;
  }

  const children = Array.isArray(dom.children) ? dom.children : [];
  const inner = children.map((child) => serializeNode(child)).join("");
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Build a full HTML document string safe for a sandboxed iframe `srcdoc`.
 */
export function hydrateDomNodeToHtml(
  root: DomNode | unknown,
  options: HydrateDomOptions = {},
): string {
  const bodyHtml = serializeNode(root);
  const title =
    typeof options.title === "string" && options.title.trim()
      ? escapeHtmlText(options.title.trim())
      : "DOM lookback";

  let baseTag = "";
  if (typeof options.baseHref === "string" && isSafeHttpUrl(options.baseHref)) {
    baseTag = `<base href="${escapeAttr(options.baseHref)}">`;
  }

  // CSP blocks script execution even if sandbox is misconfigured by a host page.
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'">`;

  // If the serialized tree already looks like a full html document, inject head bits.
  const trimmed = bodyHtml.trim();
  if (/^<html[\s>]/i.test(trimmed)) {
    // Insert meta/base after <html...> or into existing <head>.
    if (/<head[\s>]/i.test(trimmed)) {
      return trimmed.replace(/<head([^>]*)>/i, `<head$1>${csp}${baseTag}<title>${title}</title>`);
    }
    return trimmed.replace(
      /^<html([^>]*)>/i,
      `<html$1><head>${csp}${baseTag}<title>${title}</title></head>`,
    );
  }

  return (
    `<!DOCTYPE html><html><head>${csp}${baseTag}<meta charset="utf-8"><title>${title}</title>` +
    `<style>html,body{margin:0;padding:0;background:#fff;color:#111;font:14px/1.4 system-ui,sans-serif}</style>` +
    `</head><body>${trimmed}</body></html>`
  );
}
