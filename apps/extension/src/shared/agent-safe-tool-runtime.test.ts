import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_MESSAGE } from './tab-debugger';
import { createSafeToolCall, createToolCall } from './agent-conversation';
import type { AgentMemory } from './agent-memories';

const mocks = vi.hoisted(() => ({
  loadAgentMemories: vi.fn(),
  sendMessage: vi.fn(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    runtime: {
      sendMessage: mocks.sendMessage,
    },
  },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@/src/shared/agent-memories-storage', () => ({
  loadAgentMemories: mocks.loadAgentMemories,
}));

// eslint-disable-next-line import/first
import { executeSafeToolCall } from '../../entrypoints/sidepanel/agent-safe-tool-runtime';

const sampleMemory = (overrides: Partial<AgentMemory> = {}): AgentMemory => ({
  createdAt: 1_700_000_000_000,
  id: 'memory-1',
  pageTitle: 'Example',
  pageUrl: 'https://example.com/',
  text: 'Remember the API key lives in settings.',
  ...overrides,
});

describe('safe tool runtime memory tools', () => {
  it('returns shaped search_memories results without touching the tab snapshot path', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();
    mocks.loadAgentMemories.mockResolvedValueOnce([
      sampleMemory({
        id: 'memory-1',
        note: 'API tip',
        text: 'Remember the API key lives in settings.',
        truncated: true,
      }),
      sampleMemory({
        createdAt: 1_700_000_000_100,
        id: 'memory-2',
        text: 'Unrelated note about weather.',
      }),
    ]);

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'search_memories',
          query: 'api key',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        results: [
          {
            createdAt: 1_700_000_000_000,
            id: 'memory-1',
            note: 'API tip',
            pageTitle: 'Example',
            pageUrl: 'https://example.com/',
            snippet: 'Remember the API key lives in settings.',
            truncated: true,
          },
        ],
      },
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('returns an explicit empty search_memories result when nothing matches', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();
    mocks.loadAgentMemories.mockResolvedValueOnce([sampleMemory()]);

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'search_memories',
          query: 'zzzz-no-match',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        message: 'No memories matched.',
        results: [],
      },
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('requires a non-empty search_memories query', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'search_memories',
          query: '   ',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      error: 'Search query is required.',
      ok: false,
    });
    expect(mocks.loadAgentMemories).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('returns the full memory for get_memory', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();
    const memory = sampleMemory({ note: 'keep', truncated: true });
    mocks.loadAgentMemories.mockResolvedValueOnce([memory]);

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          memoryId: 'memory-1',
          name: 'get_memory',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: memory,
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('returns a tool error for an unknown get_memory id', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();
    mocks.loadAgentMemories.mockResolvedValueOnce([sampleMemory()]);

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          memoryId: 'missing',
          name: 'get_memory',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      error: 'Memory not found.',
      ok: false,
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('requires a memory id for get_memory', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'get_memory',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      error: 'Memory id is required.',
      ok: false,
    });
    expect(mocks.loadAgentMemories).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe('safe tool runtime browser dispatch', () => {
  it('forwards a kilo_browser_ call to the background with its arguments verbatim', async () => {
    mocks.sendMessage.mockReset();
    mocks.loadAgentMemories.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: { snapshot: 'page' } },
      type: BROWSER_TOOL_MESSAGE,
    });

    const toolCall = createToolCall({
      arguments: { target: 'e5' },
      name: 'kilo_browser_click',
      tabId: 7,
    });

    await expect(executeSafeToolCall(toolCall)).resolves.toStrictEqual({
      ok: true,
      value: { snapshot: 'page' },
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      arguments: { target: 'e5' },
      tabId: 7,
      tool: 'kilo_browser_click',
      type: BROWSER_TOOL_MESSAGE,
    });
    expect(mocks.loadAgentMemories).not.toHaveBeenCalled();
  });

  it('reports a background refusal as a tool error', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      error: 'The selected tab is not inspectable.',
      ok: false,
    });

    await expect(
      executeSafeToolCall(
        createToolCall({
          arguments: {},
          name: 'kilo_browser_snapshot',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      error: 'The selected tab is not inspectable.',
      ok: false,
    });
  });
});
