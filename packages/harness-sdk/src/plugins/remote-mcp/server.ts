import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Data } from 'effect';

import type { RemoteMcpTool } from './client.js';

/**
 * A remote MCP server, and what can go wrong reaching it.
 *
 * The plugin talks to a server the caller named, over the Streamable HTTP
 * transport. Nothing here is specific to one server: the values below are the
 * whole of what a caller hands over, and a caller with two servers writes two
 * of them.
 *
 * The tools a server offers are named `mcp_<server>_<tool>` in this harness, so
 * a model that reads a transcript sees which server it called. That is why the
 * id is the caller's and not the server's own name: it is part of every tool
 * name the model is given.
 */

/**
 * How a server is authorized.
 *
 * `bearer` sends `Authorization: Bearer <token>` on every request. The token is
 * not here — the client asks an accessor for it, so a credential that expires
 * is refreshed per call without anything in this file knowing how.
 *
 * `oauth` hands the caller's `authProvider` to the transport: the library adds
 * the stored access token, refreshes it on a 401, and fails `unauthorized` when
 * only a person can sign in again (`remoteMcpSignIn`).
 */
type RemoteMcpAuth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer' }
  | { readonly type: 'oauth' };

/**
 * One server the harness may reach.
 *
 * `id` is stable and part of every tool name a model sees, so it matches
 * `[A-Za-z0-9_-]+`; `name` is what a person reads in a description. `headers`
 * carries anything else the server asks for and is sent beside the credential.
 */
interface RemoteMcpServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth: RemoteMcpAuth;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Why a remote server did not answer. */
type RemoteMcpFailure = 'unreachable' | 'unauthorized' | 'missing' | 'protocol';

/**
 * A remote MCP server could not be reached, refused the credential, is not
 * there any more, or answered something the protocol does not allow.
 *
 * `cause` is whatever the transport or the client library threw. The credential
 * is never in a message and never in a log: it is not thrown, not caught, and
 * not named here.
 *
 * A failure of this kind reaches the model as a failed tool result, so a server
 * that refuses a token or disappears mid-chat leaves the conversation usable
 * and says what happened.
 */
class RemoteMcpError extends Data.TaggedError('harness/RemoteMcpError')<{
  readonly serverId: string;
  readonly kind: RemoteMcpFailure;
  readonly cause: unknown;
}> {}

/** What the model reads when a remote tool did not answer. */
const wordsOf: Readonly<Record<RemoteMcpFailure, string>> = {
  unreachable: 'The remote server could not be reached. It may be down or the network may be gone.',
  unauthorized: 'The remote server refused this session’s credential.',
  missing: 'The remote server is not there any more. It may have been removed or moved.',
  protocol: 'The remote server answered something the protocol does not allow.',
};

/**
 * Why a call failed, in the words the model gets. A refusal from the server
 * itself already carries its own words, and they are more use than anything
 * this file could write about it.
 */
const explain = (error: RemoteMcpError): string =>
  error.kind === 'protocol' && typeof error.cause === 'string' ? error.cause : wordsOf[error.kind];

/**
 * Whether a server id or a tool name may be part of a tool name.
 *
 * A model calls a tool by name, and a name it cannot write is a tool it cannot
 * call, so anything outside this set is skipped rather than mangled.
 */
const callableName = (name: string): boolean => /^[A-Za-z0-9_-]+$/u.test(name);

/** The name the model is offered a remote tool under. */
const mcpToolName = (server: RemoteMcpServer, tool: string): string => `mcp_${server.id}_${tool}`;

/**
 * The MCP Apps view a tool's metadata names, if it names one.
 *
 * The official bridge package reads the metadata (`_meta.ui.resourceUri`, with
 * the deprecated flat `_meta['ui/resourceUri']` beside it) and throws when a
 * value is there but is not a `ui://` uri. A tool's metadata is a fact this
 * host reports, not a contract it enforces — a server that writes something
 * else there has a tool with no view, not a broken server — so the throw is
 * read as no view.
 */
const uiResourceUriOf = (tool: Pick<RemoteMcpTool, '_meta'>): string | undefined => {
  try {
    return getToolUiResourceUri(tool);
  } catch {
    return undefined;
  }
};

export type { RemoteMcpAuth, RemoteMcpFailure, RemoteMcpServer };
export { callableName, explain, mcpToolName, RemoteMcpError, uiResourceUriOf };
