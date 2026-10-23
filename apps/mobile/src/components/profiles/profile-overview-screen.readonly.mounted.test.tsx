import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  mountScreen,
  resetOverviewState,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
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

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => false,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => h.connectivity,
  useCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: h.back, push: h.push }) }));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileVariablesPath: (id: string, org?: string) =>
    `/profiles/${id}/variables${org ? `?org=${org}` : ''}`,
  getProfileCommandsPath: (id: string, org?: string) =>
    `/profiles/${id}/commands${org ? `?org=${org}` : ''}`,
  getProfileSlashCommandsPath: (id: string, org?: string) =>
    `/profiles/${id}/slash-commands${org ? `?org=${org}` : ''}`,
  getProfileMcpPath: (id: string, org?: string) => `/profiles/${id}/mcp${org ? `?org=${org}` : ''}`,
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
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  CornerDownLeft: 'CornerDownLeft',
  KeyRound: 'KeyRound',
  Server: 'Server',
  Sparkles: 'Sparkles',
  Star: 'Star',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

describe('ProfileOverviewScreen without the manage role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.connectivity = 'online';
    resetOverviewState(h);
  });

  it('renders a read-only overview for an organization profile', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen('org-1');

    // No destructive delete action for a non-manager.
    expect(findAll(renderer.root, 'Button')).toHaveLength(1);

    // The metadata save button stays in the tree but disabled.
    expect(findAll(renderer.root, 'Button')[0]?.props.disabled).toBe(true);

    // The default toggle is disabled.
    expect(findAll(renderer.root, 'PreferenceRow')[0]?.props.disabled).toBe(true);

    unmount();
  });
});
