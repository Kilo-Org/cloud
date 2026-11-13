import { act, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AccountSettingsScreen } from '@/components/account-settings-screen';
import { renderWithProviders } from '@/test/render-with-providers';
import type * as ReactQuery from '@tanstack/react-query';

const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const signOutWeb = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Ban: 'Ban',
  Cpu: 'Cpu',
  FileText: 'FileText',
  Globe: 'Globe',
  KeyRound: 'KeyRound',
  Lock: 'Lock',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
  UserRound: 'UserRound',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalLogOut: 'DirectionalLogOut' }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
}));
vi.mock('@/lib/picker-bridge', () => ({
  setLanguagePickerBridge,
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm, dialog: null }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  // QueryClientProvider stays real so renderWithProviders keeps working; only the
  // mutation is replaced, so the row's action can be observed without a server.
  const actual = await importOriginal<typeof ReactQuery>();
  return { ...actual, useMutation: () => ({ mutate: signOutWeb, isPending: false }) };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: { signOutBrowserSessions: { mutationOptions: (options: unknown) => options } },
  }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function mountAccount(): Promise<ReactTestRenderer> {
  view = await renderWithProviders(<AccountSettingsScreen />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return view.renderer;
}
function findConfigureRow(renderer: ReactTestRenderer, title: string) {
  const rows = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
  );
  const row = rows.find(item => item.props.title === title);
  if (!row) {
    throw new Error(`ConfigureRow for ${title} not found`);
  }
  return row;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
});

describe('AccountSettingsScreen', () => {
  it('renders the Language, Trusted hosts, Passkeys, and Device sessions rows', async () => {
    const renderer = await mountAccount();

    const language = findConfigureRow(renderer, 'Language');
    expect(language.props).toMatchObject({ icon: 'Globe', subtitle: 'Device · English' });
    expect(findConfigureRow(renderer, 'Trusted hosts')).toBeDefined();
    expect(findConfigureRow(renderer, 'Passkeys').props).toMatchObject({
      icon: 'KeyRound',
      subtitle: 'Sign in without a password',
    });
    expect(findConfigureRow(renderer, 'Device sessions')).toBeDefined();
  });

  it('opens the app language picker from the Language row', async () => {
    const renderer = await mountAccount();

    act(() => {
      (findConfigureRow(renderer, 'Language').props.onPress as () => void)();
    });

    expect(push).toHaveBeenCalledWith('/(app)/language-picker');
    expect(setLanguagePickerBridge).toHaveBeenCalledTimes(1);
    expect(setLanguagePickerBridge).toHaveBeenCalledWith({
      onApplied: expect.any(Function),
    });
  });

  it('opens trusted hosts, passkeys, and device sessions from their rows', async () => {
    const renderer = await mountAccount();

    act(() => {
      (findConfigureRow(renderer, 'Trusted hosts').props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/trusted-hosts');

    act(() => {
      (findConfigureRow(renderer, 'Passkeys').props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/passkeys');

    act(() => {
      (findConfigureRow(renderer, 'Device sessions').props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/device-sessions');
  });

  it('opens the account surfaces the web already had', async () => {
    const renderer = await mountAccount();

    const destinations = [
      ['Edit profile', '/(app)/(tabs)/(3_profile)/profile-edit'],
      ['Sign-in methods', '/(app)/(tabs)/(3_profile)/login-methods'],
      ['Provider keys', '/(app)/(tabs)/(3_profile)/provider-keys'],
      ['Your data', '/(app)/(tabs)/(3_profile)/data-export'],
      ['Blocked and muted people', '/(app)/(tabs)/(3_profile)/blocked-people'],
    ] as const;

    for (const [title, href] of destinations) {
      act(() => {
        (findConfigureRow(renderer, title).props.onPress as () => void)();
      });
      expect(push).toHaveBeenCalledWith(href);
    }
  });

  it('asks before revoking every web session', async () => {
    const renderer = await mountAccount();

    act(() => {
      (findConfigureRow(renderer, 'Sign out of all web sessions').props.onPress as () => void)();
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sign out of all web sessions?',
        confirmLabel: 'Sign out',
        onConfirm: expect.any(Function),
      })
    );
    expect(signOutWeb).not.toHaveBeenCalled();

    const asked = confirm.mock.calls.at(-1)?.[0] as { onConfirm: () => void } | undefined;
    if (!asked) {
      throw new Error('missing confirmation dialog');
    }
    act(() => {
      asked.onConfirm();
    });
    expect(signOutWeb).toHaveBeenCalledTimes(1);
  });
});
