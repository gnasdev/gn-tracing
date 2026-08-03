/**
 * ARCHIVED Solid shell — not production. See `main.tsx`.
 */
import { Match, onMount, Switch } from "solid-js";
import { ErrorState } from "./components/ErrorState";
import { Intro } from "./components/Intro";
import { Loading } from "./components/Loading";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { PlayerShell } from "./components/PlayerShell";
import { language } from "./i18n";
import { loadFromLocation } from "./package/load-package";
import { session } from "./store/session";

export default function App() {
  void language();

  onMount(() => {
    void loadFromLocation();
  });

  return (
    <div id="app" class="gn-player-app">
      <Switch fallback={<Intro />}>
        <Match when={session.phase === "intro"}>
          <Intro />
        </Match>
        <Match when={session.phase === "loading"}>
          <Loading />
        </Match>
        <Match when={session.phase === "password"}>
          <PasswordPrompt />
        </Match>
        <Match when={session.phase === "error"}>
          <ErrorState />
        </Match>
        <Match when={session.phase === "player"}>
          <PlayerShell />
        </Match>
      </Switch>
    </div>
  );
}
