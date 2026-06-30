import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';

// Hoisted so vi.mock factories can close over them
const mocks = vi.hoisted(() => {
  const connect = vi.fn<() => Promise<void>>();
  const listTools = vi.fn<() => Promise<{ tools: unknown[] }>>();
  const callTool = vi.fn<() => Promise<unknown>>();
  const close = vi.fn<() => Promise<void>>();
  // Captures args passed to new StreamableHTTPClientTransport(url, opts)
  const transportCalls: { opts: unknown; url: URL }[] = [];

  return { callTool, close, connect, listTools, transportCalls };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    connect = mocks.connect;
    listTools = mocks.listTools;
    callTool = mocks.callTool;
    close = mocks.close;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_info: any) {}
  }
  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPError extends Error {
    readonly code: number | undefined;
    constructor(code: number | undefined, message: string | undefined) {
      super(`Streamable HTTP error: ${message}`);
      this.code = code;
    }
  }
  class StreamableHTTPClientTransport {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(url: URL, opts?: any) {
      mocks.transportCalls.push({ opts, url });
    }
  }
  return { StreamableHTTPClientTransport, StreamableHTTPError };
});

import { connectRemoteMcpServer, callRemoteMcpTool } from './remote-mcp-client';

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

const noopFetch: typeof fetch = () => Promise.resolve(new Response('{}'));

const lastTransportCall = () => {
  const call = mocks.transportCalls[mocks.transportCalls.length - 1];
  if (!call) throw new Error('No transport calls captured');
  return call;
};

describe('connectRemoteMcpServer', () => {
  it('uses no auth header for type:none', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'none' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends Authorization: Bearer header for type:bearer with token', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { token: 'tok-123', type: 'bearer' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({
      requestInit: { headers: { Authorization: 'Bearer tok-123' } },
    });
  });

  it('sends no auth header for type:bearer without token', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'bearer' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends custom header for type:header with value', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

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
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { headerName: 'X-Api-Key', type: 'header' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('sends no auth header for type:oauth', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer({ auth: { type: 'oauth' } }),
    });

    expect(lastTransportCall().opts).toMatchObject({ requestInit: { headers: {} } });
  });

  it('passes server URL as URL instance to transport', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({ fetch: noopFetch, server: baseServer() });

    expect(lastTransportCall().url).toBeInstanceOf(URL);
    expect(lastTransportCall().url.href).toBe('https://mcp.example.com/');
  });

  it('returns connected status with cached tools and lastConnectedAt on success', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({
      tools: [
        { description: 'Get weather', inputSchema: { type: 'object' }, name: 'get_weather' },
        { inputSchema: { type: 'object' }, name: 'no_desc_tool' },
      ],
    });
    mocks.close.mockResolvedValueOnce(undefined);

    const before = new Date();
    const result = await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
    });
    const after = new Date();

    expect(result.status).toBe('connected');
    expect(result.lastError).toBeUndefined();
    expect(result.cachedTools).toStrictEqual([
      { description: 'Get weather', inputSchema: { type: 'object' }, name: 'get_weather' },
      { description: undefined, inputSchema: { type: 'object' }, name: 'no_desc_tool' },
    ]);
    expect(result.lastConnectedAt).toBeDefined();
    const connectedAt = new Date(result.lastConnectedAt!);
    expect(connectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(connectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('maps StreamableHTTPError code 401 to needs_auth', async () => {
    const { StreamableHTTPError } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    mocks.connect.mockRejectedValueOnce(new StreamableHTTPError(401, 'Unauthorized'));
    mocks.close.mockResolvedValueOnce(undefined);

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
    mocks.close.mockResolvedValueOnce(undefined);

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
    mocks.close.mockResolvedValueOnce(undefined);

    await connectRemoteMcpServer({ fetch: noopFetch, server: baseServer() });

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal to connect', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.listTools.mockResolvedValueOnce({ tools: [] });
    mocks.close.mockResolvedValueOnce(undefined);

    const controller = new AbortController();
    await connectRemoteMcpServer({
      fetch: noopFetch,
      server: baseServer(),
      signal: controller.signal,
    });

    // connect(transport, { signal }) — signal is in the second arg
    const connectOptions = mocks.connect.mock.calls[mocks.connect.mock.calls.length - 1]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(connectOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns unavailable with lastError when connect is aborted', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    mocks.connect.mockRejectedValueOnce(abortErr);
    mocks.close.mockResolvedValueOnce(undefined);

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
});

describe('callRemoteMcpTool', () => {
  const route: RemoteMcpToolRoute = {
    gatewayToolName: 'mcp_test-server_get_weather',
    remoteToolName: 'get_weather',
    serverId: 'srv-1',
    serverName: 'Test Server',
  };

  const server = baseServer();

  it('returns SDK result as-is on success', async () => {
    const sdkResult = {
      content: [{ text: '{"temp": 72}', type: 'text' }],
      isError: false,
    };
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.callTool.mockResolvedValueOnce(sdkResult);
    mocks.close.mockResolvedValueOnce(undefined);

    const result = await callRemoteMcpTool({
      arguments: { city: 'NYC' },
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toStrictEqual(sdkResult);
    const callArgs = mocks.callTool.mock.calls[mocks.callTool.mock.calls.length - 1];
    expect(callArgs?.[0]).toStrictEqual({ arguments: { city: 'NYC' }, name: 'get_weather' });
    expect((callArgs?.[2] as { signal?: AbortSignal } | undefined)?.signal).toBeInstanceOf(
      AbortSignal
    );
  });

  it('returns isError result on tool call failure', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.callTool.mockRejectedValueOnce(new Error('tool exploded'));
    mocks.close.mockResolvedValueOnce(undefined);

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toStrictEqual({
      content: [{ text: expect.stringContaining('tool exploded'), type: 'text' }],
      isError: true,
    });
  });

  it('returns isError result when connect fails', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.close.mockResolvedValueOnce(undefined);

    const result = await callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server });

    expect(result).toMatchObject({ isError: true });
  });

  it('closes the client in finally even on error', async () => {
    mocks.close.mockClear();
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.close.mockResolvedValueOnce(undefined);

    await callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server });

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('passes caller abort signal as AbortSignal to callTool', async () => {
    const sdkResult = { content: [{ text: 'ok', type: 'text' }], isError: false };
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.callTool.mockResolvedValueOnce(sdkResult);
    mocks.close.mockResolvedValueOnce(undefined);

    const controller = new AbortController();
    await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
      signal: controller.signal,
    });

    const callArgs = mocks.callTool.mock.calls[mocks.callTool.mock.calls.length - 1];
    const callToolOptions = callArgs?.[2] as { signal?: AbortSignal } | undefined;
    expect(callToolOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns tool-error object (does not throw) when callTool rejects with AbortError', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.callTool.mockRejectedValueOnce(abortErr);
    mocks.close.mockResolvedValueOnce(undefined);

    const controller = new AbortController();
    controller.abort();
    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.any(String) }],
      isError: true,
    });
  });

  it('returns tool-error object (does not throw) when connect rejects with AbortError (simulating timeout)', async () => {
    const timeoutErr = Object.assign(new Error('signal timed out'), { name: 'AbortError' });
    mocks.connect.mockRejectedValueOnce(timeoutErr);
    mocks.close.mockResolvedValueOnce(undefined);

    const result = await callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.any(String) }],
      isError: true,
    });
  });
});
