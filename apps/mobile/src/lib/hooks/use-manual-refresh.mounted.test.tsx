import type * as React from 'react';
import { createElement, type Dispatch, type SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { useManualRefresh } from './use-manual-refresh';

const ERROR_MESSAGE = 'Could not refresh. Pull down to try again.';

const state = vi.hoisted(() => ({
  stateWrites: 0,
  toastErrors: [] as string[],
}));

// React 19 drops a state update on an unmounted component without reporting
// it, so counting the writes the hook makes through `useState` is the only way
// to see one issued after the screen leaves.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: ((initial: unknown) => {
      const [value, setValue] = actual.useState(initial);
      const setTracked: Dispatch<SetStateAction<unknown>> = action => {
        state.stateWrites += 1;
        setValue(action);
      };
      return [value, setTracked] as const;
    }) as typeof actual.useState,
  };
});

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (message: string) => {
      state.toastErrors.push(message);
    },
  },
}));

type HookValue = {
  refreshing: boolean;
  onRefresh: (() => void) | null;
};

type ProbeProps = {
  holder: HookValue;
  refetch: () => Promise<{ isError: boolean }>;
};

function Probe({ holder, refetch }: ProbeProps) {
  const [refreshing, onRefresh] = useManualRefresh(refetch, ERROR_MESSAGE);
  holder.refreshing = refreshing;
  holder.onRefresh = onRefresh;
  return null;
}

async function mountProbe(
  refetch: () => Promise<{ isError: boolean }>
): Promise<{ holder: HookValue; renderer: ReactTestRenderer }> {
  const holder: HookValue = { refreshing: false, onRefresh: null };
  const renderer = await act(() => TestRenderer.create(createElement(Probe, { holder, refetch })));
  return { holder, renderer };
}

async function pullToRefresh(holder: HookValue): Promise<void> {
  const onRefresh = holder.onRefresh;
  if (!onRefresh) {
    throw new Error('the probe never received onRefresh');
  }
  await act(() => {
    onRefresh();
  });
}

async function failPendingRead(read: PromiseWithResolvers<{ isError: boolean }>): Promise<void> {
  await act(async () => {
    read.resolve({ isError: true });
    await read.promise;
    await Promise.resolve();
  });
}

describe('useManualRefresh', () => {
  beforeEach(() => {
    state.stateWrites = 0;
    state.toastErrors.length = 0;
  });

  it('announces one failure and clears the flag while the screen stays mounted', async () => {
    const read = Promise.withResolvers<{ isError: boolean }>();
    const { holder, renderer } = await mountProbe(() => read.promise);

    await pullToRefresh(holder);
    expect(holder.refreshing).toBe(true);

    await failPendingRead(read);

    expect(state.toastErrors).toEqual([ERROR_MESSAGE]);
    expect(holder.refreshing).toBe(false);

    await act(() => {
      renderer.unmount();
    });
  });

  it('publishes no toast and no state update when the read settles after the screen leaves', async () => {
    const read = Promise.withResolvers<{ isError: boolean }>();
    const refetch = vi.fn(() => read.promise);
    const { holder, renderer } = await mountProbe(refetch);

    await pullToRefresh(holder);
    expect(holder.refreshing).toBe(true);

    await act(() => {
      renderer.unmount();
    });
    const writesBeforeSettle = state.stateWrites;

    await failPendingRead(read);

    expect(state.toastErrors).toEqual([]);
    expect(state.stateWrites).toBe(writesBeforeSettle);

    await pullToRefresh(holder);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(state.stateWrites).toBe(writesBeforeSettle);
  });
});
