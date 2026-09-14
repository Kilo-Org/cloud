/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as preferences-screen.mounted.test.tsx) */
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { GeneralSettingsScreen } from '@/components/general-settings-screen';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { renderWithProviders } from '@/test/render-with-providers';

vi.hoisted(() => {
  vi.stubGlobal('__DEV__', false);
});

const native = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(),
  isEnrolledAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const storage = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock('expo-local-authentication', () => native);
vi.mock('expo-secure-store', () => storage);
// The E2E fault hook stays closed: rejected reads come from the SecureStore
// mock, not the bundle-time fault window.
vi.mock('@/lib/config', () => ({ E2E_SECURE_STORE_FAULT_MS: 0 }));
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
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Bell',
  Brain: 'Brain',
  CornerDownLeft: 'CornerDownLeft',
  Cpu: 'Cpu',
  EyeOff: 'EyeOff',
  Globe: 'Globe',
  MessageSquare: 'MessageSquare',
  Mic: 'Mic',
  Shield: 'Shield',
  Smartphone: 'Smartphone',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-hide-thinking-preference', () => ({
  useHideThinkingPreference: () => ({
    hideThinking: false,
    hasLoaded: true,
    setHideThinking: vi.fn(),
  }),
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

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
async function flush(update?: () => void) {
  await act(async () => {
    update?.();
    await vi.dynamicImportSettled();
  });
}
async function mountGeneral(): Promise<Awaited<ReturnType<typeof renderWithProviders>>> {
  storage.getItemAsync.mockResolvedValue(null);
  view = await renderWithProviders(<GeneralSettingsScreen />, {
    wrapper: ({ children }) => (
      <AppUnlockProvider promptMessage="Unlock with biometrics">{children}</AppUnlockProvider>
    ),
  });
  await flush();
  return view;
}
function texts(renderer: Awaited<ReturnType<typeof renderWithProviders>>) {
  return renderer.renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    )
    .map(node => node.props.children);
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', false);
  vi.resetAllMocks();
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

describe('GeneralSettingsScreen', () => {
  it('renders the six settings with their exact titles and subtitles', async () => {
    const renderer = await mountGeneral();
    const rendered = texts(renderer);

    expect(rendered).toContain('Unlock with biometrics');
    expect(rendered).toContain('Unlock at launch and after five minutes in the background.');
    expect(rendered).toContain('Auto expand thinking');
    expect(rendered).toContain("Show the agent's thinking expanded when it finishes.");
    expect(rendered).toContain('Hide thinking details');
    expect(rendered).toContain("Don't show the agent's thinking on the session page.");
    expect(rendered).toContain('Keep screen on while on session page');
    expect(rendered).toContain('Hold the screen awake while the session is working.');
    expect(rendered).toContain('Add app attribution to PR reviews');
    expect(rendered).toContain('Append a Reviewed via Kilo footer when you submit a review.');
    expect(rendered).toContain('Return key sends message');
    expect(rendered).toContain('When off, Return inserts a newline in agent composers.');
  });

  it('renders the biometric switch off by default without prompting native authentication', async () => {
    const renderer = await mountGeneral();

    const switches = renderer.renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Switch'
    );
    const biometricSwitch = switches.find(
      sw => sw.props.accessibilityLabel === 'Unlock with biometrics'
    );

    expect(biometricSwitch).toBeDefined();
    expect(biometricSwitch?.props).toMatchObject({ value: false, disabled: false });
    expect(native.authenticateAsync).not.toHaveBeenCalled();
  });

  it('mounts the hide-thinking switch off and enabled once the preference load settles', async () => {
    const renderer = await mountGeneral();

    const switches = renderer.renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Switch'
    );
    const hideThinkingSwitch = switches.find(
      sw => sw.props.accessibilityLabel === 'Hide thinking details'
    );

    expect(hideThinkingSwitch).toBeDefined();
    expect(hideThinkingSwitch?.props).toMatchObject({ value: false, disabled: false });
  });
});
