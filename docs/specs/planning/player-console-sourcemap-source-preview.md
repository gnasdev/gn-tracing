---
title: "Player Console Sourcemap Source Preview"
description: "Implemented source-map snippet enrichment and replay rendering for console details."
type: spec
status: implemented
tags: ["console", "sourcemap", "replay"]
source_paths:
  - "src/background/cdp-manager.ts"
  - "src/background/sourcemap-resolver.ts"
  - "src/background/storage-manager.ts"
  - "src/types/recording.ts"
  - "player/player.js"
  - "player/player.css"
related:
  - "../../modules/recording-runtime.md"
  - "../../modules/drive-and-player.md"
  - "../../shared/data-models.md"
---

# Player Console Sourcemap Source Preview

## Tổng Quan

Console replay artifacts can include bounded source snippets derived from sourcemap `sourcesContent` at capture stop time. The player renders those snippets in console detail views so the replay remains self-contained and does not fetch original sourcemaps or source files after the recording is shared.

When source content is unavailable, replay falls back to the source-mapped file, line, column, and stack labels.

## Capture Flow

1. `CdpManager` observes `Debugger.scriptParsed`, discovers sourcemap URLs, and asks `SourceMapResolver` to parse them.
2. `SourceMapResolver` preserves `sourcesContent` when present and can build a bounded `SourceCodeSnippet` around the resolved original line.
3. On stop, the service worker flushes pending sourcemaps before debugger detach.
4. `StorageManager.resolveSourceMaps(...)` enriches stored console entries and stack frames with resolved locations and optional snippets.
5. Serialized replay artifacts contain only resolved metadata and compact snippets, not full sourcemaps.

## Snippet Model

`SourceCodeSnippet` stores:

- original source path
- zero-based highlighted line and optional column
- zero-based start line for the snippet window
- nearby source lines
- truncation metadata when long lines or total snippet size are capped

The model is embedded on `ConsoleEntry`, `StackFrame`, and resolved locations where available.

## Player Rendering

The console detail panel chooses the best available snippet by preferring the entry snippet, then the first stack frame snippet. It renders a compact source preview with escaped code, line numbers, highlighted target line, and horizontal scrolling for long code.

Search includes snippet content so source text can help locate relevant console entries.

## Privacy And Size Rules

- Snippets are captured only from sourcemaps already observed during the active recording.
- Replay never fetches application source files, sourcemaps, or private app assets after the recording ends.
- Snippets are bounded by context line count, line length, and total character limits.
- Full source files are not stored in replay artifacts through this feature.

## Validation

- Recordings with `sourcesContent` should show source preview in console detail.
- Recordings without `sourcesContent` should still show source-mapped labels when available.
- Older recordings without snippet fields remain compatible.
- Player CSS and JS must be synced into standalone public assets after rendering changes.
