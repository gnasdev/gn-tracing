/**
 * Floating virtual scrollbar for the popup scroll surface.
 *
 * Chromium removed overlay scrollbars, so the native bar reserves layout
 * width inside the narrow popup. This module hides the native bar and
 * paints an absolutely-positioned thumb that floats above the content.
 *
 * Geometry helpers stay DOM-free so unit tests can drive them directly.
 */

/** Smallest usable thumb so short viewports keep a draggable target. */
const MIN_THUMB_HEIGHT = 24;

export type ScrollbarMetricsInput = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  trackHeight: number;
};

export type ScrollbarMetrics = {
  /** True only when content actually overflows the container. */
  visible: boolean;
  thumbHeight: number;
  /** Offset of the thumb top edge within the track, in px. */
  thumbTop: number;
};

/**
 * Maps scroll state onto thumb geometry. Thumb height mirrors the visible
 * fraction of the content (clamped to a minimum), and its position follows
 * scrollTop across the remaining track travel.
 */
export function computeScrollbarMetrics(input: ScrollbarMetricsInput): ScrollbarMetrics {
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
  if (maxScrollTop <= 0 || input.trackHeight <= 0) {
    return { visible: false, thumbHeight: 0, thumbTop: 0 };
  }

  const rawThumbHeight = (input.clientHeight / input.scrollHeight) * input.trackHeight;
  const thumbHeight = Math.min(input.trackHeight, Math.max(MIN_THUMB_HEIGHT, rawThumbHeight));
  const travel = Math.max(1, input.trackHeight - thumbHeight);
  const thumbTop = Math.min(travel, Math.max(0, (input.scrollTop / maxScrollTop) * travel));
  return { visible: true, thumbHeight, thumbTop };
}

export type VirtualScrollbarHandle = {
  /** Recompute thumb geometry from current scroll/layout state. */
  refresh: () => void;
  /** Remove listeners, observers, and the injected track element. */
  detach: () => void;
};

/**
 * Attaches a floating scrollbar to `container`, which must be a positioned
 * element that scrolls vertically. The returned handle is mostly for tests;
 * a popup lives as long as its document, so production code ignores it.
 */
export function attachVirtualScrollbar(container: HTMLElement): VirtualScrollbarHandle {
  const track = document.createElement("div");
  track.className = "gn-vscroll";
  const thumb = document.createElement("div");
  thumb.className = "gn-vscroll-thumb";
  track.append(thumb);
  container.append(track);

  let dragging = false;
  let dragStartOffsetY = 0;
  let dragStartScrollTop = 0;

  const metrics = (): ScrollbarMetrics =>
    computeScrollbarMetrics({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      trackHeight: track.clientHeight,
    });

  const sync = (): void => {
    const m = metrics();
    track.classList.toggle("is-visible", m.visible);
    if (!m.visible) {
      return;
    }
    thumb.style.height = `${Math.round(m.thumbHeight)}px`;
    thumb.style.transform = `translateY(${Math.round(m.thumbTop)}px)`;
  };

  const onScroll = (): void => sync();

  const onTrackPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const m = metrics();
    if (!m.visible) {
      return;
    }
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const maxScrollTop = container.scrollHeight - container.clientHeight;

    if (event.target === thumb) {
      dragging = true;
      dragStartOffsetY = offsetY;
      dragStartScrollTop = container.scrollTop;
      track.classList.add("is-dragging");
      thumb.setPointerCapture(event.pointerId);
      return;
    }

    // Track click: center the thumb under the pointer, like native bars.
    const travel = Math.max(1, track.clientHeight - m.thumbHeight);
    container.scrollTop = ((offsetY - m.thumbHeight / 2) / travel) * maxScrollTop;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const m = metrics();
    const travel = Math.max(1, track.clientHeight - m.thumbHeight);
    const delta = event.clientY - rect.top - dragStartOffsetY;
    container.scrollTop = dragStartScrollTop + (delta / travel) * maxScrollTop;
  };

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    track.classList.remove("is-dragging");
    if (thumb.hasPointerCapture(event.pointerId)) {
      thumb.releasePointerCapture(event.pointerId);
    }
    sync();
  };

  // Popup sections re-render via innerHTML / hidden toggles without resizing
  // the fixed-height container, so observe DOM mutations alongside layout.
  const resizeObserver = new ResizeObserver(sync);
  resizeObserver.observe(container);
  const mutationObserver = new MutationObserver(sync);
  mutationObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  container.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", sync);
  track.addEventListener("pointerdown", onTrackPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  sync();

  return {
    refresh: sync,
    detach: () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", sync);
      track.removeEventListener("pointerdown", onTrackPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      track.remove();
    },
  };
}
