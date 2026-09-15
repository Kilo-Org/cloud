import { act, createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PULL_FEEDBACK_BUDGET_MS,
  PULL_FEEDBACK_MIN_BEAT_MS,
  type PullRefetch,
  usePullRefresh,
} from '@/components/agents/use-pull-refresh';

type Snapshot = {
  refreshing: boolean;
  busy: boolean;
  failed: boolean;
  startPull: () => void;
  startRetry: () => void;
  markSettled: () => void;
};

function renderPullRefresh(refetch: PullRefetch) {
  const latest: { current: Snapshot | null } = { current: null };
  function Probe() {
    latest.current = usePullRefresh(refetch);
    return null;
  }
  const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    renderer.current = TestRenderer.create(createElement(Probe));
  });
  return {
    state: () => {
      if (!latest.current) {
        throw new Error('probe not rendered');
      }
      return latest.current;
    },
    unmount: () => {
      const mounted = renderer.current;
      if (mounted) {
        act(() => {
          mounted.unmount();
        });
      }
    },
  };
}

/** A refetch that settles on the next microtask with the given outcome. */
function settlesWith(accepted: boolean): PullRefetch {
  return async () => {
    await Promise.resolve();
    return accepted;
  };
}

/** A refetch that rejects on the next microtask. */
function rejects(): PullRefetch {
  return async () => {
    await Promise.reject(new Error('boom'));
    return false;
  };
}

/** A refetch that never settles — the hung-request shape from device defect e1. */
function hangs(): PullRefetch {
  const never = new Promise<never>(() => undefined);
  return async () => {
    await never;
    return true;
  };
}

/** A deferred refetch: the caller resolves it through the returned callback. */
function deferred(resolvers: ((value: boolean) => void)[]): PullRefetch {
  return async () => {
    const value = await new Promise<boolean>(resolve => {
      resolvers.push(resolve);
    });
    return value;
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('usePullRefresh feedback budget', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the spinner and fails when a hung refetch passes the budget', () => {
    const { state, unmount } = renderPullRefresh(hangs());
    act(() => {
      state().startPull();
    });
    expect(state().refreshing).toBe(true);
    expect(state().failed).toBe(false);

    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
    });
    // The spinner stops, the failure line takes over: the pull always has a
    // next action, never a stuck spinner (device defect e1).
    expect(state().refreshing).toBe(false);
    expect(state().busy).toBe(false);
    expect(state().failed).toBe(true);
    unmount();
  });

  it('clears the budget failure when the late refetch lands an accepted result', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startPull();
    });
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
    });
    expect(state().failed).toBe(true);

    resolvers[0]?.(true);
    await flush();
    expect(state().failed).toBe(false);
    unmount();
  });

  it('keeps the failure when the late refetch reports rejection', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startPull();
    });
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
    });
    resolvers[0]?.(false);
    await flush();
    expect(state().failed).toBe(true);
    unmount();
  });

  it('holds the in-flight feedback through the beat before a fast rejection fails', async () => {
    const { state, unmount } = renderPullRefresh(settlesWith(false));
    act(() => {
      state().startPull();
    });
    await flush();
    // A connection-refused settlement lands fast: the Updating feedback stays
    // perceivable through the beat before the failure line takes over
    // (device defect e1-updating: Updating was a missable flash).
    expect(state().refreshing).toBe(true);
    expect(state().failed).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_MIN_BEAT_MS);
    });
    expect(state().refreshing).toBe(false);
    expect(state().failed).toBe(true);
    unmount();
  });

  it('treats an accepted resolution as settled, not failed', async () => {
    const { state, unmount } = renderPullRefresh(settlesWith(true));
    act(() => {
      state().startPull();
    });
    await flush();
    expect(state().refreshing).toBe(false);
    expect(state().failed).toBe(false);
    unmount();
  });

  it('treats a throwing refetch as failed after the beat', async () => {
    const { state, unmount } = renderPullRefresh(rejects());
    act(() => {
      state().startPull();
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_MIN_BEAT_MS);
    });
    expect(state().failed).toBe(true);
    unmount();
  });

  it('runs a retry without the native spinner', async () => {
    const { state, unmount } = renderPullRefresh(settlesWith(true));
    act(() => {
      state().startRetry();
    });
    expect(state().refreshing).toBe(false);
    expect(state().busy).toBe(true);
    await flush();
    expect(state().busy).toBe(false);
    expect(state().failed).toBe(false);
    unmount();
  });

  it('releases a superseded retry busy flag when the superseding pull settles', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startRetry();
    });
    expect(state().busy).toBe(true);
    act(() => {
      state().startPull();
    });
    // The superseded retry's settlement is token-guarded; the pull owns both
    // feedback flags from here on.
    resolvers[1]?.(false);
    await flush();
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_MIN_BEAT_MS);
    });
    // The pull failed: the line must hand over to "Couldn't refresh" + Retry.
    // A busy flag left behind by the dead retry pins "Updating" forever, with
    // no Retry and no spinner (review finding on use-pull-refresh.ts:84).
    expect(state().busy).toBe(false);
    expect(state().refreshing).toBe(false);
    expect(state().failed).toBe(true);
    unmount();
  });

  it('releases a superseded pull spinner when a superseding retry settles', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startPull();
    });
    expect(state().refreshing).toBe(true);
    act(() => {
      state().startRetry();
    });
    // Same root cause from the other side: the superseded pull's settlement
    // is token-guarded, so its spinner flag must not outlive it — the retry
    // hands the feedback over to the status line.
    resolvers[1]?.(true);
    await flush();
    expect(state().refreshing).toBe(false);
    expect(state().busy).toBe(false);
    expect(state().failed).toBe(false);
    unmount();
  });

  it('supersedes a pending pull without inheriting its budget timer', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startPull();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      state().startPull();
    });
    // The first pull's budget point passes while the second pull is still
    // inside its own budget: the spinner keeps the newest pull.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(state().refreshing).toBe(true);
    expect(state().failed).toBe(false);

    resolvers[1]?.(true);
    await flush();
    expect(state().refreshing).toBe(false);
    expect(state().failed).toBe(false);
    unmount();
  });

  it('retires a settled budget failure when a later refresh marks settled', () => {
    const { state, unmount } = renderPullRefresh(hangs());
    act(() => {
      state().startPull();
    });
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
    });
    expect(state().failed).toBe(true);

    // A refresh outside the pull lifecycle landed an accepted result: the
    // list is up to date, so the failure line must retire (a focus or
    // app-foreground refetch never runs through the hook otherwise).
    act(() => {
      state().markSettled();
    });
    expect(state().failed).toBe(false);
    unmount();
  });

  it('retires a settled rejection when a later refresh marks settled', async () => {
    const { state, unmount } = renderPullRefresh(settlesWith(false));
    act(() => {
      state().startPull();
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_MIN_BEAT_MS);
    });
    expect(state().failed).toBe(true);

    act(() => {
      state().markSettled();
    });
    expect(state().failed).toBe(false);
    unmount();
  });

  it('leaves an in-flight pull alone when a later refresh marks settled', async () => {
    const resolvers: ((value: boolean) => void)[] = [];
    const { state, unmount } = renderPullRefresh(deferred(resolvers));
    act(() => {
      state().startPull();
    });
    act(() => {
      state().markSettled();
    });
    // The in-flight pull keeps its own feedback lifecycle: the spinner stays
    // and the budget still hands over to the failure line when it hangs.
    expect(state().refreshing).toBe(true);
    expect(state().failed).toBe(false);
    act(() => {
      vi.advanceTimersByTime(PULL_FEEDBACK_BUDGET_MS);
    });
    expect(state().refreshing).toBe(false);
    expect(state().failed).toBe(true);

    resolvers[0]?.(true);
    await flush();
    expect(state().failed).toBe(false);
    unmount();
  });
});
