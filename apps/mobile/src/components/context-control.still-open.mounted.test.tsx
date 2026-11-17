// The account picker is one presented sheet. While a copy of it exists, every
// opener refuses, so a repeated open cannot stack copies that each need their
// own Done, and one Done returns to the screen underneath.
import { createElement, type ReactNode, useEffect } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ContextControl } from '@/components/context-control';
import { darkColors } from '@/lib/hooks/theme-colors.generated';
import { OrganizationProvider } from '@/lib/organization-context';
import { enterContextPicker } from '@/lib/picker-presentation';
import { contextPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { renderWithProviders } from '@/test/render-with-providers';

const list = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
type FocusEffect = () => (() => void) | undefined;
const focusEffects = vi.hoisted(() => [] as FocusEffect[]);

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, back: vi.fn() }),
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

async function press(ui: MountedUi): Promise<void> {
  await act(() => {
    (picker(ui).props.onPress as () => void)();
  });
}

describe('openPicker while the account picker is presented', () => {
  /** Every release the suite entered, so a failure cannot leak a mark. */
  const releases: (() => void)[] = [];

  function present(): void {
    releases.push(enterContextPicker());
  }

  beforeEach(() => {
    vi.stubGlobal('__DEV__', true);
    contextPickerSlot.clearAll();
    pushMock.mockReset();
    focusEffects.length = 0;
    list.mockReset().mockReturnValue(orgs as unknown as Promise<typeof orgs>);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const release of releases.splice(0)) {
      release();
    }
    for (const ui of mountedUi.splice(0)) {
      ui.unmount();
    }
  });

  it('pushes once and writes the slot once', async () => {
    const ui = await mount();
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/(app)/context-picker');
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toEqual({
      options: ['Personal', name],
      currentIndex: 0,
      onSelect: expect.any(Function),
    });
  });

  it('keeps the single push and the slot of the first open while one is presented', async () => {
    const ui = await mount();
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const writtenBefore = contextPickerSlot.get(UNFENCED_ROUTE_KEY);

    present();
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toBe(writtenBefore);
  });

  it('pushes nothing when the sheet is already presented before the first open', async () => {
    present();
    const ui = await mount();
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(0);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });

  it('opens again after the presented copy leaves', async () => {
    const ui = await mount();
    present();
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(0);

    for (const release of releases.splice(0)) {
      release();
    }
    await press(ui);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(contextPickerSlot.get(UNFENCED_ROUTE_KEY)).not.toBeUndefined();
  });

  it('releases a presentation once, however often the release runs', async () => {
    const release = enterContextPicker();
    present();
    release();
    release();
    await mount().then(ui => press(ui));
    // One release of the second entry is still outstanding, so the mark holds.
    expect(pushMock).toHaveBeenCalledTimes(0);
  });
});
