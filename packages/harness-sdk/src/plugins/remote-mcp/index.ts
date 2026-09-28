import {
  permissiveJsonSchemaValidator,
  remoteMcpClient,
  type RemoteMcpClient,
  type RemoteMcpClientDeps,
  type RemoteMcpTool,
} from './client.js';
import {
  callableName,
  explain,
  mcpToolName,
  RemoteMcpError,
  type RemoteMcpAuth,
  type RemoteMcpFailure,
  type RemoteMcpServer,
} from './server.js';
import { remoteMcpTools } from './tools.js';

/**
 * Remote MCP servers, over the transport the specification defines.
 *
 * A server is a value a caller writes down; the tools it offers are discovered
 * from it and offered to the model under `mcp_<server>_<tool>`. A failure is a
 * `RemoteMcpError` the caller can tell apart by kind, and a failure during a
 * chat reaches the model as a failed tool result rather than ending it.
 *
 * The protocol is `@modelcontextprotocol/sdk`, the MCP project's own client:
 * it ships the Streamable HTTP transport and every request and response schema,
 * so nothing here re-implements JSON-RPC or SSE. The one thing a runtime must
 * supply is its `fetch`.
 */

export type {
  RemoteMcpAuth,
  RemoteMcpClient,
  RemoteMcpClientDeps,
  RemoteMcpFailure,
  RemoteMcpServer,
  RemoteMcpTool,
};
export {
  callableName,
  explain,
  mcpToolName,
  permissiveJsonSchemaValidator,
  RemoteMcpError,
  remoteMcpClient,
  remoteMcpTools,
};
