import { act, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AccountSettingsScreen } from '@/components/account-settings-screen';
import { renderWithProviders } from '@/test/render-with-providers';

const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Globe: 'Globe',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
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
  it('renders the Language, Trusted hosts, and Device sessions rows', async () => {
    const renderer = await mountAccount();

    const language = findConfigureRow(renderer, 'Language');
    expect(language.props).toMatchObject({ icon: 'Globe', subtitle: 'Device · English' });
    expect(findConfigureRow(renderer, 'Trusted hosts')).toBeDefined();
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

  it('opens trusted hosts and device sessions from their rows', async () => {
    const renderer = await mountAccount();

    act(() => {
      (findConfigureRow(renderer, 'Trusted hosts').props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/trusted-hosts');

    act(() => {
      (findConfigureRow(renderer, 'Device sessions').props.onPress as () => void)();
    });
    expect(push).toHaveBeenCalledWith('/(app)/device-sessions');
  });
});
