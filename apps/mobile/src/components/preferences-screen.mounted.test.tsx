/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
import { type ElementType } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PreferencesScreen } from '@/components/preferences-screen';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { renderWithProviders } from '@/test/render-with-providers';

const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(),
  isEnrolledAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const storage = vi.hoisted(() => ({
  value: null as string | null,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock('expo-local-authentication', () => native);
vi.mock('expo-secure-store', () => storage);
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({
  NativeStateSurface: 'NativeStateSurface',
  StateSurface: 'StateSurface',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  Switch: 'Switch',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  AccessibilityInfo: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Brain: 'Brain',
  CornerDownLeft: 'CornerDownLeft',
  Gauge: 'Gauge',
  Globe: 'Globe',
  MessageSquare: 'MessageSquare',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
}));
vi.mock('@/components/language-picker-sheet', () => ({
  LanguagePickerSheet: 'LanguagePickerSheet',
}));
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
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/picker-bridge', () => ({
  setLanguagePickerBridge,
}));
vi.mock('@/lib/hooks/use-keep-screen-on-preference', () => ({
  useKeepScreenOnPreference: () => ({
    keepScreenOn: false,
    hasLoaded: true,
    setKeepScreenOn: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-pr-review-footer-preference', () => ({
  usePrReviewFooterPreference: () => ({
    prReviewFooter: true,
    hasLoaded: true,
    setPrReviewFooter: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-reasoning-preference', () => ({
  useReasoningPreference: () => ({
    defaultExpanded: false,
    hasLoaded: true,
    setDefaultExpanded: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-preference', () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => ({ preference: 'system' }),
}));
vi.mock('@/lib/hooks/use-return-sends-message-preference', () => ({
  useReturnSendsMessagePreference: () => ({
    returnSendsMessage: false,
    hasLoaded: true,
    setReturnSendsMessage: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ secondaryForeground: '#000000', mutedForeground: '#000000' }),
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function flush(update?: () => void) {
  await act(async () => {
    update?.();
    await vi.dynamicImportSettled();
  });
}
async function mountPreferences(raw: string | null = null): Promise<ReactTestRenderer> {
  storage.value = raw;
  storage.getItemAsync.mockResolvedValue(raw);
  view = await renderWithProviders(<PreferencesScreen />, {
    wrapper: ({ children }) => (
      <AppUnlockProvider promptMessage="Unlock with biometrics">{children}</AppUnlockProvider>
    ),
  });
  await flush();
  return view.renderer;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  storage.setItemAsync.mockImplementation(async (_key: string, value: string) => {
    await Promise.resolve();
    storage.value = value;
  });
  native.hasHardwareAsync.mockResolvedValue(true);
  native.isEnrolledAsync.mockResolvedValue(true);
  native.getEnrolledLevelAsync.mockResolvedValue(3);
  native.authenticateAsync.mockResolvedValue({ success: true });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe('PreferencesScreen account rows', () => {
  it('renders the Language and Device sessions rows moved off the profile screen', async () => {
    const renderer = await mountPreferences();

    const rows = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
    );
    const language = rows.filter(row => row.props.title === 'Language');
    const deviceSessions = rows.filter(row => row.props.title === 'Device sessions');

    expect(language).toHaveLength(1);
    expect(language[0]?.props.icon).toBe('Globe');
    expect(language[0]?.props.subtitle).toBe('Device · English');
    expect(deviceSessions).toHaveLength(1);
  });

  it('language row opens the app language picker with returnTarget preferences', async () => {
    const renderer = await mountPreferences();

    const rows = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'ConfigureRow'
    );
    const language = rows.find(row => row.props.title === 'Language');
    if (!language) {
      throw new Error('language row not found');
    }

    act(() => {
      (language.props.onPress as () => void)();
    });

    expect(push).toHaveBeenCalledWith('/(app)/language-picker');
    expect(setLanguagePickerBridge).toHaveBeenCalledTimes(1);
    expect(setLanguagePickerBridge).toHaveBeenCalledWith({
      onApplied: expect.any(Function),
    });
  });
});

describe('PreferencesScreen Return-sends switch', () => {
  it('renders the Return-sends switch off by default with its title and subtitle', async () => {
    const renderer = await mountPreferences();

    const switches = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Switch'
    );
    const returnSends = switches.find(
      sw => sw.props.accessibilityLabel === 'Return key sends message'
    );

    expect(returnSends).toBeDefined();
    expect(returnSends?.props.value).toBe(false);

    const texts = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    );
    expect(texts.some(t => t.props.children === 'Return key sends message')).toBe(true);
    expect(
      texts.some(t => t.props.children === 'When off, Return inserts a newline in agent composers.')
    ).toBe(true);
  });
});

function biometric(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ accessibilityLabel: 'Unlock with biometrics' });
}
function expectPreference(renderer: ReactTestRenderer, value: boolean, busy: boolean) {
  expect(biometric(renderer).props).toMatchObject({
    value,
    disabled: busy,
    accessibilityState: { busy, disabled: busy },
  });
  expect(renderer.root.findAllByType('ActivityIndicator' as ElementType)).toHaveLength(
    busy ? 1 : 0
  );
}
async function toggle(renderer: ReactTestRenderer, next: boolean) {
  await flush(() => {
    (biometric(renderer).props.onValueChange as (value: boolean) => void)(next);
  });
}

it('shows one disabled-by-default biometric preference without native authentication', async () => {
  const renderer = await mountPreferences();
  expectPreference(renderer, false, false);
  expect(native.authenticateAsync).not.toHaveBeenCalled();
});

it.each([false, true])(
  'keeps the committed switch during authentication and saving next=%s',
  async next => {
    const renderer = await mountPreferences(next ? 'disabled' : 'enabled');
    const auth = Promise.withResolvers<unknown>();
    const save = Promise.withResolvers<undefined>();
    native.authenticateAsync.mockReturnValueOnce(auth.promise);
    storage.setItemAsync.mockImplementationOnce(async (_key: string, value: string) => {
      await save.promise;
      storage.value = value;
    });
    await toggle(renderer, next);
    expectPreference(renderer, !next, true);
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Return key sends message' }).props
    ).toMatchObject({ value: false, disabled: false, accessibilityState: { busy: false } });
    await flush(() => {
      auth.resolve({ success: true });
    });
    expectPreference(renderer, !next, true);
    expect(storage.value).toBe(next ? 'disabled' : 'enabled');
    await flush(() => {
      save.resolve(undefined);
    });
    expectPreference(renderer, next, false);
    expect(storage.value).toBe(next ? 'enabled' : 'disabled');
  }
);

describe.each([false, true])('biometric errors with enabled=%s', enabled => {
  it.each([
    ['user_cancel', null],
    ['authentication_failed', 'Something went wrong'],
    ['lockout', 'Something went wrong'],
    ['save', 'Could not save setting'],
    ['setup', 'Unavailable'],
  ])('preserves the value after %s and allows another toggle', async (code, message) => {
    const renderer = await mountPreferences(enabled ? 'enabled' : 'disabled');
    if (code === 'save') {
      storage.setItemAsync.mockRejectedValueOnce(new Error('save failed'));
    } else if (code === 'setup') {
      native.getEnrolledLevelAsync.mockResolvedValue(0);
    } else {
      native.authenticateAsync.mockResolvedValueOnce({ success: false, error: code });
    }
    await toggle(renderer, !enabled);
    expectPreference(renderer, enabled, false);
    expect(storage.value).toBe(enabled ? 'enabled' : 'disabled');
    const text = renderer.root
      .findAllByType('Text' as ElementType)
      .map(node => node.props.children)
      .join('\n');
    if (message) {
      expect(text).toContain(message);
    } else {
      expect(text).not.toContain('Something went wrong');
    }
    if (code === 'setup') {
      expect(text).toContain('Check your device security settings and try again.');
    }
    native.getEnrolledLevelAsync.mockResolvedValue(3);
    await toggle(renderer, !enabled);
    expectPreference(renderer, !enabled, false);
    expect(storage.value).toBe(enabled ? 'disabled' : 'enabled');
  });
});
