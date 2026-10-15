import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { RemoteMcpError, type RemoteMcpFailure, type RemoteMcpServer } from './server.js';

/** Whether a thrown value is one of the library's own schema refusals. */
const isSchemaError = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === 'ZodError';

/**
 * What a failure was, read off the library rather than off a status of our own.
 *
 * The transport throws `StreamableHTTPError` carrying the status, and
 * `UnauthorizedError` when an OAuth server needs a person to sign in. Anything
 * else — a dropped connection, an abort, a refused stream — is a server that
 * could not be reached, the only honest reading of a rejection with nothing in
 * it.
 */
const kindOf = (cause: unknown): RemoteMcpFailure => {
  if (cause instanceof UnauthorizedError) {
    return 'unauthorized';
  }
  if (cause instanceof StreamableHTTPError) {
    if (cause.code === 401 || cause.code === 403) {
      return 'unauthorized';
    }
    if (cause.code === 404 || cause.code === 410) {
      return 'missing';
    }
    return 'unreachable';
  }
  return cause instanceof McpError || isSchemaError(cause) ? 'protocol' : 'unreachable';
};

const failed = (server: RemoteMcpServer, cause: unknown): RemoteMcpError =>
  new RemoteMcpError({ serverId: server.id, kind: kindOf(cause), cause });

export { failed };
