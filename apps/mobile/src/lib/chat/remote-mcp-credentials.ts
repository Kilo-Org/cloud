import { Effect } from 'effect';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { remoteMcpOAuthProvider } from './remote-mcp-oauth-provider';
import { listRemoteMcpServers, type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * How a stored server is handed to the SDK: the server value, and the
 * credential source its auth names. The token is never held here: it is read
 * from the stored server by id each time the accessor is asked, so a rotated
 * one is used rather than the one captured at discovery.
 */

/** The server as the SDK knows it: an id, a name, a URL and how it wants a credential. */
export function serverValue(server: StoredRemoteMcpServer): RemoteMcpServer {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    auth: { type: server.auth.type },
  };
}

/**
 * The credential for one call, asked each time. A bearer server whose stored
 * token is gone is reported as unauthorized rather than as an anonymous request.
 */
function tokenOf(serverId: string): Effect.Effect<string, RemoteMcpError> {
  const stored = listRemoteMcpServers().find(entry => entry.id === serverId);
  const token = stored?.auth.type === 'bearer' ? stored.auth.token : undefined;
  if (token === undefined) {
    return Effect.fail(
      new RemoteMcpError({ serverId, kind: 'unauthorized', cause: 'the stored token is gone' })
    );
  }
  return Effect.succeed(token);
}

/**
 * A token accessor for a bearer server, the stored OAuth state for an OAuth
 * one, and neither for a server that wants none.
 */
export function credentialDeps(
  server: StoredRemoteMcpServer
): Pick<RemoteMcpClientDeps, 'token' | 'authProvider'> {
  if (server.auth.type === 'oauth') {
    return { authProvider: remoteMcpOAuthProvider(server) };
  }
  if (server.auth.type === 'bearer') {
    const serverId = server.id;
    return { token: () => tokenOf(serverId) };
  }
  return {};
}
