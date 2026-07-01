import { describe, expect, it, vi } from 'vitest';
import { createRemoteMcpToolCall, createToolResult } from '@/src/shared/agent-conversation';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';

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

    /*
     * Reload from what would be written to storage. A missing schema member would
     * fail the whole-store parse and return undefined (history reset to defaults).
     */
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
