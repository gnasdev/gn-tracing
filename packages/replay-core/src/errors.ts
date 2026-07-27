/**
 * Stable error codes shared by every transport.
 *
 * Tool callers are agents, not people: an error has to say what went wrong AND
 * what to do next, in a code a client can branch on. Nothing below leaks a file
 * id, URL, or recording content into the message.
 */

export type ReplayErrorCode =
  | "INVALID_SOURCE"
  | "UNSUPPORTED_PROVIDER"
  | "PACKAGE_NOT_FOUND"
  | "PACKAGE_TOO_LARGE"
  | "PACKAGE_MALFORMED"
  | "PACKAGE_ENCRYPTED"
  | "WRONG_PASSWORD"
  | "ARTIFACT_MISSING"
  | "ENTRY_TOO_LARGE"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "UNKNOWN_RECORDING"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE";

export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  /** What the caller can do about it, in one sentence. */
  readonly hint?: string;

  constructor(code: ReplayErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
    this.hint = hint;
  }
}

export function isReplayError(value: unknown): value is ReplayError {
  return value instanceof ReplayError;
}

/** Normalizes any thrown value into a `ReplayError` for transport responses. */
export function toReplayError(
  value: unknown,
  fallbackCode: ReplayErrorCode = "UPSTREAM_UNAVAILABLE",
): ReplayError {
  if (isReplayError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return new ReplayError(fallbackCode, message);
}
