/**
 * Phosphor icon helpers for extension UI (icon font via icons/phosphor-icons.css).
 *
 * Keep names aligned with the player (`ph ph-*` classes) so surfaces stay consistent.
 */

/** Render a Phosphor icon element as HTML. */
export function phIcon(name: string, extraClass = ""): string {
  const classes = ["ph", `ph-${name}`, extraClass].filter(Boolean).join(" ");
  return `<i class="${classes}" aria-hidden="true"></i>`;
}

/** Common UI icons used across popup / history / shared surfaces. */
export const Icons = {
  feedback: () => phIcon("chat-circle-dots"),
  gear: () => phIcon("gear"),
  record: () => phIcon("record"),
  stop: () => phIcon("stop"),
  check: () => phIcon("check"),
  camera: () => phIcon("camera"),
  trash: () => phIcon("trash"),
  clockCounterClockwise: () => phIcon("clock-counter-clockwise"),
  power: () => phIcon("power"),
  pencil: () => phIcon("pencil-simple"),
  list: () => phIcon("list"),
  upload: () => phIcon("upload-simple"),
  cloudArrowUp: () => phIcon("cloud-arrow-up"),
  lock: () => phIcon("lock"),
  x: () => phIcon("x"),
  cloud: () => phIcon("cloud"),
  play: () => phIcon("play-circle"),
  folder: () => phIcon("folder-open"),
  copy: () => phIcon("copy"),
  desktop: () => phIcon("desktop"),
  sun: () => phIcon("sun"),
  moon: () => phIcon("moon"),
} as const;
