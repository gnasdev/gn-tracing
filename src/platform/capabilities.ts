/**
 * Recording capability sets per browser producer path.
 *
 * Package metadata must declare what the producer can actually capture so the
 * player/MCP never assume CDP-quality network on a Firefox package.
 */

import type {
  EvidenceCoverage,
  RecordingCapability,
} from "../../packages/replay-core/src/schema/package";
import {
  EXTENSION_CAPABILITIES,
  FIREFOX_EXTENSION_CAPABILITIES,
  SAFARI_EXTENSION_CAPABILITIES,
  SAFARI_IOS_EXTENSION_CAPABILITIES,
} from "../../packages/replay-core/src/schema/package";
import { getBrowserTarget } from "./detect";
import { coverageFromEvidenceOffers, type EvidenceOffer } from "./evidence/surfaces";
import type { BrowserTarget } from "./types";

/** Chromium-family extension (Chrome / Edge / Opera): full CDP + tabCapture. */
export const CHROMIUM_EXTENSION_CAPABILITIES: RecordingCapability[] = [...EXTENSION_CAPABILITIES];

const IN_PAGE_EVIDENCE_OFFERS: readonly EvidenceOffer[] = [
  { source: "in-page", surface: "console-api", quality: "full", capability: "console" },
  { source: "in-page", surface: "runtime-exception", quality: "full", capability: "console" },
  {
    source: "in-page",
    surface: "runtime-object-details",
    quality: "partial",
    capability: "console",
  },
  { source: "in-page", surface: "websocket-lifecycle", quality: "full", capability: "websocket" },
  { source: "in-page", surface: "websocket-frames", quality: "full", capability: "websocket" },
  { source: "in-page", surface: "storage-snapshot", quality: "partial", capability: "storage" },
];

const IN_PAGE_NETWORK_EVIDENCE_OFFERS: readonly EvidenceOffer[] = [
  { source: "in-page", surface: "network-lifecycle", quality: "partial", capability: "network" },
  {
    source: "in-page",
    surface: "network-request-headers",
    quality: "partial",
    capability: "network",
  },
  {
    source: "in-page",
    surface: "network-response-headers",
    quality: "partial",
    capability: "network",
  },
  { source: "in-page", surface: "network-initiator", quality: "partial", capability: "network" },
  { source: "in-page", surface: "network-timing", quality: "partial", capability: "network" },
];

const WEB_REQUEST_EVIDENCE_OFFERS: readonly EvidenceOffer[] = [
  { source: "web-request", surface: "network-lifecycle", quality: "full", capability: "network" },
  {
    source: "web-request",
    surface: "network-request-headers",
    quality: "full",
    capability: "network",
  },
  {
    source: "web-request",
    surface: "network-response-headers",
    quality: "full",
    capability: "network",
  },
  {
    source: "web-request",
    surface: "network-initiator",
    quality: "partial",
    capability: "network",
  },
  { source: "web-request", surface: "network-timing", quality: "partial", capability: "network" },
];

const CDP_EVIDENCE_OFFERS: readonly EvidenceOffer[] = [
  { source: "cdp", surface: "console-api", quality: "full", capability: "console" },
  { source: "cdp", surface: "runtime-exception", quality: "full", capability: "console" },
  { source: "cdp", surface: "runtime-object-details", quality: "full", capability: "console" },
  { source: "cdp", surface: "network-lifecycle", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-request-headers", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-response-headers", quality: "full", capability: "network" },
  {
    source: "cdp",
    surface: "network-response-body",
    quality: "full",
    capability: "network-bodies",
  },
  { source: "cdp", surface: "network-initiator", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-timing", quality: "full", capability: "network" },
  { source: "cdp", surface: "websocket-lifecycle", quality: "full", capability: "websocket" },
  { source: "cdp", surface: "websocket-frames", quality: "full", capability: "websocket" },
  { source: "cdp", surface: "storage-snapshot", quality: "full", capability: "storage" },
  { source: "cdp", surface: "cookie-snapshot", quality: "full", capability: "cookies" },
  { source: "cdp", surface: "dom-snapshot", quality: "full", capability: "dom-snapshot" },
  { source: "cdp", surface: "source-map-resolution", quality: "full", capability: "source-maps" },
];

/**
 * Static coverage for the evidence adapters selected by each browser runtime.
 * This deliberately names only adapters that ship in the extension today;
 * declared source vocabulary does not imply an RDP, BiDi, or WebKit adapter.
 */
export function getProducerEvidenceCoverage(
  target: BrowserTarget = getBrowserTarget(),
): EvidenceCoverage {
  if (target === "firefox" || target === "safari") {
    return coverageFromEvidenceOffers([...IN_PAGE_EVIDENCE_OFFERS, ...WEB_REQUEST_EVIDENCE_OFFERS]);
  }
  if (target === "safari-ios") {
    return coverageFromEvidenceOffers([
      ...IN_PAGE_EVIDENCE_OFFERS,
      ...IN_PAGE_NETWORK_EVIDENCE_OFFERS,
    ]);
  }
  return coverageFromEvidenceOffers(CDP_EVIDENCE_OFFERS);
}

export function getProducerCapabilities(
  target: BrowserTarget = getBrowserTarget(),
): RecordingCapability[] {
  if (target === "firefox") {
    return [...FIREFOX_EXTENSION_CAPABILITIES];
  }
  if (target === "safari") {
    return [...SAFARI_EXTENSION_CAPABILITIES];
  }
  if (target === "safari-ios") {
    return [...SAFARI_IOS_EXTENSION_CAPABILITIES];
  }
  // chrome | edge | opera share the same capability declaration.
  return [...CHROMIUM_EXTENSION_CAPABILITIES];
}

export {
  FIREFOX_EXTENSION_CAPABILITIES,
  SAFARI_EXTENSION_CAPABILITIES,
  SAFARI_IOS_EXTENSION_CAPABILITIES,
};
