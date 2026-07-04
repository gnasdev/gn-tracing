import { describe, expect, it } from "vitest";
import { isUploadArtifactKey } from "./upload-orchestrator";

describe("upload-orchestrator", () => {
  describe("isUploadArtifactKey", () => {
    it.each([
      "consoleLogs",
      "networkRequests",
      "webSocketLogs",
      "report",
      "userEvents",
      "drawing",
      "privacy",
      "diagnostics",
      "storage",
      "dom",
    ])("accepts %s as a valid artifact key", (key) => {
      expect(isUploadArtifactKey(key)).toBe(true);
    });

    it("rejects unknown artifact keys", () => {
      expect(isUploadArtifactKey("unknown")).toBe(false);
      expect(isUploadArtifactKey("")).toBe(false);
    });
  });
});
