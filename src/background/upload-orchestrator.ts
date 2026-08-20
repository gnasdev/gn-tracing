/**
 * Upload orchestrator types, constants, and pure helpers for Drive upload sessions and artifact chunking.
 *
 * Screenshot / Instant Replay package bulk data uses IndexedDB staging
 * (`screenshot-package-staging-idb`) instead of this chunk protocol.
 */
import type { MessageResponse } from "../types/messages";
import type { SessionArtifacts } from "./runtime-state";

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
  | "drawing"
  | "privacy"
  | "diagnostics"
  | "storage"
  | "dom";

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
    key === "drawing" ||
    key === "privacy" ||
    key === "diagnostics" ||
    key === "storage" ||
    key === "dom"
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
  const safeOffset = Math.max(0, Math.min(offset, totalLength));
  const chunk = value.slice(safeOffset, safeOffset + UPLOAD_ARTIFACT_CHUNK_CHARS);

  return {
    ok: true,
    chunk,
    nextOffset: safeOffset + chunk.length,
    totalLength,
  };
}
