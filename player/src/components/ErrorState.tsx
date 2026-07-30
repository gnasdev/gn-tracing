import { t } from "../i18n";
import { resetSession, session, setPhase } from "../store/session";

export function ErrorState() {
  return (
    <div class="error-state" id="error-state">
      <div class="error-card">
        <h2>{t("error.title") || "Could not open recording"}</h2>
        <p class="error-message">{session.errorMessage}</p>
        <button
          type="button"
          class="btn"
          onClick={() => {
            resetSession();
            setPhase("intro");
          }}
        >
          {t("error.back") || "Back"}
        </button>
      </div>
    </div>
  );
}
