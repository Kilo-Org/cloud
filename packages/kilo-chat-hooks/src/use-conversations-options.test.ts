import type * as ReactQueryModule from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof ReactQueryModule>('@tanstack/react-query');
  return {
    ...actual,
    useInfiniteQuery: (options: Record<string, unknown>) => {
      testState.options = options;
      return {};
    },
  };
});

import { useConversations } from './use-conversations';

describe('useConversations', () => {
  beforeEach(() => {
    testState.options = null;
  });

  it('sets refetchOnMount to always when requested', () => {
    useConversations({} as KiloChatClient, 'sandbox-1', { refetchOnMount: 'always' });

    expect(testState.options).toEqual(
      expect.objectContaining({
        refetchOnMount: 'always',
      })
    );
  });

  it('leaves remount refresh unchanged unless the caller opts in', () => {
    useConversations({} as KiloChatClient, 'sandbox-1');

    expect(testState.options).toEqual(
      expect.objectContaining({
        refetchOnMount: undefined,
      })
    );
  });
});
