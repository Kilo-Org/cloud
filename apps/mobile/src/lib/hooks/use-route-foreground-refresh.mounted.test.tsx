import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as TanStackReactQuery from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { getRouteRecoveryScope } from '@/lib/navigation/route-recovery-scope';

const invalidateQueries = vi.hoisted(() => vi.fn());

// When true, the mocked useQueryClient delegates to the real hook, so a probe
// mounted under a real QueryClientProvider reads the provider's client. The
// existing mocked blocks keep this false and get the pass-through spy.
const useRealQueryClient = vi.hoisted(() => ({ value: false }));

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const focusState = vi.hoisted(() => ({
  isFocused: true,
}));

// Captures the useFocusEffect callback so a test can simulate a focus event.
const focusEffect = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<typeof TanStackReactQuery>();
  return {
    ...actual,
    useQueryClient: () =>
      useRealQueryClient.value ? actual.useQueryClient() : { invalidateQueries },
  };
});

// One object per test, like the navigators hand a route: the recovery registry
// keys on this identity and only grows, so a shared object would leak a scope
// into a later test that expects none.
type NavigationStub = { isFocused: () => boolean; getParent: () => undefined };
const navigation: { current: NavigationStub } = {
  current: { isFocused: () => focusState.isFocused, getParent: () => undefined },
};

vi.mock('expo-router', () => ({
  // `isFocused()` is a live call, so a test can blur the route without
  // rerendering the probe - the frozen-tab case.
  useNavigation: () => navigation.current,
  useFocusEffect: (effect: () => void) => {
    focusEffect.effect = effect;
  },
}));

const KEYS: readonly (readonly unknown[])[] = [['securityAgent'], ['organizations']];

const renderCount = { value: 0 };

function Probe({ queryKeys }: { queryKeys: readonly (readonly unknown[])[] }) {
  renderCount.value += 1;
  useRouteForegroundRefresh(queryKeys);
  return createElement('ProbeText', null, 'probe');
}

/** The app-wide freshness mount shape: keys refreshed, but no recovery scope. */
function AppWideProbe({ queryKeys }: { queryKeys: readonly (readonly unknown[])[] }) {
  useRouteForegroundRefresh(queryKeys, { recoveryScope: false });
  return createElement('AppWideProbeText', null, 'app-wide');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

async function renderProbe(
  queryKeys: readonly (readonly unknown[])[]
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe, { queryKeys }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

async function renderProbeWithProvider(
  queryClient: QueryClient,
  queryKeys: readonly (readonly unknown[])[]
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Probe, { queryKeys })
      )
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

async function renderAppWideProbe(
  queryKeys: readonly (readonly unknown[])[]
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(AppWideProbe, { queryKeys }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

function backgroundThenActive(): void {
  act(() => {
    appState.emit('background');
  });
  act(() => {
    appState.emit('active');
  });
}

describe('useRouteForegroundRefresh mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigation.current = { isFocused: () => focusState.isFocused, getParent: () => undefined };
    focusState.isFocused = true;
    focusEffect.effect = undefined;
    renderCount.value = 0;
    invalidateQueries.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    focusEffect.effect = undefined;
  });

  it('invalidates exactly the listed keys on the focused foreground transition', async () => {
    await renderProbe(KEYS);

    backgroundThenActive();

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['securityAgent'] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['organizations'] });
  });

  it('invalidates nothing on the foreground transition while unfocused', async () => {
    focusState.isFocused = false;
    await renderProbe(KEYS);

    backgroundThenActive();

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('reads focus live without rerendering on the foreground transition', async () => {
    await renderProbe(KEYS);
    const rendersAfterMount = renderCount.value;

    // Blur without rerendering, then foreground the app: the hook reads focus
    // from the navigation object at the event, so a value carried through
    // React state or through a ref written in an effect would be stale here.
    focusState.isFocused = false;
    backgroundThenActive();

    expect(invalidateQueries).not.toHaveBeenCalled();
    // The hook holds no React state of its own, so the AppState transition
    // cannot rerender the route.
    expect(renderCount.value).toBe(rendersAfterMount);
  });

  it('invalidates nothing on the first focus (mount)', async () => {
    await renderProbe(KEYS);

    act(() => {
      focusEffect.effect?.();
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('records the listed keys as the route recovery scope before the first commit', async () => {
    await renderProbe(KEYS);

    // The screen boundary reads this back to refetch before it remounts a route
    // that threw, so it must be there even for a screen that never commits.
    expect(getRouteRecoveryScope(navigation.current)).toEqual(KEYS);
  });

  it('keeps an app-wide freshness mount out of the recovery scope', async () => {
    await renderAppWideProbe(KEYS);

    // These keys are the whole app's freshness, not one route's payloads: a
    // screen that declared nothing must remount instead of refetching them.
    expect(getRouteRecoveryScope(navigation.current)).toEqual([]);
  });

  it('invalidates the keys on a later focus regain', async () => {
    await renderProbe(KEYS);

    act(() => {
      focusEffect.effect?.();
    });
    expect(invalidateQueries).not.toHaveBeenCalled();

    act(() => {
      focusEffect.effect?.();
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['securityAgent'] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['organizations'] });
  });
});

describe('useRouteForegroundRefresh key matching with a real QueryClient', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    focusState.isFocused = true;
    focusEffect.effect = undefined;
    useRealQueryClient.value = true;
  });

  afterEach(() => {
    useRealQueryClient.value = false;
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    focusEffect.effect = undefined;
  });

  it('invalidates a tRPC-shaped query key with the nested prefix form', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue('sentinel');
    await queryClient.query({ queryKey: [['user', 'getMe']], queryFn });

    await renderProbeWithProvider(queryClient, [[['user']]]);

    backgroundThenActive();

    expect(queryClient.getQueryState([['user', 'getMe']])?.isInvalidated).toBe(true);
  });

  it('does not invalidate a tRPC-shaped query key with the flat prefix form', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue('sentinel');
    await queryClient.query({ queryKey: [['user', 'getMe']], queryFn });

    await renderProbeWithProvider(queryClient, [['user']]);

    backgroundThenActive();

    expect(queryClient.getQueryState([['user', 'getMe']])?.isInvalidated).toBe(false);
  });
});
