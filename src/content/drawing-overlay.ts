/**
 * Full-screen drawing overlay for GN Tracing recordings.
 *
 * Injected dynamically into the recorded tab. Captures pointer strokes while
 * drawing mode is active and forwards completed strokes to the service worker.
 * The overlay is not captured by tabCapture; strokes are replayed by the player.
 */

import {
  addStrokePoint,
  createStroke,
  DEFAULT_DRAW_COLOR,
  DEFAULT_DRAW_WIDTH,
  normalizeDrawColor,
  type RawDrawStroke,
} from "../shared/drawing";

(() => {
  type DrawingState = {
    sessionId: string;
    active: boolean;
    color: string;
    width: number;
    currentStroke: RawDrawStroke | null;
    container: HTMLDivElement;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    cleanup: () => void;
  };

  type DrawingWindow = Window & {
    __gnTracingDrawingOverlay?: DrawingState;
    __gnTracingDrawingOverlayInstalled?: boolean;
  };

  const CONTAINER_ID = "gn-tracing-drawing-overlay";
  const CANVAS_ID = "gn-tracing-drawing-canvas";

  const pageWindow = window as DrawingWindow;

  function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function sendRuntimeMessage(message: Record<string, unknown>): void {
    if (!chrome.runtime?.id) {
      return;
    }
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension context invalidated.
    }
  }

  function sendStroke(sessionId: string, stroke: RawDrawStroke): void {
    if (stroke.points.length === 0) {
      return;
    }
    sendRuntimeMessage({
      target: "service-worker",
      action: "RECORDING_DRAW_STROKE",
      data: {
        sessionId,
        stroke: {
          strokeId: stroke.strokeId,
          timestamp: stroke.timestamp,
          color: stroke.color,
          width: stroke.width,
          points: stroke.points,
        },
      },
    });
  }

  function sendClear(sessionId: string): void {
    sendRuntimeMessage({
      target: "service-worker",
      action: "RECORDING_DRAW_CLEAR",
      data: { sessionId, timestamp: Date.now() },
    });
  }

  function createOverlay(): DrawingState["container"] {
    const existing = document.getElementById(CONTAINER_ID);
    if (existing) {
      existing.remove();
    }

    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.setAttribute("aria-hidden", "true");
    container.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      touch-action: none;
    `;

    const canvas = document.createElement("canvas");
    canvas.id = CANVAS_ID;
    canvas.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    `;

    container.appendChild(canvas);
    document.documentElement.appendChild(container);

    return container;
  }

  function resizeCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function clearCanvas(state: DrawingState): void {
    const { canvas, ctx } = state;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function setActive(state: DrawingState, active: boolean): void {
    state.active = active;
    if (active) {
      state.container.classList.add("active");
      state.container.style.pointerEvents = "auto";
      state.container.style.cursor = "crosshair";
    } else {
      state.container.classList.remove("active");
      state.container.style.pointerEvents = "none";
      state.container.style.cursor = "";
      clearCanvas(state);
      sendClear(state.sessionId);
    }
  }

  function getPointerPoint(event: PointerEvent): { x: number; y: number } {
    return {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
    };
  }

  function drawSegment(
    state: DrawingState,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): void {
    const { ctx } = state;
    ctx.strokeStyle = state.color;
    ctx.lineWidth = state.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function finishStroke(state: DrawingState): void {
    const stroke = state.currentStroke;
    state.currentStroke = null;
    if (stroke && stroke.points.length > 0) {
      sendStroke(state.sessionId, stroke);
    }
  }

  function install(sessionId: string, color = DEFAULT_DRAW_COLOR): DrawingState {
    pageWindow.__gnTracingDrawingOverlay?.cleanup();

    const container = createOverlay();
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create drawing context");
    }

    const state: DrawingState = {
      sessionId,
      active: false,
      color: normalizeDrawColor(color) || DEFAULT_DRAW_COLOR,
      width: DEFAULT_DRAW_WIDTH,
      currentStroke: null,
      container,
      canvas,
      ctx,
      cleanup: () => {
        // placeholder replaced below
      },
    };

    resizeCanvas(canvas, ctx);

    const onResize = () => {
      resizeCanvas(canvas, ctx);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!state.active) {
        return;
      }
      event.preventDefault();
      const point = getPointerPoint(event);
      state.currentStroke = createStroke({
        strokeId: generateId(),
        timestamp: Date.now(),
        color: state.color,
        width: state.width,
        points: [{ x: point.x, y: point.y, t: 0 }],
      });
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!state.active || !state.currentStroke) {
        return;
      }
      event.preventDefault();
      const point = getPointerPoint(event);
      const previous = state.currentStroke.points[state.currentStroke.points.length - 1];
      const added = addStrokePoint(state.currentStroke, point, Date.now());
      if (added && previous) {
        drawSegment(state, previous, added);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!state.active || !state.currentStroke) {
        return;
      }
      event.preventDefault();
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      const point = getPointerPoint(event);
      const previous = state.currentStroke.points[state.currentStroke.points.length - 1];
      const added = addStrokePoint(state.currentStroke, point, Date.now());
      if (added && previous) {
        drawSegment(state, previous, added);
      }
      finishStroke(state);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (!state.currentStroke) {
        return;
      }
      event.preventDefault();
      finishStroke(state);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        finishStroke(state);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const isToggleShortcut =
        (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d";
      if (isToggleShortcut) {
        event.preventDefault();
        setActive(state, !state.active);
        return;
      }
      if (event.key === "Escape" && state.active) {
        event.preventDefault();
        setActive(state, false);
        finishStroke(state);
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerCancel, { passive: false });
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange);

    state.cleanup = () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      container.remove();
      delete pageWindow.__gnTracingDrawingOverlay;
    };

    pageWindow.__gnTracingDrawingOverlay = state;
    return state;
  }

  if (!pageWindow.__gnTracingDrawingOverlayInstalled) {
    chrome.runtime.onMessage.addListener(
      (
        message: {
          target?: string;
          type?: string;
          sessionId?: string;
          color?: string;
          width?: number;
        },
        _sender,
        sendResponse,
      ) => {
        if (message.target !== "drawing-overlay") {
          return false;
        }

        if (
          message.type === "START" &&
          typeof message.sessionId === "string" &&
          message.sessionId
        ) {
          try {
            const color = normalizeDrawColor(message.color) || DEFAULT_DRAW_COLOR;
            install(message.sessionId, color);
            sendResponse({ ok: true });
          } catch (error) {
            sendResponse({ ok: false, error: (error as Error).message });
          }
          return false;
        }

        if (message.type === "STOP") {
          const state = pageWindow.__gnTracingDrawingOverlay;
          if (state) {
            finishStroke(state);
            state.cleanup();
          }
          sendResponse({ ok: true });
          return false;
        }

        if (message.type === "TOGGLE") {
          const state = pageWindow.__gnTracingDrawingOverlay;
          if (!state) {
            sendResponse({ ok: false, error: "Drawing overlay not installed." });
            return false;
          }
          finishStroke(state);
          setActive(state, !state.active);
          sendResponse({ ok: true, active: state.active });
          return false;
        }

        if (message.type === "GET_STATE") {
          const state = pageWindow.__gnTracingDrawingOverlay;
          sendResponse({ ok: true, active: state?.active ?? false });
          return false;
        }

        if (message.type === "SET_COLOR" && typeof message.color === "string") {
          const state = pageWindow.__gnTracingDrawingOverlay;
          const color = normalizeDrawColor(message.color);
          if (state && color) {
            state.color = color;
          }
          sendResponse({ ok: Boolean(color) });
          return false;
        }

        if (message.type === "SET_WIDTH" && typeof message.width === "number") {
          const state = pageWindow.__gnTracingDrawingOverlay;
          if (state) {
            state.width = Math.max(1, message.width);
          }
          sendResponse({ ok: true });
          return false;
        }

        return false;
      },
    );
    pageWindow.__gnTracingDrawingOverlayInstalled = true;
  }
})();
