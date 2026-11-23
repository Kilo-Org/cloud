import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactQuery from '@tanstack/react-query';

import '@/i18n';
import { AccountSettingsScreen } from '@/components/account-settings-screen';
import { type FocusEffects, pressBurst, pressRowOfTitle } from '@/test/focus-burst.test-helpers';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * The tap-burst guard of the Account settings screen. A row here opens a pushed
 * child screen, so the screen regains focus when that child closes itself; the
 * presses that belong to the closing burst must not reach the row underneath.
 */

const push = vi.hoisted(() => vi.fn());
// The router's focus effect, captured so the case can replay the focus a return
// from a pushed child screen produces. `now` pins the clock the guard reads.
const focus = vi.hoisted<FocusEffects>(() => ({ effects: [], now: 1_700_000_000_000 }));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
  useFocusEffect: (effect: () => void) => {
    focus.effects.push(effect);
  },
}));
// The picker rows push through the guarded hook, which resolves to the same spy
// the plain rows' `useRouter` does.
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => push,
}));
vi.mock('@/components/ui/icons', () => ({
  Ban: 'Ban',
  Cpu: 'Cpu',
  FileText: 'FileText',
  Flag: 'Flag',
  Globe: 'Globe',
  KeyRound: 'KeyRound',
  Lock: 'Lock',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
  UserRound: 'UserRound',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/settings-search/settings-target', () => ({
  SettingsSearchScrollView: 'ScrollView',
  SettingsTarget: 'SettingsTarget',
}));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalLogOut: 'DirectionalLogOut' }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: 'user-1',
    isLoading: false,
    isFetchError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));
vi.mock('@/lib/picker-bridge', () => ({ setLanguagePickerBridge: vi.fn() }));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // QueryClientProvider stays real so renderWithProviders keeps working; only the
  // mutation is replaced, so no row action reaches a server.
  const actual = await importOriginal<typeof ReactQuery>();
  return { ...actual, useMutation: () => ({ mutate: vi.fn(), isPending: false }) };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: { signOutBrowserSessions: { mutationOptions: (options: unknown) => options } },
  }),
}));

async function mountAccount(): Promise<ReactTestRenderer> {
  const { renderer } = await renderWithProviders(<AccountSettingsScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return renderer;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  focus.effects.length = 0;
  focus.now = 1_700_000_000_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountSettingsScreen row press burst', () => {
  it('drops the row press of the burst that closed a pushed child screen', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => focus.now);
    const renderer = await mountAccount();
    const burst = pressBurst(
      focus,
      pressRowOfTitle(renderer.root, 'ConfigureRow', 'Trusted hosts')
    );

    // The router focuses a fresh screen once on mount, and that first focus
    // must not deaden the rows behind it.
    await burst.mount();
    burst.press();
    expect(push).toHaveBeenCalledExactlyOnceWith('/(app)/(tabs)/(3_profile)/trusted-hosts');
    push.mockClear();

    // The child screen closes itself and the router focuses this one again.
    await burst.childClosed();
    burst.burst();
    expect(push).not.toHaveBeenCalled();

    burst.afterWindow();
    expect(push).toHaveBeenCalledExactlyOnceWith('/(app)/(tabs)/(3_profile)/trusted-hosts');
  });
});
