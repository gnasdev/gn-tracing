/**
 * Hash helpers for rate-limit keys (never store raw IP in cache keys).
 */

/** SHA-256 digest truncated to 16 bytes as hex (32 chars). */
export async function hashToHexPrefix(value: string, byteCount = 16): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let index = 0; index < byteCount; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      break;
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
