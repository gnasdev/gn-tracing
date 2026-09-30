/**
 * Dependency-free ZIP writer for recording packages.
 *
 * Lifted out of the extension's offscreen document so the browser SDK can emit
 * the same container. It is the exact inverse of `../zip-reader.ts` and shares
 * that module's CRC32 and ZipCrypto keystream through `../zip-format.ts`.
 *
 * Two deliberate properties:
 *
 * - **Already-compressed media stays stored.** Video parts are WebM; running
 *   DEFLATE over them costs CPU and grows the file.
 * - **Output is a chunk list, not one buffer.** A package is mostly video, and
 *   concatenating hundreds of megabytes into a single contiguous `Uint8Array`
 *   is the kind of allocation that fails on a phone. Callers that hold a
 *   `Blob`-capable runtime should pass the chunks straight to `new Blob(...)`;
 *   `concatChunks` is there for the ones that genuinely need the bytes.
 */

import {
  calculateCrc32,
  createZipCryptoKeys,
  createZipTimestamp,
  getZipCryptoByte,
  toArrayBuffer,
  updateZipCryptoKeys,
  ZIP_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_CRYPTO_HEADER_BYTES,
  ZIP_EOCD_SIGNATURE,
  ZIP_FLAG_ENCRYPTED,
  ZIP_FLAG_UTF8,
  ZIP_LOCAL_FILE_HEADER_SIGNATURE,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
} from "../zip-format";

export interface ZipInputEntry {
  name: string;
  bytes: Uint8Array;
  /**
   * Override the filename/size heuristic. `"auto"` (the default) is what
   * producers want; the explicit values exist so tests can pin an entry to a
   * specific compression method and exercise the reader's handling of it.
   */
  compression?: "auto" | "store" | "deflate";
}

export interface BuildZipOptions {
  /** Stamped into every entry's DOS date/time field. */
  modifiedAt?: Date;
  /** Empty string means no encryption. */
  password?: string;
  /**
   * Source for the 12-byte ZipCrypto salt. Defaults to `crypto.getRandomValues`.
   * Tests inject a deterministic source; production must not.
   */
  randomBytes?: (length: number) => Uint8Array;
}

/** Entries whose payload is worth running DEFLATE over. */
export function shouldCompressZipEntry(name: string): boolean {
  return /\.(json|txt|csv|xml|html|css|js|map|svg)$/i.test(name);
}

/** Returns null when the runtime has no `CompressionStream` or DEFLATE fails. */
export async function deflateRawBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CompressionStreamCtor = globalThis.CompressionStream;
  if (typeof CompressionStreamCtor !== "function") {
    return null;
  }

  try {
    const source = new Response(toArrayBuffer(bytes)).body;
    if (!source) {
      return null;
    }
    const compressed = source.pipeThrough(new CompressionStreamCtor("deflate-raw"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  } catch {
    return null;
  }
}

function defaultRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This runtime has no crypto.getRandomValues; cannot protect a package.");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Traditional ZipCrypto entry encryption, so a downloaded archive prompts for
 * the password in ordinary unzip tools. The salt's last byte carries the high
 * CRC byte, which is how the reader checks the password.
 */
export function createZipEncryptedPayload(
  bytes: Uint8Array,
  password: string,
  crc32: number,
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Uint8Array {
  const keys = createZipCryptoKeys(password);
  const header = randomBytes(ZIP_CRYPTO_HEADER_BYTES);
  if (header.length !== ZIP_CRYPTO_HEADER_BYTES) {
    throw new Error("ZipCrypto salt must be exactly 12 bytes.");
  }
  header[ZIP_CRYPTO_HEADER_BYTES - 1] = (crc32 >>> 24) & 0xff;

  const encrypted = new Uint8Array(header.length + bytes.length);
  for (let index = 0; index < header.length; index += 1) {
    encrypted[index] = header[index] ^ getZipCryptoByte(keys);
    updateZipCryptoKeys(keys, header[index]);
  }
  for (let index = 0; index < bytes.length; index += 1) {
    encrypted[header.length + index] = bytes[index] ^ getZipCryptoByte(keys);
    updateZipCryptoKeys(keys, bytes[index]);
  }

  return encrypted;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * Writes the archive. Entry order is preserved, which matters: the reader pulls
 * small artifacts by byte range, so a producer should place them before the
 * video parts.
 */
export async function buildZipArchive(
  entries: ZipInputEntry[],
  options: BuildZipOptions = {},
): Promise<Uint8Array[]> {
  const encoder = new TextEncoder();
  const timestamp = createZipTimestamp(options.modifiedAt ?? new Date(0));
  const password = options.password ?? "";
  const shouldEncrypt = password.length > 0;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  const chunks: Uint8Array[] = [];
  const centralDirectory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const safeName = entry.name.replace(/^\/+/, "");
    if (!safeName || safeName.includes("..")) {
      throw new Error(`Invalid zip entry name: ${entry.name}`);
    }

    const nameBytes = encoder.encode(safeName);
    const bytes = entry.bytes;
    const crc32 = calculateCrc32(bytes);
    const mode = entry.compression ?? "auto";
    const compressed =
      mode === "deflate" || (mode === "auto" && shouldCompressZipEntry(safeName))
        ? await deflateRawBytes(bytes)
        : null;
    // DEFLATE is lossless but its headers can make a tiny file bigger. Store
    // those so a package is never larger than the uncompressed equivalent —
    // unless the caller explicitly asked for DEFLATE.
    const payloadBytes =
      compressed && (mode === "deflate" || compressed.byteLength < bytes.byteLength)
        ? compressed
        : bytes;
    const compressionMethod = payloadBytes === bytes ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
    const payload = shouldEncrypt
      ? createZipEncryptedPayload(payloadBytes, password, crc32, randomBytes)
      : payloadBytes;
    const flags = ZIP_FLAG_UTF8 | (shouldEncrypt ? ZIP_FLAG_ENCRYPTED : 0);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    u32(localView, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    u16(localView, 4, 20);
    u16(localView, 6, flags);
    u16(localView, 8, compressionMethod);
    u16(localView, 10, timestamp.time);
    u16(localView, 12, timestamp.date);
    u32(localView, 14, crc32);
    u32(localView, 18, payload.length);
    u32(localView, 22, bytes.length);
    u16(localView, 26, nameBytes.length);
    u16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    chunks.push(localHeader, payload);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    u32(centralView, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, flags);
    u16(centralView, 10, compressionMethod);
    u16(centralView, 12, timestamp.time);
    u16(centralView, 14, timestamp.date);
    u32(centralView, 16, crc32);
    u32(centralView, 20, payload.length);
    u32(centralView, 24, bytes.length);
    u16(centralView, 28, nameBytes.length);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, offset);
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.byteLength + payload.length;
  }

  const centralDirectorySize = centralDirectory.reduce((sum, part) => sum + part.byteLength, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  u32(endView, 0, ZIP_EOCD_SIGNATURE);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralDirectorySize);
  u32(endView, 16, offset);
  u16(endView, 20, 0);

  return [...chunks, ...centralDirectory, endRecord];
}

/** Flattens the chunk list. Only for callers that can hold the whole package. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
