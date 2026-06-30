import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  RemoteMcpAuth,
  RemoteMcpCachedTool,
  RemoteMcpServer,
} from '../../src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '../../src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';
import type { RemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';
import { createRemoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

type FetchLike = typeof fetch;

const buildAuthHeaders = (auth: RemoteMcpAuth): Record<string, string> => {
  if (auth.type === 'bearer' && auth.token) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.type === 'header' && auth.headerValue) {
    return { [auth.headerName]: auth.headerValue };
  }
  return {};
};

const combineSignal = (signal?: AbortSignal): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(20_000)
    : AbortSignal.any([signal, AbortSignal.timeout(20_000)]);

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
      await client.connect(transport, { signal: combined });
    } catch (err) {
      if (!(err instanceof UnauthorizedError) || authProvider === undefined) {
        throw err;
      }
      const code = authProvider.takeAuthorizationCode();
      if (code === undefined) {
        throw err;
      }
      await transport.finishAuth(code);
      await client.connect(transport, { signal: combined });
    }
    return client.listTools(undefined, { signal: combined });
  };

  try {
    const { tools } = await connectAndList();

    const cachedTools: RemoteMcpCachedTool[] = tools.map(t => ({
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      name: t.name,
    }));

    return {
      ...server,
      cachedTools,
      lastConnectedAt: new Date().toISOString(),
      lastError: undefined,
      status: 'connected',
    };
  } catch (err) {
    const is401 = err instanceof StreamableHTTPError && err.code === 401;
    const needsAuth = is401 || err instanceof UnauthorizedError;
    // is401 implies err instanceof StreamableHTTPError extends Error, so err.message is safe
    const message = is401
      ? `401: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);

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
}): Promise<unknown> => {
  const combined = combineSignal(signal);
  const { client, transport } = makeClient(server, fetchFn, storageArea);

  try {
    await client.connect(transport, { signal: combined });
    return await client.callTool({ arguments: args, name: route.remoteToolName }, undefined, {
      signal: combined,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { content: [{ text, type: 'text' }], isError: true };
  } finally {
    await client.close();
  }
};
