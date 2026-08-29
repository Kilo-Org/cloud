/* eslint-disable max-lines, jest/no-conditional-in-test, consistent-type-imports, no-unsafe-type-assertion, no-unsafe-call, no-unsafe-member-access, no-unsafe-assignment, no-unsafe-argument, id-length, prefer-destructuring, jest/no-untyped-mock-factory, no-useless-undefined, vitest/prefer-called-once, vitest/prefer-called-times, import/first -- test mock factories and fixture constraints */
import { describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() }, tabs: { get: vi.fn(), query: vi.fn() } },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    watch: vi.fn(() => () => {
      /* No-op */
    }),
  },
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('@/src/shared/agent-llm-turn-runner-core', () => ({
  runLlmTurn: vi.fn().mockResolvedValue({
    effectsUncertain: false,
    reason: 'completed',
    status: 'succeeded',
    summary: 'Done.',
    toolResults: [],
  }),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-safe-tool-runtime', () => ({
  createSafeToolExecutor: vi.fn(() => vi.fn().mockResolvedValue({ ok: true, value: 'safe' })),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-workflow-tool-runtime', () => ({
  executeWorkflowToolCall: vi.fn().mockResolvedValue({
    ok: true,
    value: { pagesVisited: 1, result: { done: true } },
  }),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-web-mcp-tool-runtime', () => ({
  discoverWebMcpTools: vi.fn(),
  executeWebMcpToolCall: vi.fn().mockResolvedValue({ ok: true, value: 'webmcp' }),
}));

import { runSafeLlmTurn } from './agent-safe-llm-turn-runner';
// eslint-disable-next-line import/first
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
// eslint-disable-next-line import/first
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
// eslint-disable-next-line import/first
import { discoverWebMcpTools, executeWebMcpToolCall } from './agent-web-mcp-tool-runtime';
// eslint-disable-next-line import/first
import type {
  KiloGatewayChatCompletion,
  KiloGatewayToolDefinition,
  KiloGatewayToolName,
} from '@/src/shared/kilo-api-client';
import type { LlmTurnOutcome } from '@/src/shared/agent-llm-turn-runner-core';
import { ExecutionStoppedError } from '@/src/shared/agent-tool-results';

const gatewayResponse = (completion: KiloGatewayChatCompletion): Response =>
  new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            content: completion.content,
            reasoning: completion.reasoning,
            tool_calls: completion.toolCalls.map((call, index) => ({
              function: { arguments: JSON.stringify(call.arguments), name: call.name },
              id: call.id,
              index,
            })),
          },
          finish_reason: completion.finishReason,
        },
      ],
    })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  );

const makeToolDef = (name: string): KiloGatewayToolDefinition =>
  ({
    function: {
      description: 'Test tool',
      name,
      parameters: {},
    },
    type: 'function',
  }) as KiloGatewayToolDefinition;

const makeWorkflowCtx = () => ({
  allowWorkflowsInSafeMode: true,
  evalInTab: vi.fn(),
  getTabUrl: vi.fn(),
  mode: 'safe' as const,
  navigateTab: vi.fn(),
  requestApproval: vi.fn(),
  selectedTabId: 7,
  selectedTabTitle: 'Test',
  selectedTabUrl: 'https://example.com',
  signal: new AbortController().signal,
  storage: { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() },
});

describe('safe turn runner workflow wiring', () => {
  const buildOptions = (overrides: Partial<Parameters<typeof runSafeLlmTurn>[0]> = {}) =>
    ({
      apiBaseUrl: 'https://api.example.com',
      appendEvents: vi.fn() as never,
      conversationEvents: [],
      fetch: vi.fn() as never,
      model: 'test-model',
      selectedTabId: 7,
      token: 'test-token',
      updateAssistantMessage: vi.fn() as never,
      updateThinkingBlock: vi.fn() as never,
      ...overrides,
    }) as Parameters<typeof runSafeLlmTurn>[0];

  const outcomeCases: {
    completion?: KiloGatewayChatCompletion;
    confirmed?: number;
    error?: Error;
    expected: Pick<LlmTurnOutcome, 'reason' | 'status'> & Partial<Pick<LlmTurnOutcome, 'summary'>>;
    label: string;
    nextCompletion?: KiloGatewayChatCompletion;
    requests: number;
    rounds?: number;
    stop?: 'cancelled' | 'lease_lost';
    uncertain?: boolean;
  }[] = [
    {
      error: new ExecutionStoppedError('execution_timeout', 'interrupted', true),
      expected: { reason: 'execution_timeout', status: 'interrupted' },
      label: 'uncertain execution timeout',
      requests: 1,
      uncertain: true,
    },
    {
      completion: { content: 'Final answer.', finishReason: 'stop', toolCalls: [] },
      expected: { reason: 'completed', status: 'succeeded', summary: 'Final answer.' },
      label: 'complete answer without evidence',
      requests: 1,
    },
    {
      completion: { finishReason: 'stop', toolCalls: [] },
      expected: { reason: 'empty_response', status: 'failed' },
      label: 'empty response',
      requests: 1,
    },
    {
      completion: { finishReason: 'model_context_window_exceeded', toolCalls: [] },
      expected: {
        reason: 'context_overflow',
        status: 'failed',
        summary: 'The model did not return a response.',
      },
      label: 'empty context overflow',
      requests: 1,
    },
    {
      completion: { finishReason: 'length', toolCalls: [] },
      expected: {
        reason: 'truncated_response',
        status: 'failed',
        summary: 'The model did not return a response.',
      },
      label: 'exhausted empty truncation',
      requests: 3,
    },
    {
      completion: { content: 'Partial answer.', finishReason: 'length', toolCalls: [] },
      expected: { reason: 'truncated_response', status: 'failed', summary: 'Partial answer.' },
      label: 'partial final output',
      requests: 3,
    },
    {
      completion: {
        content: 'Partial answer.',
        finishReason: 'model_context_window_exceeded',
        toolCalls: [],
      },
      expected: { reason: 'context_overflow', status: 'failed', summary: 'Partial answer.' },
      label: 'context overflow',
      requests: 1,
    },
    {
      expected: { reason: 'rounds_exhausted', status: 'failed' },
      label: 'exhausted rounds',
      requests: 0,
      rounds: 0,
    },
    {
      completion: {
        finishReason: 'tool_calls',
        toolCalls: [{ arguments: {}, id: 'read-1', name: 'get_page_snapshot' }],
      },
      confirmed: 1,
      expected: { reason: 'rounds_exhausted', status: 'failed' },
      label: 'confirmed action without final answer',
      requests: 1,
      rounds: 1,
    },
    {
      completion: {
        finishReason: 'tool_calls',
        toolCalls: [
          { arguments: {}, id: 'read-1', name: 'get_page_snapshot' },
          { arguments: { code: 'document.title = "unsafe";' }, id: 'unsafe-1', name: 'eval' },
        ],
      },
      expected: { reason: 'unsafe_tool_call', status: 'failed' },
      label: 'unsafe call in a mixed batch',
      nextCompletion: { content: 'False success.', finishReason: 'stop', toolCalls: [] },
      requests: 1,
    },
    {
      completion: {
        toolCalls: [{ arguments: {}, id: 'unfinished-1', name: 'get_page_snapshot' }],
      },
      expected: { reason: 'truncated_response', status: 'failed' },
      label: 'tool batch without finish metadata',
      nextCompletion: { content: 'False success.', finishReason: 'stop', toolCalls: [] },
      requests: 1,
    },
    {
      error: new TypeError('Gateway stream tool call did not include a supported tool name.'),
      expected: { reason: 'completed', status: 'succeeded', summary: 'Recovered.' },
      label: 'transport TypeError with the same message as an unsupported tool',
      nextCompletion: { content: 'Recovered.', finishReason: 'stop', toolCalls: [] },
      requests: 2,
    },
    {
      error: new Error('Model failed.'),
      expected: { reason: 'model_failure', status: 'failed', summary: 'Model failed.' },
      label: 'model failure',
      requests: 1,
    },
    {
      error: new TypeError('Network failed.'),
      expected: { reason: 'retry_exhausted', status: 'failed' },
      label: 'retry exhaustion',
      requests: 3,
    },
    {
      expected: { reason: 'cancelled', status: 'cancelled' },
      label: 'Stop before a model round',
      requests: 0,
      stop: 'cancelled',
    },
    {
      expected: { reason: 'lease_lost', status: 'interrupted' },
      label: 'lost lease before a model round',
      requests: 0,
      stop: 'lease_lost',
    },
  ];

  it.each(outcomeCases)('returns the real stream outcome for $label', async entry => {
    const core = await vi.importActual<typeof import('@/src/shared/agent-llm-turn-runner-core')>(
      '@/src/shared/agent-llm-turn-runner-core'
    );
    let requests = 0;
    const actions: string[] = [];
    const appended: Parameters<Parameters<typeof runSafeLlmTurn>[0]['appendEvents']>[0] = [];
    vi.mocked(runLlmTurn).mockImplementationOnce(options =>
      core.runLlmTurn({
        ...options,
        executeToolCall: toolCall => {
          actions.push(toolCall.name);
          return options.executeToolCall(toolCall);
        },
        maxToolRounds: entry.rounds ?? 5,
      })
    );
    const controller = new AbortController();
    if (entry.stop === 'cancelled') {
      controller.abort();
    }
    vi.useFakeTimers();
    try {
      const pending = runSafeLlmTurn(
        buildOptions({
          appendEvents: events => appended.push(...events),
          executionGuard: () => {
            if (entry.stop === 'lease_lost') {
              throw new ExecutionStoppedError('lease_lost');
            }
          },
          fetch: () => {
            requests += 1;
            if (
              entry.error !== undefined &&
              (requests === 1 || entry.nextCompletion === undefined)
            ) {
              throw entry.error;
            }
            return gatewayResponse(
              (requests > 1 ? entry.nextCompletion : undefined) ??
                entry.completion ?? { content: 'Done.', finishReason: 'stop', toolCalls: [] }
            );
          },
          signal: controller.signal,
        })
      );
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result).toMatchObject({
        ...entry.expected,
        effectsUncertain: entry.uncertain ?? false,
      });
      expect(appended.filter(event => event.type === 'message')).toMatchObject([
        { role: 'assistant', text: result.summary },
      ]);
      expect(result.toolResults).toHaveLength(entry.confirmed ?? 0);
      expect(actions).toHaveLength(entry.confirmed ?? 0);
      expect(requests).toBe(entry.requests);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { confirmed: false, reason: 'lease_lost', status: 'interrupted' as const },
    { confirmed: false, reason: 'owner_cancelled', status: 'cancelled' as const },
    { confirmed: true, reason: 'owner_cancelled', status: 'cancelled' as const },
  ])(
    'retains $reason after an issued search (confirmed=$confirmed)',
    async ({ confirmed, reason, status }) => {
      const core = await vi.importActual<typeof import('@/src/shared/agent-llm-turn-runner-core')>(
        '@/src/shared/agent-llm-turn-runner-core'
      );
      const controller = new AbortController();
      const request = Promise.withResolvers<Response>();
      const issued = Promise.withResolvers<void>();
      const requests: string[] = [];
      const actions: string[] = [];
      const searchResult = { results: [{ url: 'https://example.com/observed' }] };
      vi.mocked(runLlmTurn).mockImplementationOnce(options =>
        core.runLlmTurn({
          ...options,
          executeToolCall: toolCall => {
            actions.push(toolCall.name);
            return options.executeToolCall(toolCall);
          },
        })
      );
      const pending = runSafeLlmTurn(
        buildOptions({
          fetch: (input, init) => {
            requests.push(String(input));
            if (input === 'https://api.example.com/api/exa/search') {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  request.reject(init.signal?.reason);
                },
                {
                  once: true,
                }
              );
              issued.resolve();
              return request.promise;
            }
            return gatewayResponse(
              requests.length === 1
                ? {
                    finishReason: 'tool_calls',
                    toolCalls: [
                      {
                        arguments: { query: 'observed result' },
                        id: 'search-1',
                        name: 'web_search',
                      },
                      { arguments: {}, id: 'read-2', name: 'get_page_snapshot' },
                    ],
                  }
                : { content: 'False success.', finishReason: 'stop', toolCalls: [] }
            );
          },
          signal: controller.signal,
        })
      );
      await issued.promise;
      if (confirmed) {
        request.resolve(Response.json(searchResult));
      }
      controller.abort(new ExecutionStoppedError(reason, status));
      const result = await pending;

      expect(result).toMatchObject({ effectsUncertain: !confirmed, reason, status });
      expect(result.toolResults).toMatchObject(
        confirmed ? [{ effectsUncertain: false, ok: true, value: searchResult }] : []
      );
      expect(actions).toStrictEqual(['web_search']);
      expect(requests).toStrictEqual([
        'https://api.example.com/api/gateway/v1/chat/completions',
        'https://api.example.com/api/exa/search',
      ]);
    }
  );

  it('routes workflow tool calls to executeWorkflowToolCall', async () => {
    vi.mocked(runLlmTurn).mockClear();

    const workflowToolContext = makeWorkflowCtx();

    await runSafeLlmTurn(
      buildOptions({
        workflowToolContext,
        workflowTools: [makeToolDef('run_workflow')],
      })
    );

    const { calls } = vi.mocked(runLlmTurn).mock;
    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    const { tools } = firstCall[0];
    expect(tools.some(tool => tool.function.name === 'run_workflow')).toBe(true);
  });

  it('places workflow tools between safe tools and remote MCP tools in the tool array', async () => {
    vi.mocked(runLlmTurn).mockClear();

    const remoteMcpTool = makeToolDef('mcp_test_tool');
    const workflowTool = makeToolDef('run_workflow');

    await runSafeLlmTurn(
      buildOptions({
        remoteMcpTools: [remoteMcpTool],
        workflowToolContext: makeWorkflowCtx(),
        workflowTools: [workflowTool],
      })
    );

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const { tools: toolDefs } = firstCall[0];

    expect(toolDefs[0]!.function.name).toBe('get_page_snapshot');
    const workflowIndex = toolDefs.findIndex(tool => tool.function.name === 'run_workflow');
    const mcpIndex = toolDefs.findIndex(tool => tool.function.name === 'mcp_test_tool');
    expect(workflowIndex).toBeLessThan(mcpIndex);
    expect(workflowIndex).toBeGreaterThan(0);
  });

  it('calls executeWorkflowToolCall for a workflow tool event', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(executeWorkflowToolCall).mockClear();

    vi.mocked(runLlmTurn).mockImplementation(async options => {
      const toolCall = {
        arguments: { workflowId: 'wf-1' },
        id: 'tc-1',
        name: 'run_workflow' as const,
        tabId: 7,
        type: 'tool-call' as const,
      };
      await options.executeToolCall(toolCall);
      return {
        effectsUncertain: false,
        reason: 'completed',
        status: 'succeeded',
        summary: 'Done.',
        toolResults: [],
      };
    });

    const workflowToolContext = makeWorkflowCtx();

    await runSafeLlmTurn(
      buildOptions({
        workflowToolContext,
        workflowTools: [],
      })
    );

    expect(executeWorkflowToolCall).toHaveBeenCalledOnce();
    const [event, ctx] = vi.mocked(executeWorkflowToolCall).mock.calls[0]!;
    expect(event.name).toBe('run_workflow');
    expect(ctx.mode).toBe('safe');
  });

  it('does not discover WebMCP tools when allowWebMcpInSafeMode is false', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(discoverWebMcpTools).mockClear();

    await runSafeLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const { prepareTools, tools } = firstCall[0];

    const prepared = await prepareTools!();

    expect(discoverWebMcpTools).not.toHaveBeenCalled();
    expect(prepared).toBe(tools);
  });

  it('discovers and appends WebMCP tools when allowWebMcpInSafeMode is true', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(discoverWebMcpTools).mockClear();
    vi.mocked(discoverWebMcpTools).mockResolvedValue({
      documentId: 'doc-1',
      tools: [
        {
          description: 'D',
          inputSchema: {},
          name: 'double',
          origin: 'https://example.com',
          title: 'Double',
        },
      ],
    });

    await runSafeLlmTurn(buildOptions({ allowWebMcpInSafeMode: true }));

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const { prepareTools, tools } = firstCall[0];

    const prepared = await prepareTools!();

    expect(discoverWebMcpTools).toHaveBeenCalledWith(7, expect.any(Function));
    expect(prepared).toHaveLength(tools.length + 1);
    expect(prepared.at(-1)!.function.name).toBe('double');
  });

  it('populates the route map so a WebMCP tool call resolves', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(discoverWebMcpTools).mockClear();
    vi.mocked(discoverWebMcpTools).mockResolvedValue({
      documentId: 'doc-1',
      tools: [
        {
          description: 'D',
          inputSchema: {},
          name: 'double',
          origin: 'https://example.com',
          title: 'Double',
        },
      ],
    });

    await runSafeLlmTurn(buildOptions({ allowWebMcpInSafeMode: true }));

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const { prepareTools, toToolCallEvents } = firstCall[0];

    await prepareTools!();

    const events = toToolCallEvents([
      { arguments: { value: 21 }, id: 'tc-1', name: 'double' as KiloGatewayToolName },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('double');
    expect(events[0]).toHaveProperty('webMcpOrigin', 'https://example.com');
  });

  it('clears the route map when a later refresh fails, returning only fixed tools', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(discoverWebMcpTools).mockClear();
    vi.mocked(discoverWebMcpTools)
      .mockResolvedValueOnce({
        documentId: 'doc-1',
        tools: [
          {
            description: 'D',
            inputSchema: {},
            name: 'double',
            origin: 'https://example.com',
            title: 'Double',
          },
        ],
      })
      .mockResolvedValueOnce(undefined);

    await runSafeLlmTurn(buildOptions({ allowWebMcpInSafeMode: true }));

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const { prepareTools, toToolCallEvents, tools } = firstCall[0];

    const firstPrepared = await prepareTools!();
    expect(firstPrepared).toHaveLength(tools.length + 1);

    const secondPrepared = await prepareTools!();
    expect(secondPrepared).toBe(tools);

    const events = toToolCallEvents([
      { arguments: { value: 21 }, id: 'tc-1', name: 'double' as KiloGatewayToolName },
    ]);
    expect(events).toHaveLength(0);
  });

  it('routes a WebMCP event to executeWebMcpToolCall before any other branch', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(executeWebMcpToolCall).mockClear();
    vi.mocked(executeWorkflowToolCall).mockClear();

    vi.mocked(runLlmTurn).mockImplementation(async options => {
      const toolCall = {
        arguments: { value: 21 },
        definitionSignature: 'sig',
        documentId: 'doc-1',
        id: 'tc-1',
        name: 'double',
        tabId: 7,
        type: 'tool-call' as const,
        webMcpOrigin: 'https://example.com',
      };
      await options.executeToolCall(toolCall);
      return {
        effectsUncertain: false,
        reason: 'completed',
        status: 'succeeded',
        summary: 'Done.',
        toolResults: [],
      };
    });

    await runSafeLlmTurn(buildOptions({ workflowToolContext: makeWorkflowCtx() }));

    expect(executeWebMcpToolCall).toHaveBeenCalledOnce();
    expect(executeWorkflowToolCall).not.toHaveBeenCalled();
  });
});
