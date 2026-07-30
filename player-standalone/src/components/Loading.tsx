import { language, t } from "../i18n";
import { session } from "../store/session";

export function Loading() {
  // touch language for re-render when i18n changes
  void language();
  return (
    <div class="loading-state" id="loading-state">
      <div class="loading-card">
        <div class="loading-spinner" aria-hidden="true" />
        <p id="loading-message" class="loading-message">
          {session.loadingMessage || t("loading.message")}
        </p>
        <div class="loading-progress-bar" id="loading-progress-bar">
          <div class="loading-progress-fill" id="loading-progress-fill" style={{ width: "40%" }} />
        </div>
      </div>
    </div>
  );
}
