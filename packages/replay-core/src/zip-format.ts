/**
 * ZIP wire-format primitives shared by the reader and the writer.
 *
 * These lived twice — once in `./zip-reader.ts` and once in the extension's
 * offscreen packager — which is exactly the kind of duplication that eventually
 * produces a package one side can write and the other cannot read. CRC32 and
 * the ZipCrypto keystream in particular must agree bit for bit: the writer seeds
 * the keystream with a password and the reader replays it, so a divergence
 * surfaces only as "wrong password" on a package with the right password.
 *
 * Runtime floor: browsers, Node 18+, and workerd. No DOM, no `chrome.*`.
 */

export const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
export const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
export const ZIP_EOCD_SIGNATURE = 0x06054b50;

export const ZIP_FLAG_ENCRYPTED = 0x0001;
export const ZIP_FLAG_UTF8 = 0x0800;

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

export const ZIP_EOCD_MIN_SIZE = 22;
export const ZIP_CENTRAL_DIRECTORY_HEADER_SIZE = 46;
export const ZIP_LOCAL_FILE_HEADER_SIZE = 30;
export const ZIP_CRYPTO_HEADER_BYTES = 12;

/**
 * A `Uint8Array` can be a view into a larger buffer, so handing `.buffer` to an
 * API that wants an `ArrayBuffer` would pass the neighbours too. Always copy the
 * exact span.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

export function updateCrc32Value(crc: number, byte: number): number {
  return (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

export function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = updateCrc32Value(crc, byte);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipCryptoKeys = [number, number, number];

export function createZipCryptoKeys(password: string): ZipCryptoKeys {
  const keys: ZipCryptoKeys = [0x12345678, 0x23456789, 0x34567890];
  for (const byte of new TextEncoder().encode(password)) {
    updateZipCryptoKeys(keys, byte);
  }
  return keys;
}

export function updateZipCryptoKeys(keys: ZipCryptoKeys, byte: number): void {
  keys[0] = updateCrc32Value(keys[0], byte);
  keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0;
  keys[2] = updateCrc32Value(keys[2], keys[1] >>> 24);
}

export function getZipCryptoByte(keys: ZipCryptoKeys): number {
  const temp = (keys[2] | 2) >>> 0;
  return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
}

/**
 * DOS date/time as stored in a ZIP header. Seconds have 2-second resolution and
 * the epoch is 1980, both of which are the format's constraints, not ours.
 */
export function createZipTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}
