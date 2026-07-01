import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  RemoteMcpAuth,
  RemoteMcpCachedTool,
  RemoteMcpServer,
} from '../../src/shared/remote-mcp';
import {
  loadRemoteMcpStore,
  saveRemoteMcpStore,
  upsertRemoteMcpServer,
} from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';
import type { RemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';
import { createRemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

type FetchLike = typeof fetch;

const buildAuthHeaders = (auth: RemoteMcpAuth): Record<string, string> => {
  if (auth.type === 'bearer' && auth.token !== undefined) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.type === 'header' && auth.headerValue !== undefined) {
    return { [auth.headerName]: auth.headerValue };
  }
  return {};
};

const combineSignal = (signal?: AbortSignal): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(20_000)
    : AbortSignal.any([signal, AbortSignal.timeout(20_000)]);

/*
 * StreamableHTTPClientTransport.sessionId is `string | undefined`, but the
 * Transport interface declares `sessionId?: string` (meaning just `string`
 * under exactOptionalPropertyTypes). Widen through unknown to satisfy the
 * Transport parameter — the runtime object is identical.
 */
const asTransport = (transport: StreamableHTTPClientTransport): Transport =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  transport as unknown as Transport;

const makeClient = (
  server: RemoteMcpServer,
  fetchFn: FetchLike,
  storageArea?: RemoteMcpStorageArea
) => {
  const client = new Client({ name: 'kilo-extension', version: '0.0.0' });
  const authProvider: RemoteMcpOAuthProvider | undefined =
    server.auth.type === 'oauth' && storageArea !== undefined
      ? createRemoteMcpOAuthProvider({ server, storageArea })
      : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(authProvider === undefined ? {} : { authProvider }),
    fetch: fetchFn,
    requestInit: { headers: buildAuthHeaders(server.auth) },
  });
  return { authProvider, client, transport };
};

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
  const combined = combineSignal(signal);
  const { authProvider, client, transport } = makeClient(server, fetchFn, storageArea);

  /*
   * Connect and list tools, transparently completing an interactive OAuth flow
   * once if the SDK reports the connection is unauthorized.
   */
  const connectAndList = async () => {
    try {
      await client.connect(asTransport(transport), { signal: combined });
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || authProvider === undefined) {
        throw error;
      }
      const code = authProvider.takeAuthorizationCode();
      if (code === undefined) {
        throw error;
      }
      await transport.finishAuth(code);
      await client.connect(asTransport(transport), { signal: combined });
    }
    return client.listTools(undefined, { signal: combined });
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
    const is401 = error instanceof StreamableHTTPError && error.code === 401;
    const needsAuth = is401 || error instanceof UnauthorizedError;
    // Is401 implies error instanceof StreamableHTTPError extends Error, so error.message is safe
    const errorText = error instanceof Error ? error.message : String(error);
    const message: string = is401 ? `401: ${errorText}` : errorText;

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
  const freshStore = await loadRemoteMcpStore(storageArea);
  const freshServer = freshStore.servers.find(found => found.id === server.id);

  if (freshServer === undefined) {
    return undefined;
  }

  const nextStore = upsertRemoteMcpServer(freshStore, {
    ...freshServer,
    cachedTools: updated.cachedTools,
    lastConnectedAt: updated.lastConnectedAt,
    lastError: updated.lastError,
    status: updated.status,
  });
  await saveRemoteMcpStore(storageArea, nextStore);

  return nextStore.servers;
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
  const combined = combineSignal(signal);
  const { client, transport } = makeClient(server, fetchFn, storageArea);

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
    const text = error instanceof Error ? error.message : String(error);
    return { content: [{ text, type: 'text' }], isError: true };
  } finally {
    await client.close();
  }
};
