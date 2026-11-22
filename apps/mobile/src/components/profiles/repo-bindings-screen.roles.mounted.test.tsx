// The server refuses an organization bind and unbind without the manage role,
// so the screen offers Add and per-row Unbind only to a caller it would accept
// them from, and a member reads the sentence that names who may act. A role
// still resolving claims neither.
import { createElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { StateAction } from '@/components/empty-state';
import { billingHrefFor } from '@/lib/trial-refusal';
import { emptyStateProps } from '@/components/profiles/repo-bindings-screen.add-form.test-helpers';
import {
  findAll,
  findOne,
  mountScreen,
  pressButton,
  pressPressable,
  rerenderScreen,
  testBinding,
  type TestBinding,
} from '@/components/profiles/repo-bindings-screen.test-helpers';
import { act, type ReactTestInstance } from '@/test/renderer';

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
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only' | 'plan-ended',
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
// The billing step reads the reader's membership list through this module, and
// that chain cannot load in the mounted project (see `vitest.setup.ts`), so the
// read answers with a role that may change the plan. The refusal's own route
// helper stays real, so the suite asserts the value it returns.
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: (role: string | undefined) => role === 'owner' || role === 'admin',
  useOrgBoundary: () => ({ organizationId: 'org-1', role: 'owner', org: undefined }),
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
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: ({ headerRight }: { headerRight?: ReactNode }) =>
    createElement('ScreenHeader', null, headerRight),
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: (props: { label: string; onPress: () => void }) =>
    createElement('StateAction', props),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  CreditCard: 'CreditCard',
  GitBranch: 'GitBranch',
  Lock: 'Lock',
  Search: 'Search',
  SearchX: 'SearchX',
  SlidersHorizontal: 'SlidersHorizontal',
  Trash2: 'Trash2',
  Unlock: 'Unlock',
  Plus: 'Plus',
}));

const GITHUB_REPO: TestRepoOption = { platform: 'github', fullName: 'acme/api', private: true };
const PROFILE: TestProfile = { id: 'profile-1', name: 'Backend debugging', isDefault: false };

const ADD_LABEL = 'Add default';
const ROLE_SENTENCE = i18n.t('profiles.organizationRoleRequired');
const EMPTY_TITLE = i18n.t('profiles.repoBindings.empty');
const PLAN_TITLE = i18n.t('profiles.repoBindings.planEndedTitle');
// A 'plan-ended' reader holds a role that can change the plan, so the state
// pairs the step-offering sentence with the billing action under it.
const PLAN_ENDED_SENTENCE = i18n.t('common.organizationTrialEndedBilling');
const BILLING_LABEL = i18n.t('organization.hub.manageBilling');
const BILLING_HREF = billingHrefFor('org-1');

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

    // The header's `+` is the screen's one create control.
    expect(pressableLabels(renderer.root)).toContain(ADD_LABEL);
    expect(buttonLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Unbind acme/api');
    expect(textContents(renderer.root)).not.toContain(ROLE_SENTENCE);

    pressButton(renderer.root, ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Select repository…');

    unmount();
  });

  it('resolving: withholds both controls, states no rule, and lists the binding', async () => {
    permissionState.permission = 'resolving';

    const { renderer, unmount } = await mountScreen('org-1');

    expect(pressableLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).not.toContain('Unbind acme/api');
    expect(textContents(renderer.root)).not.toContain(ROLE_SENTENCE);
    expect(textContents(renderer.root)).toContain('acme/api');
    expect(textContents(renderer.root)).toContain('Backend debugging');

    unmount();
  });

  it('read-only: withholds both controls and states the rule once', async () => {
    permissionState.permission = 'read-only';

    const { renderer, unmount } = await mountScreen('org-1');

    expect(pressableLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).not.toContain('Unbind acme/api');
    expect(textContents(renderer.root).filter(text => text === ROLE_SENTENCE)).toHaveLength(1);

    unmount();
  });

  it('read-only with no bindings: states the rule and does not name the withheld action', async () => {
    permissionState.permission = 'read-only';
    bindingsState.bindingsQuery.bindings = [];

    const { renderer, unmount } = await mountScreen('org-1');

    // A member's state carries the rule as its own description, so the screen
    // names the withheld action nowhere else. The title stays the generic empty
    // title: nothing is blocked about the list itself.
    const empty = findOne(renderer.root, 'EmptyState');
    expect(empty.props.title).toBe(EMPTY_TITLE);
    expect(empty.props.description).toBe(ROLE_SENTENCE);
    expect(textContents(renderer.root).filter(text => text === ROLE_SENTENCE)).toHaveLength(0);
    expect(pressableLabels(renderer.root)).not.toContain(ADD_LABEL);
    expect(
      pressableLabels(renderer.root).filter(label => label.startsWith('Unbind '))
    ).toHaveLength(0);

    unmount();
  });

  it('plan-ended with no bindings: names the missing plan and offers the billing step', async () => {
    permissionState.permission = 'plan-ended';
    bindingsState.bindingsQuery.bindings = [];

    const { renderer, unmount } = await mountScreen('org-1');

    // The empty list is the whole surface, so its title says the plan is what
    // is missing instead of reading as a list nobody configured, its description
    // offers the step, and the step itself is the state's action: without it the
    // blocking state would leave the reader with no way to end it.
    const empty = findOne(renderer.root, 'EmptyState');
    expect(empty.props.title).toBe(PLAN_TITLE);
    expect(empty.props.title).not.toBe(EMPTY_TITLE);
    expect(empty.props.description).toBe(PLAN_ENDED_SENTENCE);
    expect(pressableLabels(renderer.root)).not.toContain(ADD_LABEL);

    // `EmptyState` is a host stub here, so its action is read as the element the
    // screen passes: the primary state control, labelled with the billing row.
    const action = empty.props.action as ReactElement<{ label: string; onPress: () => void }>;
    expect(action.type).toBe(StateAction);
    expect(action.props.label).toBe(BILLING_LABEL);

    act(() => {
      action.props.onPress();
    });
    // The step names the organization whose plan ended, so the billing screen
    // cannot open a different account's plan.
    expect(routerPush).toHaveBeenCalledWith(BILLING_HREF);

    unmount();
  });

  it('allowed with no bindings: keeps the empty title and the Add control', async () => {
    permissionState.permission = 'allowed';
    bindingsState.bindingsQuery.bindings = [];

    const { renderer, unmount } = await mountScreen('org-1');

    // A live plan can still be written, so the surface stays the plain empty
    // list with its create control.
    const empty = findOne(renderer.root, 'EmptyState');
    expect(empty.props.title).toBe(EMPTY_TITLE);
    expect(empty.props.description).toBe(i18n.t('profiles.repoBindings.emptyDescription'));
    expect(pressableLabels(renderer.root)).toContain(ADD_LABEL);

    unmount();
  });

  it('personal scope: keeps Add and per-row Unbind', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(pressableLabels(renderer.root)).toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Unbind acme/api');

    unmount();
  });

  it('closes the add form with the permission that opened it', async () => {
    const { renderer, queryClient, unmount } = await mountScreen('org-1');

    pressButton(renderer.root, ADD_LABEL);
    expect(pressableLabels(renderer.root)).toContain('Select repository…');

    permissionState.permission = 'read-only';
    act(() => {
      rerenderScreen(renderer, queryClient, 'org-1');
    });

    expect(pressableLabels(renderer.root)).not.toContain('Select repository…');
    expect(textContents(renderer.root).filter(text => text === ROLE_SENTENCE)).toHaveLength(1);
    expect(pressableLabels(renderer.root)).not.toContain(ADD_LABEL);

    permissionState.permission = 'allowed';
    act(() => {
      rerenderScreen(renderer, queryClient, 'org-1');
    });

    // A permission that allows the flow again opens it from the start.
    expect(pressableLabels(renderer.root)).toContain(ADD_LABEL);
    expect(pressableLabels(renderer.root)).not.toContain('Select repository…');

    unmount();
  });

  it('closes the profile picker with the permission that opened it', async () => {
    h.profileList.orgProfiles = [];

    const { renderer, queryClient, unmount } = await mountScreen('org-1');
    pressButton(renderer.root, ADD_LABEL);
    pressPressable(renderer.root, 'Select profile');

    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(1);
    const empty = emptyStateProps(renderer.root, 'No profiles yet');
    expect(empty.action?.props.label).toBe('Create profile');

    permissionState.permission = 'read-only';
    act(() => {
      rerenderScreen(renderer, queryClient, 'org-1');
    });

    // The sheet is part of the same flow, so it closes with it.
    expect(findAll(renderer.root, 'SessionPageSheet')).toHaveLength(0);
    expect(buttonLabels(renderer.root)).not.toContain('Create profile');
    expect(pressableLabels(renderer.root)).not.toContain('Create profile');
    expect(textContents(renderer.root)).not.toContain('Create profile');
    expect(textContents(renderer.root).filter(text => text === ROLE_SENTENCE)).toHaveLength(1);

    unmount();
  });
});
