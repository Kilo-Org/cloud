import { Effect } from 'effect';
import type { Deadline } from './http.js';
import { RemoteMcpError, type RemoteMcpServer } from './server.js';

/** Where a bearer server's token comes from: asked once per operation. */
type RemoteMcpToken = () => Effect.Effect<string, RemoteMcpError>;

/**
 * Fails when the deadline ends: its timer ran out or the caller let go. Raced
 * against the token, so a slow token source is held to the same bound as the
 * requests after it.
 */
const ended = (server: RemoteMcpServer, deadline: Deadline): Effect.Effect<never, RemoteMcpError> =>
  Effect.async<never, RemoteMcpError>(resume => {
    const end = (): void => {
      resume(
        Effect.fail(
          new RemoteMcpError({
            serverId: server.id,
            kind: 'unreachable',
            cause: 'the deadline ended before the credential arrived',
          })
        )
      );
    };
    if (deadline.signal.aborted) {
      end();
      return;
    }
    deadline.signal.addEventListener?.('abort', end);
    return Effect.sync(() => {
      deadline.signal.removeEventListener?.('abort', end);
    });
  });

/**
 * The credential header for one operation, asked only where the server wants
 * one, and asked under the operation's deadline. A bearer server with no
 * accessor is a caller's mistake, and it is reported as one rather than sent as
 * an anonymous request.
 */
const credentialFor = (
  server: RemoteMcpServer,
  token: RemoteMcpToken | undefined,
  deadline: Deadline
): Effect.Effect<Readonly<Record<string, string>>, RemoteMcpError> => {
  if (server.auth.type !== 'bearer') {
    return Effect.succeed({});
  }
  if (token === undefined) {
    return Effect.fail(
      new RemoteMcpError({
        serverId: server.id,
        kind: 'unauthorized',
        cause: 'this server needs a bearer token and no source for one was given',
      })
    );
  }
  return Effect.raceFirst(
    token().pipe(Effect.map(value => ({ Authorization: `Bearer ${value}` }))),
    ended(server, deadline)
  );
};

export type { RemoteMcpToken };
export { credentialFor };
