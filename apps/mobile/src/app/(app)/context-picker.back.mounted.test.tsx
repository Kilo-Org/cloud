// Hardware Back on the account picker route. The route is a formSheet screen, so
// the shared shell's Android Back listener dismisses it: Back closes the picker
// and never the screen underneath, which is what an interrupt during the native
// sheet's opening animation could not guarantee.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContextPickerScreen from './context-picker';
import { NavigationContext } from '@/lib/navigation/navigation-context';

const bridge = vi.hoisted(() => ({
  options: ['Personal', 'Acme'],
  currentIndex: 1,
  onSelect: vi.fn(),
}));
const slotClear = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ back: vi.fn() }));
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
  const state = { focused: true };
  return {
    state,
    isFocused: (): boolean => state.focused,
  };
});

vi.mock('react-native', () => ({
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
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  Platform: { OS: 'android' },
  StatusBar: { currentHeight: 24 },
}));
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-i18next', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Icon', Info: 'Icon' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#fff', foreground: '#000', primary: '#f00' }),
}));
vi.mock('@/lib/route-registry', () => ({
  contextPickerSlot: {
    get: () => bridge,
    clear: slotClear,
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
        createElement(ContextPickerScreen)
      )
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

describe('ContextPickerScreen hardware Back', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    bridge.onSelect.mockClear();
    router.back.mockClear();
    slotClear.mockClear();
    backHandlers.listeners.clear();
    navigation.state.focused = true;
  });

  it('dismisses only the picker and keeps the caller bridge for the next open', async () => {
    const renderer = await mount();
    expect(backHandlers.listeners.size).toBe(1);

    expect(backHandlers.press()).toEqual([true]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).not.toHaveBeenCalled();
    // Only a pick clears the slot; dismissing with Back must leave the
    // caller's rows intact, so reopening shows the same accounts.
    expect(slotClear).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
    expect(backHandlers.listeners.size).toBe(0);
  });

  it('ignores hardware Back once the route lost focus', async () => {
    const renderer = await mount();
    navigation.state.focused = false;

    expect(backHandlers.press()).toEqual([false]);
    expect(router.back).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
