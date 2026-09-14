/* eslint-disable max-lines -- one render case per tour state (empty, loading, list error, detection error, sticky check, start, start failure, started-connection lock, retry dedupe), each mounting the real tree */
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
// Every organization argument the step passes to the spawn hook, in order.
const spawnHookArgs = vi.hoisted(() => [] as unknown[]);
// Distinct per call so a test can tell a kept operation key from a regenerated
// one (a constant mock would hide the bug the key tests).
const randomUUID = vi.hoisted(() => {
  let next = 0;
  return () => {
    next += 1;
    return `op-key-${next}`;
  };
});
const QUERY_KEY = ['tour-remote-instances'];

vi.mock('expo-crypto', () => ({ randomUUID }));
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
  useRemoteInstanceSpawn: (organizationId?: unknown) => {
    spawnHookArgs.push(organizationId);
    return { status: spawnStatus.current, spawn };
  },
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

const REMOTE2: InstancePickerInstance = { ...REMOTE, connectionId: 'conn-2', name: 'desktop' };

function radioRow(label: string, checked: boolean) {
  return { accessibilityRole: 'radio', accessibilityState: { checked }, accessibilityLabel: label };
}

const textNodes = (renderer: Renderer) => renderer.root.findAllByType('Text' as ElementType);

function hasText(renderer: Renderer, value: string): boolean {
  return textNodes(renderer).some(node =>
    (Array.isArray(node.children) ? node.children : [node.children]).includes(value)
  );
}

function press(node: { props: unknown }) {
  (node.props as { onPress?: () => void }).onPress?.();
}

/** The `spawn(connectionId, opts, options)` call arguments at `index`. */
function spawnCall(index: number): { connectionId: string; operationKey?: string } | undefined {
  const call = spawn.mock.calls[index] as [string, unknown, { operationKey?: string }?] | undefined;
  if (!call) {
    return undefined;
  }
  return { connectionId: call[0], operationKey: call[2]?.operationKey };
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
    spawnHookArgs.length = 0;
    spawnStatus.current = { status: 'idle' };
    spawn.mockReset().mockResolvedValue({ status: 'ready', sessionID: 'session-1' });
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
    // The step chrome stays mounted: the person keeps the context of which
    // path they are on while the retryable error is shown.
    expect(hasText(renderer, 'tour.remoteTitle')).toBe(true);
    expect(hasText(renderer, 'tour.remoteBody')).toBe(true);
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

  it('shows a working retry when the session-detection query fails while computers are discovered', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    const refetchSessions = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });
    liveSync.set({ isError: true, refetch: refetchSessions });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.networkError'));
    // The computer list resolved, but the ✓ cannot land while detection fails,
    // so the start control is withheld and the step chrome stays mounted.
    expect(hasText(renderer, 'tour.remoteRunHint')).toBe(false);
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(hasText(renderer, 'tour.remoteFound')).toBe(false);
    expect(hasText(renderer, 'tour.remoteTitle')).toBe(true);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(refetchSessions).toHaveBeenCalled();
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    unmount();
  });

  it('keeps the check after completion when the detection query later fails', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));

    // The check only follows a session created through the tour's own start.
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });

    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [{ id: 'remote-1', connectionId: 'conn-1' }] } });
    });
    await waitFor(() => hasText(renderer, 'tour.remoteCheck'));

    // Sticky completion: a later detection failure must not take the ✓ back.
    await act(async () => {
      await Promise.resolve();
      liveSync.set({ isError: true });
    });
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(true);
    expect(hasText(renderer, 'tour.networkError')).toBe(false);
    unmount();
  });

  it('shows the start control for a connected computer without a session and does not complete', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    expect(hasText(renderer, 'tour.remoteFound')).toBe(true);
    // The whole body scrolls inside the space between the header and the
    // Skip/Done bar, so a growing computer list never covers them.
    expect(renderer.root.findAllByType('CenteredState' as ElementType)).toHaveLength(1);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(spawnCall(0)?.connectionId).toBe('conn-1');
    expect(spawnCall(0)?.operationKey).toEqual(expect.any(String));
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);
    unmount();
  });

  // The baseline must be frozen before the tour offers its start control: a
  // session created while the live list is still resolving would otherwise be
  // part of the baseline that arrives afterwards, and the check could never
  // land for that run.
  it('withholds the start control until the session baseline is frozen', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    // The live session list has not resolved yet (the default snapshot has no
    // data), so no baseline exists.
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteFound'));
    expect(hasText(renderer, 'tour.remoteStart')).toBe(false);
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    // Once the list resolves the baseline freezes, and only then does Start
    // become available.
    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [] } });
    });
    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    unmount();
  });

  it('renders the check and completes only after a remote session appears after the baseline', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    // The row alone never completes: the check requires the tour's own start.
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });

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
    expect(spawnCall(0)?.connectionId).toBe('conn-1');
    expect(spawnCall(0)?.operationKey).toEqual(expect.any(String));
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

  it('exposes every computer row as a labelled radio carrying its selected state', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE, REMOTE2] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, unmount } = await mountStep();
    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    const rows = renderer.root.findAllByType('Pressable' as ElementType);
    expect(rows.map(row => row.props)).toMatchObject([
      radioRow('laptop', true),
      radioRow('desktop', false),
    ]);
    unmount();
  });

  it('spawns in the personal scope, matching the personal session list it detects on', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, unmount } = await mountStep();

    await waitFor(() => hasText(renderer, 'tour.remoteStart'));
    // `null` pins the spawn to personal, never the live org context: the check
    // reads the personal session list, so an org-attributed spawn would never
    // appear there.
    expect(spawnHookArgs.length).toBeGreaterThan(0);
    expect(spawnHookArgs.every(argument => argument === null)).toBe(true);
    unmount();
  });

  it('keeps detection on the connection that was actually started, not the current selection', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE, REMOTE2] });
    liveSync.set({ data: { sessions: [] } });
    const { renderer, onCompletedChange, unmount } = await mountStep();
    await waitFor(() => hasText(renderer, 'tour.remoteStart'));

    // Start on the default (laptop / conn-1).
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(spawnCall(0)?.connectionId).toBe('conn-1');

    // Highlight the other computer after starting. Detection must not follow.
    const rows = renderer.root.findAllByType('Pressable' as ElementType);
    await act(async () => {
      await Promise.resolve();
      press(rows[1] as { props: unknown });
    });

    // A session on the newly-highlighted computer is not the started one.
    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [{ id: 'remote-2', connectionId: 'conn-2' }] } });
    });
    expect(hasText(renderer, 'tour.remoteCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    // The started computer's session does satisfy the check.
    await act(async () => {
      await Promise.resolve();
      liveSync.set({
        data: {
          sessions: [
            { id: 'remote-2', connectionId: 'conn-2' },
            { id: 'remote-1', connectionId: 'conn-1' },
          ],
        },
      });
    });
    await waitFor(() => hasText(renderer, 'tour.remoteCheck'));
    expect(onCompletedChange).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it('keeps one operation key across a retry of the same start intent', async () => {
    fetchInstances.mockResolvedValue({ instances: [REMOTE] });
    liveSync.set({ data: { sessions: [] } });
    // eslint-disable-next-line typescript-eslint/promise-function-async -- returns a settled promise without awaiting; making it async would trip require-await
    spawn.mockImplementation(() => {
      spawnStatus.current = { status: 'retryable' };
      return Promise.resolve({ status: 'retryable', reason: 'offline' });
    });
    const { renderer, unmount } = await mountStep();
    await waitFor(() => hasText(renderer, 'tour.remoteStart'));

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await waitFor(() => hasText(renderer, 'tour.retry'));

    // The retry re-runs the same intent and must ride the same key so the
    // relay dedupes it instead of spawning a second session.
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    const first = spawnCall(0)?.operationKey;
    const second = spawnCall(1)?.operationKey;
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    unmount();
  });
});
