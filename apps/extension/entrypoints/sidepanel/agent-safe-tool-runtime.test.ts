import { describe, expect, it, vi } from 'vitest';
import { PAGE_SNAPSHOT_MESSAGE } from '../../src/shared/tab-debugger';
import { createSafeToolCall } from '../../src/shared/agent-conversation';
import { createSafeToolExecutor, executeSafeToolCall } from './agent-safe-tool-runtime';

const sendMessage = vi.hoisted(() => vi.fn());

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage } },
  storage: { defineItem: vi.fn(() => ({ getValue: vi.fn(), setValue: vi.fn() })) },
}));

const snapshotValue = {
  nodes: [{ id: 'n1', role: 'button', tag: 'button', text: 'Search' }],
  text: 'Search the site',
  title: 'Example',
  url: 'https://example.com/',
};

const snapshotResponse = (value: object) => ({
  ok: true,
  result: { ok: true, value },
  type: PAGE_SNAPSHOT_MESSAGE,
});

const snapshotCall = (tabId: number) =>
  createSafeToolCall({ name: 'get_page_snapshot', providerToolCallId: 'call-1', tabId });

describe('safe result certainty', () => {
  it.each([
    { label: 'legacy failure', result: { error: 'Lost result.', ok: false }, uncertain: true },
    {
      label: 'confirmed denial',
      result: { effectsUncertain: false, error: 'Permission denied.', ok: false },
      uncertain: false,
    },
    {
      label: 'uncertain success',
      result: { effectsUncertain: true, ok: true, value: snapshotValue },
      uncertain: true,
    },
  ])('preserves $label through snapshot parsing', async ({ result, uncertain }) => {
    sendMessage.mockResolvedValue({ ok: true, result, type: PAGE_SNAPSHOT_MESSAGE });
    const value = await createSafeToolExecutor()(snapshotCall(994));
    expect(value).toMatchObject({ effectsUncertain: uncertain, ok: false });
  });

  it('rejects a revoked guard before a snapshot dispatch', async () => {
    sendMessage.mockClear();
    const execute = createSafeToolExecutor(() => {
      throw new Error('lease_lost');
    });
    await expect(execute(snapshotCall(995))).rejects.toMatchObject({
      reason: 'lease_lost',
      status: 'interrupted',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('get_page_snapshot unchanged-page dedupe', () => {
  it('returns a compact unchanged marker for an identical consecutive snapshot', async () => {
    sendMessage.mockResolvedValue(snapshotResponse({ ...snapshotValue }));

    const first = await executeSafeToolCall(snapshotCall(991));
    expect(first).toMatchObject({ ok: true, value: { title: 'Example' } });

    const second = await executeSafeToolCall(snapshotCall(991));
    expect(second).toMatchObject({ ok: true, value: { unchanged: true } });
  });

  it('serves the full snapshot to a new executor (conversation) on the same tab', async () => {
    sendMessage.mockResolvedValue(snapshotResponse({ ...snapshotValue }));

    const firstConversation = createSafeToolExecutor();
    await firstConversation(snapshotCall(993));
    const repeat = await firstConversation(snapshotCall(993));
    expect(repeat).toMatchObject({ ok: true, value: { unchanged: true } });

    // A new conversation has never seen the earlier snapshot; the unchanged marker would starve it of page content.
    const secondConversation = createSafeToolExecutor();
    const fresh = await secondConversation(snapshotCall(993));
    expect(fresh).toMatchObject({ ok: true, value: { text: 'Search the site', title: 'Example' } });
  });

  it('serves the full snapshot again once the page content changes', async () => {
    sendMessage.mockResolvedValue(snapshotResponse({ ...snapshotValue }));
    await executeSafeToolCall(snapshotCall(992));

    sendMessage.mockResolvedValue(
      snapshotResponse({ ...snapshotValue, text: 'Results for kubernetes' })
    );
    const changed = await executeSafeToolCall(snapshotCall(992));
    expect(changed).toMatchObject({ ok: true, value: { text: 'Results for kubernetes' } });
  });
});
