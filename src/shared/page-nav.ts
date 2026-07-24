/**
 * Shared topbar page navigation for extension full pages.
 *
 * Markup:
 *   <div class="gn-nav">
 *     <button id="gn-nav-toggle" class="icon-btn" type="button" ...>
 *     <div id="gn-nav-menu" class="gn-nav-menu" role="menu" hidden>
 *       <button type="button" role="menuitem" data-gn-nav="settings">...</button>
 *       <button type="button" role="menuitem" data-gn-nav="history">...</button>
 *       <button type="button" role="menuitem" data-gn-nav="connect">...</button>
 *     </div>
 *   </div>
 */

import type { MessageResponse } from "../types/messages";

export type PageNavId = "settings" | "history" | "connect";

const PAGE_PATHS: Record<PageNavId, string> = {
  settings: "settings/settings.html",
  history: "history/history.html",
  connect: "drive-auth/drive-auth.html",
};

function pageUrl(id: PageNavId): string {
  return chrome.runtime.getURL(PAGE_PATHS[id]);
}

function isCurrentPage(id: PageNavId): boolean {
  const path = PAGE_PATHS[id];
  return location.pathname.endsWith(`/${path}`) || location.pathname.endsWith(path);
}

function openPage(id: PageNavId): void {
  if (isCurrentPage(id)) {
    return;
  }
  location.assign(pageUrl(id));
}

async function isDriveConnected(): Promise<boolean> {
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "GOOGLE_DRIVE_STATUS",
    })) as MessageResponse & { isConnected?: boolean };
    return Boolean(result?.ok && result.isConnected);
  } catch {
    return false;
  }
}

/**
 * Wire the shared topbar nav menu. Marks the current page item and shows
 * Connect only when Google Drive is not connected.
 */
export function attachPageNav(options: { current: PageNavId }): void {
  const toggle = document.getElementById("gn-nav-toggle") as HTMLButtonElement | null;
  const menu = document.getElementById("gn-nav-menu") as HTMLElement | null;
  if (!toggle || !menu) {
    return;
  }

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-gn-nav]"));

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    menu.classList.toggle("is-open", open);
  };

  const close = (): void => setOpen(false);

  // Mark current page item.
  for (const item of items) {
    const id = item.dataset.gnNav as PageNavId | undefined;
    if (!id || !PAGE_PATHS[id]) {
      continue;
    }
    const current = id === options.current || isCurrentPage(id);
    item.classList.toggle("is-current", current);
    item.setAttribute("aria-current", current ? "page" : "false");
    if (current) {
      item.disabled = true;
    }
  }

  void isDriveConnected().then((connected) => {
    const connectItem = items.find((item) => item.dataset.gnNav === "connect");
    if (!connectItem) {
      return;
    }
    // Always show Connect on the connect page itself; otherwise only when disconnected.
    const showConnect = options.current === "connect" || !connected;
    connectItem.classList.toggle("hidden", !showConnect);
  });

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });

  menu.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-gn-nav]");
    if (!item || item.disabled) {
      return;
    }
    const id = item.dataset.gnNav as PageNavId | undefined;
    if (!id || !PAGE_PATHS[id]) {
      return;
    }
    close();
    openPage(id);
  });

  document.addEventListener("click", (event) => {
    if (menu.hidden) {
      return;
    }
    const target = event.target as Node | null;
    if (target && (toggle.contains(target) || menu.contains(target))) {
      return;
    }
    close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      close();
      toggle.focus();
    }
  });
}
