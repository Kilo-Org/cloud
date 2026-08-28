/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/hooks/use-route-foreground-refresh.mounted.test.tsx) */
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

const refreshActiveSessionsNow = vi.hoisted(() => vi.fn());

// When true, the mocked tRPC queryFn rejects, so a plain active refetch settles
// in error (the fallback path's failure case).
const queryFnImpl = vi.hoisted(() => ({ reject: false }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(() => ({
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          retry: false,
          queryFn: async () => {
            await Promise.resolve();
            if (queryFnImpl.reject) {
              throw new Error('seeded active-list failure');
            }
            return { sessions: [] };
          },
        }),
      },
    },
  })),
}));

vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));

vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsNow,
}));

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

// The exact owner query key for `organizationId: null`: the live-sync mount and
// the hook both derive it from `buildActiveSessionsTrayInput`, and the mocked
// `queryKey` embeds the same `input`.
const KEY: readonly unknown[] = [
  ['activeSessions', 'list'],
  { input: buildActiveSessionsTrayInput(null), type: 'query' },
];

const latestRef: { refetch?: () => Promise<boolean> } = {};

function Probe() {
  const { refetch } = useLiveAgentSessions({ organizationId: null });
  latestRef.refetch = refetch;
  return createElement('ProbeText', null, 'probe');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

// React Query's default notifyManager schedules via setTimeout(fn, 0); a few
// sequential macrotask turns let a settled fetch apply its state inside `act`.
async function flushTimers(): Promise<void> {
  await delay(0);
  await delay(0);
  await delay(0);
  await delay(0);
}

async function renderProbe(queryClient: QueryClient): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    rendererRef.current = TestRenderer.create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Probe))
    );
    await flushTimers();
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

async function seedError(queryClient: QueryClient): Promise<void> {
  await act(async () => {
    queryClient
      .getQueryCache()
      .find({ queryKey: KEY })
      ?.setState({
        status: 'error',
        fetchStatus: 'idle',
        data: undefined,
        error: new Error('seeded active-list failure'),
      });
    await flushTimers();
  });
}

async function refetchAndSettle(): Promise<boolean> {
  let outcome = false;
  await act(async () => {
    const refetch = latestRef.refetch;
    if (!refetch) {
      throw new Error('probe did not expose a refetch');
    }
    outcome = await refetch();
    await flushTimers();
  });
  return outcome;
}

describe('useLiveAgentSessions live owner-path refetch (mounted)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    latestRef.refetch = undefined;
    queryFnImpl.reject = false;
    refreshActiveSessionsNow.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    latestRef.refetch = undefined;
  });

  it('reports false on the owner path after the live-list query settled in error', async () => {
    const queryClient = new QueryClient();
    await renderProbe(queryClient);
    await seedError(queryClient);
    refreshActiveSessionsNow.mockResolvedValue(true);

    expect(await refetchAndSettle()).toBe(false);
  });

  it('reports true on the owner path after the live-list query settled in success', async () => {
    const queryClient = new QueryClient();
    await renderProbe(queryClient);
    expect(queryClient.getQueryState(KEY)?.status).toBe('success');
    refreshActiveSessionsNow.mockResolvedValue(true);

    expect(await refetchAndSettle()).toBe(true);
  });

  it('reports false on the fallback path when the plain refetch settles in error', async () => {
    const queryClient = new QueryClient();
    await renderProbe(queryClient);
    queryFnImpl.reject = true;
    await seedError(queryClient);
    refreshActiveSessionsNow.mockResolvedValue(false);

    expect(await refetchAndSettle()).toBe(false);
  });
});
