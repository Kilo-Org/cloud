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

// The presentation query has a stable result shape independent of renders.
const queryState = vi.hoisted(() => ({
  presentation: vi.fn(),
  presentationData: undefined as unknown,
  presentationIsError: false,
  presentationIsPending: false,
}));

const trpc = vi.hoisted(() => ({
  kiloPass: {
    getPurchasePresentation: { queryOptions: () => ({ __name: 'presentation' }) },
  },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
  // The card reads the window width to pick its stacked narrow presentation
  // (`narrow-layout.ts`). 390 dp keeps the standard side-by-side row, the same
  // width the narrow-layout test uses for its non-narrow cases.
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 2 }),
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

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/kilo-pass/kilo-pass-icon', () => ({ KiloPassIcon: 'KiloPassIcon' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#000000' }),
}));

vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpc }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: queryState.presentationData,
    isError: queryState.presentationIsError,
    isPending: queryState.presentationIsPending,
    refetch: queryState.presentation,
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
    appState.addEventListener.mockClear();
    appState.listeners.clear();
    haptics.selectionAsync.mockClear();
    queryState.presentation.mockClear();
    queryState.presentationData = undefined;
    queryState.presentationIsError = false;
    queryState.presentationIsPending = false;
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

    const renderer = await renderCard();

    expect(appState.addEventListener).not.toHaveBeenCalled();
    // The loading state still renders its single skeleton slot.
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'kiloPass.subscriptionLoading' })
    ).toHaveLength(1);
  });

  it('an active foreground transition triggers no refetch on either query', async () => {
    queryState.presentationData = { kind: 'unavailable' };

    await renderCard();

    expect(appState.addEventListener).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(0);

    act(() => {
      appState.emit('background');
      appState.emit('active');
    });
    await flush();

    expect(queryState.presentation).not.toHaveBeenCalled();
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
    expect(queryState.presentation).toHaveBeenCalledTimes(1);
  });

  it('renders the card presentation state', async () => {
    queryState.presentationData = { kind: 'unavailable' };

    const renderer = await renderCard();

    expect(renderer.root.findAllByProps({ testID: 'kilo-pass-unavailable-card' })).toHaveLength(1);
  });
});
