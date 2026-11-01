import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeText,
  findField,
  mountScreen,
  pressDelete,
  pressSave,
  resetOverviewState,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
  repeat: vi.fn(),
  guard: {
    enabled: false as boolean,
    handler: undefined as
      | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
      | undefined,
  },
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
  useCanManageOrganizationProfiles: () => true,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileOverview: () => h.query,
  useAgentProfileMutations: () => h.mutations,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    h.guard.enabled = enabled;
    h.guard.handler = handler;
  },
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
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
  View: 'View',
  ScrollView: 'ScrollView',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 0, left: 0 }),
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

function discardRequest() {
  const request = h.confirm.mock.calls.at(-1)?.[0] as
    | { onConfirm?: () => void; onCancel?: () => void }
    | undefined;
  if (!request) {
    throw new Error('the discard confirmation was not raised');
  }
  return request;
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack() {
  const handler = h.guard.handler;
  if (!handler) {
    throw new Error('the metadata guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        h.repeat();
      },
    });
  });
}

describe('ProfileOverviewScreen unsaved metadata guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.guard.enabled = false;
    h.guard.handler = undefined;
    resetOverviewState(h);
    h.query.data = testProfile();
    h.query.isPending = false;
  });

  it('leaves an untouched form without asking', async () => {
    await mountScreen();

    expect(h.guard.enabled).toBe(false);
  });

  it('asks before leaving a description edit, and Keep editing keeps the text', async () => {
    const { renderer } = await mountScreen();

    changeText(renderer.root, 'Profile description', 'Unsaved description');
    expect(h.guard.enabled).toBe(true);

    pressBack();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Discard changes?',
      message: 'Your changes will be lost.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    });

    act(() => {
      discardRequest().onCancel?.();
    });

    expect(h.repeat).not.toHaveBeenCalled();
    expect(h.guard.enabled).toBe(true);
    expect(findField(renderer.root, 'Profile description').props.defaultValue).toBe(
      'Unsaved description'
    );
  });

  it('Discard replays the leave and disarms the guard', async () => {
    const { renderer } = await mountScreen();

    changeText(renderer.root, 'Profile name', 'Renamed');
    pressBack();
    expect(h.repeat).not.toHaveBeenCalled();

    await act(async () => {
      discardRequest().onConfirm?.();
      await Promise.resolve();
    });

    expect(h.repeat).toHaveBeenCalledTimes(1);
    // The replayed action runs against the render that dropped the
    // prevention, so the listener cannot intercept it a second time.
    expect(h.guard.enabled).toBe(false);
  });

  it('disarms the guard once a save succeeds', async () => {
    h.mutations.update.mutateAsync.mockResolvedValue({ success: true });
    const { renderer } = await mountScreen();

    changeText(renderer.root, 'Profile description', 'Saved description');
    expect(h.guard.enabled).toBe(true);

    await pressSave(renderer.root);
    await waitFor(() => h.success.mock.calls.length > 0);

    expect(h.guard.enabled).toBe(false);
  });

  it('does not ask about the edits of a profile that was just deleted', async () => {
    h.mutations.deleteProfile.mutateAsync.mockResolvedValue({ success: true });
    const { renderer } = await mountScreen();

    changeText(renderer.root, 'Profile description', 'Unsaved description');
    expect(h.guard.enabled).toBe(true);

    await pressDelete(renderer.root, h.confirm);

    await waitFor(() => h.back.mock.calls.length > 0);
    expect(h.guard.enabled).toBe(false);
  });
});
