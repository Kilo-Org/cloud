import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';

// The card must not own a foreground listener: the profile route layout
// invalidates the `[['kiloPass']]` prefix through `useRouteForegroundRefresh`,
// which is focus-gated and de-duplicated by key. `addEventListener` is a spy so
// a reintroduced listener fails the test, and `emit` still drives any listener a
// future change registers, so a foreground refetch cannot slip through.
const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const addEventListener = vi.fn((_event: string, listener: (state: string) => void) => {
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  });
  return {
    listeners,
    addEventListener,
    emit: (state: string): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const haptics = vi.hoisted(() => ({ selectionAsync: vi.fn() }));

const devRefund = vi.hoisted(() => ({ value: null as string | null }));

// Inert query results with refetch spies. `useQuery` dispatches on the marker
// the mocked tRPC `queryOptions` carries, so the card's three queries each get
// a stable shape regardless of hook-call order across renders.
const queryState = vi.hoisted(() => ({
  presentation: vi.fn(),
  presentationData: undefined as unknown,
  presentationIsError: false,
  presentationIsPending: false,
  state: vi.fn(),
  stateData: undefined as unknown,
  stateIsError: false,
  stateIsPending: false,
  productsData: undefined as unknown,
  productsRefetch: vi.fn(),
}));

const trpc = vi.hoisted(() => ({
  kiloPass: {
    getCreditHistory: { pathFilter: () => ({ queryKey: [['kiloPass']] }) },
    getMobileStoreProducts: {
      queryOptions: () => ({ __name: 'mobileStoreProducts' }),
    },
    getPurchasePresentation: { queryOptions: () => ({ __name: 'presentation' }) },
    getState: {
      pathFilter: () => ({ queryKey: [['kiloPass']] }),
      queryOptions: () => ({ __name: 'state' }),
    },
  },
  user: {
    getContextBalance: { pathFilter: () => ({ queryKey: [['user']] }) },
    getCreditBlocks: { pathFilter: () => ({ queryKey: [['user']] }) },
  },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('expo-haptics', () => ({ selectionAsync: haptics.selectionAsync }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/i18n', () => ({
  i18n: { language: 'en', t: (key: string) => key },
}));

vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#000000' }),
}));

vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpc }));

vi.mock('@/lib/kilo-pass/dev-storekit-refund', () => ({
  getDevStoreKitRefundAppleProductId: () => devRefund.value,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { __name?: string }) => {
    if (options.__name === 'presentation') {
      return {
        data: queryState.presentationData,
        isError: queryState.presentationIsError,
        isPending: queryState.presentationIsPending,
        refetch: queryState.presentation,
      };
    }
    if (options.__name === 'state') {
      return {
        data: queryState.stateData,
        isError: queryState.stateIsError,
        isPending: queryState.stateIsPending,
        refetch: queryState.state,
      };
    }
    return {
      data: queryState.productsData,
      isError: false,
      isPending: false,
      refetch: queryState.productsRefetch,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

async function renderCard(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(KiloPassSubscriptionCard));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const children = (value as { children?: unknown[] }).children;
    if (Array.isArray(children)) {
      collectText(children, out);
    }
  }
  return out;
}

describe('KiloPassSubscriptionCard mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('__DEV__', false);
    appState.addEventListener.mockClear();
    appState.listeners.clear();
    haptics.selectionAsync.mockClear();
    devRefund.value = null;
    queryState.presentation.mockClear();
    queryState.state.mockClear();
    queryState.productsRefetch.mockClear();
    queryState.presentationData = undefined;
    queryState.presentationIsError = false;
    queryState.presentationIsPending = false;
    queryState.stateData = undefined;
    queryState.stateIsError = false;
    queryState.stateIsPending = false;
    queryState.productsData = undefined;
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    vi.unstubAllGlobals();
  });

  it('never registers an AppState listener while rendering', async () => {
    queryState.presentationIsPending = true;
    queryState.stateIsPending = true;

    const renderer = await renderCard();

    expect(appState.addEventListener).not.toHaveBeenCalled();
    // The loading state still renders its single skeleton slot.
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'kiloPass.subscriptionLoading' })
    ).toHaveLength(1);
  });

  it('an active foreground transition triggers no refetch on either query', async () => {
    queryState.presentationData = { kind: 'unavailable' };
    queryState.stateData = { subscription: null };

    await renderCard();

    expect(appState.addEventListener).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(0);

    act(() => {
      appState.emit('background');
      appState.emit('active');
    });
    await flush();

    expect(queryState.presentation).not.toHaveBeenCalled();
    expect(queryState.state).not.toHaveBeenCalled();
  });

  it('renders the error state and keeps Retry reachable', async () => {
    queryState.presentationIsError = true;

    const renderer = await renderCard();
    const retry = renderer.root.findByProps({ accessibilityHint: 'kiloPass.retryHint' });
    const onRetryPress = retry.props.onPress as () => void;

    act(() => {
      onRetryPress();
    });

    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(queryState.state).toHaveBeenCalledTimes(1);
    expect(queryState.presentation).toHaveBeenCalledTimes(1);
  });

  it('renders the card presentation state', async () => {
    queryState.presentationData = { kind: 'unavailable' };
    queryState.stateData = { subscription: null };

    const renderer = await renderCard();

    expect(renderer.root.findAllByProps({ testID: 'kilo-pass-unavailable-card' })).toHaveLength(1);
  });

  it('hides the dev-refund control when no refundable product is present', async () => {
    queryState.presentationData = { kind: 'unavailable' };
    queryState.stateData = { subscription: null };
    devRefund.value = null;

    const renderer = await renderCard();

    expect(collectText(renderer.toJSON())).not.toContain('kiloPass.devRefund');
  });

  it('shows the dev-refund control when a refundable product is present', async () => {
    queryState.presentationData = { kind: 'unavailable' };
    queryState.stateData = { subscription: null };
    devRefund.value = 'kilo_pass_apple_monthly';

    const renderer = await renderCard();

    expect(collectText(renderer.toJSON())).toContain('kiloPass.devRefund');
  });
});
