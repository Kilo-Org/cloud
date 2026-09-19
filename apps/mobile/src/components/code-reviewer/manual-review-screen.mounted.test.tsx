import { createElement } from 'react';
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

const keyboard = vi.hoisted(() => ({ listeners: new Map<string, ((event: unknown) => void)[]>() }));

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Keyboard: {
    addListener: (event: string, listener: (event: unknown) => void) => {
      keyboard.listeners.set(event, [...(keyboard.listeners.get(event) ?? []), listener]);
      return {
        remove: () => {
          keyboard.listeners.set(
            event,
            (keyboard.listeners.get(event) ?? []).filter(entry => entry !== listener)
          );
        },
      };
    },
  },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: BOTTOM_INSET, left: 0, right: 0 }),
}));

vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(), selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', GitPullRequest: 'GitPullRequest' }));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: 'RadioGroup',
  radioItemA11y: () => ({}),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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
    data: { connected: true },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useGitLabStatus: () => ({
    data: { connected: false },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useReviewConfig: () => ({ data: { modelSlug: 'model-x', thinkingEffort: null } }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({
  useCreateManualReview: () => ({ mutate: vi.fn(), isPending: false }),
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

describe('ManualReviewScreen primary action', () => {
  beforeEach(() => {
    keyboard.listeners.clear();
  });

  it('pins the start action outside the scroll viewport, clear of the tab bar', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ManualReviewScreen, { scope: 'personal' })
    );

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
        platform: 'android',
        fontScale: 1,
      }) + TAB_SCREEN_BOTTOM_GAP
    );

    unmount();
  });

  it('drops the tab bar clearance while the keyboard lifts the footer', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ManualReviewScreen, { scope: 'personal' })
    );

    const keyboardShow = keyboard.listeners.get('keyboardDidShow') ?? [];
    expect(keyboardShow.length).toBeGreaterThan(0);
    act(() => {
      for (const listener of keyboardShow) {
        listener({ endCoordinates: { height: 300 } });
      }
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    // Nearest first: the footer drops its tab-bar clearance, and the
    // keyboard-lift view above it takes the IME's height plus the system
    // bar inset Android subtracts from it (300 + 24).
    expect(paddingBottomsAbove(action)).toEqual([0, 300 + BOTTOM_INSET]);

    unmount();
  });

  it('keeps the tab bar clearance a short keyboard does not cover', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ManualReviewScreen, { scope: 'personal' })
    );

    const keyboardShow = keyboard.listeners.get('keyboardDidShow') ?? [];
    // The hardware-keyboard IME bar is one navigation bar tall; dropping the
    // whole clearance for it parked the action behind the tab bar (e1-fill).
    act(() => {
      for (const listener of keyboardShow) {
        listener({ endCoordinates: { height: BOTTOM_INSET } });
      }
    });

    const action = only(findAllOfType(renderer.root, 'Button'), 'primary action');
    const footerClearance = getEffectiveTabBarHeight({
      bottomInset: BOTTOM_INSET,
      platform: 'android',
      fontScale: 1,
    });
    const keyboardLift = BOTTOM_INSET + BOTTOM_INSET;
    expect(paddingBottomsAbove(action)).toEqual([
      footerClearance + TAB_SCREEN_BOTTOM_GAP - keyboardLift,
      keyboardLift,
    ]);

    unmount();
  });
});
