import { createElement, Fragment, type ReactNode } from 'react';
import { vi } from 'vitest';

import '@/i18n';
import TabsLayout from '@/app/(app)/(tabs)/_layout';
import { AgentSessionListScreen } from './session-list-screen';
import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

const organization = vi.hoisted(() => ({
  organizationId: null as string | null,
  isLoaded: true,
}));

const fetchSessions = vi.hoisted(() => vi.fn<() => Promise<{ sessions: ActiveSession[] }>>());
const attentionKv = vi.hoisted(() => ({
  getItem: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
}));

export { attentionKv, fetchSessions, organization };

vi.mock('@/lib/persist/encrypted-kv', () => attentionKv);
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          queryFn: fetchSessions,
          ...options,
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsNow: vi.fn().mockResolvedValue(false),
}));
vi.mock('expo-router', () => ({
  Tabs: Object.assign((props: { children: ReactNode }) => createElement('Tabs', props), {
    Screen: 'TabScreen',
  }),
  usePathname: () => '/',
  useSegments: () => ['(app)', '(tabs)', '(0_home)'],
  useRouter: () => ({ replace: vi.fn() }),
  useNavigation: () => ({ isFocused: () => false }),
  useFocusEffect: () => undefined,
  useScrollToTop: () => undefined,
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth/account-metadata-write', () => ({
  setAccountMetadata: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  View: 'View',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Plus: 'Plus',
  House: 'House',
  MessageCircle: 'MessageCircle',
  MessageSquare: 'MessageSquare',
  UserRound: 'UserRound',
}));
vi.mock('@/components/ui/blur-bar', () => ({ BlurBar: 'BlurBar' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/home/section-header', () => ({ SectionHeader: 'SectionHeader' }));
vi.mock('@/components/agents/remote-session-row', () => ({ RemoteSessionRow: 'RemoteSessionRow' }));
vi.mock('@/components/agents/session-list-content', () => ({ FAB_MARGIN: 0, FAB_SIZE: 0 }));
vi.mock('@/components/agents/session-list-search-header', () => ({
  SessionListSearchHeader: 'SessionListSearchHeader',
}));
vi.mock('@/components/agents/platform-filter-modal', () => ({
  SessionFilterModal: 'SessionFilterModal',
}));
vi.mock('@/components/agents/session-filter-button', () => ({
  SessionFilterButton: 'SessionFilterButton',
}));
vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/analytics/posthog', () => ({
  FEATURE_FLAG_QUICK_CHAT: 'quick-chat',
  useFeatureFlag: () => false,
}));
vi.mock('@/lib/hooks/use-kiloclaw-tab-visible', () => ({ useKiloClawTabVisible: () => false }));

export function key(organizationId: string | null = null) {
  return [
    ['activeSessions', 'list'],
    { input: buildActiveSessionsTrayInput(organizationId), type: 'query' },
  ];
}

export function sessions(
  statuses: ActiveSession['status'][],
  organizationId: string | null = null
): ActiveSession[] {
  return statuses.map((status, index) => ({
    id: `${organizationId ?? 'personal'}-${index}`,
    connectionId: 'cli',
    title: `Session ${index}`,
    status,
    organizationId,
  }));
}

export function CountSurfaces() {
  return createElement(
    Fragment,
    null,
    createElement(TabsLayout),
    createElement(AgentSessionListScreen)
  );
}

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    token: 'account',
    isLoading: false,
    isSigningOut: false,
    authEpoch: currentAuthEpoch(),
  }),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => organization }));
vi.mock('@/lib/hooks/use-organization-queries', () => {
  const orgs = ['org-a', 'org-b'].map(organizationId => ({
    organizationId,
    organizationName: organizationId,
  }));
  return {
    useOrgBoundary: () => ({
      orgs,
      org: orgs.find(org => org.organizationId === organization.organizationId),
      isResolving: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
  useUserWebConnectionHealth: () => ({ isConnected: true, reconnectExhausted: false }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: vi.fn() }),
}));
