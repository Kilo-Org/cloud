import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
  jsonSchemaValidator,
  JsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
import { Effect, unsafeCoerce } from 'effect';
import {
  bounded,
  defaultTimeoutMs,
  headersFor,
  makeDeadline,
  type Deadline,
  type RemoteMcpAbort,
  type RemoteMcpRequest,
} from './http.js';
import { RemoteMcpError, type RemoteMcpFailure, type RemoteMcpServer } from './server.js';

/**
 * The remote MCP client, over the transport the specification defines: the MCP
 * project's own `@modelcontextprotocol/sdk`, so nothing here re-implements
 * JSON-RPC or SSE. The `fetch` is the caller's (`http.ts`); discovery is bounded
 * by `discoverTimeoutMs` and a call by `timeoutMs`, so a silent server cannot
 * hold a chat; the validator is permissive, because Hermes has no `new
 * Function`; and a failure is classified by kind.
 */

/**
 * The transport the client library is handed. Not the library's `Transport`
 * itself: the class reads `sessionId` as `string | undefined` and the interface
 * declares it `sessionId?: string`, which `exactOptionalPropertyTypes` refuses
 * to join. Nothing here reads the member — the library owns it — so it is left
 * off the seam, not asserted.
 */
type RemoteMcpTransport = Omit<StreamableHTTPClientTransport, 'sessionId'>;

/**
 * The library's own validator, answering yes.
 *
 * Ajv compiles a schema with `new Function`, which Hermes forbids, and a tool
 * result reaches the model without its output schema being read here. So the
 * validator hands the value back untouched; `unsafeCoerce` is `identity`.
 */
const permissiveJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      data: unsafeCoerce(input),
      errorMessage: undefined,
      valid: true,
    });
  },
};

/** One tool as the server describes it. */
interface RemoteMcpTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

interface RemoteMcpClientDeps {
  /**
   * The runtime's `fetch`, passed in rather than read off a global, so the same
   * plugin runs in a browser, on Node and in a mobile app. It is a method here
   * on purpose: a caller holding the DOM's own `fetch` satisfies it without a
   * cast, which a property of function type would not allow.
   */
  fetch(url: string | URL, init?: RemoteMcpRequest): Promise<Response>;
  /**
   * The credential for one call, asked each time so a refreshed token is used
   * instead of the one the process started with. It fails with a
   * `RemoteMcpError`, so a source that can fail names the kind. Read only for
   * `bearer`.
   */
  token?: () => Effect.Effect<string, RemoteMcpError>;
  /** The caller's own signal, linked into the deadline of every request. */
  signal?: RemoteMcpAbort;
  /** How long one operation may take. 15 seconds by default. */
  timeoutMs?: number;
  /** How long tool discovery may take. The per-operation `timeoutMs` by default. */
  discoverTimeoutMs?: number;
  /** Replaces the permissive validator, for a runtime that can run Ajv. */
  jsonSchemaValidator?: jsonSchemaValidator;
}

interface RemoteMcpClient {
  /** The tools the server offers, as of this call. */
  readonly tools: Effect.Effect<readonly RemoteMcpTool[], RemoteMcpError>;
  /** One call, answered with the text the server sent. */
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>
  ) => Effect.Effect<string, RemoteMcpError>;
}

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

/** Whether a thrown value is one of the library's own schema refusals. */
const isSchemaError = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === 'ZodError';

/**
 * What a failure was, read off the library rather than off a status of our own.
 *
 * The transport throws `StreamableHTTPError` carrying the status. Anything else
 * — a dropped connection, an abort, a refused stream — is a server that could
 * not be reached, the only honest reading of a rejection with nothing in it.
 */
const kindOf = (cause: unknown): RemoteMcpFailure => {
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

/**
 * The credential header for one operation, asked only where the server wants
 * one. A bearer server with no accessor is a caller's mistake, and it is
 * reported as one rather than sent as an anonymous request.
 */
const credentialFor = (
  server: RemoteMcpServer,
  deps: RemoteMcpClientDeps
): Effect.Effect<Readonly<Record<string, string>>, RemoteMcpError> => {
  if (server.auth.type !== 'bearer') {
    return Effect.succeed({});
  }
  if (deps.token === undefined) {
    return Effect.fail(
      new RemoteMcpError({
        serverId: server.id,
        kind: 'unauthorized',
        cause: 'this server needs a bearer token and no source for one was given',
      })
    );
  }
  return deps.token().pipe(Effect.map(token => ({ Authorization: `Bearer ${token}` })));
};

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
  readonly deadline: Deadline;
}

const open = ({ server, deps, credential, deadline }: Opening): Connection => {
  const transport: RemoteMcpTransport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: bounded(deps, deadline),
    requestInit: { headers: headersFor(server, credential) },
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

/** One operation: a credential, a deadline, a connection, and it all closed again. */
const withServer = <A>(
  server: RemoteMcpServer,
  deps: RemoteMcpClientDeps,
  use: (connection: Connection) => Effect.Effect<A, RemoteMcpError>
): Effect.Effect<A, RemoteMcpError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const credential = yield* credentialFor(server, deps);
      const deadline = yield* Effect.acquireRelease(
        Effect.sync(() => makeDeadline(deps.timeoutMs ?? defaultTimeoutMs, deps.signal)),
        made => Effect.sync(made.stop)
      );
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => open({ server, deps, credential, deadline })),
        closed => Effect.ignore(Effect.tryPromise(() => closed.client.close()))
      );
      yield* connected(connection, server);
      return yield* use(connection);
    })
  );

/**
 * The deps discovery runs under, where the caller's `discoverTimeoutMs` stands
 * in for the `timeoutMs` that `withServer` reads. A call keeps `deps` untouched.
 */
const discoveryDeps = (deps: RemoteMcpClientDeps): RemoteMcpClientDeps =>
  deps.discoverTimeoutMs === undefined ? deps : { ...deps, timeoutMs: deps.discoverTimeoutMs };

/**
 * A client for one server.
 *
 * `tools` and `call` each open a connection of their own, so each reads the
 * credential accessor again: a token that expired between two calls is replaced
 * rather than reused.
 */
const remoteMcpClient = (server: RemoteMcpServer, deps: RemoteMcpClientDeps): RemoteMcpClient => ({
  tools: withServer(server, discoveryDeps(deps), connection => discovered(connection, server)),
  call: (name, args) =>
    withServer(server, deps, connection => called(connection, server, { name, args })),
});

export type { RemoteMcpClient, RemoteMcpClientDeps, RemoteMcpTool };
export { explain, permissiveJsonSchemaValidator, remoteMcpClient };
