import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestDeadlineError } from '@kilocode/event-service';
import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const connection = vi.hoisted(() => ({
  isConnected: () => true,
  retryConnection: () => undefined,
}));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connection,
}));
vi.mock('@kilocode/cloud-agent-sdk/list-directories', () => ({
  listDirectoriesOnConnection: vi.fn(),
}));

type Probe = { current: UseListDirectoriesResult | null };

function Harness({ connectionId, probe }: { connectionId: string | null; probe: Probe }) {
  probe.current = useListDirectories(connectionId);
  return null;
}

/** Mount the hook inside the app's QueryClientProvider and expose the latest API. */
async function mount(connectionId: string | null = 'conn-1', queryClient?: QueryClient) {
  const probe: Probe = { current: null };
  const rendered = await renderWithProviders(createElement(Harness, { connectionId, probe }), {
    queryClient,
  });
  return {
    ...rendered,
    api: () => {
      if (probe.current === null) {
        throw new Error('hook has not rendered yet');
      }
      return probe.current;
    },
  };
}

const listFn = vi.mocked(listDirectoriesOnConnection);

/**
 * The Retry budget is a one-shot flag read by the queryFn (see
 * LISTING_RETRY_DEADLINE_MS). query-core ends a refetch that repeats a no-data
 * fetch already in flight by handing back that fetch's promise (`query.js`
 * `continueRetry`) instead of re-running the queryFn, so a repeat tap must not
 * arm the flag: nothing would read it and the next plain open would inherit the
 * Retry budget (45 s across up to 32 sends) instead of its own one send and
 * 12 s deadline.
 */
describe('useListDirectories retry budget accounting', () => {
  beforeEach(() => {
    listFn.mockReset();
  });

  it('does not leak a repeat tap’s Retry budget into the next plain open', async () => {
    vi.useFakeTimers();
    const client = createTestQueryClient();
    const srcKey = ['list-directories', 'conn-1', 'src'];
    const otherKey = ['list-directories', 'conn-1', 'other'];
    /** Let React Query's start-up microtasks and the queryFn run. */
    const flush = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    try {
      // The open fails fast; the Retry then hangs, so the repeat tap lands while
      // the retry fetch — not a finished error — is on screen.
      listFn.mockResolvedValueOnce({ ok: false, reason: 'transport' });
      const { api, unmount } = await mount('conn-1', client);

      act(() => {
        api().list('src');
      });
      await flush();
      expect(api().state).toEqual({ phase: 'retryable', path: 'src' });

      listFn.mockReturnValue(new Promise(() => undefined));
      act(() => {
        api().list('src');
      });
      await flush();
      expect(listFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryState(srcKey)?.fetchStatus).toBe('fetching');

      act(() => {
        api().list('src');
      });
      await flush();
      // The repeat is a no-op: query-core returned the in-flight fetch.
      expect(listFn).toHaveBeenCalledTimes(2);

      act(() => {
        api().list('other');
      });
      await flush();
      expect(listFn).toHaveBeenCalledTimes(3);

      // The plain open of `other` keeps its contracted single send and 12 s
      // deadline: advancing only that far has to surface the failure (the leaked
      // Retry budget would still be waiting on its 45 s one). This asserts the
      // query state rather than the hook's phase, as the deadline test does:
      // React Query flushes the observer through a scheduler the fake timers
      // hold, and the phase mapping of this same failure is covered by
      // `maps a failed listing to the retryable state`.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(listFn).toHaveBeenCalledTimes(3);
      expect(client.getQueryState(otherKey)?.status).toBe('error');
      expect(client.getQueryState(otherKey)?.error).toBeInstanceOf(RequestDeadlineError);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
