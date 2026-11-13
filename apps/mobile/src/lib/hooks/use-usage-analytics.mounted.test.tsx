import { createElement } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUsageAnalytics } from '@/lib/hooks/use-usage-analytics';
import { renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';

// The window's end is the moment the hook measured, and it is part of every
// query key, so a window rebuilt on a foreground resume would empty the cache
// and swap the dashboard for its skeleton. These tests pin that contract: a
// resume moves the window only when the UTC day changed.

type BreakdownInput = { dimension?: string } & Record<string, unknown>;

const state = vi.hoisted(() => {
  const appStateListeners = new Set<(nextState: string) => void>();
  return {
    appStateListeners,
    requests: { summary: 0, timeseries: 0, models: 0, features: 0 },
    inputs: {
      summary: [] as Record<string, unknown>[],
      timeseries: [] as Record<string, unknown>[],
      models: [] as BreakdownInput[],
      features: [] as BreakdownInput[],
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, listener: (nextState: string) => void) => {
      state.appStateListeners.add(listener);
      return {
        remove: () => {
          state.appStateListeners.delete(listener);
        },
      };
    },
  },
}));

vi.mock('@/lib/trpc', () => {
  const answer = {
    summary: () => ({
      costMicrodollars: 0,
      requestCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      costPerRequest: 0,
    }),
    timeseries: () => ({ timeseries: [] }),
    breakdown: () => ({ breakdown: [] }),
  };

  function procedure(name: 'summary' | 'timeseries', path: string) {
    return {
      queryOptions: (input: Record<string, unknown>) => ({
        queryKey: ['usageAnalytics', path, input],
        queryFn: () => {
          state.requests[name] += 1;
          state.inputs[name].push(input);
          return Promise.resolve(answer[name]());
        },
      }),
    };
  }

  return {
    useTRPC: () => ({
      usageAnalytics: {
        getSummary: procedure('summary', 'getSummary'),
        getTimeseries: procedure('timeseries', 'getTimeseries'),
        getBreakdown: {
          queryOptions: (input: BreakdownInput) => {
            const name = input.dimension === 'feature' ? 'features' : 'models';
            return {
              queryKey: ['usageAnalytics', 'getBreakdown', input],
              queryFn: () => {
                state.requests[name] += 1;
                state.inputs[name].push(input);
                return Promise.resolve(answer.breakdown());
              },
            };
          },
        },
      },
    }),
  };
});

type ProbeState = {
  summary: unknown;
  isLoading: boolean;
  isFetching: boolean;
};

function Probe({ holder }: { holder: { current: ProbeState | undefined } }) {
  const usage = useUsageAnalytics({ kind: 'personal' }, '7d', 'cost');
  holder.current = {
    summary: usage.summary,
    isLoading: usage.isLoading,
    isFetching: usage.isFetching,
  };
  return null;
}

type Mounted = {
  holder: { current: ProbeState | undefined };
  queryClient: QueryClient;
  unmount: () => void;
};

const mountedRenderers: { unmount: () => void }[] = [];

/** Let the queries resolve and the tree commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mountProbe(): Promise<Mounted> {
  const holder: { current: ProbeState | undefined } = { current: undefined };
  const { queryClient, unmount } = await renderWithProviders(createElement(Probe, { holder }));
  mountedRenderers.push({ unmount });
  await settle();
  return { holder, queryClient, unmount };
}

/** A background -> active edge, the way the app delivers a foreground resume. */
function resume(): void {
  const deliver = (nextState: string) => {
    act(() => {
      for (const listener of state.appStateListeners) {
        listener(nextState);
      }
    });
  };
  deliver('background');
  deliver('active');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T15:30:00.000Z'));
  state.requests = { summary: 0, timeseries: 0, models: 0, features: 0 };
  state.inputs.summary = [];
  state.inputs.timeseries = [];
  state.inputs.models = [];
  state.inputs.features = [];
});

afterEach(() => {
  for (const mounted of mountedRenderers.splice(0)) {
    mounted.unmount();
  }
  vi.useRealTimers();
});

describe('useUsageAnalytics window across a foreground resume', () => {
  it('ends the window at the moment the screen mounted', async () => {
    const { holder } = await mountProbe();
    expect(state.inputs.summary.map(input => input.endDate)).toEqual(['2026-11-12T15:30:00.000Z']);
    expect(state.inputs.summary[0]?.startDate).toBe('2026-11-06T00:00:00.000Z');
    expect(holder.current?.summary).toBeDefined();
  });

  it('keeps the window, and with it the cached dashboard, when the resume stays on the same UTC day', async () => {
    const { holder, queryClient } = await mountProbe();
    expect(state.requests.summary).toBe(1);

    vi.setSystemTime(new Date('2026-11-12T18:05:00.000Z'));
    resume();
    await settle();

    // The key did not move, so nothing refetched it and the screen kept the
    // numbers it already had.
    expect(state.inputs.summary.map(input => input.endDate)).toEqual(['2026-11-12T15:30:00.000Z']);
    expect(state.requests.summary).toBe(1);
    expect(holder.current?.summary).toBeDefined();

    // The route's own foreground refresh refetches those keys in place on the
    // same edge. The cached summary stays visible while the read is in flight.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['usageAnalytics'] });
    });
    await settle();

    expect(state.requests.summary).toBe(2);
    expect(state.inputs.summary.map(input => input.endDate)).toEqual([
      '2026-11-12T15:30:00.000Z',
      '2026-11-12T15:30:00.000Z',
    ]);
    expect(holder.current?.summary).toBeDefined();
    expect(holder.current?.isLoading).toBe(false);
  });

  it('moves the window to the new UTC day when the resume crosses midnight', async () => {
    await mountProbe();

    vi.setSystemTime(new Date('2026-11-13T00:05:00.000Z'));
    resume();
    await settle();

    expect(state.inputs.summary.map(input => input.endDate)).toEqual([
      '2026-11-12T15:30:00.000Z',
      '2026-11-13T00:05:00.000Z',
    ]);
    expect(state.inputs.summary[1]?.startDate).toBe('2026-11-07T00:00:00.000Z');
  });

  it('moves the window from the midnight timer, without a resume', async () => {
    await mountProbe();

    // 8h30m to the UTC midnight after 15:30, plus the one-second margin.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000 + 30 * 60 * 1000 + 1_000);
    });
    await settle();

    expect(state.inputs.summary[1]?.startDate).toBe('2026-11-07T00:00:00.000Z');
    expect(String(state.inputs.summary[1]?.endDate)).toMatch(/^2026-11-13T00:00:/);
  });
});
