import { describe, expect, it, vi } from 'vitest';

// Use-tab-debugger transitively imports the WXT '#imports' virtual module; stub it so the graph loads under vitest.
// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() }, tabs: { query: vi.fn() } },
  storage: { getItem: vi.fn(), setItem: vi.fn() },
}));

// eslint-disable-next-line import/first
import { getActiveTabId } from './use-tab-debugger';

describe('active tab id lookup', () => {
  it('returns the active tab id when the query yields a numeric id', async () => {
    const tabsApi = {
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
    };

    await expect(getActiveTabId(tabsApi)).resolves.toBe(42);
    expect(tabsApi.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('returns undefined when the query yields no active tab', async () => {
    const tabsApi = {
      query: vi.fn().mockResolvedValue([]),
    };

    await expect(getActiveTabId(tabsApi)).resolves.toBeUndefined();
  });

  it('returns undefined when the active tab id is not a number', async () => {
    const tabsApi = {
      query: vi.fn().mockResolvedValue([{ id: 'not-a-number' }]),
    };

    await expect(getActiveTabId(tabsApi)).resolves.toBeUndefined();
  });

  it('returns undefined when the query rejects', async () => {
    const tabsApi = {
      query: vi.fn().mockRejectedValue(new Error('tabs.query failed')),
    };

    await expect(getActiveTabId(tabsApi)).resolves.toBeUndefined();
  });
});
