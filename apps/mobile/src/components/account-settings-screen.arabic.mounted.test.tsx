import { act, type ReactTestRenderer } from '@/test/renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AccountSettingsScreen } from '@/components/account-settings-screen';
import { renderWithProviders } from '@/test/render-with-providers';

/**
 * Arabic-render regression check for the Account settings screen.
 *
 * An explorer capture named `account-settings-arabic` reported the screen as
 * blank with no title, rows, or tab bar. The screen's own render path has no
 * language or direction branch, so this test pins the Arabic output: the header
 * title and every row title must come from the Arabic catalog, and the
 * Language row must name the active language in Arabic.
 */

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
  KeyRound: 'KeyRound',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'ar',
  useLanguagePreference: () => ({ preference: 'ar', hasLoaded: true }),
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

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('AccountSettingsScreen in Arabic', () => {
  it('renders the Arabic header title and all four row titles', async () => {
    await i18n.changeLanguage('ar');

    const renderer = await mountAccount();

    expect(renderer.root.findByType('ScreenHeader').props.title).toBe('الحساب');
    expect(findConfigureRow(renderer, 'اللغة').props).toMatchObject({ subtitle: 'العربية' });
    expect(findConfigureRow(renderer, 'المضيفون الموثوقون')).toBeDefined();
    expect(findConfigureRow(renderer, 'مفاتيح المرور')).toBeDefined();
    expect(findConfigureRow(renderer, 'جلسات الأجهزة')).toBeDefined();
  });

  it('still opens the language picker from the Arabic Language row', async () => {
    await i18n.changeLanguage('ar');

    const renderer = await mountAccount();

    act(() => {
      (findConfigureRow(renderer, 'اللغة').props.onPress as () => void)();
    });

    expect(push).toHaveBeenCalledWith('/(app)/language-picker');
    expect(setLanguagePickerBridge).toHaveBeenCalledTimes(1);
  });
});
