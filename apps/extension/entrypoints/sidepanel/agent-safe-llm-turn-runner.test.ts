/* eslint-disable consistent-type-imports, no-unsafe-type-assertion, no-unsafe-call, no-unsafe-member-access, no-unsafe-assignment, no-unsafe-argument, id-length, prefer-destructuring, jest/no-untyped-mock-factory, no-useless-undefined, vitest/prefer-called-once, vitest/prefer-called-times, import/first -- test mock factories and fixture constraints */
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

import { runSafeLlmTurn } from './agent-safe-llm-turn-runner';
// eslint-disable-next-line import/first
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
// eslint-disable-next-line import/first
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
// eslint-disable-next-line import/first
import type { KiloGatewayToolDefinition } from '@/src/shared/kilo-api-client';

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
});
