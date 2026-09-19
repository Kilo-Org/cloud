/* eslint-disable max-lines -- cohesive unit suite for conversation storage round-trip with schema validation */
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteMcpToolCall,
  createSafeToolCall,
  createToolCall,
  createToolResult,
  createWebMcpToolCall,
  createWorkflowToolCall,
} from '@/src/shared/agent-conversation';
import type { AgentConversationEvent } from '@/src/shared/agent-conversation';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';
import { conversationEventsSchema } from './agent-conversation-schemas';

// This module transitively imports the WXT '#imports' virtual module; stub it so the graph loads under vitest.
// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() } },
  storage: { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() },
}));

// eslint-disable-next-line import/first
import {
  normalizeStoredConversationStore,
  toPersistedConversationStore,
} from './agent-conversation-storage';

describe('remote MCP tool-call persistence round-trip', () => {
  it('survives a persist -> reload cycle without wiping the store', () => {
    const toolCall = createRemoteMcpToolCall({
      arguments: { city: 'Skopje' },
      name: 'mcp_fixture-mcp_get_weather',
      remoteToolName: 'get_weather',
      serverId: 'server-1',
      serverName: 'Fixture MCP',
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            toolCall,
            createToolResult({
              ok: true,
              toolCallId: toolCall.id,
              value: { tempC: 21 },
            }),
          ],
          id: 'conversation-1',
          title: 'Weather chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    // Reload from storage output. A missing schema member fails whole-store parse (history reset).
    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded).toBeDefined();
    expect(reloaded?.conversations).toHaveLength(1);
    expect(reloaded?.conversations[0]?.events).toStrictEqual([
      {
        arguments: { city: 'Skopje' },
        id: toolCall.id,
        name: 'mcp_fixture-mcp_get_weather',
        remoteToolName: 'get_weather',
        serverId: 'server-1',
        serverName: 'Fixture MCP',
        type: 'tool-call',
      },
      {
        id: reloaded?.conversations[0]?.events[1]?.id,
        ok: true,
        toolCallId: toolCall.id,
        type: 'tool-result',
        value: { tempC: 21 },
      },
    ]);
  });
});

describe('safe memory tool-call persistence round-trip', () => {
  it('keeps memoryId through a persist -> reload cycle', () => {
    const toolCall = createSafeToolCall({
      memoryId: 'memory-42',
      name: 'get_memory',
      tabId: 7,
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            toolCall,
            createToolResult({
              ok: true,
              toolCallId: toolCall.id,
              value: { id: 'memory-42', text: 'saved' },
            }),
          ],
          id: 'conversation-1',
          title: 'Memory chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      id: toolCall.id,
      memoryId: 'memory-42',
      name: 'get_memory',
      tabId: 7,
      type: 'tool-call',
    });
  });
});

describe('workflow tool-call persistence round-trip', () => {
  it('survives a persist -> reload cycle for search_workflows', () => {
    const toolCall = createWorkflowToolCall({
      arguments: { query: 'checkout' },
      name: 'search_workflows',
      tabId: 7,
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            toolCall,
            createToolResult({ ok: true, toolCallId: toolCall.id, value: { ok: true } }),
          ],
          id: 'conversation-1',
          title: 'search_workflows chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { query: 'checkout' },
      id: toolCall.id,
      name: 'search_workflows',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('survives a persist -> reload cycle for get_workflow', () => {
    const toolCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'get_workflow',
      tabId: 7,
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            toolCall,
            createToolResult({ ok: true, toolCallId: toolCall.id, value: { ok: true } }),
          ],
          id: 'conversation-1',
          title: 'get_workflow chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { workflowId: 'wf-1' },
      id: toolCall.id,
      name: 'get_workflow',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('survives a persist -> reload cycle for save_workflow and save_memory', () => {
    const saveCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'save_workflow',
      tabId: 7,
    });
    const saveMemCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'save_memory',
      tabId: 7,
    });

    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [saveCall, saveMemCall],
          id: 'conversation-1',
          title: 'save workflow chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { workflowId: 'wf-1' },
      id: saveCall.id,
      name: 'save_workflow',
      tabId: 7,
      type: 'tool-call',
    });
    expect(reloaded?.conversations[0]?.events[1]).toStrictEqual({
      arguments: { workflowId: 'wf-1' },
      id: saveMemCall.id,
      name: 'save_memory',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('survives a persist -> reload cycle for run_workflow and delete_workflow', () => {
    const runCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'run_workflow',
      tabId: 7,
    });
    const deleteCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'delete_workflow',
      tabId: 7,
    });

    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [runCall, deleteCall],
          id: 'conversation-1',
          title: 'run/delete workflow chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { workflowId: 'wf-1' },
      id: runCall.id,
      name: 'run_workflow',
      tabId: 7,
      type: 'tool-call',
    });
    expect(reloaded?.conversations[0]?.events[1]).toStrictEqual({
      arguments: { workflowId: 'wf-1' },
      id: deleteCall.id,
      name: 'delete_workflow',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('returns a defined store for a complete workflow round-trip', () => {
    const toolCall = createWorkflowToolCall({
      arguments: { workflowId: 'wf-1' },
      name: 'get_workflow',
      tabId: 7,
    });
    const result = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: { ok: true },
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [toolCall, result],
          id: 'conversation-1',
          title: 'defined store test',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };
    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));
    expect(reloaded).toBeDefined();
    expect(reloaded?.conversations).toHaveLength(1);
  });
});
describe('retired browser tool migration on load', () => {
  it('loads a conversation persisted with the retired page tools and eval', () => {
    const store = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            {
              code: 'return document.title;',
              id: 'ev-eval',
              name: 'eval',
              tabId: 7,
              type: 'tool-call',
            },
            {
              id: 'ev-snapshot',
              name: 'get_page_snapshot',
              tabId: 7,
              textStart: 100,
              type: 'tool-call',
            },
            { id: 'ev-shot', name: 'get_viewport_screenshot', tabId: 7, type: 'tool-call' },
            {
              id: 'ev-find',
              name: 'find_in_page',
              query: 'checkout',
              tabId: 7,
              type: 'tool-call',
            },
            {
              elementId: 'e12',
              id: 'ev-element',
              name: 'get_element_details',
              snapshotId: 'snapshot-1',
              tabId: 7,
              type: 'tool-call',
            },
            {
              id: 'ev-memory',
              memoryId: 'memory-42',
              name: 'get_memory',
              tabId: 7,
              type: 'tool-call',
            },
            {
              id: 'ev-result',
              ok: true,
              toolCallId: 'ev-snapshot',
              type: 'tool-result',
              value: 'page text',
            },
          ],
          id: 'conversation-1',
          title: 'Legacy chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(store);

    expect(reloaded?.conversations[0]?.events).toStrictEqual([
      {
        arguments: { function: 'return document.title;' },
        id: 'ev-eval',
        name: 'kilo_browser_evaluate',
        tabId: 7,
        type: 'tool-call',
      },
      {
        arguments: {},
        id: 'ev-snapshot',
        name: 'kilo_browser_snapshot',
        tabId: 7,
        type: 'tool-call',
      },
      {
        arguments: { scale: 'css' },
        id: 'ev-shot',
        name: 'kilo_browser_take_screenshot',
        tabId: 7,
        type: 'tool-call',
      },
      {
        arguments: { text: 'checkout' },
        id: 'ev-find',
        name: 'kilo_browser_find',
        tabId: 7,
        type: 'tool-call',
      },
      {
        arguments: { target: 'e12' },
        id: 'ev-element',
        name: 'kilo_browser_snapshot',
        tabId: 7,
        type: 'tool-call',
      },
      {
        id: 'ev-memory',
        memoryId: 'memory-42',
        name: 'get_memory',
        tabId: 7,
        type: 'tool-call',
      },
      {
        id: 'ev-result',
        ok: true,
        toolCallId: 'ev-snapshot',
        type: 'tool-result',
        value: 'page text',
      },
    ]);
  });
});

describe('schema rejection of unknown workflow-shaped tool', () => {
  it('rejects a tool-call with arguments and a name not in WorkflowToolName', () => {
    const result = conversationEventsSchema.safeParse([
      {
        arguments: { query: 'checkout' },
        id: 'ev-1',
        name: 'unknown_workflow',
        tabId: 7,
        type: 'tool-call',
      },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('browser tool-call persistence round-trip', () => {
  it('preserves reasoningDetails through a persist -> reload cycle', () => {
    const toolCall = {
      ...createToolCall({ arguments: { target: 'e1' }, name: 'kilo_browser_click', tabId: 7 }),
      reasoningDetails: [{ data: 'abc', type: 'reasoning.encrypted' }],
    };
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [toolCall],
          id: 'conversation-1',
          title: 'Browser chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { target: 'e1' },
      id: toolCall.id,
      name: 'kilo_browser_click',
      reasoningDetails: [{ data: 'abc', type: 'reasoning.encrypted' }],
      tabId: 7,
      type: 'tool-call',
    });
  });
});

describe('reasoning details survive a persist -> reload cycle for every tool-call family', () => {
  // The turn runner attaches the streamed reasoning to the first tool call of the turn whatever its family, and the gateway replay reads it back off that call.
  const reasoningDetails = [{ data: 'abc', type: 'reasoning.encrypted' }];

  const roundTrip = (event: AgentConversationEvent): AgentConversationEvent | undefined => {
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [event],
          id: 'conversation-1',
          title: 'Reasoning chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    return normalizeStoredConversationStore(toPersistedConversationStore(store))?.conversations[0]
      ?.events[0];
  };

  it('keeps reasoningDetails on a safe memory tool call', () => {
    const toolCall = {
      ...createSafeToolCall({ name: 'get_memory', tabId: 7 }),
      reasoningDetails,
    };

    expect(roundTrip(toolCall)).toStrictEqual({
      id: toolCall.id,
      name: 'get_memory',
      reasoningDetails,
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('keeps reasoningDetails on a remote MCP tool call', () => {
    const toolCall = {
      ...createRemoteMcpToolCall({
        arguments: { city: 'Skopje' },
        name: 'mcp_fixture-mcp_get_weather',
        remoteToolName: 'get_weather',
        serverId: 'server-1',
        serverName: 'Fixture MCP',
      }),
      reasoningDetails,
    };

    expect(roundTrip(toolCall)).toStrictEqual({
      arguments: { city: 'Skopje' },
      id: toolCall.id,
      name: 'mcp_fixture-mcp_get_weather',
      reasoningDetails,
      remoteToolName: 'get_weather',
      serverId: 'server-1',
      serverName: 'Fixture MCP',
      type: 'tool-call',
    });
  });

  it('keeps reasoningDetails on a WebMCP tool call', () => {
    const toolCall = {
      ...createWebMcpToolCall({
        arguments: { query: 'kilo' },
        definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
        documentId: 'doc-1',
        name: 'search',
        providerToolCallId: 'call_webmcp_1',
        tabId: 7,
        webMcpOrigin: 'https://example.com',
      }),
      reasoningDetails,
    };

    expect(roundTrip(toolCall)).toStrictEqual({
      arguments: { query: 'kilo' },
      definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
      documentId: 'doc-1',
      id: toolCall.id,
      name: 'search',
      providerToolCallId: 'call_webmcp_1',
      reasoningDetails,
      tabId: 7,
      type: 'tool-call',
      webMcpOrigin: 'https://example.com',
    });
  });

  it('keeps reasoningDetails through the retired page tool migration', () => {
    const reloaded = normalizeStoredConversationStore({
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            {
              id: 'ev-snapshot',
              name: 'get_page_snapshot',
              reasoningDetails,
              tabId: 7,
              type: 'tool-call',
            },
          ],
          id: 'conversation-1',
          title: 'Legacy chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    });

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: {},
      id: 'ev-snapshot',
      name: 'kilo_browser_snapshot',
      reasoningDetails,
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('keeps reasoningDetails through the eval migration', () => {
    const reloaded = normalizeStoredConversationStore({
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            {
              code: 'return document.title;',
              id: 'ev-eval',
              name: 'eval',
              reasoningDetails,
              tabId: 7,
              type: 'tool-call',
            },
          ],
          id: 'conversation-1',
          title: 'Legacy chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    });

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { function: 'return document.title;' },
      id: 'ev-eval',
      name: 'kilo_browser_evaluate',
      reasoningDetails,
      tabId: 7,
      type: 'tool-call',
    });
  });
});

describe('web MCP tool-call persistence round-trip', () => {
  it('preserves every WebMCP route field through a persist -> reload cycle', () => {
    const toolCall = createWebMcpToolCall({
      arguments: { query: 'kilo' },
      definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
      documentId: 'doc-1',
      name: 'search',
      providerToolCallId: 'call_webmcp_1',
      tabId: 7,
      webMcpOrigin: 'https://example.com',
    });
    const store: StoredAgentConversationStore = {
      activeConversationId: 'conversation-1',
      conversations: [
        {
          events: [
            toolCall,
            createToolResult({ ok: true, toolCallId: toolCall.id, value: { hits: 2 } }),
          ],
          id: 'conversation-1',
          title: 'WebMCP chat',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      openConversationIds: ['conversation-1'],
    };

    const reloaded = normalizeStoredConversationStore(toPersistedConversationStore(store));

    expect(reloaded?.conversations[0]?.events[0]).toStrictEqual({
      arguments: { query: 'kilo' },
      definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
      documentId: 'doc-1',
      id: toolCall.id,
      name: 'search',
      providerToolCallId: 'call_webmcp_1',
      tabId: 7,
      type: 'tool-call',
      webMcpOrigin: 'https://example.com',
    });
  });
});
