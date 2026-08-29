/* eslint-disable max-lines -- Exercise the real MCP client, transport, adapter, and runner in one focused suite. */
import {
  ErrorCode,
  isJSONRPCRequest,
  JSONRPCMessageSchema,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  JSONRPCErrorResponse,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteMcpToolCall, createUserMessage } from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import { buildRemoteMcpToolDefinitions } from '@/src/shared/remote-mcp-tools';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';
import { executeRemoteMcpToolCall } from './agent-remote-mcp-tool-runtime';
import { toRemoteMcpToolCallEvents } from './agent-tool-call-events';

// The OAuth provider imports browser; these unauthenticated fixtures never use it.
// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({ browser: {} }));

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

// Only the HTTP peer is controlled. The SDK and callRemoteMcpTool remain real.
const createRemote = (rejection?: JSONRPCErrorResponse['error']) => {
  const initialize = vi.fn<() => Promise<void>>().mockResolvedValue();
  const callTool = vi
    .fn<() => Promise<CallToolResult>>()
    .mockResolvedValue({ content: [{ text: 'ok', type: 'text' }] });
  const requests: Request[] = [];
  const toolCalls: JSONRPCRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === 'GET') {
      return new Response(null, { status: 405 });
    }
    const message = JSONRPCMessageSchema.parse(await request.json());
    if (!isJSONRPCRequest(message)) {
      return new Response(null, { status: 202 });
    }
    if (message.method === 'initialize') {
      await initialize();
      return Response.json({
        id: message.id,
        jsonrpc: '2.0',
        result: {
          capabilities: { tools: {} },
          protocolVersion: LATEST_PROTOCOL_VERSION,
          serverInfo: { name: 'fixture', version: '1.0.0' },
        },
      });
    }
    if (message.method === 'tools/call') {
      toolCalls.push(message);
      if (toolCalls.length === 1 && rejection !== undefined) {
        return Response.json({ error: rejection, id: message.id, jsonrpc: '2.0' });
      }
      return Response.json({ id: message.id, jsonrpc: '2.0', result: await callTool() });
    }
    throw new Error(`Unexpected MCP method: ${message.method}`);
  };
  return { callTool, fetch, initialize, requests, toolCalls };
};

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

const runRemoteTurn = async (
  remote: ReturnType<typeof createRemote>,
  options: { executionGuard?: ExecutionGuard; signal?: AbortSignal } = {}
) => {
  const server = connectedServer();
  const { routes, tools } = buildRemoteMcpToolDefinitions({ mode: 'dangerous', servers: [server] });
  const events: AgentConversationEvent[] = [];
  const responses = [
    {
      choices: [
        {
          delta: {
            tool_calls: ['first', 'second'].map((query, index) => ({
              function: { arguments: JSON.stringify({ query }), name: 'mcp_acme_search' },
              id: `call-${index}`,
              index,
              type: 'function',
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
  ]
    .map(
      chunk =>
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
    )
    .values();
  let modelRequests = 0;
  const outcome = await runLlmTurn<ReturnType<typeof createRemoteMcpToolCall>>({
    apiBaseUrl: 'https://app.kilo.ai',
    appendEvents: appended => events.push(...appended),
    conversationEvents: [createUserMessage('Run both searches.')],
    executeToolCall: event =>
      executeRemoteMcpToolCall({
        event,
        executionGuard: options.executionGuard,
        fetch: remote.fetch,
        routes,
        servers: [server],
        signal: options.signal,
      }),
    executionGuard: options.executionGuard,
    failureMessage: String,
    fetch: () => {
      modelRequests += 1;
      const response = responses.next().value;
      if (response === undefined) {
        throw new Error('Unexpected model retry.');
      }
      return response;
    },
    maxToolRounds: 3,
    model: 'test-model',
    noResponseMessage: 'No response.',
    signal: options.signal,
    toToolCallEvents: calls => toRemoteMcpToolCallEvents(calls, routes),
    token: 'gateway-token',
    tooManyToolRoundsMessage: 'Too many rounds.',
    tools,
    updateAssistantMessage: vi.fn(),
    updateThinkingBlock: vi.fn(),
  });
  return { events, modelRequests, outcome };
};

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
  it('stops later actions and prevents success after an issued transport fails', async () => {
    const remote = createRemote();
    remote.callTool.mockRejectedValueOnce(new Error('Connection lost.'));

    const { events, modelRequests, outcome } = await runRemoteTurn(remote);

    expect(outcome).toMatchObject({
      effectsUncertain: true,
      reason: 'effects_uncertain',
      status: 'interrupted',
      toolResults: [],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        effectsUncertain: true,
        error: 'Connection lost.',
        ok: false,
        type: 'tool-result',
      })
    );
    expect(remote.toolCalls).toMatchObject([{ params: { arguments: { query: 'first' } } }]);
    expect(modelRequests).toBe(1);
  });

  it('propagates AbortError through the SDK instead of returning a recoverable failure', async () => {
    const error = new DOMException('Stopped.', 'AbortError');
    const controller = new AbortController();
    const remote = createRemote();
    remote.callTool.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort(error);
      return { content: [] };
    });
    const server = connectedServer();

    await expect(
      executeRemoteMcpToolCall({
        event: searchEvent(),
        fetch: remote.fetch,
        routes: routesFor([server]),
        servers: [server],
        signal: controller.signal,
      })
    ).rejects.toBe(error);
    expect(remote.toolCalls).toHaveLength(1);
  });

  it('retains a typed owner reason and uncertain effects after an issued call aborts', async () => {
    const controller = new AbortController();
    const remote = createRemote();
    remote.callTool.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort(new ExecutionStoppedError('lease_lost'));
      return { content: [] };
    });

    const { events, modelRequests, outcome } = await runRemoteTurn(remote, {
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      effectsUncertain: true,
      reason: 'lease_lost',
      status: 'interrupted',
      summary: 'Interrupted: lease_lost.',
      toolResults: [],
    });
    expect(events.at(-1)).toMatchObject({ text: 'Interrupted: lease_lost.', type: 'message' });
    expect(remote.toolCalls).toHaveLength(1);
    expect(modelRequests).toBe(1);
  });

  it('rejects lost authority before calling the remote client', async () => {
    const remote = createRemote();
    const server = connectedServer();
    await expect(
      executeRemoteMcpToolCall({
        event: searchEvent(),
        executionGuard: () => {
          throw new Error('lease_lost');
        },
        fetch: remote.fetch,
        routes: routesFor([server]),
        servers: [server],
      })
    ).rejects.toMatchObject({
      effectsUncertain: false,
      reason: 'lease_lost',
      status: 'interrupted',
    });
    expect(remote.requests).toHaveLength(0);
  });

  it('prevents dispatch when the owner revokes authority during connection setup', async () => {
    const remote = createRemote();
    const connecting = Promise.withResolvers<void>();
    const finishConnection = Promise.withResolvers<void>();
    const executionGuard = vi.fn<ExecutionGuard>();
    remote.initialize.mockImplementationOnce(() => {
      connecting.resolve();
      return finishConnection.promise;
    });
    const turn = runRemoteTurn(remote, { executionGuard });
    await connecting.promise;
    executionGuard.mockImplementation(() => {
      throw new ExecutionStoppedError('lease_lost');
    });
    finishConnection.resolve();

    const { modelRequests, outcome } = await turn;

    expect(outcome).toMatchObject({
      effectsUncertain: false,
      reason: 'lease_lost',
      status: 'interrupted',
      toolResults: [],
    });
    expect(remote.toolCalls).toHaveLength(0);
    expect(modelRequests).toBe(1);
  });

  it('keeps connection failure confirmed when no tool request was issued', async () => {
    const remote = createRemote();
    remote.initialize.mockRejectedValueOnce(new Error('connect failed'));
    const server = connectedServer();

    await expect(
      executeRemoteMcpToolCall({
        event: searchEvent(),
        fetch: remote.fetch,
        routes: routesFor([server]),
        servers: [server],
      })
    ).resolves.toStrictEqual({ effectsUncertain: false, error: 'connect failed', ok: false });
    expect(remote.toolCalls).toHaveLength(0);
  });

  it('returns ok:true with a capped value on success', async () => {
    const remote = createRemote();
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: remote.fetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({
      effectsUncertain: false,
      ok: true,
      value: { content: [{ text: 'ok', type: 'text' }] },
    });
  });

  it('caps oversized results', async () => {
    const remote = createRemote();
    remote.callTool.mockResolvedValueOnce({
      content: [{ text: 'x'.repeat(70 * 1024), type: 'text' }],
    });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: remote.fetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toMatchObject({ effectsUncertain: false, ok: true, value: { truncated: true } });
  });

  it('uses the supplied fetch and preserves an empty confirmed result', async () => {
    const remote = createRemote();
    remote.callTool.mockResolvedValueOnce({ content: [] });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: remote.fetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({ effectsUncertain: false, ok: true, value: { content: [] } });
    expect(new Set(remote.requests.map(request => request.url))).toStrictEqual(
      new Set([server.url])
    );
  });

  it('returns a confirmed tool error without a request for an unresolved route', async () => {
    const remote = createRemote();
    const result = await executeRemoteMcpToolCall({
      event: searchEvent('mcp_gone_tool'),
      fetch: remote.fetch,
      routes: new Map(),
      servers: [],
    });

    expect(result).toStrictEqual({
      effectsUncertain: false,
      error: 'Remote MCP tool mcp_gone_tool is no longer available.',
      ok: false,
    });
    expect(remote.requests).toHaveLength(0);
  });

  it('returns a confirmed tool error without a request for a disabled server', async () => {
    const remote = createRemote();
    const server = connectedServer();
    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: remote.fetch,
      routes: routesFor([server]),
      servers: [{ ...server, enabled: false }],
    });

    expect(result).toStrictEqual({
      effectsUncertain: false,
      error: 'Remote MCP tool mcp_acme_search is no longer available.',
      ok: false,
    });
    expect(remote.requests).toHaveLength(0);
  });

  it('keeps a confirmed server tool error recoverable through the runner', async () => {
    const remote = createRemote();
    remote.callTool.mockResolvedValueOnce({
      content: [{ text: 'boom', type: 'text' }],
      isError: true,
    });

    const { modelRequests, outcome } = await runRemoteTurn(remote);

    expect(outcome).toMatchObject({
      effectsUncertain: false,
      reason: 'completed',
      status: 'succeeded',
      summary: 'Done.',
      toolResults: [
        { effectsUncertain: false, error: 'boom', ok: false },
        { effectsUncertain: false, ok: true, value: { content: [{ text: 'ok', type: 'text' }] } },
      ],
    });
    expect(remote.toolCalls).toHaveLength(2);
    expect(modelRequests).toBe(2);
  });

  it.each([
    {
      code: ErrorCode.InvalidParams,
      expectedError: 'MCP error -32602: Invalid query.',
      message: 'Invalid query.',
    },
    {
      code: ErrorCode.MethodNotFound,
      expectedError: 'MCP error -32601: Method not found.',
      message: 'Method not found.',
    },
  ])(
    'keeps a received JSON-RPC rejection recoverable through the runner: $code',
    async ({ code, expectedError, message }) => {
      const remote = createRemote({ code, message });

      const { modelRequests, outcome } = await runRemoteTurn(remote);

      expect(outcome).toMatchObject({
        effectsUncertain: false,
        reason: 'completed',
        status: 'succeeded',
        summary: 'Done.',
        toolResults: [
          { effectsUncertain: false, error: expectedError, ok: false },
          { effectsUncertain: false, ok: true, value: { content: [{ text: 'ok', type: 'text' }] } },
        ],
      });
      expect(remote.toolCalls).toMatchObject([
        { params: { arguments: { query: 'first' } } },
        { params: { arguments: { query: 'second' } } },
      ]);
      expect(modelRequests).toBe(2);
    }
  );

  it('caps an oversized isError message', async () => {
    const remote = createRemote();
    remote.callTool.mockResolvedValueOnce({
      content: [{ text: 'x'.repeat(70 * 1024), type: 'text' }],
      isError: true,
    });
    const server = connectedServer();

    const result = await executeRemoteMcpToolCall({
      event: searchEvent(),
      fetch: remote.fetch,
      routes: routesFor([server]),
      servers: [server],
    });

    expect(result).toStrictEqual({
      effectsUncertain: false,
      error: 'x'.repeat(64 * 1024),
      ok: false,
    });
  });
});
