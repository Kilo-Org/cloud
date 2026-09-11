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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
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
    expect(hasText(renderer, 'tour.cloudCheck')).toBe(false);
    expect(onCompletedChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      await Promise.resolve();
      press(renderer.root.findByType('Button' as ElementType));
    });

    expect(refetch).toHaveBeenCalledTimes(1);
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
    expect(clearRunOnDestinationPreference).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/agent-chat/new');

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
});
