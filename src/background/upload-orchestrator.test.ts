import { describe, expect, it } from "vitest";
import type { SessionArtifacts } from "./runtime-state";
import {
  getUploadArtifactChunk,
  isUploadArtifactKey,
  UPLOAD_ARTIFACT_CHUNK_CHARS,
} from "./upload-orchestrator";

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
      expect(isUploadArtifactKey("instantReplay")).toBe(false);
    });
  });

  describe("getUploadArtifactChunk", () => {
    it("slices recording session artifacts by sessionId", () => {
      const body = "X".repeat(UPLOAD_ARTIFACT_CHUNK_CHARS + 50);
      const sessionArtifacts = {
        "sess-1": { consoleLogs: body },
      } as unknown as Record<string, SessionArtifacts>;

      const first = getUploadArtifactChunk(sessionArtifacts, {
        sessionId: "sess-1",
        key: "consoleLogs",
        offset: 0,
      });
      expect(first.ok).toBe(true);
      expect(first.chunk?.length).toBe(UPLOAD_ARTIFACT_CHUNK_CHARS);
      expect(first.totalLength).toBe(body.length);

      const second = getUploadArtifactChunk(sessionArtifacts, {
        sessionId: "sess-1",
        key: "consoleLogs",
        offset: first.nextOffset,
      });
      expect(second.ok).toBe(true);
      expect(`${first.chunk}${second.chunk}`).toBe(body);
    });

    it("rejects missing session references", () => {
      expect(getUploadArtifactChunk({}, { key: "consoleLogs" }).ok).toBe(false);
      expect(getUploadArtifactChunk({}, { sessionId: "s", key: "instantReplay" }).ok).toBe(false);
    });
  });
});
