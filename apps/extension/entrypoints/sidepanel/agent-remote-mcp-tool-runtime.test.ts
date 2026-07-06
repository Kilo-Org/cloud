import { describe, expect, it, vi } from 'vitest';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';

const mocks = vi.hoisted(() => ({
  callRemoteMcpTool: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('./remote-mcp-client', () => ({ callRemoteMcpTool: mocks.callRemoteMcpTool }));

// eslint-disable-next-line import/first
import { executeRemoteMcpToolCall } from './agent-remote-mcp-tool-runtime';
// eslint-disable-next-line import/first
import { toRemoteMcpToolCallEvents } from './agent-tool-call-events';
// eslint-disable-next-line import/first
import { createRemoteMcpToolCall } from '@/src/shared/agent-conversation';
// eslint-disable-next-line import/first
import { buildRemoteMcpToolDefinitions } from '@/src/shared/remote-mcp-tools';

const connectedServer = (overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer => ({
  allowInSafeMode: false,
  auth: { type: 'none' },
  cachedTools: [{ inputSchema: { type: 'object' }, name: 'search' }],
  displayName: 'Acme',
  enabled: true,
  id: 'server-1',
  slug: 'acme',
  status: 'connected',
  url: 'https://mcp.example.com/',
  ...overrides,
});

const routesFor = (servers: readonly RemoteMcpServer[]): ReadonlyMap<string, RemoteMcpToolRoute> =>
  buildRemoteMcpToolDefinitions({ mode: 'dangerous', servers }).routes;

// eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-unsafe-type-assertion
const plainFetch = (() => Promise.resolve(new Response())) as unknown as typeof fetch;

const searchEvent = (
  name: `mcp_${string}` = 'mcp_acme_search'
): ReturnType<typeof createRemoteMcpToolCall> =>
  createRemoteMcpToolCall({
    arguments: { query: 'hi' },
    name,
    remoteToolName: 'search',
    serverId: 'server-1',
    serverName: 'Acme',
  });

describe('remote MCP tool-call event converter', () => {
  it('builds serverId/serverName/remoteToolName from the matching route', () => {
    const routes = routesFor([connectedServer()]);
    const toolCall: KiloGatewayToolCallRequest = {
      arguments: { query: 'hi' },
      id: 'call-1',
      name: 'mcp_acme_search',
    };

    const [event] = toRemoteMcpToolCallEvents([toolCall], routes);

    expect(event).toMatchObject({
      arguments: { query: 'hi' },
      name: 'mcp_acme_search',
      providerToolCallId: 'call-1',
      remoteToolName: 'search',
      serverId: 'server-1',
      serverName: 'Acme',
    });
  });

  it('emits an event with empty route fields when the route is gone', () => {
    const [event] = toRemoteMcpToolCallEvents(
      [{ arguments: {}, id: 'call-x', name: 'mcp_gone_tool' }],
      new Map()
    );

    expect(event).toMatchObject({ name: 'mcp_gone_tool', serverId: '', serverName: '' });
  });

  it('drops non-mcp tool calls', () => {
    expect(
      toRemoteMcpToolCallEvents([{ arguments: {}, id: 'c', name: 'eval' }], new Map())
    ).toHaveLength(0);
  });
});

describe('remote MCP tool executor', () => {
  it('returns ok:true with a capped value on success', async () => {
    mocks.callRemoteMcpTool.mockClear();
    mocks.callRemoteMcpTool.mockResolvedValueOnce({ content: [{ text: 'ok', type: 'text' }] });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({ ok: true, value: { content: [{ text: 'ok', type: 'text' }] } });
  });

  it('caps oversized results', async () => {
    mocks.callRemoteMcpTool.mockClear();
    mocks.callRemoteMcpTool.mockResolvedValueOnce({ big: 'x'.repeat(70 * 1024) });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toMatchObject({ ok: true, value: { truncated: true } });
  });

  it('passes the supplied fetch through to callRemoteMcpTool', async () => {
    mocks.callRemoteMcpTool.mockClear();
    mocks.callRemoteMcpTool.mockResolvedValueOnce({ content: [] });
    const server = connectedServer();

    await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(mocks.callRemoteMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: plainFetch })
    );
  });

  it('returns a tool error and never calls the client for an unresolved route', async () => {
    mocks.callRemoteMcpTool.mockClear();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent('mcp_gone_tool'),
      fetch: plainFetch,
      routes: new Map(),
      servers: [],
    });

    expect(result.ok).toBe(false);
    expect(mocks.callRemoteMcpTool).not.toHaveBeenCalled();
  });

  it('returns a tool error and never calls the client for a disabled server', async () => {
    mocks.callRemoteMcpTool.mockClear();
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [{ ...server, enabled: false }],
    });

    expect(result.ok).toBe(false);
    expect(mocks.callRemoteMcpTool).not.toHaveBeenCalled();
  });

  it('maps an isError MCP result to a tool error', async () => {
    mocks.callRemoteMcpTool.mockClear();
    mocks.callRemoteMcpTool.mockResolvedValueOnce({
      content: [{ text: 'boom', type: 'text' }],
      isError: true,
    });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({ error: 'boom', ok: false });
  });

  it('caps an oversized isError message', async () => {
    mocks.callRemoteMcpTool.mockClear();
    mocks.callRemoteMcpTool.mockResolvedValueOnce({
      content: [{ text: 'x'.repeat(70 * 1024), type: 'text' }],
      isError: true,
    });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: plainFetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({ error: 'x'.repeat(64 * 1024), ok: false });
  });
});
