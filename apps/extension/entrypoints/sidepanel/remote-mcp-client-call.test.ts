/* eslint-disable max-classes-per-file */
import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import type { RemoteMcpToolRoute } from '../../src/shared/remote-mcp-tools';

interface CallToolArg0 {
  arguments: Record<string, unknown>;
  name: string;
}
interface CallToolArg2 {
  signal?: AbortSignal;
}

const mocks = vi.hoisted(() => {
  const connect = vi.fn<() => Promise<void>>();
  const callTool =
    vi.fn<
      (arg0: CallToolArg0, _compat: unknown, opts: CallToolArg2 | undefined) => Promise<unknown>
    >();
  const close = vi.fn<() => Promise<void>>();

  return { callTool, close, connect };
});

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    connect = mocks.connect;
    callTool = mocks.callTool;
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
  class StreamableHTTPClientTransport {
    readonly url: URL;
    constructor(url: URL, _opts?: unknown) {
      // Mock transport — no real connection needed in call tests
      this.url = url;
    }
  }
  return {
    StreamableHTTPClientTransport,
    StreamableHTTPError: class StreamableHTTPError extends Error {},
  };
});

// eslint-disable-next-line import/first
import { callRemoteMcpTool } from './remote-mcp-client';

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

const route: RemoteMcpToolRoute = {
  gatewayToolName: 'mcp_test-server_get_weather',
  remoteToolName: 'get_weather',
  serverId: 'srv-1',
  serverName: 'Test Server',
};

const server = baseServer();

describe('remote MCP tool call', () => {
  it('returns SDK result as-is on success', async () => {
    const sdkResult = {
      content: [{ text: '{"temp": 72}', type: 'text' }],
      isError: false,
    };
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockResolvedValueOnce(sdkResult);
    mocks.close.mockResolvedValueOnce();

    const result = await callRemoteMcpTool({
      arguments: { city: 'NYC' },
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toStrictEqual(sdkResult);
    const lastCall = mocks.callTool.mock.calls.at(-1);
    expect(lastCall?.[0]).toStrictEqual({ arguments: { city: 'NYC' }, name: 'get_weather' });
    expect(lastCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns isError result on tool call failure', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockRejectedValueOnce(new Error('tool exploded'));
    mocks.close.mockResolvedValueOnce();

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('tool exploded');
  });

  it('returns isError result when connect fails', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.close.mockResolvedValueOnce();

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toMatchObject({ isError: true });
  });

  it('closes the client in finally even on error', async () => {
    mocks.close.mockClear();
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    mocks.close.mockResolvedValueOnce();

    await callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server });

    // eslint-disable-next-line vitest/prefer-called-once
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('passes caller abort signal as AbortSignal to callTool', async () => {
    const sdkResult = { content: [{ text: 'ok', type: 'text' }], isError: false };
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockResolvedValueOnce(sdkResult);
    mocks.close.mockResolvedValueOnce();

    const controller = new AbortController();
    await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
      signal: controller.signal,
    });

    expect(mocks.callTool.mock.calls.at(-1)?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns tool-error object (does not throw) when callTool rejects with AbortError', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockRejectedValueOnce(abortErr);
    mocks.close.mockResolvedValueOnce();

    const controller = new AbortController();
    controller.abort();
    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('operation was aborted');
  });

  it('returns tool-error object (does not throw) when connect rejects with AbortError (simulating timeout)', async () => {
    const timeoutErr = Object.assign(new Error('signal timed out'), { name: 'AbortError' });
    mocks.connect.mockRejectedValueOnce(timeoutErr);
    mocks.close.mockResolvedValueOnce();

    const result = await callRemoteMcpTool({
      arguments: {},
      fetch: noopFetch,
      route,
      server,
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('signal timed out');
  });
});
