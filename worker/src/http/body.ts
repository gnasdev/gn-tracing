/**
 * Bounded body readers for POST handlers.
 */

export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_FORM_BODY_BYTES = 32 * 1024;

function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function isDeclaredBodyTooLarge(request: Request, maxBytes: number): boolean {
  const length = declaredContentLength(request);
  return length != null && length > maxBytes;
}

export async function readJsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid_json" }> {
  if (isDeclaredBodyTooLarge(request, maxBytes)) {
    return { ok: false, reason: "too_large" };
  }
  try {
    const text = await request.text();
    if (text.length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

export async function readFormParams(
  request: Request,
  maxBytes = DEFAULT_MAX_FORM_BODY_BYTES,
): Promise<
  { ok: true; params: URLSearchParams } | { ok: false; reason: "too_large" | "invalid_body" }
> {
  if (isDeclaredBodyTooLarge(request, maxBytes)) {
    return { ok: false, reason: "too_large" };
  }

  try {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const text = await request.text();
      if (text.length > maxBytes) {
        return { ok: false, reason: "too_large" };
      }
      const data = JSON.parse(text) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string") {
          params.set(key, value);
        }
      }
      return { ok: true, params };
    }

    const text = await request.text();
    if (text.length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
    return { ok: true, params: new URLSearchParams(text) };
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
}
