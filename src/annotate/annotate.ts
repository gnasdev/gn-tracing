/**
 * The screenshot annotation editor page.
 *
 * Thin by design: state lives in `./editor-model.ts` and drawing lives in the
 * core's SVG renderer, so this file is pointer events, keyboard shortcuts, and
 * the save handshake with the service worker.
 *
 * Using the core renderer rather than a canvas of its own is what guarantees
 * the arrow the reporter positions is the arrow the player draws. Two renderers
 * would drift, and the drift would be invisible until someone pointed at the
 * wrong button in a bug report.
 */

import { describeAnnotation } from "../../packages/replay-core/src/annotate/describe";
import { renderAnnotationsSvg } from "../../packages/replay-core/src/annotate/svg";
import type {
  Annotation,
  NormalizedPoint,
  Screenshot,
} from "../../packages/replay-core/src/schema/annotation";
import { setButtonLoading } from "../shared/button-loading";
import {
  assertReadyToSave,
  createShape,
  EditorHistory,
  type EditorTool,
  hitTest,
} from "./editor-model";

const ANNOTATE_COPY = {
  en: {
    emptyShapes: "Nothing annotated yet.",
    packaging: "Packaging and uploading…",
    uploaded: "Uploaded. Opening the replay…",
    ready: "Draw on the screenshot, then save.",
    readyIr: "Annotate this Instant Replay still, then save to upload the lookback package.",
    noPending: "No screenshot is waiting to be annotated.",
    uploadFailed: "Upload failed.",
    titleScreenshot: "Annotate screenshot",
    titleIr: "Annotate Instant Replay",
    defaultCaptionIr: "Instant Replay capture",
  },
  vi: {
    emptyShapes: "Chưa có chú thích.",
    packaging: "Đang đóng gói và tải lên…",
    uploaded: "Đã tải lên. Đang mở replay…",
    ready: "Vẽ trên ảnh chụp, rồi lưu.",
    readyIr: "Chú thích ảnh Instant Replay này, rồi lưu để upload gói lookback.",
    noPending: "Không có ảnh chụp nào đang chờ chú thích.",
    uploadFailed: "Tải lên thất bại.",
    titleScreenshot: "Chú thích ảnh chụp",
    titleIr: "Chú thích Instant Replay",
    defaultCaptionIr: "Instant Replay capture",
  },
} as const;

function annotateLang(): "en" | "vi" {
  const lang = document.documentElement.lang?.toLowerCase() || "en";
  return lang.startsWith("vi") ? "vi" : "en";
}

function annotateT<K extends keyof (typeof ANNOTATE_COPY)["en"]>(key: K): string {
  return ANNOTATE_COPY[annotateLang()][key];
}

interface PendingScreenshot {
  id: string;
  imageDataUrl: string;
  capturedAt: number;
  url?: string;
  title?: string;
  viewport: { width: number; height: number; devicePixelRatio?: number };
  kind?: "screenshot" | "instant-replay";
}

const TOOL_SHORTCUTS: Record<string, EditorTool> = {
  v: "select",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  p: "freehand",
  t: "text",
  h: "highlight",
  x: "redact",
};

(() => {
  const elements = {
    image: document.getElementById("screenshot-img") as HTMLImageElement,
    overlay: document.getElementById("overlay") as unknown as SVGSVGElement,
    wrap: document.getElementById("canvas-wrap") as HTMLDivElement,
    color: document.getElementById("color-input") as HTMLInputElement,
    caption: document.getElementById("caption-input") as HTMLTextAreaElement,
    undo: document.getElementById("undo-btn") as HTMLButtonElement,
    redo: document.getElementById("redo-btn") as HTMLButtonElement,
    remove: document.getElementById("delete-btn") as HTMLButtonElement,
    save: document.getElementById("save-btn") as HTMLButtonElement,
    discard: document.getElementById("discard-btn") as HTMLButtonElement,
    shapeList: document.getElementById("shape-list") as HTMLUListElement,
    redactionNote: document.getElementById("redaction-note") as HTMLDivElement,
    status: document.getElementById("status") as HTMLParagraphElement,
  };

  const history = new EditorHistory();
  let pending: PendingScreenshot | null = null;
  let tool: EditorTool = "select";
  let selectedId: string | null = null;
  let dragStart: NormalizedPoint | null = null;
  let dragPoints: NormalizedPoint[] = [];
  let saving = false;

  function setStatus(message: string, isError = false): void {
    elements.status.textContent = message;
    elements.status.classList.toggle("is-error", isError);
  }

  function toNormalized(event: PointerEvent): NormalizedPoint {
    const rect = elements.overlay.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / (rect.height || 1))),
    };
  }

  /** Shape being dragged right now, so the user sees it before releasing. */
  function previewShape(current: NormalizedPoint): Annotation | null {
    if (!dragStart || tool === "select" || tool === "text") {
      return null;
    }
    return createShape({
      tool,
      from: dragStart,
      to: current,
      color: elements.color.value,
      points: tool === "freehand" ? dragPoints : undefined,
    });
  }

  function render(preview: Annotation | null = null): void {
    if (!pending) {
      return;
    }
    const shapes = preview ? [...history.annotations, preview] : history.annotations;
    elements.overlay.innerHTML = renderAnnotationsSvg(shapes, pending.viewport, {
      fragmentOnly: true,
    });
    elements.overlay.setAttribute(
      "viewBox",
      `0 0 ${pending.viewport.width} ${pending.viewport.height}`,
    );

    elements.undo.disabled = !history.canUndo;
    elements.redo.disabled = !history.canRedo;
    elements.remove.disabled = selectedId === null;

    const hasRedaction = history.annotations.some((shape) => shape.type === "redact");
    elements.redactionNote.hidden = !hasRedaction;

    renderShapeList();
  }

  function renderShapeList(): void {
    elements.shapeList.replaceChildren();
    if (history.annotations.length === 0) {
      const empty = document.createElement("li");
      empty.className = "shape-list-empty";
      empty.textContent = annotateT("emptyShapes");
      elements.shapeList.append(empty);
      return;
    }

    for (const annotation of history.annotations) {
      const item = document.createElement("li");
      item.textContent = describeAnnotation(annotation);
      item.classList.toggle("is-selected", annotation.id === selectedId);
      item.classList.toggle("is-redaction", annotation.type === "redact");
      item.addEventListener("click", () => {
        selectedId = annotation.id;
        render();
      });
      elements.shapeList.append(item);
    }
  }

  function selectTool(next: EditorTool): void {
    tool = next;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const active = button.dataset.tool === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    elements.overlay.dataset.tool = next;
  }

  elements.overlay.addEventListener("pointerdown", (event: PointerEvent) => {
    if (!pending) {
      return;
    }
    const point = toNormalized(event);

    if (tool === "select") {
      selectedId = hitTest(history.annotations, point)?.id ?? null;
      render();
      return;
    }

    if (tool === "text") {
      const value = window.prompt("Note text");
      const shape = createShape({
        tool: "text",
        from: point,
        to: point,
        color: elements.color.value,
        text: value ?? "",
      });
      if (shape) {
        history.add(shape);
        render();
      }
      return;
    }

    elements.overlay.setPointerCapture(event.pointerId);
    dragStart = point;
    dragPoints = [point];
  });

  elements.overlay.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragStart) {
      return;
    }
    const point = toNormalized(event);
    if (tool === "freehand") {
      dragPoints.push(point);
    }
    render(previewShape(point));
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragStart) {
      return;
    }
    const shape = previewShape(toNormalized(event));
    dragStart = null;
    dragPoints = [];
    if (shape) {
      history.add(shape);
      selectedId = shape.id;
    }
    render();
  };

  elements.overlay.addEventListener("pointerup", endDrag);
  elements.overlay.addEventListener("pointercancel", endDrag);

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    button.addEventListener("click", () => selectTool(button.dataset.tool as EditorTool));
  }

  elements.undo.addEventListener("click", () => {
    history.undo();
    selectedId = null;
    render();
  });
  elements.redo.addEventListener("click", () => {
    history.redo();
    selectedId = null;
    render();
  });
  elements.remove.addEventListener("click", () => {
    if (selectedId) {
      history.remove(selectedId);
      selectedId = null;
      render();
    }
  });

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        history.redo();
      } else {
        history.undo();
      }
      selectedId = null;
      render();
      return;
    }

    if ((event.key === "Backspace" || event.key === "Delete") && selectedId) {
      event.preventDefault();
      history.remove(selectedId);
      selectedId = null;
      render();
      return;
    }

    const shortcut = TOOL_SHORTCUTS[event.key.toLowerCase()];
    if (shortcut) {
      selectTool(shortcut);
    }
  });

  elements.discard.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "DISCARD_PENDING_SCREENSHOT" });
    window.close();
  });

  elements.save.addEventListener("click", async () => {
    if (!pending || saving) {
      return;
    }

    let loading: ReturnType<typeof setButtonLoading> | null = null;
    try {
      // The offscreen document bakes redactions before packaging; this guard
      // catches the case where a shape somehow reached save unbaked, so the
      // failure is a refusal rather than a leak.
      const annotations = history.annotations;
      if (!annotations.some((shape) => shape.type === "redact")) {
        assertReadyToSave(annotations);
      }

      saving = true;
      loading = setButtonLoading(elements.save, {
        label: annotateT("packaging"),
        spinner: true,
      });
      setStatus(annotateT("packaging"));

      const screenshot: Screenshot = {
        id: pending.id,
        capturedAt: pending.capturedAt,
        url: pending.url,
        title: pending.title,
        viewport: pending.viewport,
        // Rewritten by the packager once the image entry has a path.
        source: { kind: "image", path: "", mimeType: "image/jpeg" },
        annotations,
        caption: elements.caption.value.trim() || undefined,
      };

      const response = (await chrome.runtime.sendMessage({
        action: "SAVE_ANNOTATED_SCREENSHOT",
        data: { screenshot, caption: screenshot.caption },
      })) as { ok: boolean; error?: string; recordingUrl?: string };

      if (!response?.ok) {
        throw new Error(response?.error || annotateT("uploadFailed"));
      }

      setStatus(annotateT("uploaded"));
      if (response.recordingUrl) {
        await chrome.tabs.create({ url: response.recordingUrl });
      }
      window.close();
    } catch (error) {
      saving = false;
      loading?.clear();
      elements.save.disabled = false;
      setStatus((error as Error).message, true);
    }
  });

  async function load(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      action: "GET_PENDING_SCREENSHOT",
    })) as { ok: boolean; screenshot?: PendingScreenshot; error?: string };

    if (!response?.ok || !response.screenshot) {
      setStatus(response?.error || annotateT("noPending"), true);
      elements.save.disabled = true;
      return;
    }

    pending = response.screenshot;
    const isInstantReplay = pending.kind === "instant-replay";
    elements.image.src = pending.imageDataUrl;
    elements.wrap.style.aspectRatio = `${pending.viewport.width} / ${pending.viewport.height}`;
    if (isInstantReplay && !elements.caption.value.trim()) {
      elements.caption.value = annotateT("defaultCaptionIr");
      elements.caption.placeholder = annotateT("defaultCaptionIr");
    }
    const titleEl = document.querySelector<HTMLElement>("[data-i18n='annotate.title']");
    if (titleEl) {
      titleEl.textContent = isInstantReplay ? annotateT("titleIr") : annotateT("titleScreenshot");
    }
    document.title = isInstantReplay
      ? `${annotateT("titleIr")} — GN Tracing`
      : `${annotateT("titleScreenshot")} — GN Tracing`;
    selectTool("select");
    render();
    setStatus(annotateT(isInstantReplay ? "readyIr" : "ready"));
  }

  void load();
})();
