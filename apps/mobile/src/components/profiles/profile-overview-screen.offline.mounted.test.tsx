import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  findField,
  findOne,
  mountScreen,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';

const h = vi.hoisted(() => ({
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

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileVariablesPath: (id: string) => `/profiles/${id}/variables`,
  getProfileCommandsPath: (id: string) => `/profiles/${id}/commands`,
  getProfileSlashCommandsPath: (id: string) => `/profiles/${id}/slash-commands`,
  getProfileMcpPath: (id: string) => `/profiles/${id}/mcp`,
  getProfileSkillsPath: (id: string) => `/profiles/${id}/skills`,
  getProfileAgentsPath: (id: string) => `/profiles/${id}/agents`,
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
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScreenScrollView' }));
vi.mock('@/components/profiles/profile-repo-pins-section', () => ({
  ProfileRepoPinsSection: 'ProfileRepoPinsSection',
}));
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

/**
 * A failed refetch must not make a cached profile unopenable: the overview
 * keeps the profile mounted under the error banner, and the banner names
 * connectivity when the device is confirmed offline. Regression surface for
 * the profile-editor save/open drain item.
 */
describe('ProfileOverviewScreen offline refetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.connectivity = 'online';
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
  });

  it('offline refetch failure keeps the cached profile mounted and names connectivity', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.query.isError = true;
    h.connectivity = 'offline';

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'QueryError').props.variant).toBe('offline');
    // The cached profile stays usable under the banner.
    expect(findField(renderer.root, 'Profile name')).toBeTruthy();
    expect(findAll(renderer.root, 'ConfigureRow').length).toBeGreaterThan(0);

    unmount();
  });

  it('online refetch failure with cached profile keeps the server variant', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.query.isError = true;
    h.connectivity = 'online';

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'QueryError').props.variant).toBe('server');
    expect(findField(renderer.root, 'Profile name')).toBeTruthy();

    unmount();
  });

  it('unknown connectivity refetch failure keeps the server variant', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.query.isError = true;
    h.connectivity = 'unknown';

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'QueryError').props.variant).toBe('server');

    unmount();
  });

  it('error with no cached data renders only the error, no form', async () => {
    h.query.data = undefined;
    h.query.isPending = false;
    h.query.isError = true;
    h.connectivity = 'offline';

    const { renderer, unmount } = await mountScreen();

    expect(findOne(renderer.root, 'QueryError').props.variant).toBe('offline');
    expect(findAll(renderer.root, 'FormField')).toHaveLength(0);

    unmount();
  });

  it('success render passes no QueryError', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'QueryError')).toHaveLength(0);

    unmount();
  });
});
