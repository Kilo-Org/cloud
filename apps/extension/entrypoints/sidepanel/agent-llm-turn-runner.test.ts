/* eslint-disable consistent-type-imports, no-unsafe-type-assertion, jest/no-untyped-mock-factory, no-useless-undefined, vitest/prefer-called-once, vitest/prefer-called-times, import/first -- test mock factories and fixture constraints */
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
  runLlmTurn: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-eval-runtime', () => ({
  executeEvalToolCall: vi.fn().mockResolvedValue({ ok: true, value: 'eval' }),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-safe-tool-runtime', () => ({
  executeSafeToolCall: vi.fn().mockResolvedValue({ ok: true, value: 'safe' }),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./agent-workflow-tool-runtime', () => ({
  executeWorkflowToolCall: vi.fn().mockResolvedValue({
    ok: true,
    value: { pagesVisited: 1, result: { done: true } },
  }),
}));

import { runDangerousLlmTurn } from './agent-llm-turn-runner';
// eslint-disable-next-line import/first
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
// eslint-disable-next-line import/first
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
// eslint-disable-next-line import/first
import type { KiloGatewayToolDefinition } from '@/src/shared/kilo-api-client';
// eslint-disable-next-line import/first
import { maxAgentToolRounds } from '@/src/shared/agent-tool-round-limit';

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
});
