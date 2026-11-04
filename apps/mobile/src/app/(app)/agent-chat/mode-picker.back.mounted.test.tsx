// Hardware Back coverage for a second PickerSheet route. The folder picker
// exercises the shell with a drill callback; the mode picker uses the plain
// default (no override, non-scrollable body, never-inset header), so this file
// proves the shared shell's own dismiss path on a different consumer.
import { createElement, Fragment, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ModePickerScreen from './mode-picker';
import { NavigationContext } from '@/lib/navigation/navigation-context';

const bridge = vi.hoisted(() => ({
  currentValue: 'code',
  onSelect: vi.fn(),
}));
const modePickerSlotClear = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ back: vi.fn() }));
// Live BackHandler harness: the shell's armed listener registers here so a
// test can press hardware Back and observe exactly what it does.
const backHandlers = vi.hoisted(() => {
  const listeners = new Set<() => boolean>();
  return {
    listeners,
    press(): boolean[] {
      return [...listeners].map(listener => listener());
    },
  };
});
const navigation = vi.hoisted(() => {
  // `isFocused` reads through `state` so a listener that captured the function
  // still observes a later blur (the real context object is stable too).
  const state = { focused: true };
  return {
    state,
    isFocused: (): boolean => state.focused,
  };
});

const flashListMock = vi.hoisted(
  () =>
    (props: {
      data: readonly { value: string }[];
      renderItem?: (info: { item: { value: string }; index: number }) => ReactNode;
    }) =>
      createElement(
        'FlashList',
        null,
        props.data.map((item, index) =>
          createElement(
            Fragment,
            { key: item.value },
            props.renderItem ? props.renderItem({ item, index }) : null
          )
        )
      )
);

vi.mock('@shopify/flash-list', () => ({ FlashList: flashListMock }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      backHandlers.listeners.add(listener);
      return {
        remove: () => {
          backHandlers.listeners.delete(listener);
        },
      };
    },
  },
}));
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useLocalSearchParams: () => ({}),
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Icon',
  Bug: 'Icon',
  Check: 'Icon',
  Code: 'Icon',
  HelpCircle: 'Icon',
  Info: 'Icon',
  NotebookPen: 'Icon',
  Workflow: 'Icon',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#fff', foreground: '#000', primary: '#f00' }),
}));
vi.mock('@/lib/route-registry', () => ({
  modePickerSlot: {
    get: () => bridge,
    clear: modePickerSlotClear,
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: navigation as never },
        createElement(ModePickerScreen)
      )
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

describe('ModePickerScreen hardware Back', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    bridge.onSelect.mockClear();
    router.back.mockClear();
    modePickerSlotClear.mockClear();
    backHandlers.listeners.clear();
    navigation.state.focused = true;
  });

  it('dismisses the route without committing or clearing the selection', async () => {
    const renderer = await mount();
    expect(backHandlers.listeners.size).toBe(1);

    expect(backHandlers.press()).toEqual([true]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).not.toHaveBeenCalled();
    // Selecting a row clears the slot; dismissing with Back must leave the
    // caller's bridge intact so reopening the picker still shows the choice.
    expect(modePickerSlotClear).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
    expect(backHandlers.listeners.size).toBe(0);
  });

  it('ignores hardware Back while the route is not focused', async () => {
    const renderer = await mount();
    navigation.state.focused = false;

    expect(backHandlers.press()).toEqual([false]);
    expect(router.back).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
