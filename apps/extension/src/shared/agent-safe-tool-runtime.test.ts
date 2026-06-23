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
        limits: {
          maxNodeCount: 80,
          maxNodeTextLength: 500,
          maxTextLength: 8000,
        },
        nodes: [
          {
            id: 'node-1',
            role: 'button',
            tag: 'button',
            text: 'Original button',
          },
        ],
        nodesTruncated: false,
        snapshotId: 'snapshot-1',
        text: 'Original button',
        textTruncated: false,
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

  it('adds snapshot limits and default truncation metadata', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: {
          nodes: [],
          snapshotId: 'snapshot-2',
          text: 'Small page',
          title: 'Small',
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
        limits: {
          maxNodeCount: 80,
          maxNodeTextLength: 500,
          maxTextLength: 8000,
        },
        nodes: [],
        nodesTruncated: false,
        snapshotId: 'snapshot-2',
        text: 'Small page',
        textTruncated: false,
        title: 'Small',
        url: 'https://example.com/',
      },
    });
  });

  it('returns ranked find results with page text fallback and truncation metadata', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        value: {
          limits: {
            maxNodeCount: 80,
            maxNodeTextLength: 500,
            maxTextLength: 8000,
          },
          nodes: [
            {
              id: 'node-1',
              label: 'Keyword action',
              role: 'button',
              tag: 'button',
            },
            {
              href: 'https://example.com/docs/keyword',
              id: 'node-2',
              role: 'link',
              tag: 'a',
              text: 'Documentation',
            },
          ],
          nodesTruncated: false,
          snapshotId: 'snapshot-3',
          text: 'Plain paragraph has keyword outside captured nodes.',
          textTruncated: false,
          title: 'Find page',
          url: 'https://example.com/',
        },
      },
      type: PAGE_SNAPSHOT_MESSAGE,
    });

    await expect(
      executeSafeToolCall(
        createSafeToolCall({
          name: 'find_in_page',
          query: 'keyword',
          tabId: 7,
        })
      )
    ).resolves.toStrictEqual({
      ok: true,
      value: {
        matches: [
          {
            id: 'node-1',
            label: 'Keyword action',
            matchedField: 'label',
            role: 'button',
            tag: 'button',
          },
          {
            excerpt: 'Plain paragraph has keyword outside captured nodes.',
            matchedField: 'pageText',
            role: 'document',
            tag: 'body',
          },
          {
            href: 'https://example.com/docs/keyword',
            id: 'node-2',
            matchedField: 'href',
            role: 'link',
            tag: 'a',
            text: 'Documentation',
          },
        ],
        snapshotId: 'snapshot-3',
        totalMatches: 3,
        truncated: false,
      },
    });
  });
});
