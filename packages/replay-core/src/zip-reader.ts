/**
 * ZIP reader for recording packages, usable outside a browser page.
 *
 * The structural central-directory parse mirrors
 * `player-standalone/src/zip-parser.ts` (and the writer in
 * `src/offscreen/offscreen.ts`): total over any byte buffer, never throws,
 * returns a typed result union instead.
 *
 * On top of that it adds what a non-UI consumer needs:
 *
 * - **Ranged reads.** A package is mostly video. The central directory can be
 *   located from the last ~64 KB and each JSON artifact read on its own, so an
 *   agent never downloads `video.part-*.webm`.
 * - **Inflate.** DEFLATE entries are expanded with `DecompressionStream`, which
 *   exists in browsers, Node 18+, and workerd alike.
 * - **ZipCrypto.** Password-protected packages are decrypted with the inverse of
 *   `createZipEncryptedPayload` in `./write/zip-writer.ts`, using the shared
 *   keystream from `./zip-format.ts`.
 */

import {
  ZIP_CENTRAL_DIRECTORY_HEADER_SIZE as CENTRAL_DIRECTORY_HEADER_SIZE,
  ZIP_CENTRAL_DIRECTORY_SIGNATURE as CENTRAL_DIRECTORY_SIGNATURE,
  calculateCrc32,
  createZipCryptoKeys,
  ZIP_EOCD_MIN_SIZE as EOCD_MIN_SIZE,
  ZIP_EOCD_SIGNATURE as EOCD_SIGNATURE,
  getZipCryptoByte,
  ZIP_LOCAL_FILE_HEADER_SIGNATURE as LOCAL_FILE_HEADER_SIGNATURE,
  ZIP_LOCAL_FILE_HEADER_SIZE as LOCAL_FILE_HEADER_SIZE,
  toArrayBuffer,
  updateZipCryptoKeys,
  ZIP_CRYPTO_HEADER_BYTES,
  ZIP_FLAG_ENCRYPTED,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
} from "./zip-format";

// Re-exported because `calculateCrc32` was part of this module's public surface
// before the primitives were split out.
export { calculateCrc32 };

/** The EOCD record can trail up to a 65535-byte comment. */
export const MAX_EOCD_SEARCH_SPAN = 65557;

/** Metadata for a single central-directory entry. */
export interface ZipEntryRecord {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isEncrypted: boolean;
}

export type ZipParseErrorCode =
  | "EMPTY_BUFFER"
  | "TOO_SMALL"
  | "EOCD_NOT_FOUND"
  | "CENTRAL_DIRECTORY_OUT_OF_BOUNDS"
  | "CENTRAL_DIRECTORY_CORRUPT"
  | "ENTRY_OUT_OF_BOUNDS"
  | "MALFORMED";

export interface ZipParseError {
  ok: false;
  code: ZipParseErrorCode;
  message: string;
}

export interface ZipParseSuccess {
  ok: true;
  entries: ZipEntryRecord[];
}

export type ZipParseResult = ZipParseSuccess | ZipParseError;

/** Where the central directory lives, resolved from an EOCD record. */
export interface ZipDirectoryLocation {
  ok: true;
  entryCount: number;
  centralOffset: number;
  centralSize: number;
}

export type ZipLocateResult = ZipDirectoryLocation | ZipParseError;

function error(code: ZipParseErrorCode, message: string): ZipParseError {
  return { ok: false, code, message };
}

function createReaders(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    readU16: (offset: number): number | null =>
      offset >= 0 && offset + 2 <= bytes.length ? view.getUint16(offset, true) : null,
    readU32: (offset: number): number | null =>
      offset >= 0 && offset + 4 <= bytes.length ? view.getUint32(offset, true) : null,
  };
}

/**
 * Locates the central directory from a buffer that contains the END of the
 * archive. `tailStart` is the absolute offset of `tailBytes[0]` in the archive,
 * so a ranged tail read resolves absolute central-directory coordinates.
 *
 * Total: never throws for any input.
 */
export function locateZipCentralDirectory(tailBytes: Uint8Array, tailStart = 0): ZipLocateResult {
  try {
    if (tailBytes.length === 0) {
      return error("EMPTY_BUFFER", "Recording package is empty.");
    }
    if (tailBytes.length < EOCD_MIN_SIZE) {
      return error("TOO_SMALL", "Recording package is too small to contain a zip directory.");
    }

    const { readU16, readU32 } = createReaders(tailBytes);
    const searchFloor = Math.max(0, tailBytes.length - MAX_EOCD_SEARCH_SPAN);

    let eocdOffset = -1;
    for (let offset = tailBytes.length - EOCD_MIN_SIZE; offset >= searchFloor; offset -= 1) {
      if (readU32(offset) === EOCD_SIGNATURE) {
        eocdOffset = offset;
        break;
      }
    }

    if (eocdOffset < 0) {
      return error("EOCD_NOT_FOUND", "Invalid recording package. Zip directory was not found.");
    }

    const entryCount = readU16(eocdOffset + 10);
    const centralSize = readU32(eocdOffset + 12);
    const centralOffset = readU32(eocdOffset + 16);
    if (entryCount === null || centralSize === null || centralOffset === null) {
      return error("EOCD_NOT_FOUND", "Invalid recording package. Zip directory is truncated.");
    }

    // A tail-only read cannot validate an offset that precedes the window; the
    // caller re-reads that range and `parseZipDirectoryEntries` validates it.
    if (tailStart === 0 && centralOffset + centralSize > tailBytes.length) {
      return error(
        "CENTRAL_DIRECTORY_OUT_OF_BOUNDS",
        "Invalid recording package. Central directory extends past the buffer.",
      );
    }

    return { ok: true, entryCount, centralOffset, centralSize };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown parsing failure.";
    return error("MALFORMED", `Recording package could not be parsed: ${message}`);
  }
}

/**
 * Parses `entryCount` central-directory headers out of a buffer that starts at
 * the first header. Total: never throws for any input.
 */
export function parseZipDirectoryEntries(
  directoryBytes: Uint8Array,
  entryCount: number,
): ZipParseResult {
  try {
    const { readU16, readU32 } = createReaders(directoryBytes);
    const decoder = new TextDecoder();
    const entries: ZipEntryRecord[] = [];
    let offset = 0;

    for (let index = 0; index < entryCount; index += 1) {
      if (offset + CENTRAL_DIRECTORY_HEADER_SIZE > directoryBytes.length) {
        return error(
          "CENTRAL_DIRECTORY_OUT_OF_BOUNDS",
          "Invalid recording package. Central directory extends past the buffer.",
        );
      }

      if (readU32(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
        return error(
          "CENTRAL_DIRECTORY_CORRUPT",
          "Invalid recording package. Central directory is corrupt.",
        );
      }

      const flags = readU16(offset + 8) as number;
      const compressionMethod = readU16(offset + 10) as number;
      const crc32 = readU32(offset + 16) as number;
      const compressedSize = readU32(offset + 20) as number;
      const uncompressedSize = readU32(offset + 24) as number;
      const fileNameLength = readU16(offset + 28) as number;
      const extraLength = readU16(offset + 30) as number;
      const commentLength = readU16(offset + 32) as number;
      const localHeaderOffset = readU32(offset + 42) as number;

      const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd > directoryBytes.length) {
        return error(
          "ENTRY_OUT_OF_BOUNDS",
          "Invalid recording package. Entry name extends past the buffer.",
        );
      }

      entries.push({
        name: decoder.decode(directoryBytes.subarray(nameStart, nameEnd)),
        flags,
        compressionMethod,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isEncrypted: (flags & ZIP_FLAG_ENCRYPTED) !== 0,
      });

      offset = nameEnd + extraLength + commentLength;
    }

    return { ok: true, entries };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown parsing failure.";
    return error("MALFORMED", `Recording package could not be parsed: ${message}`);
  }
}

/**
 * Whole-buffer convenience parse, behaviourally identical to the player's
 * `parseZipCentralDirectory`. Total: never throws for any input.
 */
export function parseZipCentralDirectory(bytes: Uint8Array): ZipParseResult {
  const located = locateZipCentralDirectory(bytes, 0);
  if (!located.ok) {
    return located;
  }
  return parseZipDirectoryEntries(
    bytes.subarray(located.centralOffset, located.centralOffset + located.centralSize),
    located.entryCount,
  );
}

/** Absolute payload span of an entry, read from its local file header. */
export interface ZipPayloadSpan {
  start: number;
  end: number;
}

/**
 * Resolves an entry's payload span from its local header bytes. The central
 * directory records a *local header* offset, and only the local header carries
 * the real name/extra lengths, so the payload cannot be located without it.
 */
export function resolveZipPayloadSpan(
  entry: ZipEntryRecord,
  localHeaderBytes: Uint8Array,
): ZipPayloadSpan | null {
  if (localHeaderBytes.length < LOCAL_FILE_HEADER_SIZE) {
    return null;
  }
  const { readU16, readU32 } = createReaders(localHeaderBytes);
  if (readU32(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    return null;
  }
  const nameLength = readU16(26);
  const extraLength = readU16(28);
  if (nameLength === null || extraLength === null) {
    return null;
  }
  const start = entry.localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
  return { start, end: start + entry.compressedSize };
}

export type ZipDecryptResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "MISSING_PASSWORD" | "WRONG_PASSWORD" | "TRUNCATED"; message: string };

/**
 * Decrypts a traditional ZipCrypto payload — the inverse of
 * `createZipEncryptedPayload` in the offscreen writer. The 12-byte header's last
 * byte holds the high CRC byte, which is the standard password check.
 */
export function decryptZipCryptoPayload(
  payload: Uint8Array,
  password: string,
  crc32: number,
): ZipDecryptResult {
  if (!password) {
    return {
      ok: false,
      code: "MISSING_PASSWORD",
      message: "Recording package is password protected. Provide the package password.",
    };
  }
  if (payload.length < ZIP_CRYPTO_HEADER_BYTES) {
    return { ok: false, code: "TRUNCATED", message: "Encrypted entry is truncated." };
  }

  const keys = createZipCryptoKeys(password);
  const plain = new Uint8Array(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    const decrypted = (payload[index] ^ getZipCryptoByte(keys)) & 0xff;
    updateZipCryptoKeys(keys, decrypted);
    plain[index] = decrypted;
  }

  if (plain[ZIP_CRYPTO_HEADER_BYTES - 1] !== ((crc32 >>> 24) & 0xff)) {
    return {
      ok: false,
      code: "WRONG_PASSWORD",
      message: "Package password is incorrect.",
    };
  }

  return { ok: true, bytes: plain.subarray(ZIP_CRYPTO_HEADER_BYTES) };
}

/** Expands a raw DEFLATE payload. Throws only if the payload is not valid DEFLATE. */
export async function inflateRawBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamCtor = globalThis.DecompressionStream;
  if (typeof DecompressionStreamCtor !== "function") {
    throw new Error("This runtime has no DecompressionStream; cannot read compressed entries.");
  }
  const source = new Response(toArrayBuffer(bytes)).body;
  if (!source) {
    throw new Error("Cannot stream compressed entry payload.");
  }
  const inflated = source.pipeThrough(new DecompressionStreamCtor("deflate-raw"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

/**
 * Turns a raw entry payload into its original bytes: decrypt (if protected),
 * then inflate (if deflated), then verify CRC.
 */
export async function decodeZipEntryPayload(
  entry: ZipEntryRecord,
  payload: Uint8Array,
  password = "",
): Promise<Uint8Array> {
  let bytes = payload;

  if (entry.isEncrypted) {
    const decrypted = decryptZipCryptoPayload(payload, password, entry.crc32);
    if (!decrypted.ok) {
      throw new ZipEntryError(decrypted.code, decrypted.message);
    }
    bytes = decrypted.bytes;
  }

  if (entry.compressionMethod === ZIP_METHOD_DEFLATE) {
    bytes = await inflateRawBytes(bytes);
  } else if (entry.compressionMethod !== ZIP_METHOD_STORE) {
    throw new ZipEntryError(
      "UNSUPPORTED_COMPRESSION",
      `Entry ${entry.name} uses unsupported compression method ${entry.compressionMethod}.`,
    );
  }

  if (entry.crc32 !== 0 && calculateCrc32(bytes) !== entry.crc32) {
    throw new ZipEntryError("CRC_MISMATCH", `Entry ${entry.name} failed its CRC check.`);
  }

  return bytes;
}

export type ZipEntryErrorCode =
  | "MISSING_PASSWORD"
  | "WRONG_PASSWORD"
  | "TRUNCATED"
  | "UNSUPPORTED_COMPRESSION"
  | "CRC_MISMATCH";

export class ZipEntryError extends Error {
  readonly code: ZipEntryErrorCode;

  constructor(code: ZipEntryErrorCode, message: string) {
    super(message);
    this.name = "ZipEntryError";
    this.code = code;
  }
}
