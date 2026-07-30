/**
 * Full ZIP open for recording packages (store + deflate-raw + ZipCrypto).
 * Structural parse reuses pure helpers from zip-parser; inflate uses
 * DecompressionStream when available.
 */
import { parseZipCentralDirectory, type ZipEntryRecord, type ZipParseResult } from "../zip-parser";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CRYPTO_HEADER_BYTES = 12;

export type UnzipErrorCode = ZipParseResult extends { ok: false; code: infer C }
  ? C
  :
      | never
      | "INFLATE_UNSUPPORTED"
      | "INFLATE_FAILED"
      | "LOCAL_HEADER_CORRUPT"
      | "PASSWORD_REQUIRED"
      | "PASSWORD_INVALID"
      | "UNSUPPORTED_COMPRESSION";

export type UnzipResult =
  | { ok: true; files: Map<string, Uint8Array> }
  | { ok: false; code: string; message: string };

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

async function inflateRawBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("DecompressionStream unavailable");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// Classic ZipCrypto (PKZIP) — matches legacy player.js
function crc32Update(crc: number, byte: number): number {
  let c = (crc ^ byte) >>> 0;
  for (let i = 0; i < 8; i += 1) {
    c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 0;
  }
  return c >>> 0;
}

function zipCryptoKeysFromPassword(password: string): [number, number, number] {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  for (let i = 0; i < password.length; i += 1) {
    key0 = crc32Update(key0, password.charCodeAt(i) & 0xff);
    key1 = (Math.imul(key1 + (key0 & 0xff), 134775813) + 1) >>> 0;
    key2 = crc32Update(key2, (key1 >>> 24) & 0xff);
  }
  return [key0, key1, key2];
}

function decryptZipCryptoByte(keys: [number, number, number], encryptedByte: number): number {
  const temp = (keys[2] | 2) >>> 0;
  const plain = encryptedByte ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
  keys[0] = crc32Update(keys[0], plain);
  keys[1] = (Math.imul(keys[1] + (keys[0] & 0xff), 134775813) + 1) >>> 0;
  keys[2] = crc32Update(keys[2], (keys[1] >>> 24) & 0xff);
  return plain & 0xff;
}

function decryptZipCryptoPayload(
  encryptedBytes: Uint8Array,
  password: string,
  crc32: number,
): Uint8Array | null {
  if (encryptedBytes.length < ZIP_CRYPTO_HEADER_BYTES) {
    return null;
  }
  const keys = zipCryptoKeysFromPassword(password);
  const header = new Uint8Array(ZIP_CRYPTO_HEADER_BYTES);
  for (let i = 0; i < ZIP_CRYPTO_HEADER_BYTES; i += 1) {
    const encrypted = encryptedBytes[i];
    if (encrypted === undefined) {
      return null;
    }
    header[i] = decryptZipCryptoByte(keys, encrypted);
  }
  // Header last byte should match high CRC byte (or high dos-time for bit 3 — we use CRC).
  if (header[ZIP_CRYPTO_HEADER_BYTES - 1] !== ((crc32 >>> 24) & 0xff)) {
    // Some writers use time check; accept either when CRC fails? Legacy is CRC.
    // Fail closed for wrong password.
    return null;
  }
  const out = new Uint8Array(encryptedBytes.length - ZIP_CRYPTO_HEADER_BYTES);
  for (let i = 0; i < out.length; i += 1) {
    const encrypted = encryptedBytes[ZIP_CRYPTO_HEADER_BYTES + i];
    if (encrypted === undefined) {
      return null;
    }
    out[i] = decryptZipCryptoByte(keys, encrypted);
  }
  return out;
}

async function readEntryBytes(
  buffer: ArrayBuffer,
  entry: ZipEntryRecord,
  password?: string,
): Promise<Uint8Array> {
  const view = new DataView(buffer);
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > buffer.byteLength) {
    throw new Error("LOCAL_HEADER_CORRUPT");
  }
  if (readU32(view, localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error("LOCAL_HEADER_CORRUPT");
  }
  const nameLen = readU16(view, localOffset + 26);
  const extraLen = readU16(view, localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.byteLength) {
    throw new Error("LOCAL_HEADER_CORRUPT");
  }
  let payload: Uint8Array = new Uint8Array(buffer.slice(dataStart, dataEnd));

  if (entry.isEncrypted) {
    if (!password) {
      throw new Error("PASSWORD_REQUIRED");
    }
    const decrypted = decryptZipCryptoPayload(payload, password, entry.crc32);
    if (!decrypted) {
      throw new Error("PASSWORD_INVALID");
    }
    payload = new Uint8Array(decrypted);
  }

  if (entry.compressionMethod === 0) {
    return new Uint8Array(payload);
  }
  if (entry.compressionMethod === 8) {
    return await inflateRawBytes(payload);
  }
  throw new Error("UNSUPPORTED_COMPRESSION");
}

export async function unzipPackage(
  blob: Blob,
  options: { password?: string } = {},
): Promise<UnzipResult> {
  try {
    const buffer = await blob.arrayBuffer();
    const parsed = parseZipCentralDirectory(new Uint8Array(buffer));
    if (!parsed.ok) {
      return { ok: false, code: parsed.code, message: parsed.message };
    }

    const files = new Map<string, Uint8Array>();
    for (const entry of parsed.entries) {
      if (entry.name.endsWith("/")) {
        continue;
      }
      try {
        const bytes = await readEntryBytes(buffer, entry, options.password);
        files.set(entry.name.replace(/^\//, ""), bytes);
      } catch (error) {
        const code = error instanceof Error ? error.message : "MALFORMED";
        if (code === "PASSWORD_REQUIRED" || code === "PASSWORD_INVALID") {
          return {
            ok: false,
            code,
            message:
              code === "PASSWORD_REQUIRED"
                ? "This package is password-protected."
                : "Incorrect package password.",
          };
        }
        return {
          ok: false,
          code,
          message: error instanceof Error ? error.message : "Failed to read ZIP entry",
        };
      }
    }
    return { ok: true, files };
  } catch (error) {
    return {
      ok: false,
      code: "MALFORMED",
      message: error instanceof Error ? error.message : "Failed to open ZIP",
    };
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function parseJsonBytes<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(decodeUtf8(bytes)) as T;
}
