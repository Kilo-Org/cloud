import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findAll,
  findButton,
  mountScreen,
  pressButton,
  pressPressable,
  rerenderScreen,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
import { pressableLabels } from '@/components/profiles/repo-bindings-screen.add-form.test-helpers';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';

type TestRepoOption = { platform: 'github' | 'gitlab'; fullName: string; private: boolean };
type TestProfile = { id: string; name: string; isDefault: boolean };

const h = vi.hoisted(() => ({
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
const routerPush = vi.hoisted(() => vi.fn<(href: string) => void>());
const permissionState = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
}));

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => h.bindingsQuery,
  useRepoBindingMutations: () => h.mutations,
  useRepoOptions: () => h.repoOptions,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => h.profileList,
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => permissionState.permission,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => undefined },
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
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
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
  SlidersHorizontal: 'SlidersHorizontal',
  Trash2: 'Trash2',
  Unlock: 'Unlock',
}));

const GITHUB_REPO: TestRepoOption = { platform: 'github', fullName: 'acme/api', private: true };
const GITLAB_REPO: TestRepoOption = { platform: 'gitlab', fullName: 'acme/infra', private: false };
const PROFILE: TestProfile = { id: 'profile-1', name: 'Backend debugging', isDefault: false };

// The picker row for a private repository carries its privacy in the
// accessible name, so it is matched by that name, never the bare full name.
const PRIVATE_REPO_LABEL = 'acme/api, private repository';

describe('RepoBindingsScreen add form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.bindingsQuery, {
      bindings: [],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
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
    permissionState.permission = 'allowed';
    routerPush.mockReset();
  });

  it('a11y: each Add-form control names the value it holds once one is chosen', async () => {
    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select repository…');
    pressPressable(renderer.root, PRIVATE_REPO_LABEL);

    expect(pressableLabels(renderer.root)).toContain('Repository: acme/api');
    expect(pressableLabels(renderer.root)).not.toContain('Select repository…');
    expect(pressableLabels(renderer.root)).toContain('Select profile');

    // The renamed control still opens its own picker.
    pressPressable(renderer.root, 'Repository: acme/api');
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);
    pressPressable(renderer.root, 'acme/infra');

    pressPressable(renderer.root, 'Select profile');
    pressPressable(renderer.root, 'Backend debugging');

    expect(pressableLabels(renderer.root)).toContain('Profile: Backend debugging');
    expect(pressableLabels(renderer.root)).not.toContain('Select profile');

    unmount();
  });

  it('disables Add and names the reason when a refetch drops the chosen profile', async () => {
    /* The list has no stale window and refetches when the app comes back, so a
       profile deleted from another device leaves the form holding an id this
       device no longer lists. Add must not submit it, and the reason belongs in
       the line the field already reserves, so the buttons under it stay put. */
    const unavailable = i18n.t('profiles.repoBindings.profileUnavailable');
    const hintCopies = (root: ReactTestInstance): number =>
      findAll(root, 'Text').filter(node => node.props.children === unavailable).length;

    const { renderer, queryClient, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select repository…');
    pressPressable(renderer.root, PRIVATE_REPO_LABEL);
    pressPressable(renderer.root, 'Select profile');
    pressPressable(renderer.root, 'Backend debugging');

    expect(findButton(renderer.root, 'Add default').props.disabled).toBe(false);
    // Reserved height with nothing to say yet: the hint cannot push Add down.
    expect(hintCopies(renderer.root)).toBe(1);

    Object.assign(h.profileList, { personalProfiles: [] });
    act(() => {
      rerenderScreen(renderer, queryClient);
    });

    expect(findButton(renderer.root, 'Add default').props.disabled).toBe(true);
    expect(pressableLabels(renderer.root)).toContain('Select profile');
    // The reservation stays, and the visible line draws over it.
    expect(hintCopies(renderer.root)).toBe(2);
    expect(h.mutations.bind.mutateAsync).not.toHaveBeenCalled();

    unmount();
  });

  it('empty picker: a screen opened from the composer hands the opener to the create form', async () => {
    Object.assign(h.profileList, { orgProfiles: [], personalProfiles: [PROFILE] });

    const { renderer, unmount } = await mountScreen('org-1', 'composer');
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select profile');

    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    act(() => {
      empty.action?.props.onPress();
    });
    // The form carries the marker, so Back returns to this screen with its
    // picker state instead of a profiles list this screen never had.
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/profile-management/new?owner=organization&returnTo=back&organizationId=org-1&openedFrom=composer'
    );

    unmount();
  });

  it('empty picker: an organization context names an organization profile and creates one', async () => {
    Object.assign(h.profileList, { orgProfiles: [], personalProfiles: [PROFILE] });

    const { renderer, unmount } = await mountScreen('org-1');
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select profile');

    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    expect(empty.description).toBe(
      'Create an organization profile to reuse environment variables, setup commands, and skills across sessions.'
    );
    act(() => {
      empty.action?.props.onPress();
    });
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/profile-management/new?owner=organization&returnTo=back&organizationId=org-1'
    );

    unmount();
  });
});
