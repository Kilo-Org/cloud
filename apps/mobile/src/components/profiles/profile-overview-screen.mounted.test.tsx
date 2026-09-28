import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeText,
  findAll,
  findField,
  findOne,
  findRow,
  mountScreen,
  pressDelete,
  pressSave,
  rerenderScreen,
  testProfile,
  type TestProfileDetail,
} from '@/components/profiles/profile-overview-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  alert: vi.fn(),
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
  View: 'View',
  ScrollView: 'ScrollView',
  Alert: { alert: h.alert },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructiveForeground: '#FFFFFF' }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
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

describe('ProfileOverviewScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    Object.assign(h.mutations.update, { isPending: false });
    Object.assign(h.mutations.deleteProfile, { isPending: false });
  });

  it('loading: renders skeleton rows and no content rows', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findAll(renderer.root, 'ConfigureRow')).toHaveLength(0);

    unmount();
  });

  it('error: renders QueryError and Retry refetches', async () => {
    Object.assign(h.query, { isError: true, isPending: false });

    const { renderer, unmount } = await mountScreen();

    const queryError = findOne(renderer.root, 'QueryError');
    expect(queryError.props.title).toBe("Couldn't load profiles");
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('happy: seeds the fields, lists the sections, and saves the metadata', async () => {
    h.query.data = testProfile({
      vars: [{ key: 'A' }],
      commands: ['pnpm install', 'pnpm build'],
      skills: [{ id: 's1' }],
    });
    h.query.isPending = false;
    h.mutations.update.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();

    expect(findField(renderer.root, 'Profile name').props.defaultValue).toBe('Backend debugging');
    expect(findField(renderer.root, 'Profile description').props.defaultValue).toBe(
      'Old description'
    );
    expect(findAll(renderer.root, 'ConfigureRow').map(row => row.props.subtitle)).toEqual([
      '1',
      '2',
      '0',
      '0',
      '1',
      '0',
    ]);

    act(() => {
      (findRow(renderer.root, 'Skills').props as { onPress: () => void }).onPress();
    });
    expect(h.push).toHaveBeenCalledWith('/profiles/profile-1/skills');

    changeText(renderer.root, 'Profile name', '  Renamed  ');
    await pressSave(renderer.root);

    await waitFor(() => h.mutations.update.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      name: 'Renamed',
      description: 'Old description',
    });
    await waitFor(() => h.success.mock.calls.length > 0);
    expect(h.success).toHaveBeenCalledWith('Updated');

    unmount();
  });

  it('empty: an empty profile still renders all six rows with zero counts', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'ConfigureRow').map(row => row.props.subtitle)).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
    ]);

    unmount();
  });

  it('retryable: a save failure with no usable message adds saveFailed', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.update.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();

    await pressSave(renderer.root);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't save profile");

    unmount();
  });

  it('happy: the default toggle calls setAsDefault and clearDefault', async () => {
    h.query.data = testProfile({ isDefault: false });
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();

    const defaultRow = findOne(renderer.root, 'PreferenceRow');
    expect(defaultRow.props.subtitle).toBe('Auto-loaded when no repository has a pinned profile.');
    expect(defaultRow.props.switchAccessibilityLabel).toBe('Set as default');

    act(() => {
      (defaultRow.props as { onValueChange: (next: boolean) => void }).onValueChange(true);
    });
    expect(h.mutations.setAsDefault.mutate).toHaveBeenCalledWith({ profileId: 'profile-1' });

    act(() => {
      (defaultRow.props as { onValueChange: (next: boolean) => void }).onValueChange(false);
    });
    expect(h.mutations.clearDefault.mutate).toHaveBeenCalledWith({ profileId: 'profile-1' });

    unmount();
  });

  it('keeps unsaved metadata edits when a refetch changes only updatedAt', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;

    const { renderer, queryClient, unmount } = await mountScreen();

    changeText(renderer.root, 'Profile name', 'Renamed');

    // Toggling the default invalidates the detail query; the refetched profile
    // carries a new updatedAt but the same name and description.
    h.query.data = testProfile({ isDefault: true, updatedAt: '2026-02-02T00:00:00.000Z' });
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });

    await pressSave(renderer.root);

    await waitFor(() => h.mutations.update.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      name: 'Renamed',
      description: 'Old description',
    });

    unmount();
  });

  it('happy: confirming delete toasts and navigates back', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.deleteProfile.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();

    await pressDelete(renderer.root, h.alert);

    await waitFor(() => h.mutations.deleteProfile.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.deleteProfile.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
    });
    await waitFor(() => h.success.mock.calls.length > 0);
    expect(h.success).toHaveBeenCalledWith('Profile "Backend debugging" deleted');
    await waitFor(() => h.back.mock.calls.length > 0);

    unmount();
  });

  it('non-retryable: a PRECONDITION_FAILED delete shows deleteBlocked and stays', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    h.mutations.deleteProfile.mutateAsync.mockRejectedValue({
      data: { code: 'PRECONDITION_FAILED' },
    });

    const { renderer, unmount } = await mountScreen();

    await pressDelete(renderer.root, h.alert);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith(
      'This profile is used by a webhook trigger. Remove it from those triggers first.'
    );
    expect(h.back).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Profile name')).toBeTruthy();

    unmount();
  });

  it('retryable: a generic delete failure with no usable message adds deleteFailed', async () => {
    h.query.data = testProfile();
    h.query.isPending = false;
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.deleteProfile.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();

    await pressDelete(renderer.root, h.alert);

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't delete profile");
    expect(h.back).not.toHaveBeenCalled();

    unmount();
  });
});
