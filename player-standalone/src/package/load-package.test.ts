import { describe, expect, it } from "vitest";
import { unzipPackage } from "../lib/zip-open";

/** Minimal store-method ZIP with one empty file "hello.txt". */
function makeStoreZip(name: string, content: string): Blob {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(content);
  const localHeader = new ArrayBuffer(30 + nameBytes.length);
  const lh = new DataView(localHeader);
  lh.setUint32(0, 0x04034b50, true);
  lh.setUint16(8, 0, true); // method store
  lh.setUint16(26, nameBytes.length, true);
  lh.setUint16(28, 0, true);
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  local.set(new Uint8Array(localHeader), 0);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new ArrayBuffer(46 + nameBytes.length);
  const ch = new DataView(central);
  ch.setUint32(0, 0x02014b50, true);
  ch.setUint16(10, 0, true);
  ch.setUint32(16, 0, true); // crc
  ch.setUint32(20, data.length, true);
  ch.setUint32(24, data.length, true);
  ch.setUint16(28, nameBytes.length, true);
  ch.setUint32(42, 0, true); // local header offset
  const centralBytes = new Uint8Array(46 + nameBytes.length);
  centralBytes.set(new Uint8Array(central), 0);
  centralBytes.set(nameBytes, 46);

  const eocd = new ArrayBuffer(22);
  const eh = new DataView(eocd);
  eh.setUint32(0, 0x06054b50, true);
  eh.setUint16(8, 1, true);
  eh.setUint16(10, 1, true);
  eh.setUint32(12, centralBytes.length, true);
  eh.setUint32(16, local.length, true);

  return new Blob([local, centralBytes, new Uint8Array(eocd)]);
}

describe("unzipPackage", () => {
  it("reads a store-method ZIP entry", async () => {
    const blob = makeStoreZip("hello.txt", "hi");
    const result = await unzipPackage(blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = new TextDecoder().decode(result.files.get("hello.txt"));
    expect(text).toBe("hi");
  });
});
