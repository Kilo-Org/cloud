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
import { credentialFor, type RemoteMcpToken } from './credential.js';
import {
  bounded,
  defaultCallTimeoutMs,
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
  token?: RemoteMcpToken;
  /** The caller's own signal, linked into the deadline of every request. */
  signal?: RemoteMcpAbort;
  /**
   * How long one operation may take. A call gets 60 seconds by default, longer
   * than the 15 seconds a remote tool is waited on inline, so a call the
   * session backgrounds still answers. Discovery gets 15.
   */
  timeoutMs?: number;
  /** How long tool discovery may take. The per-operation `timeoutMs` by default. */
  discoverTimeoutMs?: number;
  /** Replaces the permissive validator, for a runtime that can run Ajv. */
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Told about a call the server did not answer: unreachable, refused the
      credential, or gone. A `protocol` failure is the server answering wrongly,
      so it is not one; a person's screen never sees the model's tool result. */
  onCallFailure?: (error: RemoteMcpError) => void;
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
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => open({ server, deps, credential, deadline })),
        closed => Effect.ignore(Effect.tryPromise(() => closed.client.close()))
      );
      yield* connected(connection, server);
      return yield* use(connection);
    })
  );

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
 * `tools` and `call` each open a connection of their own, so each reads the
 * credential accessor again: a token that expired between two calls is replaced
 * rather than reused.
 */
const remoteMcpClient = (server: RemoteMcpServer, deps: RemoteMcpClientDeps): RemoteMcpClient => ({
  tools: withServer(server, discoveryDeps(deps), connection => discovered(connection, server)),
  call: (name, args) =>
    withServer(server, deps, connection => called(connection, server, { name, args })).pipe(
      Effect.mapError(tellingSurface(deps))
    ),
});

export type { RemoteMcpClient, RemoteMcpClientDeps, RemoteMcpTool };
export { permissiveJsonSchemaValidator, remoteMcpClient };
