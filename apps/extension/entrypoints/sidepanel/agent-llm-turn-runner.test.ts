/* eslint-disable import/max-dependencies, max-lines, jest/no-conditional-in-test, consistent-type-imports, no-unsafe-type-assertion, jest/no-untyped-mock-factory, no-useless-undefined, vitest/prefer-called-once, vitest/prefer-called-times, import/first -- Outcome matrices use stateful executor fakes and typed module mocks. */
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
vi.mock('./agent-eval-runtime', () => ({
  executeEvalToolCall: vi.fn().mockResolvedValue({ ok: true, value: 'eval' }),
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

import { runDangerousLlmTurn } from './agent-llm-turn-runner';
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
import { browser } from '#imports';
import {
  evalInTabWithScripting,
  EVAL_TAB_MESSAGE,
  isTabDebuggerRequest,
} from '@/src/shared/tab-debugger';
import { hashWorkflowScript } from '@/src/shared/agent-workflows';
import { evalInTab } from './agent-workflow-runtime';
// eslint-disable-next-line import/first
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';

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

const makeWorkflowCtx = (mode: 'dangerous' | 'safe' = 'dangerous') => ({
  allowWorkflowsInSafeMode: false,
  evalInTab: vi.fn(),
  getTabUrl: vi.fn(),
  mode,
  navigateTab: vi.fn(),
  requestApproval: vi.fn(),
  selectedTabId: 7,
  selectedTabTitle: 'Test',
  selectedTabUrl: 'https://example.com',
  signal: new AbortController().signal,
  storage: { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() },
});

describe('dangerous turn runner workflow wiring', () => {
  const buildOptions = (overrides: Partial<Parameters<typeof runDangerousLlmTurn>[0]> = {}) =>
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
    }) as Parameters<typeof runDangerousLlmTurn>[0];

  const outcomeCases: {
    assistantMessages?: string[];
    completion?: KiloGatewayChatCompletion;
    confirmed?: number;
    error?: Error;
    expected: Pick<LlmTurnOutcome, 'reason' | 'status'> & {
      summary?: string;
      toolResults?: Partial<LlmTurnOutcome['toolResults'][number]>[];
    };
    label: string;
    nextCompletion?: KiloGatewayChatCompletion;
    requests: number;
    rounds?: number;
    stop?: 'cancelled' | 'lease_lost';
    uncertain?: boolean;
    workflowTools?: KiloGatewayToolDefinition[];
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
      assistantMessages: ['Creating the workflow now.', 'Creating the workflow now.'],
      completion: {
        finishReason: 'tool_calls',
        toolCalls: [{ arguments: {}, id: 'read-1', name: 'get_page_snapshot' }],
      },
      confirmed: 1,
      expected: {
        reason: 'incomplete_response',
        status: 'failed',
        summary: 'Creating the workflow now.',
        toolResults: [{ effectsUncertain: false, ok: true, value: 'safe' }],
      },
      label: 'unconfirmed announcement after continuation exhaustion',
      nextCompletion: {
        content: 'Creating the workflow now.',
        finishReason: 'stop',
        toolCalls: [],
      },
      requests: 3,
    },
    {
      completion: {
        finishReason: 'tool_calls',
        toolCalls: [
          { arguments: {}, id: 'read-1', name: 'get_page_snapshot' },
          ...Array.from({ length: 25 }, (_value, index) => ({
            arguments: { workflowId: `missing-${String(index)}` },
            id: `failure-${String(index)}`,
            name: 'get_workflow' as const,
          })),
          { arguments: { query: 'must not run' }, id: 'read-after-cap', name: 'find_in_page' },
        ],
      },
      confirmed: 26,
      expected: {
        reason: 'tool_failure_limit',
        status: 'failed',
        toolResults: [
          { effectsUncertain: false, ok: true, value: 'safe' },
          ...Array.from({ length: 25 }, () => ({
            effectsUncertain: false,
            error: 'Workflow tool get_workflow is no longer available.',
            ok: false as const,
          })),
        ],
      },
      label: 'tool failure cap with a pending read',
      nextCompletion: { content: 'False success.', finishReason: 'stop', toolCalls: [] },
      requests: 1,
      // Missing workflow context exercises the wrapper's real confirmed failure path.
      workflowTools: [makeToolDef('get_workflow')],
    },
    {
      completion: {
        finishReason: 'tool_calls',
        toolCalls: [
          { arguments: {}, id: 'read-1', name: 'get_page_snapshot' },
          { arguments: {}, id: 'unknown-1', name: 'unknown_tool' as KiloGatewayToolName },
        ],
      },
      expected: { reason: 'unsafe_tool_call', status: 'failed' },
      label: 'unknown call in a mixed batch',
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
      expected: {
        reason: 'model_failure',
        status: 'failed',
        summary: 'LLM request failed: Model failed.',
      },
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
    const appended: Parameters<Parameters<typeof runDangerousLlmTurn>[0]['appendEvents']>[0] = [];
    vi.mocked(discoverWebMcpTools).mockResolvedValue(undefined);
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
      const pending = runDangerousLlmTurn(
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
          workflowTools: entry.workflowTools,
        })
      );
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result).toMatchObject({
        ...entry.expected,
        effectsUncertain: entry.uncertain ?? false,
      });
      expect(appended.filter(event => event.type === 'message')).toMatchObject(
        (entry.assistantMessages ?? [result.summary]).map(text => ({ role: 'assistant', text }))
      );
      expect(result.toolResults).toHaveLength(entry.confirmed ?? 0);
      expect(result.toolResults).toStrictEqual(
        appended.filter(event => event.type === 'tool-result')
      );
      expect({ actions: actions.length, requests }).toStrictEqual({
        actions: entry.confirmed ?? 0,
        requests: entry.requests,
      });
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
      vi.mocked(discoverWebMcpTools).mockResolvedValue(undefined);
      vi.mocked(runLlmTurn).mockImplementationOnce(options =>
        core.runLlmTurn({
          ...options,
          executeToolCall: toolCall => {
            actions.push(toolCall.name);
            return options.executeToolCall(toolCall);
          },
        })
      );
      const pending = runDangerousLlmTurn(
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

  it('propagates a scripting timeout through the workflow adapter to the core', async () => {
    const core = await vi.importActual<typeof import('@/src/shared/agent-llm-turn-runner-core')>(
      '@/src/shared/agent-llm-turn-runner-core'
    );
    const runtime = await vi.importActual<typeof import('./agent-workflow-tool-runtime')>(
      './agent-workflow-tool-runtime'
    );
    const gateway = await import('@/src/shared/kilo-api-client');
    const script = 'return { done: true, result: "observed" };';
    const workflow = {
      approvedScriptHash: await hashWorkflowScript(script),
      createdAt: 1,
      description: 'Test',
      id: 'wf-1',
      name: 'Test',
      scopeOrigin: 'https://example.com',
      script,
      updatedAt: 1,
    };
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const actions: string[] = [];
    const appended: Parameters<Parameters<typeof runDangerousLlmTurn>[0]['appendEvents']>[0] = [];
    let requests = 0;
    const stream = vi
      .spyOn(gateway, 'fetchKiloGatewayChatCompletionStream')
      .mockImplementation(() => {
        requests += 1;
        return Promise.resolve(
          requests === 1
            ? {
                finishReason: 'tool_calls',
                toolCalls: [1, 2].map(index => ({
                  arguments: { workflowId: 'wf-1' },
                  id: `workflow-${String(index)}`,
                  name: 'run_workflow',
                })),
              }
            : { content: 'Done.', finishReason: 'stop', toolCalls: [] }
        );
      });
    vi.mocked(runLlmTurn).mockImplementationOnce(core.runLlmTurn);
    vi.mocked(executeWorkflowToolCall).mockImplementation(runtime.executeWorkflowToolCall);
    vi.mocked(discoverWebMcpTools).mockResolvedValue(undefined);
    vi.mocked(browser.runtime.sendMessage).mockReset();
    // eslint-disable-next-line typescript-eslint/no-misused-promises -- The browser overload includes a void callback form; this fake implements its Promise form.
    vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message: unknown) => {
      if (!isTabDebuggerRequest(message) || message.type !== EVAL_TAB_MESSAGE) {
        throw new Error('Unexpected browser message.');
      }
      return {
        ok: true,
        result: await evalInTabWithScripting({
          code: message.code,
          scriptingApi: {
            executeScript: async () => {
              actions.push('eval');
              await release.promise;
              actions.push('issued action completed later');
              finished.resolve();
              return [{ result: { ok: true, value: { done: true, result: 'observed' } } }];
            },
          },
          tabId: message.tabId,
          timeoutMs: 1,
        }),
        type: EVAL_TAB_MESSAGE,
      };
    });
    try {
      const result = await runDangerousLlmTurn(
        buildOptions({
          appendEvents: events => appended.push(...events),
          maxToolRounds: 3,
          workflowToolContext: {
            ...makeWorkflowCtx(),
            evalInTab,
            getTabUrl: () => Promise.resolve('https://example.com/page'),
            storage: {
              getItem: () => Promise.resolve([workflow]),
              removeItem: () => {},
              setItem: () => {},
            },
          },
          workflowTools: [makeToolDef('run_workflow')],
        })
      );
      expect(result).toMatchObject({
        effectsUncertain: true,
        reason: 'effects_uncertain',
        status: 'interrupted',
        toolResults: [],
      });
      expect(appended).toContainEqual(
        expect.objectContaining({ effectsUncertain: true, ok: false, type: 'tool-result' })
      );
      expect({
        actions,
        requests,
        sends: vi.mocked(browser.runtime.sendMessage).mock.calls.length,
      }).toStrictEqual({ actions: ['eval'], requests: 1, sends: 1 });
      release.resolve();
      await finished.promise;
      expect({ actions, requests }).toStrictEqual({
        actions: ['eval', 'issued action completed later'],
        requests: 1,
      });
    } finally {
      release.resolve();
      stream.mockRestore();
      vi.mocked(executeWorkflowToolCall)
        .mockReset()
        .mockResolvedValue({ effectsUncertain: false, ok: true, value: 'workflow' });
      vi.mocked(browser.runtime.sendMessage).mockReset();
    }
  });

  it('keeps cancellation and uncertainty when an issued eval aborts', async () => {
    const core = await vi.importActual<typeof import('@/src/shared/agent-llm-turn-runner-core')>(
      '@/src/shared/agent-llm-turn-runner-core'
    );
    const gateway = await import('@/src/shared/kilo-api-client');
    const stream = vi.spyOn(gateway, 'fetchKiloGatewayChatCompletionStream').mockResolvedValue({
      finishReason: 'tool_calls',
      toolCalls: [1, 2].map(index => ({
        arguments: { code: 'return 1;' },
        id: `eval-${String(index)}`,
        name: 'eval',
      })),
    });
    vi.mocked(runLlmTurn).mockImplementationOnce(core.runLlmTurn);
    vi.mocked(discoverWebMcpTools).mockResolvedValue(undefined);
    vi.mocked(browser.runtime.sendMessage)
      .mockReset()
      .mockRejectedValue(new DOMException('Stopped.', 'AbortError'));
    try {
      const result = await runDangerousLlmTurn(buildOptions());
      expect(result).toMatchObject({
        effectsUncertain: true,
        reason: 'cancelled',
        status: 'cancelled',
        toolResults: [],
      });
      expect(browser.runtime.sendMessage).toHaveBeenCalledOnce();
      expect(stream).toHaveBeenCalledOnce();
    } finally {
      stream.mockRestore();
      vi.mocked(browser.runtime.sendMessage).mockReset();
    }
  });

  it('routes workflow tool calls to executeWorkflowToolCall', async () => {
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

    await runDangerousLlmTurn(
      buildOptions({
        workflowToolContext: makeWorkflowCtx(),
        workflowTools: [],
      })
    );

    expect(executeWorkflowToolCall).toHaveBeenCalledOnce();
  });

  it('includes all six workflow tools in dangerous mode', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runDangerousLlmTurn(
      buildOptions({
        workflowToolContext: makeWorkflowCtx(),
        workflowTools: [
          makeToolDef('search_workflows'),
          makeToolDef('get_workflow'),
          makeToolDef('save_workflow'),
          makeToolDef('save_memory'),
          makeToolDef('run_workflow'),
          makeToolDef('delete_workflow'),
        ],
      })
    );

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const [{ tools }] = firstCall;

    const evalIndex = tools.findIndex(tool => tool.function.name === 'eval');
    const searchWorkflowsIndex = tools.findIndex(tool => tool.function.name === 'search_workflows');
    expect(evalIndex).toBeLessThan(searchWorkflowsIndex);
    expect(evalIndex).toBeGreaterThan(0);

    const workflowNames = tools
      .map(tool => tool.function.name)
      .filter(name =>
        [
          'search_workflows',
          'get_workflow',
          'save_workflow',
          'save_memory',
          'run_workflow',
          'delete_workflow',
        ].includes(name)
      );
    expect(workflowNames).toHaveLength(6);
  });

  it('uses the shared maxAgentToolRounds constant for the tool round limit', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runDangerousLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const [{ maxToolRounds }] = firstCall;
    expect(maxToolRounds).toBe(maxAgentToolRounds);
  });

  it('always discovers WebMCP tools regardless of allowWebMcpInSafeMode', async () => {
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

    await runDangerousLlmTurn(buildOptions({ allowWebMcpInSafeMode: false }));

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const [{ prepareTools, tools }] = firstCall;

    const prepared = await prepareTools!();

    expect(discoverWebMcpTools).toHaveBeenCalledWith(7, expect.any(Function));
    expect(prepared).toHaveLength(tools.length + 1);
    expect(prepared.at(-1)!.function.name).toBe('double');
  });

  it('clears the route map when a later refresh returns an empty document, returning only fixed tools', async () => {
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
      .mockResolvedValueOnce({ documentId: '', tools: [] });

    await runDangerousLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const [{ prepareTools, toToolCallEvents, tools }] = firstCall;

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

    await runDangerousLlmTurn(buildOptions({ workflowToolContext: makeWorkflowCtx() }));

    expect(executeWebMcpToolCall).toHaveBeenCalledOnce();
    expect(executeWorkflowToolCall).not.toHaveBeenCalled();
  });
});
