import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KiloPassSubscriptionCard } from '@/components/kilo-pass/kilo-pass-subscription-card';

// The card must not own a foreground listener: the profile route layout
// invalidates the `[['kiloPass']]` prefix through `useRouteForegroundRefresh`,
// which is focus-gated and de-duplicated by key. `emit` drives any listener a
// future change registers, so a foreground refetch cannot slip through.
const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const addEventListener = (_event: string, listener: (state: string) => void) => {
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  };
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

const routerPush = vi.hoisted(() => vi.fn());

// The pass query has a stable result shape independent of renders.
const queryState = vi.hoisted(() => ({
  refetch: vi.fn(),
  data: undefined as unknown,
  isError: false,
  isPending: false,
}));

const trpc = vi.hoisted(() => ({
  kiloPass: {
    getState: { queryOptions: () => ({ queryKey: ['kiloPass', 'getState'] as const }) },
  },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  // The card reads the window width to pick its stacked narrow presentation
  // (`narrow-layout.ts`). 390 dp keeps the standard side-by-side row, the same
  // width the narrow-layout test uses for its non-narrow cases.
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 2 }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('expo-haptics', () => ({ selectionAsync: haptics.selectionAsync }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/i18n', () => ({
  i18n: {
    language: 'en',
    // The mocked translator echoes a key, except for the sentence joiner: the
    // catalog value is punctuation, so echoing its key would change the label
    // under test rather than its separator.
    t: (key: string) => (key === 'common.sentenceJoiner' ? '. ' : key),
  },
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('@/components/ui/icons', () => ({ ChevronRight: 'ChevronRight' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#000000' }),
}));

vi.mock('@/lib/kilo-pass/state', () => ({
  getKiloPassCardContentState: () => {
    if (queryState.isPending) {
      return { kind: 'loading' };
    }
    if (queryState.isError) {
      return {
        kind: 'error',
        title: 'kiloPass.unavailable',
        description: 'kiloPass.tryAgainFromProfile',
        actionLabel: 'common.retry',
      };
    }
    return {
      kind: 'card',
      title: 'Kilo Pass',
      description: 'kiloPass.notAvailableInApp',
      accessibilityLabel: 'Kilo Pass. kiloPass.notAvailableInApp',
    };
  },
}));

vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpc }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: queryState.data,
    isError: queryState.isError,
    isPending: queryState.isPending,
    refetch: queryState.refetch,
  }),
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

describe('KiloPassSubscriptionCard mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('__DEV__', false);
    appState.listeners.clear();
    haptics.selectionAsync.mockClear();
    routerPush.mockClear();
    queryState.refetch.mockClear();
    queryState.data = { subscription: null, isEligibleForFirstMonthPromo: true };
    queryState.isError = false;
    queryState.isPending = false;
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

  it('shows the subscription loading state while the pass query is pending', async () => {
    queryState.isPending = true;

    const renderer = await renderCard();
    const loadingCard = renderer.root.findByProps({
      accessibilityLabel: 'kiloPass.subscriptionLoading',
    });

    expect(loadingCard.props.accessibilityState).toEqual({ busy: true });
  });

  it('an active foreground transition triggers no refetch', async () => {
    await renderCard();

    act(() => {
      appState.emit('background');
      appState.emit('active');
    });
    await flush();

    expect(queryState.refetch).not.toHaveBeenCalled();
  });

  it('renders the error state and keeps Retry reachable', async () => {
    queryState.isError = true;

    const renderer = await renderCard();
    const retry = renderer.root.findByProps({ accessibilityHint: 'kiloPass.retryHint' });
    const onRetryPress = retry.props.onPress as () => void;

    act(() => {
      onRetryPress();
    });

    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(queryState.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the no-pass card and opens the pass screen on press', async () => {
    const renderer = await renderCard();
    const card = renderer.root.findByProps({ accessibilityRole: 'button' });
    const renderedText = renderer.root
      .findAll(node => Object.is(node.type, 'Text'))
      .map(node => node.props.children);

    expect(renderedText).toEqual(['Kilo Pass', 'kiloPass.notAvailableInApp']);
    expect(card.props.accessibilityLabel).toBe('Kilo Pass. kiloPass.notAvailableInApp');

    act(() => {
      (card.props.onPress as () => void)();
    });

    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/(app)/kilo-pass');
  });
});
