import { createSignal } from "solid-js";
import { t } from "../i18n";
import { loadFromLocation, openLocalFile } from "../package/load-package";
import { session } from "../store/session";

export function PasswordPrompt(props: { pendingFile?: File | null }) {
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    try {
      if (props.pendingFile) {
        await openLocalFile(props.pendingFile, password());
      } else if (session.recordingId) {
        await loadFromLocation(password());
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="password-state" id="password-state">
      <form class="password-card" onSubmit={(e) => void submit(e)}>
        <h2>{t("password.title") || "Password required"}</h2>
        <p class="password-message">{session.passwordMessage}</p>
        <label class="password-field">
          <span>{t("password.label") || "Package password"}</span>
          <input
            type="password"
            autocomplete="current-password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            disabled={busy()}
          />
        </label>
        <button type="submit" class="btn btn-primary" disabled={busy()}>
          {busy() ? t("password.unlocking") || "Unlocking…" : t("password.unlock") || "Unlock"}
        </button>
      </form>
    </div>
  );
}
