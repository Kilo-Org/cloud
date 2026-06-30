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
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';

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

const makeClient = (server: RemoteMcpServer, fetchFn: FetchLike) => {
  const client = new Client({ name: 'kilo-extension', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: fetchFn,
    requestInit: { headers: buildAuthHeaders(server.auth) },
  });
  return { client, transport };
};

export const connectRemoteMcpServer = async ({
  fetch: fetchFn,
  server,
  signal,
}: {
  readonly fetch: FetchLike;
  readonly server: RemoteMcpServer;
  readonly signal?: AbortSignal;
}): Promise<RemoteMcpServer> => {
  const combined = combineSignal(signal);
  const { client, transport } = makeClient(server, fetchFn);

  try {
    await client.connect(transport, { signal: combined });
    const { tools } = await client.listTools(undefined, { signal: combined });

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
      status: is401 ? 'needs_auth' : 'unavailable',
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
}: {
  readonly arguments: Record<string, unknown>;
  readonly fetch: FetchLike;
  readonly route: RemoteMcpToolRoute;
  readonly server: RemoteMcpServer;
  readonly signal?: AbortSignal;
}): Promise<unknown> => {
  const combined = combineSignal(signal);
  const { client, transport } = makeClient(server, fetchFn);

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
