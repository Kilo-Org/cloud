import { createElement, type ReactNode, useEffect } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl } from '@/components/context-control';
import { darkColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider } from '@/lib/organization-context';
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { renderWithProviders } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
type NavigationState = { index: number; routes: { name: string }[] };
const navigation = vi.hoisted(() => ({
  getState: vi.fn<() => NavigationState | undefined>(() => undefined),
  /** The navigator above: set per test to exercise the ancestor walk. */
  getParent: vi.fn<() => { getState: () => NavigationState | undefined } | undefined>(
    () => undefined
  ),
}));
type FocusEffect = () => (() => void) | undefined;
const focusEffects = vi.hoisted(() => [] as FocusEffect[]);
const slotSet = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
  useNavigation: () => navigation,
  useFocusEffect: (effect: FocusEffect) => {
    if (!focusEffects.includes(effect)) {
      focusEffects.push(effect);
    }
    useEffect(() => effect(), [effect]);
  },
}));
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ token: 'token', isLoading: false, sessionEnded: false }),
}));
vi.mock('@/lib/auth/logout-cleanup', () => ({ unregisterActivityTokensAndTombstone: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
  setItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return undefined;
  }),
  deleteItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return undefined;
  }),
}));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations-list'], queryFn: list }) },
    },
  }),
}));
type PartialQueryOptions = { queryFn?: () => Promise<unknown> };
vi.mock('@tanstack/react-query', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    useQuery: (options: PartialQueryOptions) => {
      if (!options.queryFn) {
        return {
          data: undefined,
          isPending: false,
          isError: false,
          isFetching: false,
          refetch: vi.fn(),
        };
      }
      const promise = options.queryFn();
      if (promise instanceof Promise) {
        throw new TypeError(
          'queryFn resolved asynchronously; this suite serves data synchronously'
        );
      }
      return {
        data: promise,
        isPending: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      };
    },
  };
});
vi.mock('react-native', () => ({
  BackHandler: { addEventListener: vi.fn(() => ({ remove: () => undefined })) },
  ActivityIndicator: 'ActivityIndicator',
  Modal: (props: { visible?: boolean; children?: ReactNode }) =>
    props.visible ? createElement('Modal', null, props.children) : null,
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 18 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => darkColors }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/hooks/use-organizations-list', () => ({
  useOrganizationsList: () => ({ data: orgs, isLoading: false }),
}));

const name = 'The org with the picker already presented';
const orgs = [{ organizationId: 'org-a', organizationName: name, role: 'owner' }];
type MountedUi = Awaited<ReturnType<typeof renderWithProviders>>;
const mountedUi: MountedUi[] = [];

/** The route the opener pushes, the name the presented route carries. */
const PICKED_ROUTES = [{ name: 'context-picker' }];
const PRESENTED_STATE = { index: 0, routes: PICKED_ROUTES };

function Surface() {
  return createElement(ContextControl);
}

async function mount(): Promise<MountedUi> {
  const ui = await renderWithProviders(createElement(Surface), {
    wrapper: OrganizationProvider,
  });
  mountedUi.push(ui);
  return ui;
}

function picker(ui: MountedUi): ReactTestInstance {
  return ui.renderer.root.findByProps({ accessibilityHint: 'Select account' });
}

async function openPicker(ui: MountedUi): Promise<void> {
  await act(() => {
    (picker(ui).props.onPress as () => void)();
  });
}

describe('openPicker while the account picker route is already presented', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', true);
    contextPickerSlot.clearAll();
    slotSet.mockReset();
    pushMock.mockReset();
    navigation.getState.mockReset().mockReturnValue(undefined);
    navigation.getParent.mockReset().mockReturnValue(undefined);
    focusEffects.length = 0;
    list.mockReset().mockReturnValue(orgs as unknown as Promise<typeof orgs>);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const ui of mountedUi.splice(0)) {
      ui.unmount();
    }
  });

  it('pushes once and writes the slot once, then the press while presented is a no-op', async () => {
    const ui = await mount();
    await openPicker(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/(app)/context-picker');
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toEqual({
      options: ['Personal', name],
      currentIndex: 0,
      onSelect: expect.any(Function),
    });

    navigation.getState.mockReturnValue(PRESENTED_STATE);
    const writtenBefore = contextPickerSlot.get(UNFENCED_ROUTE_KEY);
    await openPicker(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toBe(writtenBefore);
  });

  it('returns without writing or pushing when the route is already presented', async () => {
    const ui = await mount();
    navigation.getState.mockReturnValue(PRESENTED_STATE);
    await openPicker(ui);
    expect(pushMock).toHaveBeenCalledTimes(0);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });

  it('walks to the parent navigator when only its own state shows the sheet', async () => {
    // The tab-in-(app)-stack shape: the control's nearest navigator still
    // reports the tab row on top while the parent `(app)` stack carries the
    // presented context-picker — the shape the stacking bug came from.
    const ui = await mount();
    navigation.getState.mockReturnValue({ index: 0, routes: [{ name: 'index' }] });
    navigation.getParent.mockReturnValue({ getState: () => PRESENTED_STATE });
    await openPicker(ui);
    expect(pushMock).toHaveBeenCalledTimes(0);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });
});
