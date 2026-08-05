/**
 * Exit 0 when a TCP port is already accepting connections, else 1.
 *
 * Used by `task player:dev` / `task worker:dev` so the shared dev services can be
 * reused instead of colliding. Without it, running `task dev BROWSER=chrome` and
 * `task dev BROWSER=firefox` side by side kills the second stack: both try to
 * bind the player (:5176) and the Worker (:8787), which are per-repo, not
 * per-browser-target.
 *
 * Both loopback families are probed, because dev servers differ on which one they
 * bind: Vite listens on `[::1]` only, while workerd binds `127.0.0.1` and `[::1]`.
 * Probing just one would report a running Vite as absent.
 *
 * Usage: node scripts/port-listening.mjs <port> [host ...]
 * Deliberately dependency-free and quiet — callers branch on the exit code.
 */

import net from "node:net";

const CONNECT_TIMEOUT_MS = 700;
const DEFAULT_HOSTS = ["127.0.0.1", "::1"];

function parsePort(raw) {
  const port = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`port-listening: invalid port ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return port;
}

/** Resolves true when something accepts a connection at host:port. */
function isListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    // ECONNREFUSED / EAFNOSUPPORT / EHOSTUNREACH: nothing usable on this family.
    socket.once("error", () => finish(false));
  });
}

const port = parsePort(process.argv[2]);
const hosts = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_HOSTS;

const results = await Promise.all(hosts.map((host) => isListening(host, port)));
process.exit(results.some(Boolean) ? 0 : 1);
