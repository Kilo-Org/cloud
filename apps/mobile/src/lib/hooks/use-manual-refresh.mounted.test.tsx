import type * as React from 'react';
import { createElement, type Dispatch, type SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { useManualRefresh } from './use-manual-refresh';

const ERROR_MESSAGE = 'Could not refresh. Pull down to try again.';

const state = vi.hoisted(() => ({
  stateWrites: 0,
  toastErrors: [] as string[],
  announcements: [] as string[],
  reducedMotion: false,
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

// The pull announces its own start and finish to a reader only while the
// motion policy reports reduced motion; the spy keeps the order and the keys.
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: (message: string) => {
    state.announcements.push(message);
  },
}));

// The real policy reaches `expo-battery` and reanimated; this suite drives the
// one flag the hook reads.
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: state.reducedMotion,
    scrollAnimated: !state.reducedMotion,
  }),
}));

// The two announcement labels are catalog copy; the spy records the keys.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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

async function settlePendingRead(
  read: PromiseWithResolvers<{ isError: boolean }>,
  result: { isError: boolean }
): Promise<void> {
  await act(async () => {
    read.resolve(result);
    await read.promise;
    await Promise.resolve();
  });
}

async function failPendingRead(read: PromiseWithResolvers<{ isError: boolean }>): Promise<void> {
  await settlePendingRead(read, { isError: true });
}

describe('useManualRefresh', () => {
  beforeEach(() => {
    state.stateWrites = 0;
    state.toastErrors.length = 0;
    state.announcements.length = 0;
    state.reducedMotion = false;
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

  it('ignores a second pull while the first read is still running', async () => {
    // Reduced motion is on, so a pull that were admitted would announce a
    // second start: the guard is what keeps it from doing so.
    state.reducedMotion = true;
    const read = Promise.withResolvers<{ isError: boolean }>();
    const refetch = vi.fn(() => read.promise);
    const { holder, renderer } = await mountProbe(refetch);

    await pullToRefresh(holder);
    await pullToRefresh(holder);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(state.announcements).toEqual(['common.loading']);
    expect(holder.refreshing).toBe(true);

    await settlePendingRead(read, { isError: false });

    // One admitted pull, so one start and one finish — never two of either.
    expect(state.announcements).toEqual(['common.loading', 'common.updated']);
    expect(state.toastErrors).toEqual([]);
    expect(holder.refreshing).toBe(false);

    await act(() => {
      renderer.unmount();
    });
  });

  it('announces the start and the finish under reduced motion', async () => {
    state.reducedMotion = true;
    const read = Promise.withResolvers<{ isError: boolean }>();
    const { holder, renderer } = await mountProbe(() => read.promise);

    await pullToRefresh(holder);
    // The start is announced when the pull is admitted, not when the read
    // settles, so a slow read still answers the gesture.
    expect(state.announcements).toEqual(['common.loading']);

    await settlePendingRead(read, { isError: false });

    expect(state.announcements).toEqual(['common.loading', 'common.updated']);
    expect(state.toastErrors).toEqual([]);
    expect(holder.refreshing).toBe(false);

    await act(() => {
      renderer.unmount();
    });
  });

  it('announces only the start when the pull fails under reduced motion', async () => {
    state.reducedMotion = true;
    const read = Promise.withResolvers<{ isError: boolean }>();
    const { holder, renderer } = await mountProbe(() => read.promise);

    await pullToRefresh(holder);
    await failPendingRead(read);

    // A failure is the toast's to announce, so the band's finish stays silent
    // and the failure is raised once, not twice.
    expect(state.announcements).toEqual(['common.loading']);
    expect(state.toastErrors).toEqual([ERROR_MESSAGE]);
    expect(holder.refreshing).toBe(false);

    await act(() => {
      renderer.unmount();
    });
  });

  it('announces nothing when the motion policy allows motion', async () => {
    const read = Promise.withResolvers<{ isError: boolean }>();
    const { holder, renderer } = await mountProbe(() => read.promise);

    await pullToRefresh(holder);
    await settlePendingRead(read, { isError: false });

    // The platform's own indicator is live here, so a second spoken copy of the
    // same pull would only be noise.
    expect(state.announcements).toEqual([]);
    expect(holder.refreshing).toBe(false);

    await act(() => {
      renderer.unmount();
    });
  });

  it('announces no finish and writes no state when the read settles after the screen leaves', async () => {
    state.reducedMotion = true;
    const read = Promise.withResolvers<{ isError: boolean }>();
    const { holder, renderer } = await mountProbe(() => read.promise);

    await pullToRefresh(holder);
    expect(state.announcements).toEqual(['common.loading']);

    await act(() => {
      renderer.unmount();
    });
    const writesBeforeSettle = state.stateWrites;

    await settlePendingRead(read, { isError: false });

    expect(state.announcements).toEqual(['common.loading']);
    expect(state.toastErrors).toEqual([]);
    expect(state.stateWrites).toBe(writesBeforeSettle);
  });
});
