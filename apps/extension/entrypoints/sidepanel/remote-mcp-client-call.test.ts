/* eslint-disable max-classes-per-file */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionStoppedError } from '../../src/shared/agent-tool-results';
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

  it.each([
    new Error('Connection lost.'),
    new McpError(ErrorCode.ConnectionClosed, 'Connection closed.'),
    new McpError(ErrorCode.RequestTimeout, 'Request timed out.'),
  ])('does not turn an issued transport failure into a server tool error: %s', async failure => {
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockRejectedValueOnce(failure);
    mocks.close.mockResolvedValueOnce();

    await expect(
      callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server })
    ).rejects.toBe(failure);
  });

  it('returns a confirmed server tool error without throwing', async () => {
    const result = { content: [{ text: 'tool exploded', type: 'text' }], isError: true };
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockResolvedValueOnce(result);
    mocks.close.mockResolvedValueOnce();

    await expect(
      callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server })
    ).resolves.toStrictEqual(result);
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

    expect(result).toStrictEqual({
      content: [{ text: 'connect failed', type: 'text' }],
      isError: true,
    });
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

  it('propagates an issued AbortError instead of reporting a server tool error', async () => {
    const error = new DOMException('The operation was aborted', 'AbortError');
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockRejectedValueOnce(error);
    mocks.close.mockResolvedValueOnce();

    await expect(
      callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server })
    ).rejects.toBe(error);
  });

  it('marks a typed abort from an issued call uncertain without losing its owner reason', async () => {
    mocks.connect.mockResolvedValueOnce();
    mocks.callTool.mockRejectedValueOnce(new ExecutionStoppedError('lease_lost'));
    mocks.close.mockResolvedValueOnce();

    await expect(
      callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server })
    ).rejects.toMatchObject({
      effectsUncertain: true,
      reason: 'lease_lost',
      status: 'interrupted',
    });
  });

  it('keeps a connection AbortError confirmed before tool dispatch', async () => {
    mocks.callTool.mockClear();
    mocks.connect.mockRejectedValueOnce(new DOMException('Stopped.', 'AbortError'));
    mocks.close.mockResolvedValueOnce();

    await expect(
      callRemoteMcpTool({ arguments: {}, fetch: noopFetch, route, server })
    ).rejects.toMatchObject({
      effectsUncertain: false,
      reason: 'cancelled',
      status: 'cancelled',
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it('checks a direct caller guard before opening a connection', async () => {
    mocks.connect.mockClear();
    const error = new ExecutionStoppedError('lease_lost');

    await expect(
      callRemoteMcpTool({
        arguments: {},
        executionGuard: () => {
          throw error;
        },
        fetch: noopFetch,
        route,
        server,
      })
    ).rejects.toBe(error);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
