import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  changeSearch,
  findAll,
  findButton,
  findOne,
  mountScreen,
  pressButton,
  pressPressable,
  rerenderScreen,
  testBinding,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

type TestRepoOption = { platform: 'github' | 'gitlab'; fullName: string; private: boolean };
type TestProfile = { id: string; name: string; isDefault: boolean };

const h = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  bindingsQuery: {
    bindings: [] as TestBinding[],
    isLoading: true,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    bind: { mutateAsync: vi.fn(), isPending: false },
    unbind: { mutateAsync: vi.fn(), isPending: false },
  },
  repoOptions: {
    repositories: [] as TestRepoOption[],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  profileList: {
    orgProfiles: [] as TestProfile[],
    personalProfiles: [] as TestProfile[],
    effectiveDefaultId: null as string | null,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => h.bindingsQuery,
  useRepoBindingMutations: () => h.mutations,
  useRepoOptions: () => h.repoOptions,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => h.profileList,
}));
vi.mock('sonner-native', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  I18nManager: { isRTL: false },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#000000',
    destructive: '#FF0000',
    primary: '#0000FF',
  }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  GitBranch: 'GitBranch',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  Trash2: 'Trash2',
  Unlock: 'Unlock',
}));

const GITHUB_REPO: TestRepoOption = { platform: 'github', fullName: 'acme/api', private: true };
const GITLAB_REPO: TestRepoOption = { platform: 'gitlab', fullName: 'acme/infra', private: false };
const PROFILE: TestProfile = { id: 'profile-1', name: 'Backend debugging', isDefault: false };

describe('RepoBindingsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.bindingsQuery, {
      bindings: [],
      isLoading: true,
      isError: false,
      isRefetching: false,
    });
    Object.assign(h.mutations.bind, { isPending: false });
    Object.assign(h.mutations.unbind, { isPending: false });
    Object.assign(h.repoOptions, {
      repositories: [GITHUB_REPO, GITLAB_REPO],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
    Object.assign(h.profileList, {
      orgProfiles: [],
      personalProfiles: [PROFILE],
      effectiveDefaultId: null,
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
  });

  it('loading: renders skeletons and no binding rows', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(
      findAll(renderer.root, 'Pressable').some(n => n.props.accessibilityLabel === 'Unbind')
    ).toBe(false);

    unmount();
  });

  it('retryable: a bindings query failure shows QueryError and Retry refetches', async () => {
    Object.assign(h.bindingsQuery, { isError: true, isLoading: false });

    const { renderer, unmount } = await mountScreen();

    const queryError = findOne(renderer.root, 'QueryError');
    expect(queryError.props.title).toBe("Couldn't load profiles");
    act(() => {
      (queryError.props as { onRetry: () => void }).onRetry();
    });
    expect(h.bindingsQuery.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('empty: shows No defaults configured with the explanation', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, unmount } = await mountScreen();

    const empty = findOne(renderer.root, 'EmptyState');
    expect(empty.props.title).toBe('No defaults configured');
    expect(empty.props.description).toContain('automatically apply a profile');

    unmount();
  });

  it('happy: lists a binding with its repo, badge and profile, and unbinds it', async () => {
    Object.assign(h.bindingsQuery, { bindings: [testBinding()], isLoading: false });
    h.mutations.unbind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();

    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain('acme/api');
    expect(texts).toContain('Backend debugging');
    expect(texts).toContain('GH');

    pressPressable(renderer.root, 'Unbind');
    await waitFor(() => h.mutations.unbind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.unbind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      repoFullName: 'acme/api',
      platform: 'github',
    });

    unmount();
  });

  it('non-retryable: Add stays disabled until a repo and a profile are chosen', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');

    expect(findButton(renderer.root, 'Add default').props.disabled).toBe(true);

    pressPressable(renderer.root, 'Select repository…');
    pressPressable(renderer.root, 'acme/api');
    expect(findButton(renderer.root, 'Add default').props.disabled).toBe(true);

    pressPressable(renderer.root, 'Select profile');
    pressPressable(renderer.root, 'Backend debugging');
    expect(findButton(renderer.root, 'Add default').props.disabled).toBe(false);

    unmount();
  });

  it('presents both Add pickers through the sheet surface', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    pressPressable(renderer.root, 'Select repository…');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    pressPressable(renderer.root, 'acme/api');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);

    pressPressable(renderer.root, 'Select profile');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);

    unmount();
  });

  it('happy: picking a repo and a profile binds through bindToRepo', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    h.mutations.bind.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select repository…');
    pressPressable(renderer.root, 'acme/infra');
    pressPressable(renderer.root, 'Select profile');
    pressPressable(renderer.root, 'Backend debugging');
    pressButton(renderer.root, 'Add default');

    await waitFor(() => h.mutations.bind.mutateAsync.mock.calls.length > 0);
    expect(h.mutations.bind.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      repoFullName: 'acme/infra',
      platform: 'gitlab',
    });

    unmount();
  });

  it('retryable: a bind failure with no usable message toasts the fallback', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });
    const error = new Error('placeholder');
    error.message = '';
    h.mutations.bind.mutateAsync.mockRejectedValue(error);

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select repository…');
    pressPressable(renderer.root, 'acme/api');
    pressPressable(renderer.root, 'Select profile');
    pressPressable(renderer.root, 'Backend debugging');
    pressButton(renderer.root, 'Add default');

    await waitFor(() => h.error.mock.calls.length > 0);
    expect(h.error).toHaveBeenCalledWith("Couldn't set default profile");

    unmount();
  });

  it('filters the repo picker as the search text changes', async () => {
    Object.assign(h.bindingsQuery, { isLoading: false });

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select repository…');

    expect(
      findAll(renderer.root, 'Pressable').some(n => n.props.accessibilityLabel === 'acme/api')
    ).toBe(true);
    await changeSearch(renderer.root, 'infra');
    await waitFor(
      () =>
        !findAll(renderer.root, 'Pressable').some(n => n.props.accessibilityLabel === 'acme/api')
    );
    expect(
      findAll(renderer.root, 'Pressable').some(n => n.props.accessibilityLabel === 'acme/api')
    ).toBe(false);
    expect(
      findAll(renderer.root, 'Pressable').some(n => n.props.accessibilityLabel === 'acme/infra')
    ).toBe(true);

    unmount();
  });

  it('keeps the rows while a refetch is in flight', async () => {
    Object.assign(h.bindingsQuery, { bindings: [testBinding()], isLoading: false });

    const { renderer, queryClient, unmount } = await mountScreen();

    h.bindingsQuery.isRefetching = true;
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain('acme/api');

    unmount();
  });
});
