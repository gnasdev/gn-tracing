import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 63973;
const SERVICE_NAME = "gn-tracing-dev-extension-reload";
const RELOAD_TARGETS = new Set(["chrome", "edge", "opera", "firefox"]);
const WAIT_TIMEOUT_MS = 25_000;

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Request body must be JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isExtensionOrigin(origin) {
  return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
}

function isReloadTarget(value) {
  return typeof value === "string" && RELOAD_TARGETS.has(value);
}

/**
 * Coordinates build revisions between development watchers and loaded extensions.
 * Every browser target has an independent revision so a Chrome-only rebuild never
 * restarts a Firefox extension.
 */
export async function createDevExtensionReloadCoordinator(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const revisions = new Map(Array.from(RELOAD_TARGETS, (target) => [target, 0]));
  const waiters = new Map(Array.from(RELOAD_TARGETS, (target) => [target, new Set()]));
  let server;

  const revisionFor = (target) => String(revisions.get(target) || 0);

  const notify = (target) => {
    const nextRevision = (revisions.get(target) || 0) + 1;
    revisions.set(target, nextRevision);
    const payload = { target, revision: String(nextRevision) };
    for (const waiter of waiters.get(target) || []) {
      clearTimeout(waiter.timeout);
      writeJson(waiter.response, 200, payload);
    }
    waiters.get(target)?.clear();
    return payload;
  };

  const handleWait = (request, response, url) => {
    const target = url.searchParams.get("target");
    const knownRevision = url.searchParams.get("revision") || "";
    if (!isReloadTarget(target)) {
      writeJson(response, 400, { ok: false, error: "invalid_target" });
      return;
    }

    const currentRevision = revisionFor(target);
    if (knownRevision !== currentRevision) {
      writeJson(response, 200, { target, revision: currentRevision });
      return;
    }

    const waiter = { response, timeout: null };
    const removeWaiter = () => {
      clearTimeout(waiter.timeout);
      waiters.get(target)?.delete(waiter);
    };
    waiter.timeout = setTimeout(() => {
      waiters.get(target)?.delete(waiter);
      writeJson(response, 200, { target, revision: revisionFor(target) });
    }, WAIT_TIMEOUT_MS);
    waiters.get(target)?.add(waiter);
    request.once("close", removeWaiter);
  };

  const requestListener = async (request, response) => {
    const origin = request.headers.origin || "";
    if (origin && !isExtensionOrigin(origin)) {
      writeJson(response, 403, { ok: false, error: "forbidden_origin" });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    const url = new URL(request.url || "/", `http://${host}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: SERVICE_NAME });
      return;
    }
    if (request.method === "GET" && url.pathname === "/wait") {
      handleWait(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/notify") {
      try {
        const body = await readJson(request);
        if (!isReloadTarget(body?.target)) {
          writeJson(response, 400, { ok: false, error: "invalid_target" });
          return;
        }
        writeJson(response, 200, { ok: true, ...notify(body.target) });
      } catch (error) {
        writeJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "invalid_request",
        });
      }
      return;
    }
    writeJson(response, 404, { ok: false, error: "not_found" });
  };

  return {
    async start() {
      if (server) {
        const address = server.address();
        return { origin: `http://${host}:${address.port}` };
      }
      server = createServer(requestListener);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Dev extension reload coordinator did not expose a TCP port.");
      }
      return { origin: `http://${host}:${address.port}` };
    },
    async stop() {
      for (const targetWaiters of waiters.values()) {
        for (const waiter of targetWaiters) {
          clearTimeout(waiter.timeout);
          waiter.response.destroy();
        }
        targetWaiters.clear();
      }
      if (!server) return;
      const currentServer = server;
      server = undefined;
      await new Promise((resolve, reject) =>
        currentServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function checkHealth(port) {
  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/health`);
    const body = await response.json();
    return response.ok && body?.ok === true && body.service === SERVICE_NAME;
  } catch {
    return false;
  }
}

async function runCli() {
  const portIndex = process.argv.indexOf("--port");
  const requestedPort = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
  if (process.argv.includes("--health")) {
    process.exit((await checkHealth(port)) ? 0 : 1);
  }

  const coordinator = await createDevExtensionReloadCoordinator({ port });
  const { origin } = await coordinator.start();
  console.log(`[dev:reload] ${SERVICE_NAME} listening on ${origin}`);
  const stop = async () => {
    await coordinator.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().catch((error) => {
    console.error(`[dev:reload] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
