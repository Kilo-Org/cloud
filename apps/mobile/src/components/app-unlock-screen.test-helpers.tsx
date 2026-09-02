/* eslint-disable typescript-eslint/no-deprecated, max-lines -- Use the repository's DOM-free mounted renderer; one shared harness mocks every native module the five layouts reach. */
import { createElement, type ElementType, type ReactElement, useState } from 'react';
import { type AppStateStatus } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { expect, vi } from 'vitest';
import { appUnlockScreenLayout } from '@/components/app-unlock-screen';
import { AppRootProviders } from '@/components/app-root-providers';
import KiloClawLayout from '@/app/(app)/(tabs)/(1_kiloclaw)/_layout';
import { QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
export function unlockRoot() {
  if (!view) {
    throw new Error('Scene not mounted');
  }
  return view.renderer.root;
}
export async function mount(ui: ReactElement = <KiloClawLayout />, languageReady = true) {
  view = await renderWithProviders(
    <AppRootProviders languageReady={languageReady}>{ui}</AppRootProviders>
  );
  await flush();
}
export function rerender(ui: ReactElement) {
  view?.renderer.update(
    <QueryClientProvider client={view.queryClient}>
      <AppRootProviders languageReady>{ui}</AppRootProviders>
    </QueryClientProvider>
  );
}
export function retry() {
  return unlockRoot().findAllByType('Pressable' as ElementType)[0];
}
export async function unmountUnlock() {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  i18n.removeResourceBundle('fr', 'translation');
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
}

const native = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(),
  isEnrolledAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const storage = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
const catalogs = vi.hoisted(() => ({ fr: vi.fn() }));
const announcements = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const lifecycle = vi.hoisted(() => ({
  change: undefined as ((state: AppStateStatus) => void) | undefined,
}));
export { announcements, catalogs, lifecycle, native, platform, storage };
vi.mock('@/i18n/catalogs', () => ({ CATALOG_LOADERS: catalogs }));
vi.mock('expo-local-authentication', () => native);
vi.mock('expo-secure-store', () => storage);
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Switch: 'Switch',
  ActivityIndicator: 'ActivityIndicator',
  Platform: platform,
  I18nManager: { isRTL: false },
  AccessibilityInfo: { announceForAccessibility: announcements },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: AppStateStatus) => void) => {
      lifecycle.change = listener;
      return {
        remove: () => {
          lifecycle.change = undefined;
        },
      };
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 12, left: 0, right: 0 }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'PrivacyCover' },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (build: () => unknown) => build(),
}));
vi.mock('expo-screen-capture', () => ({}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({
  Bell: 'Icon',
  Brain: 'Icon',
  CheckCircle2: 'Icon',
  CornerDownLeft: 'Icon',
  Gauge: 'Icon',
  Globe: 'Icon',
  Info: 'Icon',
  Loader: 'Icon',
  MessageSquare: 'Icon',
  Shield: 'Icon',
  Smartphone: 'Icon',
  TriangleAlert: 'Icon',
  XCircle: 'Icon',
}));
vi.mock('expo-router', () => ({
  // One mounted descriptor per navigator exercises its production callback.
  Stack: Object.assign(
    ({ screenLayout }: { screenLayout: typeof appUnlockScreenLayout }) =>
      createElement('Scene', null, screenLayout({ children: <Draft /> })),
    { Screen: 'StackScreen' }
  ),
  useRouter: () => ({ push: vi.fn() }),
  useLocalSearchParams: () => ({ owner: 'owner', repo: 'repo', number: '1', scope: 'personal' }),
  useSegments: () => ['(app)', '(tabs)', '(3_profile)', 'organization'],
}));
vi.mock('@expo/react-native-action-sheet', () => ({ ActionSheetProvider: 'ActionSheetProvider' }));
vi.mock('@rn-primitives/portal', () => ({ PortalHost: 'PortalHost' }));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'GestureHandlerRootView',
}));
vi.mock('sonner-native', () => ({ Toaster: 'Toaster' }));
vi.mock('@/lib/auth/auth-context', () => ({ AuthProvider: 'AuthProvider' }));
vi.mock('@/lib/glanceable/org-fence', () => ({ useGlanceableOrgFence: () => undefined }));
vi.mock('@/lib/glanceable/mount', () => ({ GlanceablePublisherMount: () => null }));
vi.mock('@/lib/organization-context', () => ({ OrganizationProvider: 'OrganizationProvider' }));
vi.mock('@/components/offline-banner', () => ({ OfflineBanner: 'OfflineBanner' }));
vi.mock('@/lib/query-client-lifecycle', () => ({
  QueryClientNativeLifecycle: 'QueryClientNativeLifecycle',
}));
vi.mock('@/lib/query-client', async () => {
  const { createTestQueryClient } = await import('@/test/render-with-providers');
  return { queryClient: createTestQueryClient() };
});
vi.mock('@/lib/trpc', () => ({
  TRPCProvider: 'TRPCProvider',
  trpcClient: {},
  useTRPC: () => ({
    user: { getMe: { queryKey: () => [] } },
    organizations: { list: { queryKey: () => [] } },
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#ffffff',
    foreground: '#000000',
    primaryForeground: '#000000',
    secondaryForeground: '#000000',
    mutedForeground: '#000000',
  }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: () => ({ userId: null }) }));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetDetents: () => ({ fullSheetDetent: 1 }) }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/hooks/use-security-lifecycle-invalidation', () => ({
  useSecurityLifecycleInvalidation: vi.fn(),
}));
vi.mock('@/lib/auth/logout-reconciliation', () => ({ attemptLogoutReconciliation: vi.fn() }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(),
}));
vi.mock('@rn-primitives/slot', () => ({}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  UserWebConnectionProvider: 'UserWebConnectionProvider',
}));
vi.mock('@/components/kilo-chat/kilo-chat-provider', () => ({
  KiloChatProvider: 'KiloChatProvider',
}));
vi.mock('@/components/kilo-chat/kilo-chat-presence-mount', () => ({
  KiloChatPresenceMount: 'KiloChatPresenceMount',
}));
vi.mock('@/components/share/share-payload-navigator', () => ({
  SharePayloadNavigator: 'SharePayloadNavigator',
}));
vi.mock('@/lib/active-sessions-live-sync-mount', () => ({
  ActiveSessionsLiveSyncMount: 'ActiveSessionsLiveSyncMount',
}));
vi.mock('@/lib/persist/cache-persistence-mount', () => ({
  CachePersistenceMount: 'CachePersistenceMount',
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/pr-review/pr-review-connect-gate', () => ({
  PrReviewConnectGate: 'PrReviewConnectGate',
}));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  PendingReviewProvider: 'PendingReviewProvider',
  pendingReviewDraftKey: () => 'draft',
}));
vi.mock('@/components/security-agent/security-agent-command-observer', () => ({
  SecurityAgentCommandObserver: 'SecurityAgentCommandObserver',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/lib/hooks/use-language-preference', () => ({
  getResolvedLanguage: () => 'en',
  useLanguagePreference: () => ({ preference: 'device', hasLoaded: true }),
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
vi.mock('@/lib/hooks/use-theme-preference', () => ({
  setThemePreference: vi.fn(),
  useThemePreference: () => ({ preference: 'system' }),
}));
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  useTrustedHosts: () => ({ trustedHosts: [], hasLoaded: true }),
}));
vi.mock('@/lib/picker-bridge', () => ({ setLanguagePickerBridge: vi.fn() }));

function Draft() {
  const [value, onChange] = useState('saved draft');
  return createElement('Draft', { value, onChange });
}

export function resetUnlockMocks() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__DEV__', true);
  vi.resetAllMocks();
  platform.OS = 'ios';
  storage.getItemAsync.mockResolvedValue('enabled');
  native.hasHardwareAsync.mockResolvedValue(true);
  native.isEnrolledAsync.mockResolvedValue(true);
  native.getEnrolledLevelAsync.mockResolvedValue(3);
  native.authenticateAsync.mockResolvedValue({ success: true });
}

export async function flush(update?: () => void) {
  await act(async () => {
    update?.();
    await vi.dynamicImportSettled();
  });
}

export function text(root: ReactTestInstance) {
  const texts = root.findAllByType('Text' as ElementType);
  return texts.map(node => node.props.children).join('\n');
}

export function expectHidden(root: ReactTestInstance, hidden: boolean) {
  const scenes = root.findAllByType('Scene' as ElementType);
  expect(scenes.length).toBeGreaterThan(0);
  for (const scene of scenes) {
    const wrapper = scene.find(
      node => (node.type as string) === 'View' && node.props.pointerEvents !== undefined
    );
    expect(wrapper.props).toMatchObject({
      pointerEvents: hidden ? 'none' : 'auto',
      accessibilityElementsHidden: hidden,
      importantForAccessibility: hidden ? 'no-hide-descendants' : 'auto',
    });
    expect((wrapper.props.className as string).includes('opacity-0')).toBe(hidden);
    expect(wrapper.findAllByType('Draft' as ElementType)).toHaveLength(1);
  }
}

export function nestedUnlockScenes(children: ReactElement) {
  return appUnlockScreenLayout({ children: appUnlockScreenLayout({ children }) });
}

function isHidden(node: ReactTestInstance): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.props.accessibilityElementsHidden ||
      parent.props.importantForAccessibility === 'no-hide-descendants'
    ) {
      return true;
    }
  }
  return false;
}

export function expectFeedback(root: ReactTestInstance, message: string, copies: number) {
  const messages = root.findAll(
    node => (node.type as string) === 'Text' && node.props.children === message
  );
  expect(messages).toHaveLength(copies);
  const visible = messages.filter(node => !isHidden(node));
  expect(visible).toHaveLength(1);
  expect(visible[0]?.props.accessibilityLiveRegion).toBe(
    platform.OS === 'android' ? 'polite' : undefined
  );
}
