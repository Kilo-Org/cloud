import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenErrorBoundary } from '@/components/screen-error-boundary';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { act, TestRenderer } from '@/test/renderer';
import { setRouteRecoveryScope } from '@/lib/navigation/route-recovery-scope';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

let events: TelemetryEvent[] = [];

// A fresh navigation object per test: the recovery registry keys on this
// identity and only grows, so one shared object would leak a scope between
// tests. `parent` is what a nested screen walks to when it declared no scope.
type NavigationStub = {
  isFocused: () => boolean;
  getParent: () => NavigationStub | undefined;
};
const navigation = vi.hoisted(() => {
  const stub = (parent?: NavigationStub): NavigationStub => ({
    isFocused: () => true,
    getParent: () => parent,
  });
  const initial = stub();
  return { current: initial, parent: stub(), make: stub };
});
const router = vi.hoisted(() => ({
  canGoBack: vi.fn(() => true),
  back: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('expo-router', () => ({
  useNavigation: () => navigation.current,
  useRouter: () => router,
  useSegments: () => ['(app)', 'agent-chat', '[session-id]'],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

function mount(props: { error: Error; retry: () => Promise<void> }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const holder: { tree?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.tree = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ScreenErrorBoundary, props) as ReactElement
      ) as ReactElement
    );
  });
  const tree = holder.tree;
  if (!tree) {
    throw new Error('boundary did not mount');
  }
  return { tree, client };
}

/** A promise nobody resolves yet, so the refetch stays in flight. */
function deferred() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, resolve };
}

function pressRetry(tree: TestRenderer.ReactTestRenderer) {
  const retry = tree.root.findByType(QueryError as never).props.onRetry as () => void;
  act(() => {
    retry();
  });
}

function pressGoBack(tree: TestRenderer.ReactTestRenderer) {
  const onPress = tree.root.findByType(Button as never).props.onPress as () => void;
  act(() => {
    onPress();
  });
}

beforeEach(() => {
  navigation.parent = navigation.make();
  navigation.current = navigation.make(navigation.parent);
  router.canGoBack.mockReturnValue(true);
  router.back.mockReset();
  router.replace.mockReset();
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

describe('ScreenErrorBoundary', () => {
  it('offers a retry and a way out of the failed route', () => {
    const tree = mount({ error: new Error('route render failed'), retry: vi.fn() }).tree;

    expect(tree.root.findByType(QueryError as never).props).toMatchObject({
      placement: 'static',
      isRetrying: false,
    });
    expect(tree.root.findAllByType(Button as never)).toHaveLength(1);

    pressGoBack(tree);

    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('replaces the route with the authenticated entry when a cold link left no history', () => {
    router.canGoBack.mockReturnValue(false);
    const tree = mount({ error: new Error('route render failed'), retry: vi.fn() }).tree;

    pressGoBack(tree);

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(app)/(tabs)');
  });

  it('refetches the route its scope declares before remounting it', async () => {
    const queryPrefixes = [[['cliSessionsV2']], [['modelPreferences']]] as const;
    setRouteRecoveryScope(navigation.current, queryPrefixes);
    const retry = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const { tree, client } = mount({
      error: new Error('poisoned payload'),
      retry: retry as unknown as () => Promise<void>,
    });
    const recovery = deferred();
    const refetch = vi.spyOn(client, 'refetchQueries').mockReturnValue(recovery.promise);

    pressRetry(tree);

    // The screen must not remount against the payload that just threw: the
    // refetch is in flight and Retry reports it.
    expect(refetch.mock.calls.map(call => call[0]?.queryKey)).toEqual([
      [['cliSessionsV2']],
      [['modelPreferences']],
    ]);
    expect(tree.root.findByType(QueryError as never).props.isRetrying).toBe(true);
    expect(retry).not.toHaveBeenCalled();

    await act(async () => {
      recovery.resolve(undefined);
      await recovery.promise;
    });

    expect(refetch.mock.calls.every(call => call[0]?.type === 'all')).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
    expect(tree.root.findByType(QueryError as never).props.isRetrying).toBe(false);
  });

  it('refetches the scope the enclosing layout declared for a screen that declares none', async () => {
    const queryPrefixes = [[['githubPrReview']]] as const;
    setRouteRecoveryScope(navigation.parent, queryPrefixes);
    const retry = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const { tree, client } = mount({
      error: new Error('poisoned review payload'),
      retry: retry as unknown as () => Promise<void>,
    });
    const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);

    await act(async () => {
      pressRetry(tree);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refetch.mock.calls.map(call => call[0]?.queryKey)).toEqual([[['githubPrReview']]]);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('remounts without a refetch when the route declares no scope', async () => {
    const retry = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const { tree, client } = mount({
      error: new Error('unsupported input'),
      retry: retry as unknown as () => Promise<void>,
    });
    const refetch = vi.spyOn(client, 'refetchQueries');

    await act(async () => {
      pressRetry(tree);
      await Promise.resolve();
    });

    expect(refetch).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('reports one event per caught failure', () => {
    const error = new Error('route render failed');

    // The same failure reaching the fallback twice (a remount, a scene
    // re-render) is one event; a different failure is its own event.
    mount({ error, retry: vi.fn() });
    mount({ error, retry: vi.fn() });
    mount({ error: new Error('another route failure'), retry: vi.fn() });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      level: 'error',
      error,
      tags: { 'error.subsystem': 'agent-chat', 'error.operation': 'render_screen' },
      fingerprint: ['agent-chat', 'render_screen', 'Error', 'route render failed'],
    });
  });
});
