import { describe, expect, it, vi } from 'vitest';
import { PAGE_SNAPSHOT_MESSAGE } from './tab-debugger';
import { createSafeToolCall } from './agent-conversation';
import { executeSafeToolCall } from '../../entrypoints/sidepanel/agent-safe-tool-runtime';
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    runtime: {
      sendMessage: mocks.sendMessage,
    },
  },
}));

describe('safe tool runtime', () => {
  it('resolves element details from the requested cached snapshot', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: {
          nodes: [
            {
              id: 'node-1',
              role: 'button',
              tag: 'button',
              text: 'Original button',
            },
          ],
          snapshotId: 'snapshot-1',
          text: 'Original button',
          title: 'Original page',
          url: 'https://example.com/',
        },
      },
      type: PAGE_SNAPSHOT_MESSAGE,
    });

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'get_page_snapshot',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        nodes: [
          {
            id: 'node-1',
            role: 'button',
            tag: 'button',
            text: 'Original button',
          },
        ],
        snapshotId: 'snapshot-1',
        text: 'Original button',
        title: 'Original page',
        url: 'https://example.com/',
      },
    });

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          elementId: 'node-1',
          name: 'get_element_details',
          snapshotId: 'snapshot-1',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        id: 'node-1',
        role: 'button',
        tag: 'button',
        text: 'Original button',
      },
    });
    expect(mocks.sendMessage.mock.calls[0]?.[0]).toStrictEqual({
      tabId: 7,
      type: PAGE_SNAPSHOT_MESSAGE,
    });
    expect(mocks.sendMessage.mock.calls[1]).toBeUndefined();
  });
});
