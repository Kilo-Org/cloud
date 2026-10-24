import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  findOne,
  mountScreen,
  queryErrorProps,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refetch: vi.fn(),
  query: {
    data: undefined as TestProfileDetail | undefined,
    error: undefined as unknown,
    isError: false,
    isPending: true,
    isRefetching: false,
  },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfile: () => ({ ...h.query, refetch: h.refetch }),
  useAgentProfileMutations: () => ({
    update: { mutateAsync: vi.fn(), isPending: false },
    deleteProfile: { mutateAsync: vi.fn(), isPending: false },
    setAsDefault: { mutate: vi.fn(), isPending: false },
    clearDefault: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => true,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: h.back, push: h.push, replace: h.replace }),
}));
vi.mock('@/lib/navigation/pop-when-focused', () => ({ usePopWhenFocused: () => h.back }));
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
 * Error states a Retry cannot resolve. A profile the server no longer serves
 * left the Profiles list advertising a row that opened into a load-failure
 * banner whose Retry re-issued the same answer forever; the screen now says
 * the profile is gone and returns to the list.
 */
describe('ProfileOverviewScreen terminal error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, {
      data: undefined,
      error: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
  });

  it('stale row: NOT_FOUND names the missing profile, offers no Retry, and refreshes the lists', async () => {
    Object.assign(h.query, {
      data: testProfile(),
      isError: true,
      isPending: false,
      error: { data: { code: 'NOT_FOUND', httpStatus: 404 } },
    });
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    const { renderer, unmount } = await mountScreen();

    const props = queryErrorProps(renderer.root);
    expect(props.variant).toBe('not-found');
    // The not-found variant's own copy names the removal; the screen's generic
    // load-failure title would claim the app broke.
    expect(props.title).toBeUndefined();
    // Retry would re-issue the same answer, and the header's back control is
    // already the way out, so no second control is composed here.
    expect(props.onRetry).toBeUndefined();
    expect(props.action).toBeUndefined();
    // A cached profile must not stay editable once the server refuses it.
    expect(findAll(renderer.root, 'FormField')).toHaveLength(0);
    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    // Without history the header back lands on the Profiles list.
    expect(findOne(renderer.root, 'ScreenHeader').props.backFallback).toBe(
      '/(app)/(tabs)/(3_profile)/profiles'
    );

    // The dead row leaves the lists; the failed detail read is not refetched.
    await waitFor(() =>
      invalidate.mock.calls.some(call => call[0]?.queryKey?.[1] === 'listCombined')
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agentProfiles', 'list'] });
    expect(h.refetch).not.toHaveBeenCalled();

    unmount();
  });

  it('permission: a refused read shows the permission state without Retry', async () => {
    Object.assign(h.query, {
      data: testProfile(),
      isError: true,
      isPending: false,
      error: { data: { code: 'FORBIDDEN', httpStatus: 403 } },
    });

    const { renderer, unmount } = await mountScreen();

    const props = queryErrorProps(renderer.root);
    expect(props.variant).toBe('permission');
    expect(props.onRetry).toBeUndefined();
    expect(props.action).toBeUndefined();
    expect(findAll(renderer.root, 'FormField')).toHaveLength(0);

    unmount();
  });

  it('retryable: a failure without a code keeps the banner, the Retry action and the cached editor', async () => {
    Object.assign(h.query, {
      data: testProfile(),
      isError: true,
      isPending: false,
      error: new Error('aborted'),
    });

    const { renderer, unmount } = await mountScreen();

    const props = queryErrorProps(renderer.root);
    expect(props.variant).toBe('server');
    expect(props.title).toBe("Couldn't load profiles");
    expect(props.onRetry).toBeDefined();
    expect(findAll(renderer.root, 'FormField').length).toBeGreaterThan(0);

    unmount();
  });
});
