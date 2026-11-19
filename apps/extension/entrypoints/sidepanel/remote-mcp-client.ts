/* eslint-disable import/max-dependencies, max-lines -- one transport adapter per MCP concern; the connect/retry flow reads better in one file */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { describeFetchError } from '../../src/shared/agent-turn-error';
import type {
  RemoteMcpAuth,
  RemoteMcpCachedTool,
  RemoteMcpServer,
} from '../../src/shared/remote-mcp';
import { updateRemoteMcpStore, upsertRemoteMcpServer } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';
import type { RemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';
import { AUTH_INCOMPLETE_MESSAGE, createRemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

type FetchLike = typeof fetch;

const NEEDS_CREDENTIALS_MESSAGE =
  'This server needs credentials. Add a bearer token, a custom header, or OAuth in Edit.';
const UNREACHABLE_MESSAGE =
  "Kilo couldn't reach this server. Check the URL and that the server is running.";

const STREAMABLE_HTTP_PREFIX = 'Streamable HTTP error: ';
const POSTING_PREFIX = /^Error POSTing to endpoint(?: \(HTTP \d+\))?: /u;

/*
 * The SDK wraps the server's own reason in transport boilerplate
 * ("Streamable HTTP error: Error POSTing to endpoint: <body>"). Show only the
 * reason, and drop an empty remainder so the row never renders bare scaffolding.
 */
const extractServerReason = (message: string): string | undefined => {
  let reason = message.startsWith(STREAMABLE_HTTP_PREFIX)
    ? message.slice(STREAMABLE_HTTP_PREFIX.length)
    : message;
  reason = reason.replace(POSTING_PREFIX, '').trim();

  return reason === '' ? undefined : reason;
};

/*
 * A remote MCP server is a third party, so the copy names it rather than Kilo:
 * the user's next step is the server URL, its credentials, or its health.
 */
const describeConnectFailure = (error: unknown) => {
  const needsAuth =
    (error instanceof StreamableHTTPError && error.code === 401) ||
    error instanceof UnauthorizedError;

  if (needsAuth) {
    return { message: NEEDS_CREDENTIALS_MESSAGE, needsAuth };
  }

  // The interactive sign-in opened but never handed back a code: retrying Connect is the next step.
  if (error instanceof Error && error.message === AUTH_INCOMPLETE_MESSAGE) {
    return { message: AUTH_INCOMPLETE_MESSAGE, needsAuth: true };
  }

  // A fetch network failure is a TypeError; no HTTP layer answered at all.
  if (error instanceof TypeError) {
    return { message: UNREACHABLE_MESSAGE, needsAuth };
  }

  const status = error instanceof StreamableHTTPError ? error.code : undefined;
  const described = describeFetchError(error, status);
  const reason = error instanceof Error ? extractServerReason(error.message) : undefined;

  return {
    message: reason === undefined ? described.title : `${described.title} ${reason}`,
    needsAuth,
  };
};

const buildAuthHeaders = (auth: RemoteMcpAuth) => {
  if (auth.type === 'bearer' && auth.token !== undefined) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.type === 'header' && auth.headerValue !== undefined) {
    return { [auth.headerName]: auth.headerValue };
  }
  return {};
};

const CONNECT_TIMEOUT_MS = 20_000;
// Interactive OAuth blocks on the user, so the auth-carrying connect gets a far longer budget.
const AUTH_TIMEOUT_MS = 5 * 60_000;

const combineSignal = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

/*
 * The extension CSP forbids eval, but the SDK's default Ajv validator compiles
 * tool output schemas with `new Function`. We forward tool results to the model
 * without consuming output-schema validation, so inject a permissive validator.
 */
const permissiveJsonSchemaValidator: jsonSchemaValidator = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic identity: the value is never read, only `valid` is.
  getValidator: () => input => ({ data: input as never, errorMessage: undefined, valid: true }),
};

/*
 * StreamableHTTPClientTransport.sessionId is `string | undefined`, but the
 * Transport interface declares `sessionId?: string` (meaning just `string`
 * under exactOptionalPropertyTypes). Widen through unknown to satisfy the
 * Transport parameter — the runtime object is identical.
 */
const asTransport = (transport: StreamableHTTPClientTransport): Transport =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- exactOptionalPropertyTypes makes `sessionId?: string` incompatible with `string | undefined`; the runtime object is identical, only the optional-property strictness differs.
  transport as unknown as Transport;

const makeAuthProvider = (
  server: RemoteMcpServer,
  storageArea?: RemoteMcpStorageArea
): RemoteMcpOAuthProvider | undefined =>
  server.auth.type === 'oauth' && storageArea !== undefined
    ? createRemoteMcpOAuthProvider({ server, storageArea })
    : undefined;

const makeClient = (): Client =>
  new Client(
    { name: 'kilo-extension', version: '0.0.0' },
    { jsonSchemaValidator: permissiveJsonSchemaValidator }
  );

/*
 * A fresh transport per connect attempt: the SDK's connect() starts it, and a
 * started transport cannot be reused for the post-auth reconnect.
 */
const makeTransport = (
  server: RemoteMcpServer,
  fetchFn: FetchLike,
  authProvider?: RemoteMcpOAuthProvider
): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(new URL(server.url), {
    ...(authProvider === undefined ? {} : { authProvider }),
    fetch: fetchFn,
    requestInit: { headers: buildAuthHeaders(server.auth) },
  });

export const connectRemoteMcpServer = async ({
  fetch: fetchFn,
  server,
  signal,
  storageArea,
}: {
  readonly fetch: FetchLike;
  readonly server: RemoteMcpServer;
  readonly signal?: AbortSignal;
  readonly storageArea?: RemoteMcpStorageArea;
}): Promise<RemoteMcpServer> => {
  const authProvider = makeAuthProvider(server, storageArea);
  const client = makeClient();

  /*
   * Connect and list tools, transparently completing an interactive OAuth flow
   * once if the SDK reports the connection is unauthorized. The auth-carrying
   * connect gets a longer timeout because it blocks on the user, and the retry
   * uses a fresh transport because the first one is already started.
   */
  const connectAndList = async () => {
    const transport = makeTransport(server, fetchFn, authProvider);
    try {
      await client.connect(asTransport(transport), {
        signal: combineSignal(
          signal,
          authProvider === undefined ? CONNECT_TIMEOUT_MS : AUTH_TIMEOUT_MS
        ),
      });
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || authProvider === undefined) {
        throw error;
      }
      const code = authProvider.takeAuthorizationCode();
      if (code === undefined) {
        throw new Error(AUTH_INCOMPLETE_MESSAGE, { cause: error });
      }
      await transport.finishAuth(code);
      await client.connect(asTransport(makeTransport(server, fetchFn, authProvider)), {
        signal: combineSignal(signal, CONNECT_TIMEOUT_MS),
      });
    }
    return client.listTools(undefined, { signal: combineSignal(signal, CONNECT_TIMEOUT_MS) });
  };

  try {
    const { tools } = await connectAndList();

    const cachedTools: RemoteMcpCachedTool[] = tools.map(tool => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
    }));

    return {
      ...server,
      cachedTools,
      lastConnectedAt: new Date().toISOString(),
      lastError: undefined,
      status: 'connected',
    };
  } catch (error) {
    const { message, needsAuth } = describeConnectFailure(error);

    return {
      ...server,
      cachedTools: [],
      lastError: message,
      status: needsAuth ? 'needs_auth' : 'unavailable',
    };
  } finally {
    await client.close();
  }
};

/*
 * Connect a server and persist the connection results. Reloads the store before
 * merging so OAuth tokens written by the provider mid-connect survive, then saves
 * only the connection fields. Returns the saved servers, or undefined when the
 * server was removed mid-connect.
 */
export const connectAndPersistRemoteMcpServer = async ({
  fetch: fetchFn,
  server,
  storageArea,
}: {
  readonly fetch: FetchLike;
  readonly server: RemoteMcpServer;
  readonly storageArea: RemoteMcpStorageArea;
}): Promise<readonly RemoteMcpServer[] | undefined> => {
  const updated = await connectRemoteMcpServer({ fetch: fetchFn, server, storageArea });
  let savedServers: readonly RemoteMcpServer[] | undefined = undefined;

  await updateRemoteMcpStore(storageArea, freshStore => {
    const freshServer = freshStore.servers.find(found => found.id === server.id);
    if (freshServer === undefined) {
      return freshStore;
    }

    const nextStore = upsertRemoteMcpServer(freshStore, {
      ...freshServer,
      cachedTools: updated.cachedTools,
      lastConnectedAt: updated.lastConnectedAt,
      lastError: updated.lastError,
      status: updated.status,
    });
    savedServers = nextStore.servers;
    return nextStore;
  });

  return savedServers;
};

/*
 * The tool path is model-initiated, so it must never open the user's browser:
 * an unauthorized server becomes a tool error that asks the user for
 * credentials. Every other provider call (stored tokens, non-interactive
 * refresh) still delegates unchanged.
 */
const withoutInteractiveSignIn = (provider: RemoteMcpOAuthProvider): RemoteMcpOAuthProvider => ({
  ...provider,
  redirectToAuthorization(): Promise<void> {
    throw new UnauthorizedError('Interactive sign-in is required for this server.');
  },
});

/*
 * Persist needs-sign-in for a server the tool path could not authenticate, so
 * its settings row shows the Connect/Edit affordance instead of the last good
 * status.
 */
const persistNeedsAuth = async (
  storageArea: RemoteMcpStorageArea | undefined,
  serverId: string
): Promise<void> => {
  if (storageArea === undefined) {
    return;
  }

  await updateRemoteMcpStore(storageArea, store => {
    const freshServer = store.servers.find(found => found.id === serverId);
    if (freshServer === undefined) {
      return store;
    }

    return upsertRemoteMcpServer(store, { ...freshServer, status: 'needs_auth' });
  });
};

export const callRemoteMcpTool = async ({
  arguments: args,
  fetch: fetchFn,
  route,
  server,
  signal,
  storageArea,
}: {
  readonly arguments: Record<string, unknown>;
  readonly fetch: FetchLike;
  readonly route: RemoteMcpToolRoute;
  readonly server: RemoteMcpServer;
  readonly signal?: AbortSignal;
  readonly storageArea?: RemoteMcpStorageArea;
}): Promise<CallToolResult> => {
  const combined = combineSignal(signal, CONNECT_TIMEOUT_MS);
  const client = makeClient();
  const authProvider = makeAuthProvider(server, storageArea);
  const transport = makeTransport(
    server,
    fetchFn,
    authProvider === undefined ? undefined : withoutInteractiveSignIn(authProvider)
  );

  try {
    await client.connect(asTransport(transport), { signal: combined });
    const result = await client.callTool(
      { arguments: args, name: route.remoteToolName },
      CallToolResultSchema,
      { signal: combined }
    );
    /*
     * The callTool overload statically returns the modern result unioned with the
     * legacy { toolResult } shape. Re-parse with the schema to collapse that to a
     * typed CallToolResult so callers never hand-inspect an unknown.
     */
    return CallToolResultSchema.parse(result);
  } catch (error) {
    const described = describeConnectFailure(error);
    if (described.needsAuth) {
      // The user-facing tool result must not depend on whether the status write lands.
      await persistNeedsAuth(storageArea, server.id).catch(() => {});
    }

    return {
      content: [{ text: described.message, type: 'text' }],
      isError: true,
    };
  } finally {
    await client.close();
  }
};
