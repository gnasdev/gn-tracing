/**
 * Upload orchestrator types, constants, and pure helpers for Drive upload sessions and artifact chunking.
 */
import type { MessageResponse } from "../types/messages";
import type { SessionArtifacts } from "./service-worker";

export interface UploadSuccessResult {
  ok: true;
  recordingUrl?: string;
  folderId?: string;
  indexFileId?: string;
  targetFolderId?: string | null;
}

export type UploadArtifactKey =
  | "consoleLogs"
  | "networkRequests"
  | "webSocketLogs"
  | "report"
  | "userEvents"
  | "privacy"
  | "diagnostics";

export interface UploadArtifactChunkResponse extends MessageResponse {
  chunk?: string;
  nextOffset?: number;
  totalLength?: number;
}

export const UPLOAD_ARTIFACT_CHUNK_CHARS = 1024 * 1024;

export function isUploadArtifactKey(key: string): key is UploadArtifactKey {
  return (
    key === "consoleLogs" ||
    key === "networkRequests" ||
    key === "webSocketLogs" ||
    key === "report" ||
    key === "userEvents" ||
    key === "privacy" ||
    key === "diagnostics"
  );
}

export function getUploadArtifactChunk(
  sessionArtifacts: Record<string, SessionArtifacts>,
  data: Record<string, unknown> | undefined,
): UploadArtifactChunkResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const key = typeof data?.key === "string" ? data.key : "";
  const offset =
    typeof data?.offset === "number" && Number.isFinite(data.offset)
      ? Math.max(0, Math.floor(data.offset))
      : 0;

  if (!sessionId || !isUploadArtifactKey(key)) {
    return { ok: false, error: "Missing upload artifact reference." };
  }

  const value = sessionArtifacts[sessionId]?.[key] || "";
  const totalLength = value.length;
  const chunk = value.slice(offset, offset + UPLOAD_ARTIFACT_CHUNK_CHARS);

  return {
    ok: true,
    chunk,
    nextOffset: offset + chunk.length,
    totalLength,
  };
}
