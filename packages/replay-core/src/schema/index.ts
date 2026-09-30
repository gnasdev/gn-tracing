/**
 * `@gn-tracing/replay-core/schema` — the recording format itself.
 *
 * Producers (extension packager, browser SDK) and readers (player, MCP servers,
 * Worker route) both depend on this module and on nothing else of each other.
 * Keep it free of I/O: types, constants, and total functions over them only.
 */

export * from "./annotation";
export * from "./capture";
export * from "./package";
export * from "./privacy";
