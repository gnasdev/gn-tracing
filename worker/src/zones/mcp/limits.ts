/** Worker memory is limited; a package over this must be read locally. */
export const MAX_REMOTE_PACKAGE_BYTES = 24 * 1024 * 1024;
/**
 * Per-artifact inflate ceiling, forwarded to the package reader.
 *
 * Without it the reader's 32 MB default applies, and a highly compressible
 * `console.json` behind a public link can inflate to that inside a 128 MB
 * isolate — then be parsed and re-serialized on top. A JSON artifact this large
 * would exceed the response budget anyway.
 */
export const MAX_REMOTE_ENTRY_BYTES = 8 * 1024 * 1024;
/** Request body ceiling, checked against the bytes actually read. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
/**
 * Most JSON-RPC messages accepted in one POST body.
 *
 * MCP `2025-06-18` — the version this server advertises as its default —
 * removed JSON-RPC batching and requires the POST body to be a single request,
 * notification, or response. Arrays are still accepted here as a deliberate
 * superset for `2025-03-26` and `2024-11-05` clients, so this cap costs a
 * spec-current client nothing.
 *
 * The number bounds work per rate-limit token rather than expressing a client
 * need: one 64 KB body holds roughly a thousand `tools/call` entries, each able
 * to trigger its own upstream package fetch, and the per-IP limit is charged
 * once for the whole body. 32 is far above any real client's batch and far
 * below the point where one request can monopolise an isolate.
 */
export const MAX_BATCH_MESSAGES = 32;
