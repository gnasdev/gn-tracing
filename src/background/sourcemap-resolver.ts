import type { SourceMapRaw, ResolvedLocation } from "../types/recording";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const charToInt = new Uint8Array(128);
for (let i = 0; i < BASE64.length; i++) {
  charToInt[BASE64.charCodeAt(i)] = i;
}

function decodeVLQ(str: string, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < str.length) {
    const c = charToInt[str.charCodeAt(i++)];
    value += (c & 31) << shift;
    shift += 5;
    if ((c & 32) === 0) break;
  }
  return { value: (value & 1) ? -(value >> 1) : (value >> 1), next: i };
}

function decodeMappings(mappingsStr: string): number[][][] {
  const lines: number[][][] = [];
  let srcFile = 0, srcLine = 0, srcCol = 0, nameIdx = 0;

  for (const lineStr of mappingsStr.split(";")) {
    const segments: number[][] = [];
    let genCol = 0;
    let i = 0;

    while (i < lineStr.length) {
      if (lineStr[i] === ",") { i++; continue; }

      const seg: number[] = [];

      let d = decodeVLQ(lineStr, i);
      genCol += d.value;
      seg.push(genCol);
      i = d.next;

      if (i < lineStr.length && lineStr[i] !== "," && lineStr[i] !== ";") {
        d = decodeVLQ(lineStr, i);
        srcFile += d.value;
        seg.push(srcFile);
        i = d.next;

        d = decodeVLQ(lineStr, i);
        srcLine += d.value;
        seg.push(srcLine);
        i = d.next;

        d = decodeVLQ(lineStr, i);
        srcCol += d.value;
        seg.push(srcCol);
        i = d.next;

        if (i < lineStr.length && lineStr[i] !== "," && lineStr[i] !== ";") {
          d = decodeVLQ(lineStr, i);
          nameIdx += d.value;
          seg.push(nameIdx);
          i = d.next;
        }
      }

      segments.push(seg);
    }

    lines.push(segments);
  }

  return lines;
}

interface ParsedMap {
  sources: string[];
  names: string[];
  mappings: number[][][];
}

export class SourceMapResolver {
  #maps = new Map<string, ParsedMap>();

  addMap(scriptUrl: string, raw: SourceMapRaw): void {
    if (!raw || raw.version !== 3 || !raw.mappings) return;
    const sourceRoot = raw.sourceRoot || "";
    const sources = (raw.sources || []).map((s) => sourceRoot + s);
    const names = raw.names || [];
    const mappings = decodeMappings(raw.mappings);
    this.#maps.set(scriptUrl, { sources, names, mappings });
  }

  resolve(url: string, line: number, column: number): ResolvedLocation | null {
    const map = this.#maps.get(url);
    if (!map) return null;
    if (line < 0 || line >= map.mappings.length) return null;

    const segments = map.mappings[line];
    if (!segments || segments.length === 0) return null;

    let lo = 0, hi = segments.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid][0] <= column) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best < 0) return null;
    const seg = segments[best];
    if (seg.length < 4) return null;

    return {
      source: map.sources[seg[1]] || null,
      line: seg[2],
      column: seg[3],
      name: seg.length >= 5 ? (map.names[seg[4]] || null) : null,
    };
  }

  get size(): number {
    return this.#maps.size;
  }

  clear(): void {
    this.#maps.clear();
  }
}
