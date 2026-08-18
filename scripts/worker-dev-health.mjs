/**
 * Exit 0 only when the local OAuth Worker owns its expected health endpoint.
 *
 * A TCP listener on :63972 is not enough: another local service could occupy the
 * port and receive the extension's credential-free OAuth exchange request.
 *
 * Usage: node scripts/worker-dev-health.mjs [health-url]
 */

import { pathToFileURL } from "node:url";

const DEFAULT_HEALTH_URL = "http://localhost:63972/health";
const EXPECTED_SERVICE = "gn-tracing-oauth-proxy";
const HEALTH_TIMEOUT_MS = 700;

export async function isGnTracingOauthWorker(healthUrl = DEFAULT_HEALTH_URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }

    const body = await response.json();
    return body?.ok === true && body.service === EXPECTED_SERVICE;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exit((await isGnTracingOauthWorker(process.argv[2])) ? 0 : 1);
}
