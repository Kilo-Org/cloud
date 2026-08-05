/* eslint-disable max-lines -- cohesive unit suite for conversation storage round-trip with schema validation */
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteMcpToolCall,
  createSafeToolCall,
  createToolResult,
  createWorkflowToolCall,
} from '@/src/shared/agent-conversation';
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
