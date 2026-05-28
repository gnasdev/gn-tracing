/**
 * Resolves generated stack frames back to original source locations.
 */
import type {
  ResolvedLocation,
  SourceCodeSnippet,
  SourceMapRaw,
  SourceMapResolveResult,
} from "../types/recording";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SOURCE_SNIPPET_CONTEXT_LINES = 3;
const SOURCE_SNIPPET_MAX_LINE_LENGTH = 500;
const SOURCE_SNIPPET_MAX_TOTAL_CHARS = 6000;
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
  return { value: value & 1 ? -(value >> 1) : value >> 1, next: i };
}

function decodeMappings(mappingsStr: string): number[][][] {
  const lines: number[][][] = [];
  let srcFile = 0,
    srcLine = 0,
    srcCol = 0,
    nameIdx = 0;

  for (const lineStr of mappingsStr.split(";")) {
    const segments: number[][] = [];
    let genCol = 0;
    let i = 0;

    while (i < lineStr.length) {
      if (lineStr[i] === ",") {
        i++;
        continue;
      }

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
  sourcesContent: Array<string | null | undefined>;
  names: string[];
  mappings: number[][][];
}

export function getSourceMapUrlKeys(url: string): string[] {
  const keys = new Set<string>();
  if (!url) return [];
  keys.add(url);

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    keys.add(parsed.href);

    if (parsed.search) {
      const withoutQuery = new URL(parsed.href);
      withoutQuery.search = "";
      keys.add(withoutQuery.href);
    }
  } catch {
    const hashIndex = url.indexOf("#");
    if (hashIndex >= 0) {
      keys.add(url.slice(0, hashIndex));
    }
  }

  return Array.from(keys);
}

function parseMap(raw: SourceMapRaw): ParsedMap | null {
  if (!raw || raw.version !== 3) return null;

  if (raw.mappings) {
    const sourceRoot = raw.sourceRoot || "";
    return {
      sources: (raw.sources || []).map((s) => sourceRoot + s),
      sourcesContent: raw.sourcesContent || [],
      names: raw.names || [],
      mappings: decodeMappings(raw.mappings),
    };
  }

  if (!raw.sections?.length) return null;

  const parsed: ParsedMap = {
    sources: [],
    sourcesContent: [],
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
    parsed.sourcesContent.push(...child.sourcesContent);
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

function truncateSnippetLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= SOURCE_SNIPPET_MAX_LINE_LENGTH) {
    return { text: line, truncated: false };
  }
  return {
    text: `${line.slice(0, SOURCE_SNIPPET_MAX_LINE_LENGTH)}...(truncated)`,
    truncated: true,
  };
}

function readSourceSnippetLines(
  content: string,
  startLine: number,
  endLine: number,
  targetLine: number,
): string[] | null {
  const lines: string[] = [];
  let currentLine = 0;
  let lineStart = 0;
  let sawTargetLine = false;

  for (let i = 0; i <= content.length; i++) {
    let isLineBreak = i === content.length;
    let lineEnd = i;

    if (!isLineBreak) {
      const char = content[i];
      if (char === "\r" || char === "\n") {
        isLineBreak = true;
        if (char === "\r" && content[i + 1] === "\n") {
          lineEnd = i;
          i++;
        }
      }
    }

    if (!isLineBreak) {
      continue;
    }

    if (currentLine === targetLine) {
      sawTargetLine = true;
    }
    if (currentLine >= startLine && currentLine < endLine) {
      lines.push(content.slice(lineStart, lineEnd));
    }
    if (currentLine >= endLine) {
      break;
    }

    currentLine++;
    lineStart = i + 1;
  }

  return sawTargetLine ? lines : null;
}

function buildSourceSnippet(
  source: string,
  content: string | null | undefined,
  line: number,
  column: number,
): SourceCodeSnippet | undefined {
  if (typeof content !== "string" || line < 0) {
    return undefined;
  }

  const startLine = Math.max(0, line - SOURCE_SNIPPET_CONTEXT_LINES);
  const endLine = line + SOURCE_SNIPPET_CONTEXT_LINES + 1;
  let truncated = false;
  let totalChars = 0;

  // Store only the few lines needed to explain the captured stack frame. The
  // full file can be large or sensitive, so replay artifacts should not embed it.
  const sourceLines = readSourceSnippetLines(content, startLine, endLine, line);
  if (!sourceLines) {
    return undefined;
  }

  const lines: string[] = [];
  for (const sourceLine of sourceLines) {
    const result = truncateSnippetLine(sourceLine);
    truncated = truncated || result.truncated;
    const remainingChars = SOURCE_SNIPPET_MAX_TOTAL_CHARS - totalChars;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const suffix = "...(truncated)";
    const text =
      result.text.length > remainingChars
        ? remainingChars > suffix.length
          ? `${result.text.slice(0, remainingChars - suffix.length)}${suffix}`
          : suffix.slice(0, remainingChars)
        : result.text;
    truncated = truncated || text !== result.text;
    totalChars += text.length;
    lines.push(text);
  }

  return {
    source,
    startLine,
    line,
    column,
    lines,
    truncated: truncated || undefined,
  };
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

  addMap(scriptUrl: string, raw: SourceMapRaw): boolean {
    const parsed = parseMap(raw);
    if (!parsed) return false;
    for (const key of getSourceMapUrlKeys(scriptUrl)) {
      this.#maps.set(key, parsed);
    }
    return true;
  }

  resolve(url: string, line: number, column: number): ResolvedLocation | null {
    const result = this.resolveWithStatus(url, line, column);
    return result.status === "mapped" ? (result.location ?? null) : null;
  }

  resolveWithStatus(url: string, line: number, column: number): SourceMapResolveResult {
    const map = getSourceMapUrlKeys(url)
      .map((key) => this.#maps.get(key))
      .find(Boolean);
    if (!map) return { status: "no-map-for-generated-url" };
    if (line < 0 || line >= map.mappings.length) return { status: "no-generated-line" };

    const segments = map.mappings[line];
    if (!segments || segments.length === 0) return { status: "no-segment-for-column" };

    let lo = 0,
      hi = segments.length - 1,
      best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid][0] <= column) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best < 0) return { status: "no-segment-for-column" };
    const seg = segments[best];
    if (seg.length < 4) return { status: "no-original-segment" };

    return {
      status: "mapped",
      location: {
        source: map.sources[seg[1]] || null,
        line: seg[2],
        column: seg[3],
        name: seg.length >= 5 ? map.names[seg[4]] || null : null,
        sourceSnippet: map.sources[seg[1]]
          ? buildSourceSnippet(map.sources[seg[1]], map.sourcesContent[seg[1]], seg[2], seg[3])
          : undefined,
      },
    };
  }

  get size(): number {
    return this.#maps.size;
  }

  clear(): void {
    this.#maps.clear();
  }
}
