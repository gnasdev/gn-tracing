/**
 * Shared busy-state helpers for extension buttons (spinner + aria-busy).
 */

import { escapeHtml } from "./upload-history-ui";

export type ButtonLoadingOptions = {
  label: string;
  /** When true (default), inject .btn-spinner before the label span. */
  spinner?: boolean;
  /** Extra class toggled while loading (default "is-loading"). */
  loadingClass?: string;
};

export type ButtonLoadingHandle = {
  /** Restore previous innerHTML, disabled, aria-busy, and loading class. */
  clear: () => void;
};

export function buttonSpinnerHtml(): string {
  return `<span class="btn-spinner" aria-hidden="true"></span>`;
}

export function setButtonLoading(
  button: HTMLButtonElement,
  options: ButtonLoadingOptions,
): ButtonLoadingHandle {
  const loadingClass = options.loadingClass ?? "is-loading";
  const prev = {
    html: button.innerHTML,
    disabled: button.disabled,
    busy: button.getAttribute("aria-busy"),
    hadLoadingClass: button.classList.contains(loadingClass),
  };

  const spinner = options.spinner === false ? "" : buttonSpinnerHtml();
  button.innerHTML = `${spinner}<span>${escapeHtml(options.label)}</span>`;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add(loadingClass);

  return {
    clear: () => {
      button.innerHTML = prev.html;
      button.disabled = prev.disabled;
      if (prev.busy == null) {
        button.removeAttribute("aria-busy");
      } else {
        button.setAttribute("aria-busy", prev.busy);
      }
      if (!prev.hadLoadingClass) {
        button.classList.remove(loadingClass);
      }
    },
  };
}
