/**
 * ZIP central-directory parser (importable, total, non-throwing).
 *
 * The standalone player loads recording packages that are ZIP archives. The
 * runtime decoder lives in `public/player.js` (`unzipStoredPackage`), but that
 * implementation is a vanilla, non-importable script that *throws* on malformed
 * input. This module extracts the structural central-directory parsing into a
 * pure, importable function that returns a typed result/error union instead of
 * throwing, so callers (and tests) can reason about malformed input safely.
 *
 * The byte-layout logic mirrors `unzipStoredPackage` in `public/player.js`:
 * locate the End Of Central Directory (EOCD) record, read the entry count and
 * central-directory offset, then walk each central-directory header reading its
 * metadata. It deliberately performs only the synchronous structural parse (no
 * decompression, decryption, or CRC validation) so it is total over every
 * possible byte buffer.
 *
 * Property 9 (ZIP/CRC parsing safety): for ANY byte buffer this function returns
 * either a valid entry list or a typed error value and never throws an uncaught
 * exception.
 */

// ZIP record signatures (little-endian), matching the writer in
// `src/offscreen/offscreen.ts` and the reader in `public/player.js`.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

// General-purpose bit flag: bit 0 marks an encrypted entry.
const ZIP_FLAG_ENCRYPTED = 0x0001;

// Fixed sizes of the records we parse.
const EOCD_MIN_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;

// The EOCD record may be followed by a variable-length comment of up to 65535
// bytes, so the signature can sit at most (65535 + 22) bytes from the end.
const MAX_EOCD_SEARCH_SPAN = 65557;

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

/** Discriminated error codes for malformed/unparseable buffers. */
export type ZipParseErrorCode =
  | "EMPTY_BUFFER"
  | "TOO_SMALL"
  | "EOCD_NOT_FOUND"
  | "CENTRAL_DIRECTORY_OUT_OF_BOUNDS"
  | "CENTRAL_DIRECTORY_CORRUPT"
  | "ENTRY_OUT_OF_BOUNDS"
  | "MALFORMED";

/** Typed error returned for empty, truncated, or malformed buffers. */
export interface ZipParseError {
  ok: false;
  code: ZipParseErrorCode;
  message: string;
}

/** Successful parse: the ordered list of central-directory entries. */
export interface ZipParseSuccess {
  ok: true;
  entries: ZipEntryRecord[];
}

export type ZipParseResult = ZipParseSuccess | ZipParseError;

function error(code: ZipParseErrorCode, message: string): ZipParseError {
  return { ok: false, code, message };
}

/**
 * Parse the central directory of a ZIP byte buffer.
 *
 * Total function: returns a {@link ZipParseSuccess} for a structurally valid
 * archive or a {@link ZipParseError} for any empty, truncated, or malformed
 * buffer. Never throws for any input.
 */
export function parseZipCentralDirectory(bytes: Uint8Array): ZipParseResult {
  try {
    if (bytes.length === 0) {
      return error("EMPTY_BUFFER", "Recording package is empty.");
    }
    if (bytes.length < EOCD_MIN_SIZE) {
      return error("TOO_SMALL", "Recording package is too small to contain a zip directory.");
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();

    // Bounds-checked little-endian readers so an out-of-range read yields a
    // typed error instead of a thrown RangeError.
    const readU16 = (offset: number): number | null =>
      offset >= 0 && offset + 2 <= bytes.length ? view.getUint16(offset, true) : null;
    const readU32 = (offset: number): number | null =>
      offset >= 0 && offset + 4 <= bytes.length ? view.getUint32(offset, true) : null;

    // Locate the EOCD signature by scanning backwards from the latest position
    // it could occupy, bounded by the maximum comment span.
    let eocdOffset = -1;
    const searchFloor = Math.max(0, bytes.length - MAX_EOCD_SEARCH_SPAN);
    for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= searchFloor; offset -= 1) {
      if (readU32(offset) === EOCD_SIGNATURE) {
        eocdOffset = offset;
        break;
      }
    }

    if (eocdOffset < 0) {
      return error("EOCD_NOT_FOUND", "Invalid recording package. Zip directory was not found.");
    }

    const entryCount = readU16(eocdOffset + 10);
    let centralOffset = readU32(eocdOffset + 16);
    if (entryCount === null || centralOffset === null) {
      return error("EOCD_NOT_FOUND", "Invalid recording package. Zip directory is truncated.");
    }

    const entries: ZipEntryRecord[] = [];

    for (let index = 0; index < entryCount; index += 1) {
      if (centralOffset + CENTRAL_DIRECTORY_HEADER_SIZE > bytes.length) {
        return error(
          "CENTRAL_DIRECTORY_OUT_OF_BOUNDS",
          "Invalid recording package. Central directory extends past the buffer.",
        );
      }

      if (readU32(centralOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
        return error(
          "CENTRAL_DIRECTORY_CORRUPT",
          "Invalid recording package. Central directory is corrupt.",
        );
      }

      const flags = readU16(centralOffset + 8) as number;
      const compressionMethod = readU16(centralOffset + 10) as number;
      const crc32 = readU32(centralOffset + 16) as number;
      const compressedSize = readU32(centralOffset + 20) as number;
      const uncompressedSize = readU32(centralOffset + 24) as number;
      const fileNameLength = readU16(centralOffset + 28) as number;
      const extraLength = readU16(centralOffset + 30) as number;
      const commentLength = readU16(centralOffset + 32) as number;
      const localHeaderOffset = readU32(centralOffset + 42) as number;

      const nameStart = centralOffset + CENTRAL_DIRECTORY_HEADER_SIZE;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd > bytes.length) {
        return error(
          "ENTRY_OUT_OF_BOUNDS",
          "Invalid recording package. Entry name extends past the buffer.",
        );
      }

      const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
      const isEncrypted = (flags & ZIP_FLAG_ENCRYPTED) !== 0;

      entries.push({
        name,
        flags,
        compressionMethod,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isEncrypted,
      });

      centralOffset += CENTRAL_DIRECTORY_HEADER_SIZE + fileNameLength + extraLength + commentLength;
    }

    return { ok: true, entries };
  } catch (cause) {
    // Safety net: no byte buffer should ever produce an uncaught exception.
    const message = cause instanceof Error ? cause.message : "Unknown parsing failure.";
    return error("MALFORMED", `Recording package could not be parsed: ${message}`);
  }
}
