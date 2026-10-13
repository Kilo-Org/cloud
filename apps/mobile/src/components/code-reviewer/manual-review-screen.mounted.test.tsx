import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

import { ManualReviewScreen } from './manual-review-screen';

// The explorer finding (manual-review, 2026-09-19) was the primary action
// clipped mid-label at the scroll fold, under the tab bar, at 560 density. The
// fix pins the action in a footer below the scroll view, so these tests assert
// the structural guarantee (the action is not inside the scroll viewport) and
// the footer clearance (it sits a tab bar's height above the overlay).
const BOTTOM_INSET = 24;
const TAB_SCREEN_BOTTOM_GAP = 16;

const platformState = vi.hoisted(() => ({ OS: 'android' }));
const status = vi.hoisted(() => ({
  connected: true,
  loading: false,
  errorCode: null as string | null,
  pending: false,
  refetch: vi.fn(),
  push: vi.fn(),
}));
// The footer reads its keyboard lift from the root `KeyboardProvider` instead of
// listening to React Native's keyboard events. The store below is driven per
// test so the footer clearance can be asserted against a raised keyboard; the
// app-level stub in `vitest.setup.ts` always reports a hidden one.
const keyboardStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { height: 0 },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHeight: (height: number) => {
      keyboardStore.state.height = height;
      for (const listener of listeners) {
        listener();
      }
    },
  };
});

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.OS;
    },
  },
  Dimensions: { get: () => ({ height: 900 }) },
  // `@/components/ui/input` reads `I18nManager.isRTL` through
  // `@/lib/rtl-text`; the mock must expose it or the shared box throws.
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-keyboard-controller', async () => {
  // `vi.mock` factories are hoisted above the file's static imports, so `react`
  // must be pulled in here.
  const React = await import('react');
  const heightOf = () => keyboardStore.state.height;
  return {
    KeyboardProvider: 'KeyboardProvider',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardChatScrollView: 'KeyboardChatScrollView',
    useKeyboardState: (selector?: (state: Record<string, unknown>) => unknown) => {
      const height = React.useSyncExternalStore(keyboardStore.subscribe, heightOf, heightOf);
      const state = {
        height,
        isVisible: height > 0,
        progress: height > 0 ? 1 : 0,
        duration: 0,
      };
      return selector ? selector(state) : state;
    },
  };
});
// The real footer and the tab-screen clearance are used on purpose: the footer
// measures its own clearance with the real `useTabBarBottomPadding` (this screen
// no longer renders `TabScreenScrollView`, so the old tab-screen mock does not
// apply). Both read the safe-area insets through
// `react-native-safe-area-context`, whose module resolves to its untransformed
// `react-native` entry (`src/index.tsx`): the CommonJS entry requires a Flow
// react-native subpath this node project cannot load, and every mounted suite
// mocks it. So stub the module's only native dependency instead of the module
// itself, and keep the real footer and clearance.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: BOTTOM_INSET, left: 0, right: 0 }),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn(), push: status.push }) }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field-a11y', () => ({ formFieldA11y: () => 'a11y' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', GitPullRequest: 'GitPullRequest' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The real `@/components/tab-screen` and `@/lib/code-reviewer-status` are used
// on purpose. The footer measures its clearance with the real
// `useTabBarBottomPadding` (this screen no longer renders `TabScreenScrollView`,
// so the old tab-screen mock does not apply), and the recovery cases below
// depend on the real `classifyProviderErrorCode` to tell retryable from
// permanent failures.
vi.mock('@/lib/code-reviewer-config', () => ({
  PLATFORM_CAPABILITIES: { github: { label: 'GitHub' }, gitlab: { label: 'GitLab' } },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#ffffff',
    mutedForeground: '#888888',
    primary: '#e5e54b',
    primaryForeground: '#111111',
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({ useAvailableModels: () => ({ models: [] }) }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({
    data: { connected: status.connected },
    isLoading: status.loading,
    isError: status.errorCode !== null,
    error: { data: { code: status.errorCode } },
    isFetching: false,
    refetch: status.refetch,
  }),
  useGitLabStatus: () => ({
    data: { connected: false },
    isLoading: status.loading,
    isError: status.errorCode !== null,
    error: { data: { code: status.errorCode } },
    isFetching: false,
    refetch: status.refetch,
  }),
  useReviewConfig: () => ({ data: { modelSlug: 'model-x', thinkingEffort: null } }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useCreateManualReview: () => ({ mutate: vi.fn(), isPending: status.pending }),
}));

function findAllOfType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => String(node.type) === type);
}

function only<T>(items: T[], what: string): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`Expected one ${what}, received ${items.length}`);
  }
  return item;
}

async function renderScreen() {
  const { renderer, unmount } = await renderWithProviders(
    createElement(ManualReviewScreen, { scope: 'personal' })
  );
  return { renderer, unmount };
}

/** Every inline `paddingBottom` on the way up from a node, nearest first. */
function paddingBottomsAbove(node: TestRenderer.ReactTestInstance): number[] {
  const values: number[] = [];
  let current: TestRenderer.ReactTestInstance | null = node.parent;
  while (current) {
    /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
    const style: unknown = current.props.style;
    /* eslint-enable typescript-eslint/no-unsafe-member-access */
    const entries = Array.isArray(style) ? style : [style];
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && 'paddingBottom' in entry) {
        const value: unknown = (entry as { paddingBottom?: unknown }).paddingBottom;
        if (typeof value === 'number') {
          values.push(value);
        }
      }
    }
    current = current.parent;
  }
  return values;
}

beforeEach(() => {
  keyboardStore.setHeight(0);
  status.connected = true;
  status.loading = false;
  status.errorCode = null;
  status.pending = false;
  status.refetch.mockClear();
  status.push.mockClear();
});

describe.each(['android', 'ios'] as const)('ManualReviewScreen primary action on %s', platform => {
  beforeEach(() => {
    platformState.OS = platform;
  });

  it('pins the start action outside the scroll viewport, clear of the tab bar', async () => {
    const { renderer, unmount } = await renderScreen();

    const scrollViews = findAllOfType(renderer.root, 'ScrollView');
    expect(scrollViews).toHaveLength(1);
    const scrollView = only(scrollViews, 'scroll view');
    // The action used to be the scroll body's last child, so a tall form
    // clipped it mid-label at the fold.
    expect(findAllOfType(scrollView, 'Button')).toHaveLength(0);

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    const [footerClearance] = paddingBottomsAbove(action);
    expect(footerClearance).toBe(
      getEffectiveTabBarHeight({
        bottomInset: BOTTOM_INSET,
        platform,
        fontScale: 1,
      }) + TAB_SCREEN_BOTTOM_GAP
    );

    unmount();
  });

  it('drops the tab bar clearance while the keyboard lifts the footer', async () => {
    const { renderer, unmount } = await renderScreen();

    // A keyboard at least as tall as the tab bar. The footer hands the whole
    // bottom space to the lift view (`KeyboardAvoidingView`), which owns it
    // while the keyboard is open, so its own clearance collapses to 0.
    const keyboardLift = platform === 'android' ? 300 : 324;
    act(() => {
      keyboardStore.setHeight(keyboardLift);
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect(paddingBottomsAbove(action)).toEqual([0]);
    // The lift view is the sole keyboard owner while the keyboard is up.
    expect(findAllOfType(renderer.root, 'KeyboardAvoidingView')).toHaveLength(1);

    // The provider clears the height when the keyboard hides; the footer
    // restores its tab-bar clearance.
    act(() => {
      keyboardStore.setHeight(0);
    });
    expect(paddingBottomsAbove(action)).toEqual([
      getEffectiveTabBarHeight({ bottomInset: BOTTOM_INSET, platform, fontScale: 1 }) +
        TAB_SCREEN_BOTTOM_GAP,
    ]);

    unmount();
  });

  it('keeps the tab bar clearance a short keyboard does not cover', async () => {
    const { renderer, unmount } = await renderScreen();

    // The hardware-keyboard IME bar is one navigation bar tall; the footer keeps
    // the difference so the action never lands behind the tab bar (e1-fill).
    const keyboardLift = BOTTOM_INSET + BOTTOM_INSET;
    act(() => {
      keyboardStore.setHeight(keyboardLift);
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    const footerClearance = getEffectiveTabBarHeight({
      bottomInset: BOTTOM_INSET,
      platform,
      fontScale: 1,
    });
    expect(paddingBottomsAbove(action)).toEqual([
      footerClearance + TAB_SCREEN_BOTTOM_GAP - keyboardLift,
    ]);

    unmount();
  });

  it('keeps the action pinned and disabled while provider status is loading', async () => {
    status.loading = true;
    status.connected = false;
    const { renderer, unmount } = await renderScreen();
    expect(findAllOfType(renderer.root, 'Skeleton')).toHaveLength(2);
    const button = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect((button.props as { disabled: boolean }).disabled).toBe(true);
    // The footer is the sole clearance source now (the deleted lift layer is
    // gone); at rest it reserves the tab bar height plus its final gap.
    expect(paddingBottomsAbove(button)).toEqual([
      getEffectiveTabBarHeight({ bottomInset: BOTTOM_INSET, platform, fontScale: 1 }) +
        TAB_SCREEN_BOTTOM_GAP,
    ]);
    unmount();
  });

  it('keeps the pending action in the same footer', async () => {
    status.pending = true;
    const { renderer, unmount } = await renderScreen();
    const button = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    expect((button.props as { loading: boolean }).loading).toBe(true);
    // The footer is the sole clearance source now (the deleted lift layer is
    // gone); at rest it reserves the tab bar height plus its final gap.
    expect(paddingBottomsAbove(button)).toEqual([
      getEffectiveTabBarHeight({ bottomInset: BOTTOM_INSET, platform, fontScale: 1 }) +
        TAB_SCREEN_BOTTOM_GAP,
    ]);
    unmount();
  });

  it.each([
    ['INTERNAL_SERVER_ERROR', true],
    ['FORBIDDEN', false],
    ['NOT_FOUND', false],
  ])('preserves the recovery action for %s', async (code, retryable) => {
    status.connected = false;
    status.errorCode = code;
    const { renderer, unmount } = await renderScreen();
    const error = only(findAllOfType(renderer.root, 'QueryError'), 'provider error');
    const { onRetry } = error.props as { onRetry?: () => void };
    expect(Boolean(onRetry)).toBe(retryable);
    if (retryable) {
      act(() => onRetry?.());
      expect(status.refetch).toHaveBeenCalledTimes(2);
    }
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(0);
    expect(findAllOfType(renderer.root, 'Button')).toHaveLength(0);
    unmount();
  });

  it('offers provider connection instead of a start action when empty', async () => {
    status.connected = false;
    const { renderer, unmount } = await renderScreen();
    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    const { action } = empty.props as { action: { props: { onPress: () => void } } };
    act(() => {
      action.props.onPress();
    });
    expect(status.push).toHaveBeenCalledWith(
      '/(app)/(tabs)/(3_profile)/code-reviewer/personal/github'
    );
    expect(findAllOfType(renderer.root, 'ScrollView')).toHaveLength(0);
    unmount();
  });
});

describe('ManualReviewScreen connect provider CTA', () => {
  it('renders the Connect GitHub action full-width like the PR-review connect gate', async () => {
    status.connected = false;
    const { renderer, unmount } = await renderScreen();

    const empty = only(findAllOfType(renderer.root, 'EmptyState'), 'empty state');
    const { action } = empty.props as { action: ReactElement<{ className?: string }> };
    const className = String(action.props.className);
    expect(className).toContain('w-full');
    expect(className).toContain('mt-3');

    unmount();
  });
});
