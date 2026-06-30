/* eslint-disable max-classes-per-file, max-lines */
import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';

interface TransportOpts {
  authProvider?: { redirectToAuthorization(url: URL): Promise<void> };
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: { headers?: Record<string, string> };
}

const mocks = vi.hoisted(() => {
  const connect = vi.fn<(transport: unknown, opts: { signal?: AbortSignal }) => Promise<void>>();
  const listTools = vi.fn<() => Promise<{ tools: unknown[] }>>();
  const close = vi.fn<() => Promise<void>>();
  const finishAuth = vi.fn<(code: string) => Promise<void>>();
  // Captures args passed to new StreamableHTTPClientTransport(url, opts)
  const transportCalls: { opts: TransportOpts; url: URL }[] = [];

  return { close, connect, finishAuth, listTools, transportCalls };
});

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = mocks.close;
  }
  return { Client };
});

// Remote-mcp-client transitively imports the OAuth provider, which imports `browser`.
// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    identity: {
      getRedirectURL: () => 'https://abc.chromiumapp.org/remote-mcp',
      // eslint-disable-next-line promise/prefer-await-to-then
      launchWebAuthFlow: () => Promise.resolve('https://abc.chromiumapp.org/remote-mcp?code=x'),
    },
  },
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPError extends Error {
    readonly code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(`Streamable HTTP error: ${message}`);
      this.code = code;
    }
  }
  class StreamableHTTPClientTransport {
    authProvider: { redirectToAuthorization(url: URL): Promise<void> } | undefined;
    finishAuth = mocks.finishAuth;
    constructor(url: URL, opts: TransportOpts = {}) {
      this.authProvider = opts.authProvider;
      mocks.transportCalls.push({ opts, url });
    }
  }
  return { StreamableHTTPClientTransport, StreamableHTTPError };
});

// eslint-disable-next-line import/first
import { connectRemoteMcpServer } from './remote-mcp-client';

// eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-unsafe-type-assertion
const noopFetch = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch;

const baseServer = (overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer => ({
  allowInSafeMode: false,
  auth: { type: 'none' },
  cachedTools: [],
  displayName: 'Test Server',
  enabled: true,
  id: 'srv-1',
  lastConnectedAt: undefined,
  lastError: undefined,
  slug: 'test-server',
  status: 'untested',
  url: 'https://mcp.example.com/',
  ...overrides,
});

const lastTransportCall = () => {
  const call = mocks.transportCalls.at(-1);
  if (!call) {
    throw new Error('No transport calls captured');
  }
  return call;
};

describe('remote MCP server connection', () => {
  it('uses no auth header for type:none', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'none' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends Authorization: Bearer header for type:bearer with token', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { token: 'tok-123', type: 'bearer' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({
      requestInit: { headers: { Authorization: 'Bearer tok-123' } },
    });
  });

  it('sends no auth header for type:bearer without token', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'bearer' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends custom header for type:header with value', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({
        auth: { headerName: 'X-Api-Key', headerValue: 'secret', type: 'header' },
      }),
    });

    expect(lastTransportCall().opts).toMatchObject({
      requestInit: { headers: { 'X-Api-Key': 'secret' } },
    });
  });

  it('sends no auth header for type:header without value', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { headerName: 'X-Api-Key', type: 'header' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends no auth header for type:oauth', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'oauth' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('passes server URL as URL instance to transport', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({ fetch: noopFetch, server: baseServer() });

    expect(lastTransportCall().url).toBeInstanceOf(URL);
    expect(lastTransportCall().url.href).toBe('https://mcp.example.com/');
  });

  it('returns connected status with cached tools and lastConnectedAt on success', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({
      tools: [
        { description: 'Get weather', inputSchema: { type: 'object' }, name: 'get_weather' },
        { inputSchema: { type: 'object' }, name: 'no_desc_tool' },
      ],
    });
    mocks.close.mockResolvedValueOnce();

    const before = Date.now();
    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
    });

    expect(result.status).toBe('connected');
    expect(result.lastError).toBeUndefined();
    expect(result.cachedTools).toStrictEqual([
      { description: 'Get weather', inputSchema: { type: 'object' }, name: 'get_weather' },
      { description: undefined, inputSchema: { type: 'object' }, name: 'no_desc_tool' },
    ]);
    expect(result.lastConnectedAt).toBeDefined();
    expect(new Date(result.lastConnectedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('maps StreamableHTTPError code 401 to needs_auth', async () => {
    const { StreamableHTTPError } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    mocks.connect.mockRejectedValueOnce(new StreamableHTTPError(401, 'Unauthorized'));
    mocks.close.mockResolvedValueOnce();

    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
    });

    expect(result.status).toBe('needs_auth');
    expect(result.lastError).toContain('401');
    expect(result.cachedTools).toHaveLength(0);
  });

  it('maps non-401 errors to unavailable', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('Network failure'));
    mocks.close.mockResolvedValueOnce();

    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
    });

    expect(result.status).toBe('unavailable');
    expect(result.lastError).toContain('Network failure');
  });

  it('closes the client in finally block even on error', async () => {
    mocks.close.mockClear();
    mocks.connect.mockRejectedValueOnce(new Error('boom'));
    mocks.close.mockResolvedValueOnce();

    await connectRemoteMcpServer({ fetch: noopFetch, server: baseServer() });

    // eslint-disable-next-line vitest/prefer-called-once
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal to connect', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    const controller = new AbortController();
    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
      signal: controller.signal,
    });

    // Connect(transport, { signal }) — signal is in the second arg
    expect(mocks.connect.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns unavailable with lastError when connect is aborted', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    mocks.connect.mockRejectedValueOnce(abortErr);
    mocks.close.mockResolvedValueOnce();

    const controller = new AbortController();
    controller.abort();
    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
      signal: controller.signal,
    });

    expect(result.status).toBe('unavailable');
    expect(result.lastError).toBeTruthy();
    expect(result.cachedTools).toHaveLength(0);
  });

  it('runs the oauth flow and retries connect on UnauthorizedError', async () => {
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
    const oauthServer = baseServer({ auth: { type: 'oauth' } });
    const storageArea = {
      getItem: () => ({ servers: [oauthServer] }),
      setItem: () => {},
    };

    mocks.connect.mockClear();
    mocks.finishAuth.mockClear();
    // First connect simulates the SDK: redirect the user, then throw Unauthorized.
    mocks.connect.mockImplementationOnce(async () => {
      await lastTransportCall().opts.authProvider?.redirectToAuthorization(
        new URL('https://auth.example.com/authorize')
      );
      throw new UnauthorizedError('needs auth');
    });
    // Second connect (after finishAuth) succeeds.
    mocks.connect.mockResolvedValueOnce();
    mocks.finishAuth.mockResolvedValueOnce();
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce();

    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: oauthServer,
      storageArea,
    });

    // LaunchWebAuthFlow returns ...?code=x, so finishAuth is called with that code.
    expect(mocks.finishAuth).toHaveBeenCalledWith('x');
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('connected');
  });

  it('maps UnauthorizedError to needs_auth when no code is captured', async () => {
    const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
    const oauthServer = baseServer({ auth: { type: 'oauth' } });
    mocks.connect.mockRejectedValueOnce(new UnauthorizedError('nope'));
    mocks.close.mockResolvedValueOnce();

    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: oauthServer,
      storageArea: { getItem: () => ({ servers: [oauthServer] }), setItem: () => {} },
    });

    expect(result.status).toBe('needs_auth');
  });
});
