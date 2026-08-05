/**
 * Map `webRequest.ResourceType` onto the CDP-style `resourceType` strings the
 * player already filters by (see `resourceType: params.type` in cdp-manager.ts,
 * which forwards CDP's own `Network.ResourceType`).
 *
 * Both vocabularies are stable enums from their respective specs; this is a
 * pure lookup so it is testable without any browser API.
 */

/** Firefox's chrome.webRequest.ResourceType values (MDN, WebExtensions API). */
export type WebRequestResourceType =
  | "main_frame"
  | "sub_frame"
  | "stylesheet"
  | "script"
  | "image"
  | "object"
  | "object_subrequest"
  | "font"
  | "xmlhttprequest"
  | "ping"
  | "beacon"
  | "xslt"
  | "xml_dtd"
  | "web_manifest"
  | "csp_report"
  | "imageset"
  | "websocket"
  | "speculative"
  | "other";

const RESOURCE_TYPE_TO_CDP: Record<WebRequestResourceType, string> = {
  main_frame: "Document",
  sub_frame: "Document",
  stylesheet: "Stylesheet",
  script: "Script",
  image: "Image",
  imageset: "Image",
  object: "Object",
  object_subrequest: "Object",
  font: "Font",
  xmlhttprequest: "XHR",
  ping: "Ping",
  beacon: "Ping",
  xslt: "XSLT",
  xml_dtd: "XML",
  web_manifest: "Manifest",
  csp_report: "CSPViolationReport",
  websocket: "WebSocket",
  speculative: "Prefetch",
  other: "Other",
};

/** Unknown values fall back to "Other" rather than throwing: a future Firefox
 * resource type must degrade, not break the recording. */
export function toCdpResourceType(webRequestType: string): string {
  return RESOURCE_TYPE_TO_CDP[webRequestType as WebRequestResourceType] ?? "Other";
}
