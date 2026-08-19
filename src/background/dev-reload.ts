export const DEV_RELOAD_REVISION_KEY = "gn_tracing_dev_reload_revision";
const RETRY_DELAY_MS = 750;

export interface DevReloadRevisionStore {
  get(): Promise<string | undefined>;
  set(revision: string): Promise<void>;
}

export interface DevReloadClientOptions {
  appEnv: string;
  browserTarget: string;
  canReload?: () => boolean;
  fetchImpl?: typeof fetch;
  reload?: () => void;
  reloadUrl: string;
  store?: DevReloadRevisionStore;
}

export function isDevReloadSafe({
  isRecording,
  sessionId,
}: Pick<{ isRecording: boolean; sessionId: string | null }, "isRecording" | "sessionId">): boolean {
  return !isRecording && sessionId === null;
}

export function createDevReloadClientStarter(start: () => void): () => boolean {
  let started = false;
  return () => {
    if (started) {
      return false;
    }
    started = true;
    start();
    return true;
  };
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function createChromeRevisionStore(): DevReloadRevisionStore {
  return {
    async get() {
      const stored = await chrome.storage.session.get(DEV_RELOAD_REVISION_KEY);
      const value = stored[DEV_RELOAD_REVISION_KEY];
      return isRevision(value) ? value : undefined;
    },
    async set(revision) {
      await chrome.storage.session.set({ [DEV_RELOAD_REVISION_KEY]: revision });
    },
  };
}

/**
 * Records the revision before calling runtime.reload so the replacement runtime
 * observes the same revision and does not enter a reload loop. The final guard
 * is deliberately adjacent to reload because recording state may change while
 * session storage is being updated.
 */
export async function applyDevReloadRevision(
  revision: string,
  {
    canReload = () => true,
    reload,
    store,
  }: Pick<Required<DevReloadClientOptions>, "reload" | "store"> &
    Pick<DevReloadClientOptions, "canReload">,
): Promise<boolean> {
  const previousRevision = await store.get();
  if (previousRevision === revision || !canReload()) {
    return false;
  }

  await store.set(revision);
  if (!canReload()) {
    await store.set(previousRevision || "");
    return false;
  }
  if (previousRevision === undefined) {
    return false;
  }

  reload();
  return true;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Starts a long-polling reload client for a development extension bundle. */
export function startDevReloadClient(options: DevReloadClientOptions): () => void {
  if (options.appEnv !== "development" || !options.reloadUrl) {
    return () => {};
  }

  const fetchImpl = options.fetchImpl || fetch;
  const reload = options.reload || (() => chrome.runtime.reload());
  const store = options.store || createChromeRevisionStore();
  const canReload = options.canReload || (() => true);
  const baseUrl = options.reloadUrl.replace(/\/+$/, "");
  let stopped = false;

  const listen = async (): Promise<void> => {
    while (!stopped) {
      try {
        const revision = (await store.get()) || "";
        const endpoint = new URL(`${baseUrl}/wait`);
        endpoint.searchParams.set("target", options.browserTarget);
        endpoint.searchParams.set("revision", revision);
        const response = await fetchImpl(endpoint, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Reload coordinator returned HTTP ${response.status}.`);
        }
        const body = (await response.json()) as { revision?: unknown; target?: unknown };
        if (body.target !== options.browserTarget || !isRevision(body.revision)) {
          throw new Error("Reload coordinator returned an invalid revision.");
        }
        if (!canReload() && (await store.get()) !== body.revision) {
          await wait(RETRY_DELAY_MS);
          continue;
        }
        await applyDevReloadRevision(body.revision, { canReload, store, reload });
      } catch {
        await wait(RETRY_DELAY_MS);
      }
    }
  };

  void listen();
  return () => {
    stopped = true;
  };
}
