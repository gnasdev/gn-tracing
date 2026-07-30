import { t } from "../i18n";
import { openLocalFile } from "../package/load-package";

export function Intro() {
  let fileInput: HTMLInputElement | undefined;

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    await openLocalFile(file);
  }

  return (
    <div class="intro-state player-intro" id="intro-state">
      <div class="intro-card">
        <h1>{t("intro.title") || "GN Tracing Player"}</h1>
        <p class="intro-lead">
          {t("intro.lead") || "Open a recording package (.zip) or use a share link."}
        </p>
        <div class="intro-actions">
          <button type="button" class="btn btn-primary" onClick={() => fileInput?.click()}>
            {t("intro.openFile") || "Open package"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            onChange={(e) => void onFiles(e.currentTarget.files)}
          />
        </div>
        <p class="intro-hint">
          {t("intro.hint") || "Tip: upload from the extension, then open the replay URL."}
        </p>
      </div>
    </div>
  );
}
