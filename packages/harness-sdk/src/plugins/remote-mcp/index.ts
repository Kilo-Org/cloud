import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  permissiveJsonSchemaValidator,
  remoteMcpClient,
  type RemoteMcpClient,
  type RemoteMcpClientDeps,
  type RemoteMcpTool,
} from './client.js';
import {
  remoteMcpSignIn,
  type RemoteMcpSignInDeps,
  type RemoteMcpSignInProvider,
} from './sign-in.js';
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
 * it ships the Streamable HTTP transport, every request and response schema,
 * and OAuth (discovery, registration, PKCE, refresh), so nothing here
 * re-implements JSON-RPC, SSE or OAuth. The one thing a runtime must supply is
 * its `fetch`, and for an `oauth` server a provider that keeps its tokens. The
 * library's OAuth types are re-exported under this plugin's names so that
 * provider can be written without a second copy of the library.
 */

export type {
  OAuthClientInformationMixed as RemoteMcpOAuthClient,
  OAuthClientMetadata as RemoteMcpOAuthClientMetadata,
  OAuthClientProvider as RemoteMcpOAuthProvider,
  OAuthTokens as RemoteMcpOAuthTokens,
  RemoteMcpAuth,
  RemoteMcpClient,
  RemoteMcpClientDeps,
  RemoteMcpFailure,
  RemoteMcpServer,
  RemoteMcpSignInDeps,
  RemoteMcpSignInProvider,
  RemoteMcpTool,
};
export {
  callableName,
  explain,
  mcpToolName,
  permissiveJsonSchemaValidator,
  RemoteMcpError,
  remoteMcpClient,
  remoteMcpSignIn,
  remoteMcpTools,
};
