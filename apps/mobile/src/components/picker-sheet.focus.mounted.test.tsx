/* eslint-disable max-lines -- test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/sheet-header.mounted.test.tsx) */
import { type Context, createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { PickerSheet } from './picker-sheet';
import { SheetHeader } from './sheet-header';
import '@/i18n';

const NAVIGATION_CONTEXT_MODULE = 'expo-router/build/react-navigation/core/NavigationContext';

// The vendored context is a plain `createContext(undefined)` in expo-router.
// Mocking it with a context of this suite's own keeps a Node test off the build
// file and lets the shell's focus read be driven from the provider value. The
// factory is hoisted above the imports, so React is only reachable through a
// dynamic import here.
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: () => () => undefined,
  }),
  // The shell's hardware Back listener dismisses through the router; this
  // suite mounts with the platform Back module absent, so the listener never
  // arms and the mock only has to satisfy the import.
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  I18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
  Platform: { OS: 'ios' },
  StatusBar: { currentHeight: 0 },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState', StateAction: 'StateAction' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info', Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827' }),
}));

async function mountSheet(
  focused: boolean,
  props: { onCancel?: () => void; expired: boolean }
): Promise<TestRenderer.ReactTestRenderer> {
  const { NavigationContext }: { NavigationContext: Context<unknown> } = await import(
    NAVIGATION_CONTEXT_MODULE
  );
  const element: ReactElement = createElement(PickerSheet, {
    title: 'Repository',
    onDone: () => undefined,
    onCancel: props.onCancel,
    scrollable: false,
    expired: props.expired,
  });
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: { isFocused: () => focused, addListener: () => () => undefined } },
        element
      )
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PickerSheet expired shell', () => {
  it('paints nothing while its route is not the one on screen', async () => {
    const renderer = await mountSheet(false, { expired: true });

    // The caller's data is gone and this sheet is no longer the screen the user
    // is on: a dead modal must not appear over another screen.
    expect(renderer.toJSON()).toBeNull();

    act(() => {
      renderer.unmount();
    });
  });

  it('still explains the expired options while its route is on screen', async () => {
    const renderer = await mountSheet(true, { expired: true });

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves Done as the only exit while an expired shell has no Cancel', async () => {
    const renderer = await mountSheet(true, { expired: true });
    const [header] = renderer.root.findAllByType(SheetHeader);
    if (!header) {
      throw new Error('the expired shell rendered no header');
    }

    // Done is the one way out of a shell with no Cancel, so it must stay
    // pressable even though there is nothing to commit.
    expect(header.props.doneDisabled).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('disables Done while an expired shell offers Cancel', async () => {
    const onCancel = vi.fn<() => void>();
    const renderer = await mountSheet(true, { expired: true, onCancel });
    const [header] = renderer.root.findAllByType(SheetHeader);
    if (!header) {
      throw new Error('the expired shell rendered no header');
    }

    // Two controls that both only close the sheet leave Done promising a
    // selection that cannot exist: Cancel is the single exit instead.
    expect(header.props.doneDisabled).toBe(true);

    act(() => {
      (header.props.onCancel as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps Done pressable on a live picker that offers Cancel', async () => {
    const renderer = await mountSheet(true, { expired: false, onCancel: () => undefined });
    const [header] = renderer.root.findAllByType(SheetHeader);
    if (!header) {
      throw new Error('the picker rendered no header');
    }

    // A live sheet commits a choice through Done, so its Cancel must not
    // withdraw that action.
    expect(header.props.doneDisabled).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });
});
