// The server refuses an organization bind and unbind without the manage role,
// so the screen offers Add and per-row Unbind only to a caller it would accept
// them from, and a member reads the sentence that names who may act. A role
// still resolving claims neither.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  findAll,
  mountScreen,
  pressButton,
  pressPressable,
  testBinding,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
import { type ReactTestInstance } from '@/test/renderer';

type TestRepoOption = { platform: 'github' | 'gitlab'; fullName: string; private: boolean };
type TestProfile = { id: string; name: string; isDefault: boolean };

const h = vi.hoisted(() => ({
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
const bindingsState = vi.hoisted(() => ({
  bindingsQuery: {
    bindings: [] as TestBinding[],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));
const mutationState = vi.hoisted(() => ({
  bind: { mutateAsync: vi.fn(), isPending: false },
  unbind: { mutateAsync: vi.fn(), isPending: false },
}));
const routerPush = vi.hoisted(() => vi.fn<(href: string) => void>());
const permissionState = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
}));

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => bindingsState.bindingsQuery,
  useRepoBindingMutations: () => mutationState,
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
const PROFILE: TestProfile = { id: 'profile-1', name: 'Backend debugging', isDefault: false };

const ADD_LABEL = 'Add default';
const ROLE_SENTENCE = i18n.t('profiles.organizationRoleRequired');

function buttonLabels(root: ReactTestInstance): string[] {
  return findAll(root, 'Button')
    .map(node => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

function pressableLabels(root: ReactTestInstance): string[] {
  return findAll(root, 'Pressable')
    .map(node => node.props.accessibilityLabel)
    .filter((label): label is string => typeof label === 'string');
}

function textContents(root: ReactTestInstance): unknown[] {
  return findAll(root, 'Text').map(node => node.props.children);
}

describe('RepoBindingsScreen roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(bindingsState.bindingsQuery, {
      bindings: [testBinding()],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
    Object.assign(mutationState.bind, { isPending: false });
    Object.assign(mutationState.unbind, { isPending: false });
    Object.assign(h.repoOptions, {
      repositories: [GITHUB_REPO],
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
    Object.assign(h.profileList, {
      orgProfiles: [PROFILE],
      personalProfiles: [PROFILE],
      effectiveDefaultId: null,
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
    permissionState.permission = 'allowed';
    routerPush.mockReset();
  });

  it('allowed: offers Add and per-row Unbind, and Add opens the form', async () => {
    const { renderer, unmount } = await mountScreen('org-1');

    expect(buttonLabels(renderer.root)).toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Unbind acme/api');
    expect(textContents(renderer.root)).not.toContain(ROLE_SENTENCE);

    pressButton(renderer.root, ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Select repository…');

    unmount();
  });

  it('resolving: withholds both controls, states no rule, and lists the binding', async () => {
    permissionState.permission = 'resolving';

    const { renderer, unmount } = await mountScreen('org-1');

    expect(buttonLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).not.toContain('Unbind acme/api');
    expect(textContents(renderer.root)).not.toContain(ROLE_SENTENCE);
    expect(textContents(renderer.root)).toContain('acme/api');
    expect(textContents(renderer.root)).toContain('Backend debugging');

    unmount();
  });

  it('read-only: withholds both controls and states the rule once', async () => {
    permissionState.permission = 'read-only';

    const { renderer, unmount } = await mountScreen('org-1');

    expect(buttonLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).not.toContain('Unbind acme/api');
    expect(textContents(renderer.root).filter(text => text === ROLE_SENTENCE)).toHaveLength(1);

    unmount();
  });

  it('personal scope: keeps Add and per-row Unbind', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(buttonLabels(renderer.root)).toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Unbind acme/api');

    unmount();
  });
});
