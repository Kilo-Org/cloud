import { act, createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { TourCloudStep } from './tour-cloud-step';

type Renderer = Awaited<ReturnType<typeof renderWithProviders>>['renderer'];

// A tiny external store the mocked `useActiveSessions` reads through
// `useSyncExternalStore`, so a test can push a new live list (the row created
// through the tour) and observe the step react.
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

const routerPush = vi.hoisted(() => vi.fn());
const clearRunOnDestinationPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/active-sessions-live-sync-mount', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useActiveSessions: () => useSyncExternalStore(liveSync.subscribe, liveSync.get, liveSync.get),
  };
});
vi.mock('@/lib/hooks/use-persisted-run-on-destination', () => ({
  clearRunOnDestinationPreference,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, View: 'View' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Keep `@/lib/utils` free of `@/i18n`: its import-time i18next init is not
// wanted in a DOM-free mounted test, and `cn` is the only export used here.
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useRouter: () => ({ push: routerPush }),
    // The step refreshes the live list whenever the tour regains focus (the
    // pushed session screen popping back). Behave like an effect for tests.
    useFocusEffect: (effect: () => void) => {
      useEffect(effect, [effect]);
    },
  };
});
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666', good: '#24784A' }),
}));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  CircleCheck: 'CircleCheck',
  Cloud: 'Cloud',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

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

describe('TourCloudStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveSync.reset();
  });

  it('completes only after a cloud session appears after the baseline', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    liveSync.set({ data: { sessions: [{ id: 'remote-1', connectionId: 'conn-1' }] } });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    expect(hasText(renderer, 'tour.cloudTitle')).toBe(true);
    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      liveSync.set({
        data: {
          sessions: [
            { id: 'remote-1', connectionId: 'conn-1' },
            { id: 'cloud-1', connectionId: 'cloud-agent' },
          ],
        },
      });
    });

    await waitFor(() => hasText(renderer, 'tour.cloudCheck'));
    expect(onCompletedChange).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it('wraps the whole step body in a single scroll container', async () => {
    // A short screen or a large system font can make the body taller than the
    // space between the header and the Skip/Done bar; the body must scroll
    // there instead of overflowing over them.
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    liveSync.set({ data: { sessions: [] } });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    expect(hasText(renderer, 'tour.cloudTitle')).toBe(true);
    expect(renderer.root.findAllByType('CenteredState' as ElementType)).toHaveLength(1);
    unmount();
  });

  it('shows a working retry for a retryable network failure without completing', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    const refetch = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });
    liveSync.set({ data: undefined, isError: true, refetch });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    expect(hasText(renderer, 'tour.networkError')).toBe(true);
    // The step chrome stays mounted: the person keeps the context of which
    // path they are on while the retryable error is shown.
    expect(hasText(renderer, 'tour.cloudTitle')).toBe(true);
    expect(hasText(renderer, 'tour.cloudBody')).toBe(true);
    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });

    // The mount focus refresh already fired once; the retry control must add
    // its own call on top of it.
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    unmount();
  });

  it('stays waiting when the create action is refused (form owns the error)', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    liveSync.set({ data: { sessions: [] } });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    // The tour must not touch the stored run-on preference: it asks the form
    // to open on Cloud Agent for this entry through a transient route param.
    expect(clearRunOnDestinationPreference).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/(app)/agent-chat/new?preselectRunOn=cloud');

    // The live service refused the create, so no cloud row ever appears.
    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [] } });
    });
    await waitFor(() => hasText(renderer, 'tour.cloudWaiting'));

    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).not.toHaveBeenCalledWith(true);
    unmount();
  });

  it('offers the creation action again when the form was abandoned without a session (p7)', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    liveSync.set({ data: { sessions: [] } });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await act(async () => {
      await Promise.resolve();
      liveSync.set({ data: { sessions: [] } });
    });
    await waitFor(() => hasText(renderer, 'tour.cloudWaiting'));

    // The waiting state must not be a dead end: opening the form latches it, so
    // returning from a form that created nothing has to leave the New session
    // control available to create or retry (p7).
    expect(hasText(renderer, 'tour.cloudNewSession')).toBe(true);
    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).not.toHaveBeenCalledWith(true);

    routerPush.mockClear();
    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/agent-chat/new?preselectRunOn=cloud');
    unmount();
  });

  it('shows the waiting body and never the check while the list is loading or empty', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    liveSync.set({ data: undefined });

    const { renderer, unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });
    await waitFor(() => hasText(renderer, 'tour.cloudWaiting'));

    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(renderer.root.findAllByType('Skeleton' as ElementType).length).toBeGreaterThan(0);
    unmount();
  });

  it('refreshes the live list on focus so a session created in a pushed screen lands', async () => {
    const onCompletedChange = vi.fn<(completed: boolean) => void>();
    const refetch = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });
    liveSync.set({ data: { sessions: [] }, refetch });

    const { unmount } = await renderWithProviders(
      createElement(TourCloudStep, { onCompletedChange })
    );

    expect(refetch).toHaveBeenCalled();
    unmount();
  });

  it('keeps refreshing while waiting so the created session lands without a heartbeat poll', async () => {
    vi.useFakeTimers();
    try {
      const onCompletedChange = vi.fn<(completed: boolean) => void>();
      const refetch = vi.fn(async () => {
        await Promise.resolve();
        return true;
      });
      liveSync.set({ data: { sessions: [] }, refetch });

      const { renderer, unmount } = await renderWithProviders(
        createElement(TourCloudStep, { onCompletedChange })
      );
      const afterMount = refetch.mock.calls.length;

      await act(async () => {
        await Promise.resolve();
        press(renderer.root.findByType('Button' as ElementType));
      });
      await act(async () => {
        await Promise.resolve();
        vi.advanceTimersByTime(5000);
      });

      expect(refetch.mock.calls.length).toBeGreaterThan(afterMount);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
