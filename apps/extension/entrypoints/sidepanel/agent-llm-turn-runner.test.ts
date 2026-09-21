/* eslint-disable max-lines */
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

// eslint-disable-next-line vitest/prefer-import-in-mock
vi.mock('./browser-tool-runtime', () => ({
  executeKiloBrowserToolCall: vi.fn().mockResolvedValue({ ok: true, value: 'browser' }),
}));

import { runDangerousLlmTurn } from './agent-llm-turn-runner';
// eslint-disable-next-line import/first
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
// eslint-disable-next-line import/first
import { KILO_BROWSER_TOOL_NAMES } from '@/src/shared/browser-tool-definitions';
// eslint-disable-next-line import/first
import { executeKiloBrowserToolCall } from './browser-tool-runtime';
// eslint-disable-next-line import/first
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
// eslint-disable-next-line import/first
import { discoverWebMcpTools, executeWebMcpToolCall } from './agent-web-mcp-tool-runtime';
// eslint-disable-next-line import/first
import type { KiloGatewayToolDefinition, KiloGatewayToolName } from '@/src/shared/kilo-api-client';
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

    const webSearchIndex = tools.findIndex(tool => tool.function.name === 'web_search');
    const searchWorkflowsIndex = tools.findIndex(tool => tool.function.name === 'search_workflows');
    expect(webSearchIndex).toBeLessThan(searchWorkflowsIndex);
    expect(webSearchIndex).toBe(KILO_BROWSER_TOOL_NAMES.length);

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

    expect(discoverWebMcpTools).toHaveBeenCalledWith(7);
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
    });

    await runDangerousLlmTurn(buildOptions({ workflowToolContext: makeWorkflowCtx() }));

    expect(executeWebMcpToolCall).toHaveBeenCalledOnce();
    expect(executeWorkflowToolCall).not.toHaveBeenCalled();
  });

  it('lists every kilo browser tool in upstream order plus the non-browser tools', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runDangerousLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const names = firstCall[0].tools.map(tool => tool.function.name);

    expect(names).toStrictEqual([
      ...KILO_BROWSER_TOOL_NAMES,
      'web_search',
      'search_memories',
      'get_memory',
    ]);
    expect(names).toHaveLength(29);
  });

  it('routes a kilo_browser_* gateway call to a browser tool-call event without refusing', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runDangerousLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const events = firstCall[0].toToolCallEvents([
      {
        arguments: { element: 'Save', target: 'e5' },
        id: 'call-click',
        name: 'kilo_browser_click',
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      arguments: { element: 'Save', target: 'e5' },
      name: 'kilo_browser_click',
      providerToolCallId: 'call-click',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('routes a kilo_browser_* event to executeKiloBrowserToolCall', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(executeKiloBrowserToolCall).mockClear();

    vi.mocked(runLlmTurn).mockImplementation(async options => {
      const toolCall = {
        arguments: { text: 'Checkout' },
        id: 'tc-wait',
        name: 'kilo_browser_wait_for' as const,
        tabId: 7,
        type: 'tool-call' as const,
      };
      await options.executeToolCall(toolCall);
    });

    await runDangerousLlmTurn(buildOptions());

    expect(executeKiloBrowserToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(executeKiloBrowserToolCall).mock.calls[0]![0].name).toBe(
      'kilo_browser_wait_for'
    );
  });

  it('keeps the tool round limit and its message working', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runDangerousLlmTurn(buildOptions({ maxToolRounds: 4 }));

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    expect(firstCall[0].maxToolRounds).toBe(4);
    expect(firstCall[0].tooManyToolRoundsMessage).toBe(
      'The model requested too many tool rounds. Send another message to continue.'
    );
  });
});
