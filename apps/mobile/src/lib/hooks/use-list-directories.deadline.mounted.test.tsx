import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestDeadlineError } from '@kilocode/event-service';
import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import { act } from '@/test/renderer';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const connection = vi.hoisted(() => ({
  isConnected: () => false,
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
 * The listing deadline: a transport that hangs without a close event (a
 * stalled relay, a radio that vanished before the socket opened) must still
 * end the wait inside the picker's error budget instead of holding the
 * skeleton for the SDK's 30 s command budget.
 */
describe('useListDirectories deadline', () => {
  beforeEach(() => {
    listFn.mockReset();
  });

  it('fails a listing that outlives its deadline', async () => {
    // The transport accepted the command but never answered (a stalled relay).
    // The SDK's own command budget is 30s, far past any usable picker state, so
    // the hook's own deadline has to end the wait. React Query publishes the
    // failure through its own scheduler, so this asserts the query state; the
    // retryable projection of that failure is covered by the test below.
    vi.useFakeTimers();
    const client = createTestQueryClient();
    listFn.mockReturnValueOnce(new Promise(() => undefined));
    const { api, unmount } = await mount('conn-1', client);
    const key = ['list-directories', 'conn-1', 'src'];
    try {
      act(() => {
        api().list('src');
      });
      expect(api().state).toEqual({ phase: 'skeleton', path: 'src' });
      // Flush React Query's start-up microtasks so the listing (and with it the
      // deadline timer) is really in flight before the clock moves.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(listFn).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(key)?.status).toBe('pending');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(client.getQueryState(key)?.status).toBe('error');
      expect(client.getQueryState(key)?.error).toBeInstanceOf(RequestDeadlineError);
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it('maps a failed listing to the retryable state', async () => {
    // What the deadline throws is what a dead socket throws: a plain failure
    // the picker answers with Retry, never the permanent unsupported branch.
    listFn.mockRejectedValueOnce(new RequestDeadlineError(12_000));
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('src');
    });
    await waitFor(() => api().state?.phase === 'retryable');
    expect(api().state).toEqual({ phase: 'retryable', path: 'src' });
    unmount();
  });
});
