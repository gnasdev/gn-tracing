/**
 * Content-script injection that does not mistake a resolved promise for success.
 *
 * MDN, scripting.executeScript(): "In Firefox and Safari, partial lack of host
 * permissions can result in a successful execution (with the partial results in
 * the resolved promise). In Chrome, any missing permission prevents any execution
 * from happening."
 *
 * So on Firefox `await executeScript(...)` can resolve while the script never ran,
 * with the reason sitting in `InjectionResult.error` for that frame. Discarding the
 * resolved array — which the recording paths used to do — turns a failed injection
 * into a silent one: the recording proceeds and its console/network evidence is
 * simply empty.
 */

/** Per-frame result shape; `error` is Firefox/Safari-only (Chrome issue 1271527). */
type InjectionResultLike = {
  frameId?: number;
  error?: { message?: string } | string | null;
  result?: unknown;
};

export type InjectionOutcome =
  /** `partialFailures` lists frames that refused, when a refusal is tolerable. */
  { ok: true; partialFailures?: string[] } | { ok: false; error: string };

function describeFrameError(entry: InjectionResultLike): string | null {
  const { error } = entry;
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return message || "injection reported an unnamed error";
}

/**
 * Collapse an executeScript result array into a single outcome.
 *
 * An empty array means no frame was injected at all, which Firefox also reports
 * without rejecting — that is a failure, not a silent success.
 *
 * `requireAllFrames: false` (the default for multi-frame injection) treats the
 * run as successful when at least one frame took the script, and returns the
 * subframe failures separately. Cross-origin and sandboxed iframes routinely
 * refuse injection, and losing one iframe must not abort a whole recording.
 */
export function summarizeInjectionResults(
  results: unknown,
  options: { requireAllFrames?: boolean } = {},
): InjectionOutcome {
  const requireAllFrames = options.requireAllFrames ?? true;

  if (!Array.isArray(results)) {
    // Some engines resolve with undefined; nothing to contradict success.
    return { ok: true };
  }
  if (results.length === 0) {
    return { ok: false, error: "no frame was injected" };
  }

  const failures: string[] = [];
  let injectedFrames = 0;
  for (const entry of results as InjectionResultLike[]) {
    const message = describeFrameError(entry ?? {});
    if (message) {
      const frame = typeof entry?.frameId === "number" ? ` (frame ${entry.frameId})` : "";
      failures.push(`${message}${frame}`);
      continue;
    }
    injectedFrames += 1;
  }

  if (failures.length === 0) {
    return { ok: true };
  }
  if (!requireAllFrames && injectedFrames > 0) {
    return { ok: true, partialFailures: failures };
  }
  return { ok: false, error: failures.join("; ") };
}

/**
 * Inject one file and report whether it actually ran.
 *
 * Never throws: a rejection and a resolved-with-error both come back as
 * `{ ok: false, error }` so callers handle one shape.
 *
 * `allFrames` matters for evidence completeness: without it only the top
 * document is instrumented, so every iframe's console and network traffic is
 * invisible — a gap Chromium does not have, because CDP attaches to the whole
 * tab.
 */
export async function injectScriptFile(input: {
  tabId: number;
  file: string;
  world?: "ISOLATED" | "MAIN";
  allFrames?: boolean;
}): Promise<InjectionOutcome> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: input.tabId, ...(input.allFrames ? { allFrames: true } : {}) },
      files: [input.file],
      ...(input.world ? { world: input.world } : {}),
    } as Parameters<typeof chrome.scripting.executeScript>[0]);
    // With allFrames, a refusing iframe must not fail the whole injection.
    return summarizeInjectionResults(results, { requireAllFrames: !input.allFrames });
  } catch (error) {
    return { ok: false, error: (error as Error)?.message || String(error) };
  }
}
