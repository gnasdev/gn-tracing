/**
 * Delays reload notification until every extension bundling context has a
 * successful result. A static-only update also waits for that same baseline.
 */
export function createDevExtensionReloadGate(notify) {
  const buildStates = new Map();

  const isReady = () => buildStates.size > 0 && [...buildStates.values()].every(Boolean);

  const notifyIfReady = () => {
    if (isReady()) {
      notify();
    }
  };

  return {
    register(buildKey) {
      buildStates.set(buildKey, false);
    },
    begin(buildKey) {
      buildStates.set(buildKey, false);
    },
    report(buildKey, hasErrors) {
      buildStates.set(buildKey, !hasErrors);
      notifyIfReady();
    },
    notifyStaticAssets() {
      notifyIfReady();
    },
  };
}
