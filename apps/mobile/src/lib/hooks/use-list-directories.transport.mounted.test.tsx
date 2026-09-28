import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listDirectoriesOnConnection,
  type ListDirectoriesResult,
} from '@kilocode/cloud-agent-sdk/list-directories';

import { act } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useListDirectories, type UseListDirectoriesResult } from './use-list-directories';

const connection = vi.hoisted(() => {
  let connected = false;
  return {
    isConnected: vi.fn(() => connected),
    setConnected: (next: boolean) => {
      connected = next;
    },
    retryConnection: vi.fn(),
  };
});

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
async function mount(connectionId: string | null = 'conn-1') {
  const probe: Probe = { current: null };
  const rendered = await renderWithProviders(createElement(Harness, { connectionId, probe }));
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
const server = { name: 'server', path: 'src/server' };

/**
 * `waitFor` polls with `setTimeout(0)`, which is too tight to observe an
 * attempt that pauses between its sends; this variant keeps polling on real
 * timers for longer.
 */
async function waitForRealTimers(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially, one real tick at a time
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 25);
      });
    });
  }
  if (!predicate()) {
    throw new Error('waitForRealTimers: condition not met');
  }
}

describe('useListDirectories transport failures, nudges and retry pacing', () => {
  beforeEach(() => {
    listFn.mockReset();
    connection.retryConnection.mockClear();
    // The picker only lists over a live transport; a rebuilding one is the
    // exception, and the tests below that exercise it disconnect explicitly.
    connection.setConnected(true);
  });

  it('resets a transport failure to the skeleton on retry, then recovers', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'transport' });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');
    expect(api().state).toEqual({ phase: 'retryable', path: 'src' });

    // The Retry CTA repeats the path on screen: the refetch drops the query
    // back to pending and clears the error before the retry lands. Keep the
    // retry in flight so the pending phase it produces is observable.
    let resolveRetry: ((result: ListDirectoriesResult) => void) | undefined = undefined;
    const retry = new Promise<ListDirectoriesResult>(resolve => {
      resolveRetry = resolve;
    });
    listFn.mockReturnValue(retry);
    act(() => {
      api().list('src');
    });
    await waitFor(() => api().state?.phase === 'skeleton');
    expect(api().state).toEqual({ phase: 'skeleton', path: 'src' });

    await act(async () => {
      resolveRetry?.({ ok: true, path: 'src', directories: [server] });
      await Promise.resolve();
    });
    await waitFor(() => api().state?.phase === 'ready');
    expect(api().state).toEqual({ phase: 'ready', path: 'src', directories: [server] });
    // One send for the open that failed, one for the Retry.
    expect(listFn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('restarts a parked transport before the send it would otherwise block on', async () => {
    // The reconnect loop may have parked on a long backoff or exhausted itself
    // while the sheet sat on the error, and a send on that socket blocks in the
    // SDK's open waiter instead of failing. The attempt nudges the transport
    // before its first send; a failed send then reports the retryable state the
    // sheet already shows.
    listFn.mockResolvedValueOnce({ ok: false, reason: 'transport' });
    const { api, unmount } = await mount('conn-1');

    // The socket dropped while the sheet sat on the error.
    connection.setConnected(false);
    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');
    expect(connection.retryConnection).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(api().state).toEqual({ phase: 'retryable', path: 'src' });
    unmount();
  });

  it('nudges a parked transport before a send that never returns', async () => {
    // A send that starts on a parked transport blocks in the SDK's open waiter
    // until the listing deadline and never resolves, so a nudge that only
    // follows a failed send never runs — the picker's Retry then always
    // reports the error even after the relay is back (the recorded e1
    // failure). The nudge must happen BEFORE the send waits.
    const send = Promise.withResolvers<ListDirectoriesResult>();
    listFn.mockReturnValue(send.promise);
    const { api, unmount } = await mount('conn-1');

    connection.setConnected(false);
    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => connection.retryConnection.mock.calls.length > 0);
    expect(connection.retryConnection).toHaveBeenCalledTimes(1);
    expect(listFn).toHaveBeenCalledTimes(1);
    // End the attempt with a listing rather than a failure: a failure would put
    // the loop's next paced send on the timers of whatever test runs next.
    send.resolve({ ok: true, path: 'src', directories: [server] });
    unmount();
  });

  it('reports the retryable failure after one send while the transport keeps rejecting', async () => {
    // A plain open (not the Retry) puts the listing on the wire once: the
    // picker's error state stays inside the sheet's 15 s window.
    listFn.mockResolvedValue({ ok: false, reason: 'transport' });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');
    expect(api().state).toEqual({ phase: 'retryable', path: 'src' });
    expect(listFn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps a user Retry sending past the open that failed', async () => {
    // The CLI re-attaches to a restarted relay on its own backoff (~38 s
    // measured, 2026-09-17), and until then the relay answers every send with a
    // fast retryable failure. A user Retry must keep sending — paced — instead
    // of reporting the sheet's error after one fast failure, so one tap bridges
    // the outage-recovery window.
    listFn.mockResolvedValue({ ok: false, reason: 'transport' });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');
    expect(listFn).toHaveBeenCalledTimes(1);

    // Four more fast failures on the Retry, then the listing lands.
    listFn.mockResolvedValue({ ok: true, path: 'src', directories: [server] });
    for (let i = 0; i < 4; i += 1) {
      listFn.mockResolvedValueOnce({ ok: false, reason: 'transport' });
    }

    act(() => {
      api().list('src');
    });
    await waitFor(() => api().state?.phase === 'skeleton');
    await waitForRealTimers(() => listFn.mock.calls.length >= 6, 9000);
    // The sixth send is the one that lands: wait for its result to reach the
    // observer instead of racing the assertion against the mock's microtasks.
    await waitFor(() => api().state?.phase === 'ready');
    expect(api().state).toEqual({ phase: 'ready', path: 'src', directories: [server] });
    expect(listFn).toHaveBeenCalledTimes(6);
    unmount();
  });

  it('stops the Retry loop when the picker unmounts mid-attempt', async () => {
    // React Query aborts the query when the picker unmounts (its cleanup drops
    // the connection's listings); the paced Retry loop must observe that and
    // stop sending for a screen that is gone.
    vi.useFakeTimers();
    try {
      listFn.mockResolvedValue({ ok: false, reason: 'transport' });
      const { api, renderer } = await mount('conn-1');

      act(() => {
        api().list('src');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listFn).toHaveBeenCalledTimes(1);

      // The Retry CTA repeats the path on screen: the loop paces its sends and
      // is waiting out its first resend delay when the picker unmounts.
      act(() => {
        api().list('src');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listFn).toHaveBeenCalledTimes(2);

      act(() => {
        renderer.unmount();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // The abort ends the loop: no send after the unmount, whatever the
      // remaining Retry budget.
      expect(listFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a connected transport alone when Retry only refetches', async () => {
    listFn.mockResolvedValue({ ok: false, reason: 'transport' });
    const { api, unmount } = await mount('conn-1');

    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'retryable');

    connection.setConnected(true);
    listFn.mockReset();
    listFn.mockResolvedValue({ ok: true, path: 'src', directories: [server] });
    act(() => {
      api().list('src');
    });
    await waitForRealTimers(() => api().state?.phase === 'ready');
    expect(connection.retryConnection).not.toHaveBeenCalled();
    unmount();
  });

  it('maps unsupported and invalid results to the permanent unsupported state', async () => {
    listFn.mockResolvedValueOnce({ ok: false, reason: 'unsupported' });
    const first = await mount('conn-1');
    act(() => {
      first.api().list('src');
    });
    await waitFor(() => first.api().state?.phase === 'unsupported');
    expect(first.api().state).toEqual({ phase: 'unsupported', path: 'src' });
    first.unmount();

    listFn.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    const second = await mount('conn-1');
    act(() => {
      second.api().list('src');
    });
    await waitFor(() => second.api().state?.phase === 'unsupported');
    expect(second.api().state).toEqual({ phase: 'unsupported', path: 'src' });
    second.unmount();
  });
});
