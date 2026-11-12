// The account picker route: the sheet carries the standard formSheet chrome
// (title, Done), one action row per account with the current account checked,
// and a pick that reports the chosen account and closes only this route. Back
// belongs to the same dismissal, so an interrupted presentation never reaches
// the screen under it.
import { createElement, type ElementType } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import AccountPickerScreen from './account-picker';
import { NavigationContext } from '@/lib/navigation/navigation-context';

const bridge = vi.hoisted(() => ({
  rows: [
    { organizationId: null, label: 'Personal' },
    { organizationId: 'org-a', label: 'Acme Corp' },
  ] as { organizationId: string | null; label: string }[],
  shownOrganizationId: 'org-a' as string | null,
  onSelect: vi.fn(),
}));
const slotState = vi.hoisted(() => ({ present: true }));
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
  return { state, isFocused: (): boolean => state.focused };
});
const theme = vi.hoisted(() => ({ primary: '#FFDD00' }));

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
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', Info: 'Info' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme }));
vi.mock('@/lib/route-registry', () => ({
  accountPickerSlot: {
    get: () => (slotState.present ? bridge : undefined),
    clear: slotClear,
  },
  UNFENCED_ROUTE_KEY: 'unscoped',
  useRouteRegistry: vi.fn(),
}));

const mounted: TestRenderer.ReactTestRenderer[] = [];

// The app's stubbed primitives, declared as elements so a node-type check is a
// typed comparison against the stub the suite registered.
const Pressable = 'Pressable' as ElementType;
const Check = 'Check' as ElementType;
const SheetHeader = 'SheetHeader' as ElementType;
const EmptyState = 'EmptyState' as ElementType;

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: navigation as never },
        createElement(AccountPickerScreen)
      )
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  mounted.push(ref.current);
  return ref.current;
}

function isAccountRow(node: TestRenderer.ReactTestInstance): boolean {
  if (node.type !== Pressable || node.props.accessibilityRole !== 'button') {
    return false;
  }
  const state: unknown = node.props.accessibilityState;
  return typeof state === 'object' && state !== null && 'selected' in state;
}

function selectedOf(node: TestRenderer.ReactTestInstance): boolean {
  const state: unknown = node.props.accessibilityState;
  if (typeof state !== 'object' || state === null || !('selected' in state)) {
    throw new Error('account row lost its selected state');
  }
  return state.selected === true;
}

function accountRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(isAccountRow).map(node => {
    const checks = node.findAll(child => child.type === Check);
    return {
      label: node.props.accessibilityLabel as string,
      selected: selectedOf(node),
      check: checks.length > 0,
      checkColor: checks[0]?.props.color as string | undefined,
      divider:
        typeof node.props.className === 'string' &&
        node.props.className.includes('border-hair-soft'),
    };
  });
}

function header(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => node.type === SheetHeader);
}

describe('AccountPickerScreen', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    bridge.shownOrganizationId = 'org-a';
    bridge.onSelect.mockClear();
    slotClear.mockClear();
    slotState.present = true;
    router.back.mockClear();
    backHandlers.listeners.clear();
    navigation.state.focused = true;
    theme.primary = '#FFDD00';
  });
  afterEach(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount();
    }
  });

  it('marks the account the opener shows and closes the route on a pick', async () => {
    const renderer = await mount();
    expect(header(renderer).props.title).toBe('Select account');
    expect(
      accountRows(renderer).map(row => ({
        label: row.label,
        selected: row.selected,
        check: row.check,
      }))
    ).toEqual([
      { label: 'Personal', selected: false, check: false },
      { label: 'Acme Corp', selected: true, check: true },
    ]);

    const row = renderer.root.find(
      node => node.type === Pressable && node.props.accessibilityLabel === 'Personal'
    );
    await act(() => {
      (row.props.onPress as () => void)();
    });
    expect(slotClear).toHaveBeenCalled();
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).toHaveBeenCalledWith(null);
  });

  it('paints the current-account check with the active theme colour', async () => {
    const renderer = await mount();
    expect(accountRows(renderer)[1]?.checkColor).toBe('#FFDD00');
    theme.primary = '#123456';
    await act(() => {
      renderer.update(
        createElement(
          NavigationContext.Provider,
          { value: navigation as never },
          createElement(AccountPickerScreen)
        )
      );
    });
    expect(accountRows(renderer)[1]?.checkColor).toBe('#123456');
  });

  it('divides rows from each other only', async () => {
    const renderer = await mount();
    expect(accountRows(renderer).map(row => row.divider)).toEqual([true, false]);
  });

  it('marks Personal when the opener shows the personal account', async () => {
    bridge.shownOrganizationId = null;
    const renderer = await mount();
    expect(accountRows(renderer).map(row => row.selected)).toEqual([true, false]);
  });

  it('marks no row when the shown membership is no longer listed', async () => {
    bridge.shownOrganizationId = 'org-gone';
    const renderer = await mount();
    expect(accountRows(renderer).map(row => row.selected)).toEqual([false, false]);
  });

  it('closes only this route on hardware Back', async () => {
    await mount();
    expect(backHandlers.listeners.size).toBe(1);
    expect(backHandlers.press()).toEqual([true]);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(bridge.onSelect).not.toHaveBeenCalled();
  });

  it('does not close the route on a Back it no longer owns', async () => {
    navigation.state.focused = false;
    await mount();
    expect(backHandlers.press()).toEqual([false]);
    expect(router.back).not.toHaveBeenCalled();
  });

  it('shows the expired shell when the opener seeded no accounts', async () => {
    slotState.present = false;
    const renderer = await mount();
    expect(accountRows(renderer)).toHaveLength(0);
    expect(renderer.root.find(node => node.type === EmptyState)).toBeTruthy();
  });
});