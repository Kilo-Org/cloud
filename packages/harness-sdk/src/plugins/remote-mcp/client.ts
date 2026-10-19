import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Effect } from 'effect';
import { withServer, type Connection } from './connection.js';
import { type RemoteMcpClientDeps } from './deps.js';
import { failed } from './failure.js';
import { defaultCallTimeoutMs, defaultTimeoutMs } from './http.js';
import { resourceOf, type RemoteMcpResource } from './resource.js';
import { RemoteMcpError, type RemoteMcpServer } from './server.js';

/**
 * The remote MCP client, over the transport the specification defines: the MCP
 * project's own `@modelcontextprotocol/sdk`, so nothing here re-implements
 * JSON-RPC or SSE. The `fetch` is the caller's (`http.ts`); discovery is bounded
 * by `discoverTimeoutMs` and a call by `timeoutMs`, so a silent server cannot
 * hold a chat; the validator is permissive (`validator.ts`), because Hermes has
 * no `new Function`; and a failure is classified by kind.
 */

/** One tool as the server describes it. */
interface RemoteMcpTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The server's own metadata, carried as it stands. `uiResourceUriOf` reads it. */
  readonly _meta: Readonly<Record<string, unknown>> | undefined;
}

interface RemoteMcpClient {
  /** The tools the server offers, as of this call. */
  readonly tools: Effect.Effect<readonly RemoteMcpTool[], RemoteMcpError>;
  /** One call, answered with the text the server sent. */
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>
  ) => Effect.Effect<string, RemoteMcpError>;
  /** One resource, read off the same server under the same deadline as a call. */
  readonly resource: (uri: string) => Effect.Effect<RemoteMcpResource, RemoteMcpError>;
}

const discovered = (
  connection: Connection,
  server: RemoteMcpServer
): Effect.Effect<readonly RemoteMcpTool[], RemoteMcpError> =>
  Effect.tryPromise({
    try: () => connection.client.listTools(undefined, {}),
    catch: cause => failed(server, cause),
  }).pipe(
    Effect.map(result =>
      result.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _meta: tool._meta,
      }))
    )
  );

/**
 * The text a result carries, joined with newlines: an image, an audio clip or
 * an embedded resource is not something a model reads as words.
 */
const textOf = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.flatMap(part => (typeof part.text === 'string' ? [part.text] : [])).join('\n');

/** One call, and what the server refused about it. */
interface Asked {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const called = (
  connection: Connection,
  server: RemoteMcpServer,
  asked: Asked
): Effect.Effect<string, RemoteMcpError> =>
  Effect.tryPromise({
    try: async () => {
      const { name, args } = asked;
      const answered = await connection.client.callTool({ name, arguments: args }, undefined, {});
      const result = CallToolResultSchema.parse(answered);
      const text = textOf(result.content);
      if (result.isError === true) {
        /*
         * The server refused the call. Its own words go back to the model as a
         * failed result, because the model is the party that can do something
         * about it — retry, call another tool, or tell the person.
         */
        throw new RemoteMcpError({ serverId: server.id, kind: 'protocol', cause: text });
      }
      return text;
    },
    catch: cause => (cause instanceof RemoteMcpError ? cause : failed(server, cause)),
  });

/**
 * The deps discovery runs under: the caller's `discoverTimeoutMs`, else its
 * `timeoutMs`, else 15 seconds, stands in for the `timeoutMs` that `withServer`
 * reads. A call keeps `deps` untouched, so its deadline is `timeoutMs`, else
 * 60 seconds: longer than a remote tool is waited on inline (`tools.ts`), so a
 * call the session moves to the background can still answer.
 */
const discoveryDeps = (deps: RemoteMcpClientDeps): RemoteMcpClientDeps => ({
  ...deps,
  timeoutMs: deps.discoverTimeoutMs ?? deps.timeoutMs ?? defaultTimeoutMs,
});

/** The mapper that tells the surface about a call the server did not answer. */
const tellingSurface =
  (deps: RemoteMcpClientDeps) =>
  (error: RemoteMcpError): RemoteMcpError => {
    if (error.kind !== 'protocol') {
      deps.onCallFailure?.(error);
    }
    return error;
  };

/**
 * A client for one server.
 *
 * `tools`, `call` and `resource` each open a connection of their own, so each
 * reads the credential accessor again: a token that expired between two calls
 * is replaced rather than reused.
 */
const remoteMcpClient = (server: RemoteMcpServer, deps: RemoteMcpClientDeps): RemoteMcpClient => ({
  tools: withServer(server, discoveryDeps(deps), connection => discovered(connection, server)),
  call: (name, args) =>
    withServer(server, deps, connection => called(connection, server, { name, args })).pipe(
      Effect.mapError(tellingSurface(deps))
    ),
  resource: uri =>
    withServer(server, deps, connection => resourceOf(connection, server, uri)).pipe(
      Effect.mapError(tellingSurface(deps))
    ),
});

export type { RemoteMcpClient, RemoteMcpClientDeps, RemoteMcpResource, RemoteMcpTool };
export { defaultCallTimeoutMs, remoteMcpClient };
