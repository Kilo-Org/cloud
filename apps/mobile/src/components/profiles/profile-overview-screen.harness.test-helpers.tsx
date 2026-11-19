// The module-mock harness for the Profile Overview screen's identity and
// sections suites. This import MUST stay first in each suite: the helpers
// register the module mocks while they are evaluated.
import { vi } from 'vitest';

import {
  findAll,
  resetOverviewState,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { type ReactTestInstance } from '@/test/renderer';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
  connectivity: 'online' as string,
  query: {
    data: undefined as TestProfileDetail | undefined,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    update: { mutateAsync: vi.fn(), isPending: false },
    deleteProfile: { mutateAsync: vi.fn(), isPending: false },
    setAsDefault: { mutate: vi.fn(), isPending: false },
    clearDefault: { mutate: vi.fn(), isPending: false },
  },
}));

// `vi.hoisted` results cannot be exported at their declaration (vitest hoists
// them above the export), so they are exported after the declaration instead.
export { h };

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => h.permission,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileOverview: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => h.connectivity,
  useCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('expo-router', () => ({
  usePreventRemove: () => undefined,
  useRouter: () => ({ back: h.back, push: h.push, replace: h.replace }),
}));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => h.back }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentProfiles: {
      list: { pathFilter: () => ({ queryKey: ['agentProfiles', 'list'] }) },
      listCombined: { pathFilter: () => ({ queryKey: ['agentProfiles', 'listCombined'] }) },
    },
  }),
}));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfilesPath: () => '/(app)/(tabs)/(3_profile)/profiles',
  getProfileVariablesPath: (id: string, org?: string) =>
    `/profiles/${id}/variables${org ? `?org=${org}` : ''}`,
  getProfileCommandsPath: (id: string, org?: string) =>
    `/profiles/${id}/commands${org ? `?org=${org}` : ''}`,
  getProfileSlashCommandsPath: (id: string, org?: string) =>
    `/profiles/${id}/slash-commands${org ? `?org=${org}` : ''}`,
  getProfileMcpPath: (id: string, org?: string) => `/profiles/${id}/mcp${org ? `?org=${org}` : ''}`,
  getProfileInstructionsPath: (id: string, org?: string) =>
    `/profiles/${id}/instructions${org ? `?org=${org}` : ''}`,
  getProfileSkillsPath: (id: string, org?: string) =>
    `/profiles/${id}/skills${org ? `?org=${org}` : ''}`,
  getProfileAgentsPath: (id: string, org?: string) =>
    `/profiles/${id}/agents${org ? `?org=${org}` : ''}`,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  View: 'View',
  ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructiveForeground: '#FFFFFF' }),
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/profiles/profile-repo-pins-section', () => ({
  ProfileRepoPinsSection: 'ProfileRepoPinsSection',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text', EYEBROW_LINE_HEIGHT_DP: 22 }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  CornerDownLeft: 'CornerDownLeft',
  Download: 'Download',
  FileText: 'FileText',
  KeyRound: 'KeyRound',
  Server: 'Server',
  Sparkles: 'Sparkles',
  Star: 'Star',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

/** Return the mocked screen state to the values each test starts from. */
export function resetProfileOverview(): void {
  vi.clearAllMocks();
  h.connectivity = 'online';
  h.permission = 'allowed';
  resetOverviewState(h);
}

/** The count each settings row paints in its trailing value cell, null when it shows none. */
export function rowCounts(root: ReactTestInstance): (string | null)[] {
  return findAll(root, 'ConfigureRow')
    .filter(node => node.props.title !== 'Import config')
    .map(node => {
      const trailing = node.props.trailing as
        | { props?: { children?: { props?: { text?: string } }[] } }
        | undefined;
      return trailing?.props?.children?.[0]?.props?.text ?? null;
    });
}
