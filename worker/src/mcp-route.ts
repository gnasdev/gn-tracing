/**
 * Compatibility re-exports for the remote MCP zone.
 * Prefer importing from `./zones/mcp/handler` in new code.
 */

export {
  createRemoteRecordingStore,
  handleMcpRequest,
  isMcpEnabled,
  isMcpPath,
  MAX_REMOTE_ENTRY_BYTES,
  MAX_REMOTE_PACKAGE_BYTES,
  MCP_SERVER_INFO,
  type McpEnv,
  mcpCorsHeaders,
} from "./zones/mcp/handler";
