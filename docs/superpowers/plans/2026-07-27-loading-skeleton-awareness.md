# Loading, Skeleton & Awareness Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make loading, busy, empty, and progress feedback consistent and correct across the extension surfaces, hosted pages, and replay player — without introducing a UI framework.

**Architecture:** Stay vanilla HTML/CSS/TS. Extract shared CSS tokens (spinner, progress bar, empty card, button-busy) into `shared/theme.css`, add a tiny pure helper for button busy state used by popup/feedback/storage-auth/annotate, and fix the player state machine so package load always shows `#loading-state` (extension + standalone parity). Skeleton/shimmer is limited to optional lightweight pulse blocks only where load time is user-visible; no React Skeleton library.

**Tech Stack:** Vanilla TypeScript/JS, Vitest, Biome, existing `shared/theme.css` design tokens, Phosphor/inline SVG icons, esbuild extension build, player-standalone sync via `player-standalone/scripts/sync-player.js`.

## Global Constraints

- No React/Vue/Svelte rewrite; no Suspense; no third-party skeleton libraries.
- Extension and standalone player share `player/player.js` + `player/player.css`; HTML shells must stay parity-tested.
- After editing `player/player.js` or `player/player.css`, run the standalone sync script (or whatever Taskfile target the repo uses) so `player-standalone/public/` stays aligned — check `Taskfile.yml` / `DEVELOPER.md`.
- i18n: every new user-facing string needs EN + VI (popup maps, player `t()` dictionaries, annotate/storage-auth local maps as applicable).
- Accessibility: busy buttons get `aria-busy="true"`; determinate bars get `role="progressbar"` + `aria-valuemin/max/now`.
- Prefer reuse of `.btn-spinner`, `.history-empty` / `.session-empty`, player `.spinner` / `.loading-progress-*` over new one-off CSS.
- YAGNI: skip multi-user presence, route-level loaders, and content skeletons if parse time is sub-100ms after download.
- Tests: Vitest; run targeted files first, then `npm test` before claiming done. Lint: `npm run lint`.
- Do not commit secrets; do not amend unless asked; Conventional Commits.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `shared/theme.css` | Canonical spinner, progress bar, empty-card, button-busy, skeleton-pulse tokens |
| `player/player.css` | Consume shared tokens or thin aliases; remove duplicate `@keyframes spin` if moved |
| `player/player.html` | Loading/intro default classes; progress a11y attrs |
| `player-standalone/index.html` | Parity with extension shell defaults for state containers |
| `player/player.js` | `showLoading()` on primary load path; progress a11y updates; password busy spinner |
| `player/player-html-parity.test.ts` | Assert loading/intro default class parity + required loading ids |
| `src/shared/button-loading.ts` | Pure helper: set/clear button loading (spinner + label + aria-busy + disabled) |
| `src/shared/button-loading.test.ts` | Unit tests for helper |
| `src/popup/popup.ts` | Use helper; optional checkingTab busy; wire or remove `session.empty` |
| `src/shared/feedback-ui.ts` | Button spinner while submitting |
| `src/storage-auth/storage-auth.ts` + `storage-auth/storage-auth.html` | Spinner on busy provider status/actions |
| `src/annotate/annotate.ts` | Save busy + i18n empty copy |
| `docs/modules/replay-player.md` | Document loading state machine + HTML defaults |
| `docs/features/extension-surfaces.md` | Document busy/empty patterns on extension surfaces |

**Out of scope files:** `packages/*` (no UI), `worker/*`, `mcp/*`, React rewrites, drive-auth orphaned full page (optional cleanup only if cheap).

---

### Task 1: Player package-load always shows loading state

**Files:**
- Modify: `player/player.js` (init load path ~8511–8528; `showLoading` ~6305–6312)
- Modify: `player/player.html` (~64–72, ~100)
- Modify: `player-standalone/index.html` (~64–71, ~98)
- Test: `player/player-html-parity.test.ts`
- Docs (fold-in): `docs/modules/replay-player.md` loading section

**Interfaces:**
- Consumes: existing `showLoading()`, `showIntro()`, `showError()`, `resetLoadingProgress()`, `loadRecordingFilesFromIndex`, `loadRecordingFromFiles`
- Produces: guaranteed visible `#loading-state` whenever a replay URL/package load starts; intro only when no params

**Problem:** `showLoading()` runs only after password unlock (~5645, ~5673). Primary `init` path calls `resetLoadingProgress` but never `showLoading()`. Extension HTML starts with `#loading-state.hidden` + intro visible; standalone starts with loading visible + intro hidden. Extension users can see intro flash while download progress updates a hidden panel.

- [ ] **Step 1: Extend parity test for state-container defaults and loading ids**

Add to `player/player-html-parity.test.ts`:

```ts
const REQUIRED_LOADING_IDS = [
  "loading-state",
  "loading-message",
  "loading-progress-fill",
  "loading-progress-text",
  "password-state",
  "error-state",
  "intro-state",
  "player-state",
];

// inside describe:
for (const id of REQUIRED_LOADING_IDS) {
  it(`extension player.html has #${id}`, () => {
    expect(extensionIds.has(id)).toBe(true);
  });
  it(`standalone index.html has #${id}`, () => {
    expect(standaloneIds.has(id)).toBe(true);
  });
}

function hasClassOnId(html: string, id: string, className: string): boolean {
  const re = new RegExp(`id="${id}"[^>]*class="([^"]*)"`, "i");
  const m = html.match(re);
  if (!m) return false;
  return m[1].split(/\s+/).includes(className);
}

it("both shells hide loading-state by default (JS shows it when loading)", () => {
  expect(hasClassOnId(extensionHtml, "loading-state", "hidden")).toBe(true);
  expect(hasClassOnId(standaloneHtml, "loading-state", "hidden")).toBe(true);
});

it("both shells hide intro-state by default when loading may start immediately", () => {
  // After fix: intro starts hidden; JS calls showIntro() only when no params
  expect(hasClassOnId(extensionHtml, "intro-state", "hidden")).toBe(true);
  expect(hasClassOnId(standaloneHtml, "intro-state", "hidden")).toBe(true);
});
```

Note: if first-paint without JS is a concern for bare player open, prefer: both hide loading + hide intro initially is wrong (blank flash). **Chosen contract:**

- Default HTML: `#loading-state` **without** `hidden`, `#intro-state` **with** `hidden` (optimistic load chrome — standalone already does this).
- JS: `init` with no params → `showIntro()`; with replay params → `showLoading()` immediately before await; unlock path already calls `showLoading()`.

Adjust the parity assertions to that contract:

```ts
it("both shells show loading-state by default", () => {
  expect(hasClassOnId(extensionHtml, "loading-state", "hidden")).toBe(false);
  expect(hasClassOnId(standaloneHtml, "loading-state", "hidden")).toBe(false);
});

it("both shells hide intro-state by default", () => {
  expect(hasClassOnId(extensionHtml, "intro-state", "hidden")).toBe(true);
  expect(hasClassOnId(standaloneHtml, "intro-state", "hidden")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run player/player-html-parity.test.ts -v`

Expected: FAIL on extension `loading-state` hidden and/or `intro-state` not hidden.

- [ ] **Step 3: Align HTML defaults**

In `player/player.html`:

```html
<!-- Loading state (default visible; JS switches to intro/error/player) -->
<div id="loading-state" class="state-container">
  ...
</div>
...
<div id="intro-state" class="state-container hidden">
```

Confirm `player-standalone/index.html` already matches (loading visible, intro hidden). If not, make it match.

- [ ] **Step 4: Call `showLoading()` on primary load paths**

In `player/player.js` `init`, replace the replay/direct branches:

```js
if (replayRecordingId) {
  if (replayRef.provider !== "google-drive" && replayRef.provider !== "dropbox") {
    elements.errorMessage.textContent = t("error.providerUnsupported", {
      provider: replayRef.provider,
    });
    showError();
    return;
  }
  activeReplayProvider = replayRef.provider;
  showLoading();
  setLoadingMessage(t("loading.package"));
  recordingFiles = await loadRecordingFilesFromIndex(replayRecordingId);
  await loadRecordingFromFiles();
} else if (videos && metadataFileId) {
  showLoading();
  recordingFiles = buildDirectRecordingFiles(urlParams);
  await loadRecordingFromFiles();
} else if (!hasParams) {
  console.info("[GN Tracing Player] Showing intro state without replay params");
  showIntro();
} else {
  elements.errorMessage.textContent = t("error.invalidParams");
  showError();
}
```

Keep unlock paths calling `showLoading()` as today.

Ensure `showLoading()` still resets progress (already does via `resetLoadingProgress`). Avoid double-reset thrash: if you call `setLoadingMessage` right after `showLoading()`, that is fine.

- [ ] **Step 5: Run parity test**

Run: `npx vitest run player/player-html-parity.test.ts -v`

Expected: PASS

- [ ] **Step 6: Manual smoke checklist (document in commit body if not automatable)**

1. Open extension player with no query → intro.
2. Open standalone `/?` bare → intro (after JS).
3. Open replay URL (Drive/Dropbox mock or real) → loading spinner + progress, never intro flash.
4. Password package → password form; after unlock → loading then player.

- [ ] **Step 7: Commit**

```bash
git add player/player.js player/player.html player-standalone/index.html player/player-html-parity.test.ts
git commit -m "fix(player): show loading state on package load for both shells"
```

---

### Task 2: Progress bar accessibility (player + popup)

**Files:**
- Modify: `player/player.html`, `player-standalone/index.html` (loading progress markup)
- Modify: `player/player.js` (`renderLoadingProgress` ~1430–1458)
- Modify: `popup/popup.html` and/or `src/popup/popup.ts` where upload progress bars are built (~688–716, ~933–972)
- Test: extend `player/player-html-parity.test.ts` or add small pure unit if progress markup is string-built

**Interfaces:**
- Consumes: `renderLoadingProgress`, popup progress item renderer
- Produces: bars with `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` updated live

- [ ] **Step 1: Write failing assertion for player markup**

In parity test, assert both HTMLs contain progressbar role on the loading bar container:

```ts
it("loading progress bar exposes progressbar role", () => {
  expect(extensionHtml).toMatch(/id="loading-progress-fill"[\s\S]{0,200}role="progressbar"|role="progressbar"[\s\S]{0,200}id="loading-progress-fill"|class="loading-progress-bar"[^>]*role="progressbar"/);
  // Prefer role on the bar wrapper:
  expect(extensionHtml).toContain('class="loading-progress-bar"');
  expect(extensionHtml).toMatch(/loading-progress-bar"[^>]*role="progressbar"/);
  expect(standaloneHtml).toMatch(/loading-progress-bar"[^>]*role="progressbar"/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run player/player-html-parity.test.ts -v`

- [ ] **Step 3: Update HTML**

```html
<div
  class="loading-progress-bar"
  role="progressbar"
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow="0"
  aria-labelledby="loading-message"
  id="loading-progress-bar"
>
  <div id="loading-progress-fill" class="loading-progress-fill"></div>
</div>
```

Bind `elements.loadingProgressBar` in player.js element cache (~1268 area).

- [ ] **Step 4: Update `renderLoadingProgress`**

```js
if (elements.loadingProgressFill) {
  elements.loadingProgressFill.style.width = `${percent}%`;
}
if (elements.loadingProgressBar) {
  elements.loadingProgressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
}
```

- [ ] **Step 5: Popup upload bars**

Where progress item HTML is built in `src/popup/popup.ts`, add the same role/aria attributes on the bar element. When patching width during incremental updates, also set `aria-valuenow`.

Example pattern:

```ts
`<div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${escapeHtml(label)}">
  <div class="progress-bar-fill" style="width:${pct}%"></div>
</div>`
```

Use existing class names already in `popup/popup.css` — do not invent parallel BEM if `progress-item` structure already exists; only add ARIA.

- [ ] **Step 6: Run tests**

Run: `npx vitest run player/player-html-parity.test.ts src/shared/upload-history-ui.test.ts -v`

Expected: PASS (upload-history if touched; else skip)

- [ ] **Step 7: Commit**

```bash
git add player/player.html player-standalone/index.html player/player.js player/player-html-parity.test.ts src/popup/popup.ts
git commit -m "feat(a11y): expose progressbar semantics on player and popup bars"
```

---

### Task 3: Shared button-loading helper + tokenized spinner

**Files:**
- Create: `src/shared/button-loading.ts`
- Create: `src/shared/button-loading.test.ts`
- Modify: `shared/theme.css` (`.btn-spinner` colors via tokens; `.btn.is-loading`)
- Modify: `src/popup/popup.ts` (replace local `getLoadingIcon` / stop loading wiring where clean)
- Sync note: if `player-standalone/public/theme.css` is a copy, update source `shared/theme.css` and re-sync per project scripts

**Interfaces:**
- Consumes: DOM `HTMLButtonElement`, optional idle HTML snapshot
- Produces:

```ts
export type ButtonLoadingOptions = {
  label: string;
  /** When true, inject .btn-spinner before label span */
  spinner?: boolean;
  /** Extra class toggled while loading (default "is-loading") */
  loadingClass?: string;
};

export type ButtonLoadingHandle = {
  /** Restore previous innerHTML, disabled, aria-busy, class */
  clear: () => void;
};

export function setButtonLoading(
  button: HTMLButtonElement,
  options: ButtonLoadingOptions,
): ButtonLoadingHandle;

export function buttonSpinnerHtml(): string;
```

- [ ] **Step 1: Write failing unit tests**

```ts
// src/shared/button-loading.test.ts
import { describe, expect, it } from "vitest";
import { buttonSpinnerHtml, setButtonLoading } from "./button-loading";

describe("buttonSpinnerHtml", () => {
  it("returns btn-spinner span", () => {
    expect(buttonSpinnerHtml()).toContain('class="btn-spinner"');
    expect(buttonSpinnerHtml()).toContain('aria-hidden="true"');
  });
});

describe("setButtonLoading", () => {
  it("disables button, sets aria-busy, injects spinner and label", () => {
    const button = document.createElement("button");
    button.innerHTML = "<span>Save</span>";
    button.className = "btn btn-secondary";

    const handle = setButtonLoading(button, { label: "Saving…", spinner: true });

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-loading")).toBe(true);
    expect(button.innerHTML).toContain("btn-spinner");
    expect(button.textContent).toContain("Saving…");

    handle.clear();
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.classList.contains("is-loading")).toBe(false);
    expect(button.innerHTML).toBe("<span>Save</span>");
  });

  it("escapes label text", () => {
    const button = document.createElement("button");
    setButtonLoading(button, { label: `<img src=x onerror=alert(1)>`, spinner: false });
    expect(button.innerHTML).not.toContain("<img");
    expect(button.textContent).toContain("<img");
  });
});
```

Vitest DOM: project already uses happy-dom or jsdom via vitest config — check `vitest.config.ts` / `vitest.shared.ts`. If no DOM, use `document` from existing test setup (see other DOM tests e.g. `test/content/drawing-overlay.test.ts`).

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run src/shared/button-loading.test.ts -v`

Expected: FAIL module not found

- [ ] **Step 3: Implement helper**

```ts
// src/shared/button-loading.ts
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buttonSpinnerHtml(): string {
  return `<span class="btn-spinner" aria-hidden="true"></span>`;
}

export function setButtonLoading(
  button: HTMLButtonElement,
  options: { label: string; spinner?: boolean; loadingClass?: string },
): { clear: () => void } {
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
      if (prev.busy == null) button.removeAttribute("aria-busy");
      else button.setAttribute("aria-busy", prev.busy);
      if (!prev.hadLoadingClass) button.classList.remove(loadingClass);
    },
  };
}
```

If `escapeHtml` already exists in a shared module used by popup, import it instead of duplicating — grep `function escapeHtml` under `src/shared/`.

- [ ] **Step 4: Tokenize spinner CSS**

In `shared/theme.css`, replace hardcoded white borders:

```css
.btn-spinner {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: gn-spin 0.7s linear infinite;
}

.btn.is-loading {
  opacity: 0.85;
  cursor: progress;
}
```

Keep `.btn-stop.is-loading` or fold into `.btn.is-loading`.

Optionally alias player spinner animation to `gn-spin` in `player/player.css` to avoid two keyframe names (cosmetic).

- [ ] **Step 5: Wire popup stop loading to helper where low-risk**

In `src/popup/popup.ts`:

```ts
import { buttonSpinnerHtml } from "../shared/button-loading";

function getLoadingIcon(): string {
  return buttonSpinnerHtml();
}
```

Do not force a full rewrite of `renderStopAndUploadLoading` in this task if it sets many unrelated UI bits — only share the spinner HTML. Full handle-based refactor can wait until Task 4 if stop flow is special-cased.

- [ ] **Step 6: Run tests + lint**

Run:

```bash
npx vitest run src/shared/button-loading.test.ts -v
npm run lint
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/button-loading.ts src/shared/button-loading.test.ts shared/theme.css src/popup/popup.ts player/player.css
git commit -m "feat(ui): add shared button loading helper and tokenized spinner"
```

---

### Task 4: Extension surface busy indicators (storage-auth, feedback, annotate, checkingTab)

**Files:**
- Modify: `src/storage-auth/storage-auth.ts`, `storage-auth/storage-auth.html`
- Modify: `src/shared/feedback-ui.ts`
- Modify: `src/annotate/annotate.ts` (+ annotate HTML/CSS if status needs spinner)
- Modify: `src/popup/popup.ts` (`refreshActiveTabRecordingAvailability` / start button while checking)
- Test: `src/shared/feedback.test.ts` (extend if it covers UI); add focused tests where pure logic exists

**Interfaces:**
- Consumes: `setButtonLoading` from Task 3
- Produces: visible spinner + disabled controls during connect/disconnect/submit/save/tab-check

- [ ] **Step 1: Feedback submit uses spinner**

In `src/shared/feedback-ui.ts` `handleSubmit`:

```ts
import { setButtonLoading } from "./button-loading";

// replace bare textContent assignment:
const loading = setButtonLoading(submitBtn, {
  label: labels.sending,
  spinner: true,
});
// in finally / both success and error paths before re-enable:
loading.clear();
// then re-apply disabled=false and restore idle label via existing logic
```

Careful: `setOpen(false)` on success may unmount — call `clear()` before hide, or skip clear if button is gone.

- [ ] **Step 2: storage-auth busy status shows spinner**

In `render()` when `busy`:

```ts
status.classList.add("is-busy");
status.innerHTML = `${buttonSpinnerHtml()}<span>${
  currentLanguage === "vi" ? "Đang xử lý…" : "Working…"
}</span>`;
```

CSS in `storage-auth/storage-auth.html` (or shared theme):

```css
.provider-card .status.is-busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.provider-card .status .btn-spinner {
  width: 12px;
  height: 12px;
}
```

Disable connect/disconnect buttons while that provider is in `busyProviders` (likely already done — verify and keep).

Ensure `storage-auth` page loads `shared/theme.css` (or duplicate spinner rules only if theme is not linked — prefer linking theme).

- [ ] **Step 3: Annotate save busy + i18n empty**

Add EN/VI maps (mirror popup pattern if annotate already has language):

```ts
const emptyCopy = currentLanguage === "vi" ? "Chưa có chú thích." : "Nothing annotated yet.";
empty.textContent = emptyCopy;
```

On package/upload save:

```ts
const loading = setButtonLoading(elements.save /* or primary upload btn */, {
  label: currentLanguage === "vi" ? "Đang tải lên…" : "Uploading…",
  spinner: true,
});
try {
  // existing save
} finally {
  loading.clear();
}
```

Keep `setStatus(...)` text as secondary awareness.

- [ ] **Step 4: Popup Start while checking tab**

In `refreshActiveTabRecordingAvailability`, while check is in flight and not recording, mark Start button:

```ts
// at start, if idle + connected:
if (!latestPopupState?.recording?.isRecording && toggleBtn) {
  toggleBtn.disabled = true;
  toggleBtn.setAttribute("aria-busy", "true");
  // optional: small spinner only if updateRecordingUI won't immediately overwrite
}
// in finally path of check, updateRecordingUI already runs — ensure it clears aria-busy when idle
```

Minimal approach (preferred): set a flag `activeTabRecordingCheckInFlight = true`, and in `updateRecordingUI` when idle:

```ts
const checking = activeTabRecordingCheckInFlight;
toggleBtn.disabled = checking || !canStart;
if (checking) {
  toggleBtn.setAttribute("aria-busy", "true");
  setButtonLabel(toggleBtn, getLoadingIcon(), t("actions.start")); // or a "Checking…" label if i18n key added
} else {
  toggleBtn.removeAttribute("aria-busy");
  // existing start label
}
```

Add i18n only if label changes: e.g. `actions.checkingTab` EN/VI. Prefer keeping Start label + spinner over new copy.

- [ ] **Step 5: Run tests + lint**

```bash
npx vitest run src/shared/button-loading.test.ts src/shared/feedback.test.ts -v
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/storage-auth/storage-auth.ts storage-auth/storage-auth.html src/shared/feedback-ui.ts src/annotate/annotate.ts src/popup/popup.ts
git commit -m "feat(extension): consistent busy spinners on auth, feedback, annotate, popup"
```

---

### Task 5: Empty-state consistency (session queue + shared empty cards)

**Files:**
- Modify: `src/popup/popup.ts` (`renderSessions` ~744–781)
- Modify: `popup/popup.css` / `shared/theme.css` if needed for `.session-empty`
- Test: none dedicated — add a small pure render test only if session list HTML is extractable; otherwise manual + lint

**Interfaces:**
- Consumes: i18n keys `session.empty` (already defined EN/VI ~107, ~213)
- Produces: either visible empty card when queue section is shown empty, **or** delete dead CSS/i18n if product decision is “hide section when empty”

**Decision (lock in):** Keep **hide section when empty** (current product behavior for compact popup). Remove dead code to reduce confusion:

- Delete unused i18n keys `session.empty` if nothing references them after audit
- Delete or keep `.session-empty` CSS only if still used elsewhere; grep first

If product prefers empty card instead: show section always and render:

```ts
sessionList.innerHTML = `<div class="session-empty">${escapeHtml(t("session.empty"))}</div>`;
sessionQueueSection.classList.remove("hidden");
```

**Default for this plan: remove dead `session.empty` keys and unused `.session-empty` rules** after grep confirms no live render path. Document decision in commit message.

- [ ] **Step 1: Grep usages**

```bash
rg "session\.empty|session-empty" -n .
```

- [ ] **Step 2: Remove or wire based on grep**

Implement the chosen path above with no leftover dead strings.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add -A src/popup/popup.ts popup/popup.css shared/theme.css
git commit -m "chore(popup): resolve dead session empty-state (hide section)"
```

---

### Task 6: Player password unlock busy polish

**Files:**
- Modify: `player/player.js` (`setPasswordPromptBusy` ~1540–1548)
- Modify: `player/player.css` (password submit button spinner layout if needed)
- Test: none automated unless extracting pure helper — manual smoke

**Interfaces:**
- Consumes: `setPasswordPromptBusy(isBusy)`
- Produces: spinner + `aria-busy` on unlock button while decrypting

- [ ] **Step 1: Enhance `setPasswordPromptBusy`**

```js
function setPasswordPromptBusy(isBusy) {
  passwordPromptBusy = isBusy;
  if (elements.passwordInput) {
    elements.passwordInput.disabled = isBusy;
  }
  if (elements.passwordSubmit) {
    elements.passwordSubmit.disabled = isBusy;
    elements.passwordSubmit.setAttribute("aria-busy", isBusy ? "true" : "false");
    if (isBusy) {
      elements.passwordSubmit.innerHTML = `${/* spinner html identical to btn-spinner */}<span></span>`;
      elements.passwordSubmit.querySelector("span").textContent = t("password.unlocking");
      elements.passwordSubmit.classList.add("is-loading");
    } else {
      elements.passwordSubmit.textContent = t("password.unlock");
      elements.passwordSubmit.classList.remove("is-loading");
      elements.passwordSubmit.removeAttribute("aria-busy");
    }
  }
}
```

Player cannot import TS module directly — **inline the same spinner markup string** as `buttonSpinnerHtml()` returns, or attach a tiny `window.gnUi` only if already a pattern (prefer inline duplicate one-liner to avoid new player/extension bridge).

Ensure password button has class `btn` if theme spinner expects it; else add player-local CSS:

```css
#recording-password-submit.is-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: progress;
}
#recording-password-submit .btn-spinner {
  /* same as theme or inherit */
}
```

- [ ] **Step 2: Manual smoke** — wrong password restores button; correct password transitions to loading state.

- [ ] **Step 3: Commit**

```bash
git add player/player.js player/player.css
git commit -m "fix(player): spinner and aria-busy on password unlock"
```

---

### Task 7: Optional content skeleton (player log panes only if justified)

**Files:**
- Modify: `player/player.css`, `player/player.js`, optionally both HTML shells
- Test: parity ids if new DOM nodes

**YAGNI gate:** Only implement if after Task 1, users still stare at a blank player chrome for >300ms after download completes (zip parse / JSON hydrate). Profile once manually. If parse is instant, **skip this task entirely** and mark cancelled in the plan checklist.

If proceeding:

- [ ] **Step 1: Add CSS**

```css
.gn-skeleton {
  border-radius: 6px;
  background: linear-gradient(
    90deg,
    var(--border-subtle) 0%,
    var(--bg-card-hover) 50%,
    var(--border-subtle) 100%
  );
  background-size: 200% 100%;
  animation: gn-skeleton-shimmer 1.2s ease-in-out infinite;
}
@keyframes gn-skeleton-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
.gn-skeleton-row { height: 14px; margin: 8px 12px; }
.gn-skeleton-row.w-80 { width: 80%; }
.gn-skeleton-row.w-60 { width: 60%; }
```

Prefer putting keyframes in `shared/theme.css` if multiple surfaces need it.

- [ ] **Step 2: Show 4–6 skeleton rows in console/network viewers between `showPlayer()` start and first `renderConsoleEntries` completion** — or a single `isHydrating` flag cleared after initial renders in `showPlayer`.

```js
function renderPaneSkeleton(container) {
  if (!container) return;
  container.innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<div class="gn-skeleton gn-skeleton-row ${i % 2 ? "w-60" : "w-80"}" aria-hidden="true"></div>`
  ).join("");
  container.setAttribute("aria-busy", "true");
}
```

Clear `aria-busy` when real content renders.

- [ ] **Step 3: Skip skeleton when entry arrays are already in memory (common case after sync parse).**

- [ ] **Step 4: Commit only if shipped**

```bash
git commit -m "feat(player): optional shimmer placeholders during log hydrate"
```

---

### Task 8: Unify spinner keyframes + orphan drive-auth note + docs

**Files:**
- Modify: `player/player.css` (`@keyframes spin` → `gn-spin` or re-export)
- Modify: `docs/modules/replay-player.md` (Package Loading / UI states)
- Modify: `docs/features/extension-surfaces.md` (busy/empty patterns)
- Optional: `drive-auth/drive-auth.html` — leave redirect stub; do not revive orphan loading UI

- [ ] **Step 1: Deduplicate keyframes**

In `player/player.css`:

```css
.spinner {
  ...
  animation: gn-spin 1s linear infinite;
}
/* remove local @keyframes spin if gn-spin is available via theme.css import order */
```

Verify player HTML links `shared/theme.css` (or standalone public theme). If player does **not** load theme, keep local `@keyframes gn-spin` copy in `player.css` with the same name.

- [ ] **Step 2: Docs — replay player**

Add under Package Loading:

```markdown
## Loading UI state machine

Mutually exclusive shells: `loading-state` | `password-state` | `error-state` | `intro-state` | `player-state`.

- HTML default: loading visible, intro hidden (extension + standalone parity).
- No replay params → `showIntro()`.
- Replay/direct params → `showLoading()` before network I/O; progress via `loadingProgressEntries` + determinate bar (`role=progressbar`).
- Password packages → `showPasswordPrompt()`; after unlock → `showLoading()` then parse.
- Success → `showPlayer()`; failure → `showError()`.
```

- [ ] **Step 3: Docs — extension surfaces**

Document:

- Stop & Upload: `.btn-spinner` + `aria-busy`
- Upload queue: determinate bars with progressbar semantics
- storage-auth / feedback / annotate: shared button-loading pattern
- Empty history: `upload-history-ui` empty card
- Session queue: hidden when empty

- [ ] **Step 4: Run full verification**

```bash
npx vitest run player/player-html-parity.test.ts src/shared/button-loading.test.ts src/shared/feedback.test.ts -v
npm test
npm run lint
```

If player assets must sync:

```bash
# check Taskfile / DEVELOPER.md for exact command, e.g.:
node player-standalone/scripts/sync-player.js
```

- [ ] **Step 5: Commit**

```bash
git add player/player.css docs/modules/replay-player.md docs/features/extension-surfaces.md
git commit -m "docs(ui): document loading state machine and unify spinner tokens"
```

---

## Evaluation rubric (do this before/after implementation)

Use as acceptance criteria for the whole effort:

| # | Criterion | How to verify | Target |
|---|-----------|---------------|--------|
| E1 | Extension player with replay URL never shows intro during download | Manual + code path calls `showLoading` | Pass |
| E2 | Standalone + extension loading/intro default classes match | `player-html-parity.test.ts` | Pass |
| E3 | Loading bar has live `aria-valuenow` | Inspect DOM during load | Pass |
| E4 | Popup upload bar has progressbar role | Inspect DOM during upload | Pass |
| E5 | storage-auth connect shows spinner | Manual | Pass |
| E6 | Feedback submit shows spinner | Manual | Pass |
| E7 | Annotate upload shows spinner; empty list i18n | Manual EN/VI | Pass |
| E8 | Password unlock shows spinner + aria-busy | Manual | Pass |
| E9 | No new framework deps | `package.json` diff | Pass |
| E10 | Lint + unit tests green | `npm run lint && npm test` | Pass |
| E11 | Dead `session.empty` resolved | rg clean or wired | Pass |
| E12 | Docs updated | replay-player + extension-surfaces | Pass |

**Baseline snapshot (pre-work):** Record in PR description: “extension intro flash: yes/no; surfaces with spinner: stop-only; skeleton: none.”

---

## Self-Review

**1. Spec coverage (user ask: evaluate + finish awareness/skeleton/loading for extensions, pages, player)**

| Ask | Tasks |
|-----|-------|
| Evaluate | Rubric + file structure audit (this plan) |
| Awareness (status/empty/busy messaging) | Tasks 4, 5, 6 |
| Skeleton | Task 7 (optional gated) + explicit non-goals |
| Loading | Tasks 1–4, 6, 8 |
| Extensions | Tasks 3–5 |
| Pages (standalone/hosted) | Tasks 1–2, 8 (player-standalone parity + sync) |
| Player | Tasks 1, 2, 6, 7, 8 |

**2. Placeholder scan:** No TBD/TODO steps; code blocks are concrete; optional Task 7 has explicit skip gate.

**3. Type consistency:** `setButtonLoading` / `buttonSpinnerHtml` names stable across Tasks 3–4; player keeps string spinner (no TS import). Progress a11y uses `loadingProgressBar` element name consistently.

**4. Non-goals restated:** No multi-user presence, no React Skeleton, no resurrecting drive-auth full-page loader, no Next.js `loading.tsx`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-loading-skeleton-awareness.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
