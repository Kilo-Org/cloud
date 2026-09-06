/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PreferencesScreen } from '@/components/preferences-screen';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { renderWithProviders } from '@/test/render-with-providers';

const push = vi.hoisted(() => vi.fn());
const setLanguagePickerBridge = vi.hoisted(() => vi.fn());
// The screen mounts the feature-flag debug surface, which reads PostHog flag
// statuses; the cases below seed the registry the section renders.
const posthog = vi.hoisted(() => ({
  statuses: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/analytics/posthog', () => ({
  useFeatureFlagStatuses: () => posthog.statuses,
}));
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
async function mountPreferences(): Promise<ReactTestRenderer> {
  storage.getItemAsync.mockResolvedValue(null);
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
  posthog.statuses = [];
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

describe('PreferencesScreen feature-flag debug surface', () => {
  it('lists which flags the build applies and which it skips, with reasons', async () => {
    posthog.statuses = [
      {
        key: 'mobile-pr-review',
        minAppVersion: '1.0.4',
        defaultValue: true,
        appVersion: '1.0.5',
        applied: true,
        value: true,
        reason: 'applied',
        loaded: true,
      },
      {
        key: 'mobile-quick-chat',
        minAppVersion: '1.0.6',
        defaultValue: false,
        appVersion: '1.0.5',
        applied: false,
        value: false,
        reason: 'build-too-old',
        loaded: true,
      },
    ];
    const renderer = await mountPreferences();

    const lines = renderer.root
      .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
      .map(node => [node.props.children].flat().join(''));
    expect(lines).toContain('Feature flags');
    expect(lines).toContain('mobile-pr-review');
    expect(lines).toContain('Enabled · remote · ≥ 1.0.4');
    expect(lines).toContain('mobile-quick-chat');
    expect(lines).toContain('Off · default · < 1.0.6');
    expect(lines).toContain('v1.0.5');
  });
});
