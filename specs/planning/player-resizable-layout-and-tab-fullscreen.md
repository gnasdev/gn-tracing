# Player Resizable Layout And Tab Fullscreen

## Context

- Requested scope is limited to the replay player UI under `player/*`, with synced standalone assets under `player-standalone/public/*`.
- Current player layout is a fixed 2-column grid with no persisted layout preferences, no draggable splitter, and no container-level fullscreen mode.
- `specs/_sync.md` is behind current HEAD and must be refreshed when implementation lands.

## Goals

1. Add a draggable splitter between the video pane and the log/spec pane.
2. Persist pane size as a percent in `localStorage`.
3. Allow switching between horizontal and vertical layout orientations.
4. Add video fullscreen for the player tab container only (browser fullscreen API on the video pane/container, not OS/screen fullscreen).

## Proposed Implementation

### 1. Player layout state

- Introduce persisted UI state in `player/player.js`:
  - `layoutMode`: `horizontal` | `vertical`
  - `splitPercent`: numeric percent for the primary pane size
  - `isTabFullscreen`: derived runtime state only
- Store state in `localStorage` with safe parsing and clamped defaults:
  - horizontal default `50`
  - vertical default `55`

### 2. DOM changes

- Add a compact layout toolbar near the tab area or video controls with:
  - horizontal layout toggle
  - vertical layout toggle
  - fullscreen toggle for the video pane container
- Insert an explicit splitter element between the video pane and logs pane for pointer dragging and keyboard accessibility.

### 3. Styling changes

- Convert `.main-layout` from fixed columns into CSS-variable-driven layout.
- Support both modes with a root attribute/class:
  - horizontal: `grid-template-columns: <video>% <splitter> auto`
  - vertical: `grid-template-rows: <video>% <splitter> auto`
- Add visual affordances for splitter hover/dragging and keep small-screen behavior usable.
- Make fullscreen mode expand only the player video section container inside the current tab using the Fullscreen API pseudo-classes.

### 4. Interaction wiring

- Implement pointer drag handlers on the splitter with min/max clamping to avoid collapsing panes.
- Persist updated percent after drag and after layout switch.
- Restore saved layout state during init before first render.
- Wire fullscreen button to `requestFullscreen()` / `exitFullscreen()` on the video section container and keep button icon/state in sync via `fullscreenchange`.

### 5. Standalone sync and specs

- Run `player-standalone/scripts/sync-player.js` after updating `player/*`.
- Refresh `specs/modules/drive-and-player.md` with the new persisted player layout/fullscreen behavior.
- Refresh `specs/_sync.md` to current HEAD snapshot after code/spec updates.
- Rebuild `graphify-out/` graph after code edits per repo instruction.

## Risks / Checks

- Drag handling must not interfere with video progress dragging.
- Fullscreen target should remain the video pane only, so logs/spec pane does not expand with it.
- Orientation switch must preserve a sane percent even when old persisted values came from the other axis.
- Need to keep extension player and standalone player assets aligned via sync script.
