import { createElement, useState } from 'react';
import { vi } from 'vitest';
import { type appUnlockScreenLayout } from '@/components/app-unlock-screen';

const native = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(),
  isEnrolledAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const storage = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
const catalogs = vi.hoisted(() => ({ fr: vi.fn() }));
export { catalogs, native, storage };
vi.mock('@/i18n/catalogs', () => ({ CATALOG_LOADERS: catalogs }));
vi.mock('expo-local-authentication', () => native);
vi.mock('expo-secure-store', () => storage);
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false },
  AccessibilityInfo: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
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
  CheckCircle2: 'Icon',
  Info: 'Icon',
  Loader: 'Icon',
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
vi.mock('@/lib/organization-context', () => ({ OrganizationProvider: 'OrganizationProvider' }));
vi.mock('@/components/dev-session-injector', () => ({ DevSessionInjector: 'DevSessionInjector' }));
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
  }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({ useCurrentUserId: () => ({ userId: null }) }));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetDetents: () => ({ fullSheetDetent: 1 }) }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));
vi.mock('@/lib/hooks/use-security-lifecycle-invalidation', () => ({
  useSecurityLifecycleInvalidation: vi.fn(),
}));
vi.mock('@/lib/auth/logout-reconciliation', () => ({ attemptLogoutReconciliation: vi.fn() }));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({}));
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

function Draft() {
  const [value, onChange] = useState('saved draft');
  return createElement('Draft', { value, onChange });
}
