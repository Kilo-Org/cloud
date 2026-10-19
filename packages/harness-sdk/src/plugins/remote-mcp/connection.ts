import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Effect } from 'effect';
import {
  authProviderFor,
  credentialFor,
  type RemoteMcpOAuthOption,
} from './credential.js';
import { failed } from './failure.js';
import {
  bounded,
  defaultCallTimeoutMs,
  headersFor,
  makeDeadline,
  type Deadline,
} from './http.js';
import type { RemoteMcpClientDeps } from './deps.js';
import type { RemoteMcpError, RemoteMcpServer } from './server.js';
import type { RemoteMcpTransport } from './transport.js';
import { permissiveJsonSchemaValidator } from './validator.js';

/**
 * One connection to one server: how it is opened, and the one operation that
 * opens it, uses it, and closes it again. Everything the client value offers —
 * discovery, a call, a resource — runs inside `withServer`, so each operation
 * reads the credential accessor again and is bounded by its own deadline.
 */

/** Everything one operation needs, opened once and closed at the end. */
interface Connection {
  readonly client: Client;
  readonly transport: RemoteMcpTransport;
}

/** What a connection is opened from. One object, because it is one decision. */
interface Opening {
  readonly server: RemoteMcpServer;
  readonly deps: RemoteMcpClientDeps;
  readonly credential: Readonly<Record<string, string>>;
  readonly oauth: RemoteMcpOAuthOption;
  readonly deadline: Deadline;
}

const open = ({ server, deps, credential, oauth, deadline }: Opening): Connection => {
  const transport: RemoteMcpTransport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: bounded(deps, deadline),
    requestInit: { headers: headersFor(server, credential) },
    ...oauth,
  });
  const client = new Client(
    { name: 'kilo-harness', version: '0.0.0' },
    { jsonSchemaValidator: deps.jsonSchemaValidator ?? permissiveJsonSchemaValidator }
  );
  return { client, transport };
};

const connected = (
  connection: Connection,
  server: RemoteMcpServer
): Effect.Effect<void, RemoteMcpError> =>
  Effect.tryPromise({
    try: () => connection.client.connect(connection.transport),
    catch: cause => failed(server, cause),
  });

/**
 * One operation: a deadline, a credential, a connection, and it all closed
 * again. The deadline comes first, so it bounds the credential too.
 */
const withServer = <A>(
  server: RemoteMcpServer,
  deps: RemoteMcpClientDeps,
  use: (connection: Connection) => Effect.Effect<A, RemoteMcpError>
): Effect.Effect<A, RemoteMcpError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const deadline = yield* Effect.acquireRelease(
        Effect.sync(() => makeDeadline(deps.timeoutMs ?? defaultCallTimeoutMs, deps.signal)),
        made => Effect.sync(made.stop)
      );
      const credential = yield* credentialFor(server, deps.token, deadline);
      const oauth = yield* authProviderFor(server, deps.authProvider);
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => open({ server, deps, credential, oauth, deadline })),
        closed => Effect.ignore(Effect.tryPromise(() => closed.client.close()))
      );
      yield* connected(connection, server);
      return yield* use(connection);
    })
  );

export type { Connection };
export { withServer };
