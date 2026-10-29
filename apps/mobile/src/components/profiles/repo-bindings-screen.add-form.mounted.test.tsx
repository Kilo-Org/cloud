import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  mountScreen,
  pressButton,
  pressPressable,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
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

/** The accessible names of every pressable the screen currently renders. */
function pressableLabels(root: ReactTestInstance): string[] {
  return findAll(root, 'Pressable')
    .map(node => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

/** The empty state with this title — the screen and the picker sheet each render one. */
function emptyStateByTitle(root: ReactTestInstance, title: string): ReactTestInstance {
  const empty = findAll(root, 'EmptyState').find(node => node.props.title === title);
  if (!empty) {
    throw new Error(`empty state ${title} was not rendered`);
  }
  return empty;
}

/** The props `EmptyState` receives; it is a host node here, so its action stays a prop. */
type EmptyStateNode = {
  props: {
    description?: string;
    action?: { props: { onPress: () => void; children: { props: { children: string } } } };
  };
};

function emptyStateProps(root: ReactTestInstance, title: string): EmptyStateNode['props'] {
  // The mocked surface is a host node, so its props are untyped at the boundary.
  return emptyStateByTitle(root, title).props as EmptyStateNode['props'];
}

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
    pressPressable(renderer.root, 'acme/api');

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

  it('empty picker: create opens the profile form for this context and returns to it', async () => {
    Object.assign(h.profileList, { personalProfiles: [] });

    const { renderer, unmount } = await mountScreen();
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select profile');

    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    expect(empty.description).toBe(
      'Create a profile to reuse environment variables, setup commands, and skills across sessions.'
    );
    expect(empty.action?.props.children.props.children).toBe('Create profile');
    act(() => {
      empty.action?.props.onPress();
    });

    // The sheet dismisses before the push, so the form cannot render behind it.
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);
    expect(routerPush).toHaveBeenCalledWith(
      '/(app)/profile-management/new?owner=personal&returnTo=back'
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

  it('empty picker: a read-only organization context offers no create action', async () => {
    permissionState.permission = 'read-only';
    Object.assign(h.profileList, { orgProfiles: [], personalProfiles: [PROFILE] });

    const { renderer, unmount } = await mountScreen('org-1');
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select profile');

    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    expect(empty.description).toBe(
      'An organization owner or admin can create an organization profile.'
    );
    expect(empty.action).toBeUndefined();

    unmount();
  });

  it('empty picker: an unresolved role does not yet read as read-only', async () => {
    permissionState.permission = 'resolving';
    Object.assign(h.profileList, { orgProfiles: [], personalProfiles: [PROFILE] });

    const { renderer, unmount } = await mountScreen('org-1');
    pressButton(renderer.root, 'Add default');
    pressPressable(renderer.root, 'Select profile');

    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    expect(empty.description).toBe(
      'Create an organization profile to reuse environment variables, setup commands, and skills across sessions.'
    );
    // The action still waits for the role: a member must never be offered a
    // create the server rejects.
    expect(empty.action).toBeUndefined();

    unmount();
  });
});
