import { act, createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseQueryOptions } from '@tanstack/react-query';
import type * as ReactI18next from 'react-i18next';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { TourRemoteStep } from './tour-remote-step';

type Renderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

// A tiny external store the mocked `useActiveSessions` reads through
// `useSyncExternalStore`, so a test can push a new live list (the row created
// by the tour's own start action) and observe the step react.
const liveSync = vi.hoisted(() => {
  type SessionRow = { id: string; connectionId?: string };
  type Snapshot = {
    data: { sessions: SessionRow[] } | undefined;
    isError: boolean;
    isFetching: boolean;
    refetch: () => Promise<boolean>;
  };
  const initialSnapshot: Snapshot = {
    data: undefined,
    isError: false,
    isFetching: false,
    refetch: async () => {
      await Promise.resolve();
      return true;
    },
  };
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set: (next: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      snapshot = initialSnapshot;
      listeners.clear();
    },
  };
});

// The listInstances query the step owns, and the remote spawn it dispatches.
const fetchInstances = vi.hoisted(() =>
  vi.fn<() => Promise<{ instances: InstancePickerInstance[] }>>()
);
const spawn = vi.hoisted(() => vi.fn());
const spawnStatus = vi.hoisted(() => ({ current: { status: 'idle' as string } }));
const QUERY_KEY = ['tour-remote-instances'];

vi.mock('@/lib/active-sessions-live-sync-mount', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useActiveSessions: () => useSyncExternalStore(liveSync.subscribe, liveSync.get, liveSync.get),
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: {
      listInstances: {
        queryOptions: (_input: undefined, options: Partial<UseQueryOptions>) => ({
          queryKey: QUERY_KEY,
          queryFn: fetchInstances,
          ...options,
          retryDelay: 0,
        }),
      },
    },
  }),
}));
vi.mock('@/lib/hooks/use-remote-instance-spawn', () => ({
  useRemoteInstanceSpawn: () => ({ status: spawnStatus.current, spawn }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    mutedForeground: '#666666',
    primary: '#0000ff',
    good: '#24784A',
  }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  CircleCheck: 'CircleCheck',
  Lock: 'Lock',
  SearchX: 'SearchX',
  Server: 'Server',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

const REMOTE: InstancePickerInstance = {
  connectionId: 'conn-1',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'remote',
  startedAt: null,
  gitBranch: null,
};

function textNodes(renderer: Renderer) {
  return renderer.root.findAllByType('Text' as ElementType);
}

function hasText(renderer: Renderer, value: string): boolean {
  return textNodes(renderer).some(node =>
    (Array.isArray(node.children) ? node.children : [node.children]).includes(value)
  );
}

function press(node: { props: unknown }) {
  (node.props as { onPress?: () => void }).onPress?.();
}

async function mountStep() {
  const onCompletedChange = vi.fn<(completed: boolean) => void>();
  const mounted = await renderWithProviders(createElement(TourRemoteStep, { onCompletedChange }));
  return { ...mounted, onCompletedChange };
}

describe('TourRemoteStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveSync.reset();
    spawnStatus.current = { status: 'idle' };
    fetchInstances.mockReset().mockResolvedValue({ instances: [] });
  });

  it('shows the empty copy and never a start control when no computer is discovered', async () => {
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteEmptyTitle'));
    expect(hasText(renderer, 'tour.remoteEmptyBody')).toBe(true);
    expect(hasText(renderer, 'tour.remoteRunHint')).toBe(true);
    expect(hasText(renderer, 'tour.checkAgain')).toBe(true);
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);
    unmount();
  });

  it('renders content-shaped skeleton rows while the computer list is loading', async () => {
    fetchInstances.mockReturnValue(new Promise(() => undefined));
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    expect(renderer.root.findAllByType('Skeleton' as ElementType).length).toBeGreaterThan(0);
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);
    unmount();
  });

  it('shows a working retry for a retryable list failure without completing or starting', async () => {
    fetchInstances.mockRejectedValue(new Error('offline'));
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.networkError'));
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    const before = fetchInstances.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await waitFor(() => fetchInstances.mock.calls.length > before);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    unmount();
  });

  it('shows the start control for a connected computer without a session and does not complete', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    expect(hasText(renderer, 'tour.remoteFound')).toBe(true);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(spawn).toHaveBeenCalledWith('conn-1');
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);
    unmount();
  });

  it('renders the check and completes only after a remote session appears after the baseline', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [{ id: 'remote-1', connectionId: 'conn-1' }] } });
    });

    await waitFor(() => hasText(renderer, 'tour.remoteCheck'));
    expect(onCompletedChange).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it('shows a working retry when the start action fails retryably and does not complete', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    spawnStatus.current = { status: 'retryable' };
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'agents.remoteSpawnRetryable'));
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(spawn).toHaveBeenCalledWith('conn-1');
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    unmount();
  });

  it('keeps the start control for a non-retryable start failure without completing', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    spawnStatus.current = { status: 'nonRetryable' };
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'agents.remoteSpawnNonRetryable'));
    expect(hasText(renderer, 'tour.remoteStart')).toBe(true);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);
    unmount();
  });
});
