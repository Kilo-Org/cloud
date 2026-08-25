/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/hooks/use-force-update.mounted.test.tsx) */
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as TanStackReactQuery from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

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

vi.mock('expo-router', () => ({
  // `isFocused()` is a live call, so a test can blur the route without
  // rerendering the probe - the frozen-tab case.
  useNavigation: () => ({ isFocused: () => focusState.isFocused }),
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

    // A blurred tab is frozen: it never rerenders, so a focus value carried
    // through React state or through a ref written in an effect stays stale.
    // Blur without rerendering, then foreground the app.
    focusState.isFocused = false;
    backgroundThenActive();

    expect(invalidateQueries).not.toHaveBeenCalled();
    // The hook holds no React state of its own, so the AppState transition
    // itself cannot rerender a frozen route.
    expect(renderCount.value).toBe(rendersAfterMount);
  });

  it('invalidates nothing on the first focus (mount)', async () => {
    await renderProbe(KEYS);

    act(() => {
      focusEffect.effect?.();
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
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
    await queryClient.prefetchQuery({ queryKey: [['user', 'getMe']], queryFn });

    await renderProbeWithProvider(queryClient, [[['user']]]);

    backgroundThenActive();

    expect(queryClient.getQueryState([['user', 'getMe']])?.isInvalidated).toBe(true);
  });

  it('does not invalidate a tRPC-shaped query key with the flat prefix form', async () => {
    const queryClient = new QueryClient();
    const queryFn = vi.fn().mockResolvedValue('sentinel');
    await queryClient.prefetchQuery({ queryKey: [['user', 'getMe']], queryFn });

    await renderProbeWithProvider(queryClient, [['user']]);

    backgroundThenActive();

    expect(queryClient.getQueryState([['user', 'getMe']])?.isInvalidated).toBe(false);
  });
});
