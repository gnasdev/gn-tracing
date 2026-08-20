/**
 * `CdpStorageSnapshotCollector` behavior: this module had zero direct test
 * coverage while it lived inside `cdp-manager.ts` (only reachable through the
 * god-class's 2500+ other lines). Now that it is isolated, these tests cover
 * the storage/DOM redaction gating and the failure-tolerance contract that
 * `captureStorageSnapshot`/`captureDomSnapshot` document.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../shared/privacy-redaction";
import type { DomSnapshot, StorageSnapshot } from "../types/recording";
import { CdpStorageSnapshotCollector } from "./cdp-storage-snapshot";
import type { StorageManager } from "./storage-manager";

const TAB_ID = 7;

function fakeStorage(): StorageManager {
  return {
    setStorageSnapshot: vi.fn(),
    addDomSnapshot: vi.fn(),
  } as unknown as StorageManager;
}

/** Chrome mock spy shape from test/mocks/chrome.ts (installed by test/setup.ts). */
function mockSendCommand(byMethod: Record<string, unknown>): void {
  (
    chrome.debugger.sendCommand as unknown as {
      mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
    }
  ).mockImplementation((...args: unknown[]) => {
    const method = args[1] as string;
    if (method in byMethod) {
      const value = byMethod[method];
      if (value instanceof Error) {
        return Promise.reject(value);
      }
      return Promise.resolve(value);
    }
    return Promise.resolve({});
  });
}

function mockTabUrl(url: string): void {
  (
    chrome.tabs.get as unknown as {
      mockImplementation: (fn: (...args: unknown[]) => unknown) => void;
    }
  ).mockImplementation(() => Promise.resolve({ url }));
}

describe("CdpStorageSnapshotCollector.captureStorageSnapshot", () => {
  beforeEach(() => {
    mockTabUrl("https://shop.example.com/checkout");
  });

  it("redacts a sensitive storage key when redactStorageValues is enabled", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: true, redactDomTextContent: true });
    collector.setPrivacySettings(getPrivacyProfileSettings("standard"));
    mockSendCommand({
      "DOMStorage.getDOMStorageItems": { entries: [["authToken", "supersecretvalue"]] },
      "Network.getAllCookies": { cookies: [] },
    });

    await collector.captureStorageSnapshot(TAB_ID, "start");

    const snapshot = (storage.setStorageSnapshot as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StorageSnapshot;
    expect(snapshot.phase).toBe("start");
    expect(snapshot.localStorage[0].redacted).toBe(true);
    expect(snapshot.localStorage[0].value).not.toContain("supersecretvalue");
  });

  it("keeps storage values verbatim when redactStorageValues is disabled", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: false, redactDomTextContent: true });
    collector.setPrivacySettings(getPrivacyProfileSettings("standard"));
    mockSendCommand({
      "DOMStorage.getDOMStorageItems": { entries: [["authToken", "supersecretvalue"]] },
      "Network.getAllCookies": { cookies: [] },
    });

    await collector.captureStorageSnapshot(TAB_ID, "stop");

    const snapshot = (storage.setStorageSnapshot as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as StorageSnapshot;
    expect(snapshot.localStorage[0]).toEqual({ key: "authToken", value: "supersecretvalue" });
  });

  it("records a limitation and continues with an empty result when a CDP query fails", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: true, redactDomTextContent: true });
    collector.setPrivacySettings(getPrivacyProfileSettings("standard"));
    mockSendCommand({
      "DOMStorage.getDOMStorageItems": new Error("query failed"),
      "Network.getAllCookies": { cookies: [] },
    });

    await collector.captureStorageSnapshot(TAB_ID, "start");

    expect(storage.setStorageSnapshot).toHaveBeenCalledTimes(1);
    const limitations = collector.getStorageLimitations();
    expect(limitations.some((message) => message.includes("storage query failed"))).toBe(true);
  });

  it("clears limitations from a prior session on reset", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: true, redactDomTextContent: true });
    collector.setPrivacySettings(getPrivacyProfileSettings("standard"));
    mockSendCommand({
      "DOMStorage.getDOMStorageItems": new Error("query failed"),
      "Network.getAllCookies": { cookies: [] },
    });
    await collector.captureStorageSnapshot(TAB_ID, "start");
    expect(collector.getStorageLimitations().length).toBeGreaterThan(0);

    collector.reset();
    expect(collector.getStorageLimitations()).toEqual([]);
  });
});

describe("CdpStorageSnapshotCollector.captureDomSnapshot", () => {
  beforeEach(() => {
    mockTabUrl("https://shop.example.com/checkout");
  });

  it("masks a node matching a configured selector and its descendants", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: true, redactDomTextContent: true });
    collector.setPrivacySettings({
      ...getPrivacyProfileSettings("standard"),
      maskDomSelectors: [".secret"],
    });
    // strings: 0="#document" 1="div" 2="class" 3="secret" 4="#text" 5="ssn: 123-45-6789"
    mockSendCommand({
      "DOMSnapshot.captureSnapshot": {
        strings: ["#document", "div", "class", "secret", "#text", "ssn: 123-45-6789"],
        documents: [
          {
            documentURL: 0,
            nodes: {
              parentIndex: [-1, 0],
              nodeType: [9, 1],
              nodeName: [0, 1],
              nodeValue: [-1, -1],
              attributes: [[], [2, 3]],
            },
          },
        ],
      },
    });

    await collector.captureDomSnapshot(TAB_ID, "stop");

    expect(storage.addDomSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = (storage.addDomSnapshot as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as DomSnapshot;
    const child = snapshot.root.children?.[0];
    expect(child?.masked).toBe(true);
    expect(child?.attributes?.class).not.toBe("secret");
  });

  it("records a limitation and does not push a snapshot when the CDP query fails", async () => {
    const storage = fakeStorage();
    const collector = new CdpStorageSnapshotCollector(storage);
    collector.setCaptureSettings({ redactStorageValues: true, redactDomTextContent: true });
    collector.setPrivacySettings(getPrivacyProfileSettings("standard"));
    mockSendCommand({ "DOMSnapshot.captureSnapshot": new Error("boom") });

    await collector.captureDomSnapshot(TAB_ID, "stop");

    expect(storage.addDomSnapshot).not.toHaveBeenCalled();
    expect(
      collector
        .getStorageLimitations()
        .some((message) => message.includes("DOMSnapshot query failed")),
    ).toBe(true);
  });
});
