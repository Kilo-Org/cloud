// Mounted harness for use-pull-refresh.mounted.test.tsx: the probe renderer
// and the refetch shapes the feedback cases drive.

import { act, createElement } from 'react';

import { TestRenderer } from '@/test/renderer';

import { type PullRefetch, usePullRefresh } from '@/components/agents/use-pull-refresh';

type Snapshot = {
  refreshing: boolean;
  busy: boolean;
  failed: boolean;
  startPull: () => void;
  startRetry: () => void;
  markSettled: () => void;
};

export function renderPullRefresh(refetch: PullRefetch) {
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
export function settlesWith(accepted: boolean): PullRefetch {
  return async () => {
    await Promise.resolve();
    return accepted;
  };
}

/** A refetch that rejects on the next microtask. */
export function rejects(): PullRefetch {
  return async () => {
    await Promise.reject(new Error('boom'));
    return false;
  };
}

/** A refetch that never settles — the hung-request shape from device defect e1. */
export function hangs(): PullRefetch {
  const never = new Promise<never>(() => undefined);
  return async () => {
    await never;
    return true;
  };
}

/** A deferred refetch: the caller resolves it through the returned callback. */
export function deferred(resolvers: ((value: boolean) => void)[]): PullRefetch {
  return async () => {
    const value = await new Promise<boolean>(resolve => {
      resolvers.push(resolve);
    });
    return value;
  };
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
