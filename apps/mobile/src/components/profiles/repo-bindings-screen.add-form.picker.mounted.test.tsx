// The profile picker the Add form opens: its empty state names the profile the
// context lists, and its create action depends on the manage role. The form's
// own field and Add-button contract lives in
// `repo-bindings-screen.add-form.mounted.test.tsx`.

import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import {
  findAll,
  mountScreen,
  pressButton,
  pressPressable,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
import { emptyStateProps } from '@/components/profiles/repo-bindings-screen.add-form.test-helpers';
import { act } from '@/test/renderer';

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

vi.mock('@/lib/hooks/use-repo-bindings', () => ({
  useRepoBindings: () => h.bindingsQuery,
  useRepoBindingMutations: () => h.mutations,
  useRepoOptions: () => h.repoOptions,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileList: () => h.profileList,
}));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => 'allowed',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => undefined },
  Platform: { OS: 'ios' },
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
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: ({ headerRight }: { headerRight?: ReactNode }) =>
    createElement('ScreenHeader', null, headerRight),
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { action?: ReactNode }) => createElement('EmptyState', props, props.action),
  StateAction: (props: { label: string; onPress: () => void }) =>
    createElement('StateAction', props),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Plus: 'Plus',
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

const PROFILE: TestProfile = { id: 'profile-1', name: 'Backend debugging', isDefault: false };

describe('RepoBindingsScreen add form profile picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.bindingsQuery, { bindings: [], isLoading: false, isError: false });
    Object.assign(h.profileList, {
      orgProfiles: [],
      personalProfiles: [PROFILE],
      effectiveDefaultId: null,
      isLoading: false,
      isError: false,
      isRefetching: false,
    });
    routerPush.mockReset();
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
    expect(empty.action?.props.label).toBe('Create profile');
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
