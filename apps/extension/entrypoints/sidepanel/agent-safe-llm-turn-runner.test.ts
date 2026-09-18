/* eslint-disable max-lines */
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

import { runSafeLlmTurn } from './agent-safe-llm-turn-runner';
// eslint-disable-next-line import/first
import { runLlmTurn } from '@/src/shared/agent-llm-turn-runner-core';
// eslint-disable-next-line import/first
import { KILO_SAFE_BROWSER_TOOL_NAMES } from '@/src/shared/browser-tool-definitions';
// eslint-disable-next-line import/first
import { executeKiloBrowserToolCall } from './browser-tool-runtime';
// eslint-disable-next-line import/first
import { executeWorkflowToolCall } from './agent-workflow-tool-runtime';
// eslint-disable-next-line import/first
import { discoverWebMcpTools, executeWebMcpToolCall } from './agent-web-mcp-tool-runtime';
// eslint-disable-next-line import/first
import type { KiloGatewayToolDefinition, KiloGatewayToolName } from '@/src/shared/kilo-api-client';

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

    expect(
      toolDefs.slice(0, KILO_SAFE_BROWSER_TOOL_NAMES.length).map(tool => tool.function.name)
    ).toStrictEqual([...KILO_SAFE_BROWSER_TOOL_NAMES]);
    const workflowIndex = toolDefs.findIndex(tool => tool.function.name === 'run_workflow');
    const mcpIndex = toolDefs.findIndex(tool => tool.function.name === 'mcp_test_tool');
    expect(workflowIndex).toBeLessThan(mcpIndex);
    expect(workflowIndex).toBeGreaterThan(KILO_SAFE_BROWSER_TOOL_NAMES.length);
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

    expect(discoverWebMcpTools).toHaveBeenCalledWith(7);
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
    expect(events[0]).toMatchObject({ name: 'double' });
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
    });

    await runSafeLlmTurn(buildOptions({ workflowToolContext: makeWorkflowCtx() }));

    expect(executeWebMcpToolCall).toHaveBeenCalledOnce();
    expect(executeWorkflowToolCall).not.toHaveBeenCalled();
  });

  it('lists the read-only kilo browser tools plus the non-browser safe tools first', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runSafeLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const names = firstCall[0].tools.map(tool => tool.function.name);

    expect(names).toStrictEqual([
      ...KILO_SAFE_BROWSER_TOOL_NAMES,
      'web_search',
      'search_memories',
      'get_memory',
    ]);
  });

  it('routes a kilo_browser_* event to executeKiloBrowserToolCall', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(executeKiloBrowserToolCall).mockClear();
    vi.mocked(runLlmTurn).mockImplementation(async options => {
      const toolCall = {
        arguments: { scale: 'css' },
        id: 'tc-shot',
        name: 'kilo_browser_take_screenshot' as const,
        tabId: 7,
        type: 'tool-call' as const,
      };
      await options.executeToolCall(toolCall);
    });

    await runSafeLlmTurn(buildOptions());

    expect(executeKiloBrowserToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(executeKiloBrowserToolCall).mock.calls[0]![0].name).toBe(
      'kilo_browser_take_screenshot'
    );
  });

  it('converts a read-only kilo_browser_* gateway call to a browser tool-call event', async () => {
    vi.mocked(runLlmTurn).mockClear();

    await runSafeLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const events = firstCall[0].toToolCallEvents([
      { arguments: { scale: 'css' }, id: 'call-shot', name: 'kilo_browser_take_screenshot' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      arguments: { scale: 'css' },
      name: 'kilo_browser_take_screenshot',
      providerToolCallId: 'call-shot',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('refuses a non-read-only browser call in safe mode and keeps the refusal visible', async () => {
    vi.mocked(runLlmTurn).mockClear();
    vi.mocked(executeKiloBrowserToolCall).mockClear();

    await runSafeLlmTurn(buildOptions());

    const firstCall = vi.mocked(runLlmTurn).mock.calls[0]!;
    const events = firstCall[0].toToolCallEvents([
      {
        arguments: { element: 'Save', target: 'e5' },
        id: 'call-click',
        name: 'kilo_browser_click',
      },
    ]);

    // The refusal travels with its call: the tool-call event renders the exchange and the tool-result event reaches the conversation and the model.
    expect(events).toHaveLength(2);
    const callEvent = events.find(event => event.type === 'tool-call');
    const refusal = events.find(event => event.type === 'tool-result');

    expect(callEvent).toMatchObject({
      arguments: { element: 'Save', target: 'e5' },
      name: 'kilo_browser_click',
      providerToolCallId: 'call-click',
      tabId: 7,
      type: 'tool-call',
    });
    expect(refusal).toMatchObject({
      error:
        'kilo_browser_click is not read-only: safe mode exposes only the Playwright MCP tools the upstream server marks with readOnlyHint, and this tool does not carry it. Switch to danger mode to run it.',
      ok: false,
      toolCallId: callEvent?.id,
      type: 'tool-result',
    });
  });
});
