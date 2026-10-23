// Containment for a render failure inside the Profile stack. Without a closer
// boundary the throw reaches the app's root error boundary, which replaces the
// whole app — the bottom tab bar and the Profile header included — and its
// Retry resets navigation to the initial tab. The stack must instead degrade to
// the screen's own retryable error state and keep the user on Profile.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileStackErrorBoundary } from './profile-stack-error-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { act, TestRenderer } from '@/test/renderer';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

let events: TelemetryEvent[] = [];

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#fff',
    foreground: '#000',
    mutedForeground: '#666',
  }),
}));

function ThrowingStack({ throwFor }: Readonly<{ throwFor: { current: boolean } }>) {
  if (throwFor.current) {
    throw new Error('profile render failed');
  }
  return createElement('ProfileStackContent');
}

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const holder: { tree?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.tree = TestRenderer.create(
      createElement(QueryClientProvider, { client }, children) as ReactElement
    );
  });
  const tree = holder.tree;
  if (!tree) {
    throw new Error('boundary did not mount');
  }
  return { tree, client };
}

function deferred() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, resolve };
}

function pressRetry(tree: TestRenderer.ReactTestRenderer) {
  const fallbackRetry = tree.root.findByType(QueryError as never).props.onRetry as () => void;
  act(() => {
    fallbackRetry();
  });
}

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

describe('ProfileStackErrorBoundary', () => {
  it('keeps the Profile header and the scroll viewport when a stack screen throws', () => {
    const throwFor = { current: true };
    const { tree } = mount(
      createElement(ProfileStackErrorBoundary, null, createElement(ThrowingStack, { throwFor }))
    );

    const header = tree.root.findByType(ScreenHeader as never);
    expect(header.props).toMatchObject({ title: 'common.profile', showBackButton: false });
    expect(tree.root.findAllByType(TabScreenScrollView as never)).toHaveLength(1);
    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(1);
    expect(tree.root.findAll(node => String(node.type) === 'ProfileStackContent')).toHaveLength(0);
  });

  it('reports the throw through the telemetry sink with its component stack', () => {
    const throwFor = { current: true };
    mount(
      createElement(ProfileStackErrorBoundary, null, createElement(ThrowingStack, { throwFor }))
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.level).toBe('error');
    expect(event?.tags).toEqual({
      'error.subsystem': 'profile',
      'error.operation': 'render_stack',
    });
    const componentStack = event?.extra?.componentStack;
    expect(typeof componentStack).toBe('string');
    expect((componentStack as string).length).toBeGreaterThan(0);
    expect(event?.fingerprint?.slice(0, 2)).toEqual(['profile', 'render_stack']);
  });

  it('keeps a healthy stack rendered without emitting telemetry', () => {
    const throwFor = { current: false };
    const { tree } = mount(
      createElement(ProfileStackErrorBoundary, null, createElement(ThrowingStack, { throwFor }))
    );

    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(0);
    expect(tree.root.findAll(node => String(node.type) === 'ProfileStackContent')).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('refetches the stack reads before it remounts, and clears once they settle', async () => {
    const throwFor = { current: true };
    const { tree, client } = mount(
      createElement(ProfileStackErrorBoundary, null, createElement(ThrowingStack, { throwFor }))
    );
    const recovery = deferred();
    const refetch = vi.spyOn(client, 'refetchQueries').mockReturnValue(recovery.promise);

    pressRetry(tree);

    // The crashed payload is still cached while the recovery read runs, so the
    // boundary must not remount yet: a fresh instance would throw again and
    // pin the fallback through the refetch.
    expect(tree.root.findByType(QueryError as never).props.isRetrying).toBe(true);
    expect(tree.root.findAll(node => String(node.type) === 'ProfileStackContent')).toHaveLength(0);

    // The read settles with a payload the render can handle.
    throwFor.current = false;
    await act(async () => {
      recovery.resolve(undefined);
      await recovery.promise;
    });

    expect(refetch).toHaveBeenCalledWith({ type: 'all' });
    expect(tree.root.findAllByType(QueryError as never)).toHaveLength(0);
    expect(tree.root.findAll(node => String(node.type) === 'ProfileStackContent')).toHaveLength(1);
  });
});
