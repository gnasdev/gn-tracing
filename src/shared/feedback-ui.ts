/**
 * Shared topbar Feedback button + popover form for extension surfaces.
 *
 * Submit always goes through the service worker (`SUBMIT_FEEDBACK`) so the
 * GitHub token never leaves the Worker and host_permissions stay centralized.
 */

import type { MessageResponse } from "../types/messages";
import { buildFeedbackDiagnostics, validateFeedbackMessage } from "./feedback";

export interface FeedbackUiLabels {
  button: string;
  sectionAria: string;
  label: string;
  placeholder: string;
  hint: string;
  submit: string;
  cancel: string;
  sending: string;
  success: string;
  failed: string;
}

export interface FeedbackUiController {
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
  refreshLabels: () => void;
  destroy: () => void;
  getButton: () => HTMLButtonElement;
  getPanel: () => HTMLElement;
}

export interface AttachFeedbackPopoverOptions {
  /**
   * Topbar actions container (or any parent). The feedback wrapper is inserted
   * as a child; use `before` to control position among siblings.
   */
  mount: HTMLElement;
  /** Optional existing button; otherwise one is created. */
  button?: HTMLButtonElement | null;
  /** Optional existing panel; otherwise one is created inside the wrapper. */
  panel?: HTMLElement | null;
  /** Insert the wrapper before this sibling (within `mount`). */
  before?: HTMLElement | null;
  getLabels: () => FeedbackUiLabels;
  /**
   * Result toast/status. Surfaces that already have toasts should pass this.
   * Defaults to a brief text status inside the popover.
   */
  onResult?: (result: { ok: boolean; message: string }) => void;
}

const FEEDBACK_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
`.trim();

function ensureIds(prefix: string): {
  wrapId: string;
  buttonId: string;
  panelId: string;
  messageId: string;
  submitId: string;
  cancelId: string;
  statusId: string;
} {
  return {
    wrapId: `${prefix}-wrap`,
    buttonId: `${prefix}-toggle-btn`,
    panelId: `${prefix}-panel`,
    messageId: `${prefix}-message`,
    submitId: `${prefix}-submit-btn`,
    cancelId: `${prefix}-cancel-btn`,
    statusId: `${prefix}-status`,
  };
}

/**
 * Mount a Feedback button with an anchored popover form on an extension page.
 */
export function attachFeedbackPopover(options: AttachFeedbackPopoverOptions): FeedbackUiController {
  const ids = ensureIds("feedback");

  let button = options.button || null;
  let panel = options.panel || null;
  let wrap: HTMLElement;

  if (button?.parentElement?.classList.contains("gn-feedback")) {
    wrap = button.parentElement;
  } else if (panel?.parentElement?.classList.contains("gn-feedback")) {
    wrap = panel.parentElement;
  } else {
    wrap = document.createElement("div");
    wrap.className = "gn-feedback";
    wrap.id = ids.wrapId;
    if (options.before && options.before.parentElement === options.mount) {
      options.mount.insertBefore(wrap, options.before);
    } else {
      options.mount.appendChild(wrap);
    }
  }

  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.id = ids.buttonId;
    // Icon-only control — label goes to aria-label/title via refreshLabels().
    button.className = "icon-btn gn-feedback-btn";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-haspopup", "dialog");
    button.innerHTML = FEEDBACK_ICON;
    wrap.appendChild(button);
  } else if (!button.classList.contains("gn-feedback-btn")) {
    button.classList.add("gn-feedback-btn", "icon-btn");
    if (button.childElementCount === 0 && !button.querySelector("svg")) {
      button.innerHTML = FEEDBACK_ICON;
    }
    if (button.parentElement !== wrap) {
      wrap.appendChild(button);
    }
  }

  if (!panel) {
    panel = document.createElement("div");
    panel.id = ids.panelId;
    panel.className = "gn-feedback-popover hidden";
    panel.setAttribute("role", "dialog");
    panel.innerHTML = `
      <label class="gn-feedback-label" for="${ids.messageId}"></label>
      <textarea
        id="${ids.messageId}"
        class="gn-feedback-message"
        rows="4"
        maxlength="4000"
      ></textarea>
      <p class="gn-feedback-hint"></p>
      <div class="gn-feedback-status hidden" id="${ids.statusId}" role="status" aria-live="polite"></div>
      <div class="gn-feedback-actions">
        <button type="button" id="${ids.submitId}" class="btn btn-start btn-small"></button>
        <button type="button" id="${ids.cancelId}" class="btn btn-secondary btn-small"></button>
      </div>
    `;
    wrap.appendChild(panel);
  } else {
    panel.classList.add("gn-feedback-popover");
    if (panel.parentElement !== wrap) {
      wrap.appendChild(panel);
    }
  }

  button.setAttribute("aria-controls", panel.id);

  const messageInput =
    (panel.querySelector(`#${ids.messageId}`) as HTMLTextAreaElement | null) ||
    (panel.querySelector("textarea") as HTMLTextAreaElement);
  const submitBtn =
    (panel.querySelector(`#${ids.submitId}`) as HTMLButtonElement | null) ||
    (panel.querySelector(".gn-feedback-actions .btn-start") as HTMLButtonElement);
  const cancelBtn =
    (panel.querySelector(`#${ids.cancelId}`) as HTMLButtonElement | null) ||
    (panel.querySelector(".gn-feedback-actions .btn-secondary") as HTMLButtonElement);
  const labelEl = panel.querySelector(".gn-feedback-label, .feedback-label") as HTMLElement | null;
  const hintEl = panel.querySelector(".gn-feedback-hint, .feedback-hint") as HTMLElement | null;
  const statusEl =
    (panel.querySelector(`#${ids.statusId}`) as HTMLElement | null) ||
    (panel.querySelector(".gn-feedback-status") as HTMLElement | null);
  let open = !panel.classList.contains("hidden");
  let submitting = false;

  const setStatus = (text: string, kind: "info" | "error" | "success" | "clear" = "info"): void => {
    if (!statusEl) {
      return;
    }
    if (kind === "clear" || !text) {
      statusEl.textContent = "";
      statusEl.classList.add("hidden");
      statusEl.classList.remove("is-error", "is-success");
      return;
    }
    statusEl.textContent = text;
    statusEl.classList.remove("hidden", "is-error", "is-success");
    if (kind === "error") {
      statusEl.classList.add("is-error");
    } else if (kind === "success") {
      statusEl.classList.add("is-success");
    }
  };

  const refreshLabels = (): void => {
    const labels = options.getLabels();
    // Icon-only: never put visible text on the trigger.
    button!.setAttribute("aria-label", labels.button);
    button!.setAttribute("title", labels.button);
    panel!.setAttribute("aria-label", labels.sectionAria);
    if (labelEl) {
      labelEl.textContent = labels.label;
    }
    if (messageInput) {
      messageInput.placeholder = labels.placeholder;
    }
    if (hintEl) {
      hintEl.textContent = labels.hint;
    }
    if (submitBtn && !submitting) {
      submitBtn.textContent = labels.submit;
    }
    if (cancelBtn) {
      cancelBtn.textContent = labels.cancel;
    }
  };

  const setOpen = (next: boolean): void => {
    open = next;
    panel!.classList.toggle("hidden", !next);
    button!.setAttribute("aria-expanded", next ? "true" : "false");
    wrap.classList.toggle("is-open", next);
    if (next) {
      setStatus("", "clear");
      messageInput?.focus();
    }
  };

  const handleToggle = (event: Event): void => {
    event.stopPropagation();
    setOpen(!open);
  };

  const handleCancel = (): void => {
    setOpen(false);
  };

  const handleDocumentClick = (event: MouseEvent): void => {
    if (!open) {
      return;
    }
    const target = event.target as Node | null;
    if (target && wrap.contains(target)) {
      return;
    }
    setOpen(false);
  };

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && open) {
      setOpen(false);
      button!.focus();
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (submitting || !messageInput || !submitBtn) {
      return;
    }
    const labels = options.getLabels();
    const validated = validateFeedbackMessage(messageInput.value);
    if (!validated.ok) {
      setStatus(validated.error, "error");
      options.onResult?.({ ok: false, message: validated.error });
      return;
    }

    submitting = true;
    submitBtn.disabled = true;
    messageInput.disabled = true;
    if (cancelBtn) {
      cancelBtn.disabled = true;
    }
    submitBtn.textContent = labels.sending;
    setStatus("", "clear");

    try {
      const result = (await chrome.runtime.sendMessage({
        action: "SUBMIT_FEEDBACK",
        data: {
          message: validated.message,
          diagnostics: buildFeedbackDiagnostics(),
        },
      })) as MessageResponse & { issueUrl?: string };

      if (!result?.ok) {
        const error = result?.error || labels.failed;
        setStatus(error, "error");
        options.onResult?.({ ok: false, message: error });
        return;
      }

      messageInput.value = "";
      setOpen(false);
      const successMessage = result.message || labels.success;
      options.onResult?.({
        ok: true,
        message: successMessage,
      });
      if (!options.onResult) {
        setStatus(successMessage, "success");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail || labels.failed;
      setStatus(message, "error");
      options.onResult?.({ ok: false, message });
    } finally {
      submitting = false;
      submitBtn.disabled = false;
      messageInput.disabled = false;
      if (cancelBtn) {
        cancelBtn.disabled = false;
      }
      submitBtn.textContent = options.getLabels().submit;
    }
  };

  button.addEventListener("click", handleToggle);
  cancelBtn?.addEventListener("click", handleCancel);
  submitBtn?.addEventListener("click", () => {
    void handleSubmit();
  });
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleKeydown);

  refreshLabels();
  setOpen(false);

  return {
    setOpen,
    isOpen: () => open,
    refreshLabels,
    destroy: () => {
      button?.removeEventListener("click", handleToggle);
      cancelBtn?.removeEventListener("click", handleCancel);
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleKeydown);
    },
    getButton: () => button!,
    getPanel: () => panel!,
  };
}
