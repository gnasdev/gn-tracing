/**
 * Resolves generated stack frames back to original source locations.
 */
import type { SourceMapRaw, ResolvedLocation } from "../types/recording";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const charToInt = new Uint8Array(128);
for (let i = 0; i < BASE64.length; i++) {
  charToInt[BASE64.charCodeAt(i)] = i;
}

// Source maps encode generated-to-original locations as base64 VLQ deltas.
// Decoding keeps running state per line, so the parser mirrors the source map v3
// format instead of treating each segment as absolute coordinates.
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

function parseMap(raw: SourceMapRaw): ParsedMap | null {
  if (!raw || raw.version !== 3) return null;

  if (raw.mappings) {
    const sourceRoot = raw.sourceRoot || "";
    return {
      sources: (raw.sources || []).map((s) => sourceRoot + s),
      names: raw.names || [],
      mappings: decodeMappings(raw.mappings),
    };
  }

  if (!raw.sections?.length) return null;

  const parsed: ParsedMap = {
    sources: [],
    names: [],
    mappings: [],
  };

  for (const section of raw.sections) {
    if (!section.map) continue;
    const child = parseMap(section.map);
    if (!child) continue;

    const sourceOffset = parsed.sources.length;
    const nameOffset = parsed.names.length;
    parsed.sources.push(...child.sources);
    parsed.names.push(...child.names);

    const lineOffset = section.offset?.line || 0;
    const columnOffset = section.offset?.column || 0;
    child.mappings.forEach((segments, childLine) => {
      const targetLine = lineOffset + childLine;
      if (!parsed.mappings[targetLine]) {
        parsed.mappings[targetLine] = [];
      }

      for (const segment of segments) {
        const shifted = [...segment];
        shifted[0] += childLine === 0 ? columnOffset : 0;
        if (shifted.length >= 4) {
          shifted[1] += sourceOffset;
        }
        if (shifted.length >= 5) {
          shifted[4] += nameOffset;
        }
        parsed.mappings[targetLine].push(shifted);
      }
    });
  }

  for (const segments of parsed.mappings) {
    segments?.sort((a, b) => a[0] - b[0]);
  }

  return parsed;
}

export class SourceMapResolver {
  /**
   * Minimal source-map resolver used during stop-time enrichment.
   *
   * It stores parsed maps by generated script URL and resolves the closest
   * mapping segment at or before the generated column. The implementation stays
   * intentionally small because recordings only need line/column/source labels,
   * not full source-map consumer features.
   */
  #maps = new Map<string, ParsedMap>();

  addMap(scriptUrl: string, raw: SourceMapRaw): void {
    const parsed = parseMap(raw);
    if (!parsed) return;
    this.#maps.set(scriptUrl, parsed);
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
