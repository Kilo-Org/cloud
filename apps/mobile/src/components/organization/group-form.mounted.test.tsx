/* eslint-disable max-lines -- the form's create swap, both leave exits and the delete path share one mock harness. */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupForm } from '@/components/organization/group-form';
import { type OrgGroup } from '@/lib/hooks/use-org-groups-queries';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { insideLeaveSettle, resetLeaveSettle } from '@/lib/navigation/leave-settle';

const mutations = vi.hoisted(() => ({
  create: { isPending: false, mutate: vi.fn() },
  updateDetails: { isPending: false, mutate: vi.fn() },
  remove: { isPending: false, mutate: vi.fn() },
}));

const members = vi.hoisted(() => ({
  data: undefined as
    | { members: { id: string; name: string; email: string; status: string }[] }
    | undefined,
  isPending: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));

// The navigation state the form reads for its exit decision, changeable per test.
const nav = vi.hoisted(() => ({
  routes: [] as { key: string; name: string }[],
  index: 0,
  isFocused: true,
}));

const router = vi.hoisted(() => ({
  dismissTo: vi.fn<(href: unknown) => void>(),
  canGoBack: vi.fn(() => true),
}));

const popOnce = vi.hoisted(() => vi.fn());
const stackSafeReplace = vi.hoisted(() => ({ replace: vi.fn<(href: unknown) => void>() }));
const guard = vi.hoisted(() => ({
  leave: [] as (() => void)[],
  handleDirtyChange: vi.fn(),
}));
const confirmMock = vi.hoisted(() => vi.fn());
// The picker's toggles, handed to the suite through the double's props.
const picker = vi.hoisted(() => ({
  onToggleMember: undefined as ((id: string, on: boolean) => void) | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: router.dismissTo, canGoBack: router.canGoBack }),
  useNavigation: () => ({
    getState: () => ({ index: nav.index, routes: nav.routes }),
    isFocused: () => nav.isFocused,
  }),
}));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => popOnce }));
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => stackSafeReplace,
}));
// The guard double hands the leave through on demand: the suite pins where the
// form navigates after a save, not the guard's own dialog, which the profile
// overview guard suite covers.
vi.mock('@/components/profiles/use-metadata-leave-guard', () => ({
  useMetadataLeaveGuard: () => ({
    handleDirtyChange: guard.handleDirtyChange,
    leaveWithoutAsking: (leave: () => void) => {
      guard.leave.push(leave);
    },
    dialog: null,
  }),
}));
// The queries module pulls `@kilocode/trpc/mobile`, whose output the Node
// transform cannot parse, so the whole module is a double; the suite reads the
// group only through the props the form hands on.
vi.mock('@/lib/hooks/use-org-groups-queries', () => ({
  useOrgGroupMutations: () => mutations,
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgWithMembers: () => members,
  isActiveOrgMember: (member: { status: string }) => member.status === 'active',
}));
vi.mock('@/lib/hooks/use-form-field-scroll', () => ({
  useFormFieldScroll: () => ({
    scrollRef: { current: null },
    fieldLayout: () => () => undefined,
    scrollToField: vi.fn(),
  }),
}));
// The picker double records the selection callbacks the form wires, so the suite
// drives a member toggle without mounting ChoiceRow's haptics and icons.
vi.mock('@/components/organization/group-member-picker', () => ({
  GroupMemberPicker: (props: Record<string, unknown>) => {
    picker.onToggleMember = props.onToggleMember as (id: string, on: boolean) => void;
    return createElement('GroupMemberPicker', props);
  },
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, dialog: null }),
}));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  useColorScheme: () => 'light',
}));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ Search: 'Search' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
// The icon barrels reach `react-native-svg`, whose Flow-derived ESM output the
// Node transform cannot parse; the suite reads icons through host elements.
vi.mock('react-native-svg', () => new Proxy({}, { get: () => 'Svg' }));
// `@rn-primitives/slot@1.5.2` ships untranspiled JSX in its dist, like its
// dialog sibling the setup file stubs; the suite reads trees through hosts.
vi.mock('@rn-primitives/slot', () => ({ Root: 'Root', Pressable: 'Pressable' }));
// The real Save control loads its spinner policy through the Expo runtime
// (battery level and reanimated), which this Node project cannot import.
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));

/* `node.type` widens to `ElementType` across a tree that holds both component
 * and host nodes, so a literal comparison reads as an impossible one; the
 * unknown annotation widens the comparison instead of fighting the check. */
const PRESSABLE: unknown = 'Pressable';

const GROUPS_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/groups';
const GROUP_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/group-form';

const storedGroupBase: OrgGroup = {
  id: 'group-1',
  organization_id: 'org-1',
  name: 'Workshop',
  description: 'The workshop group',
  memberIds: [],
  policies: [],
  created_at: '2026-01-01T00:00:00.000Z',
  created_by_kilo_user_id: null,
  updated_at: '2026-01-01T00:00:00.000Z',
};

function storedGroup(overrides: Partial<OrgGroup> = {}): OrgGroup {
  return { ...storedGroupBase, ...overrides };
}

async function mountForm(group: OrgGroup | undefined) {
  const mounted = await renderWithProviders(
    createElement(GroupForm, { organizationId: 'org-1', group })
  );
  return {
    ...mounted,
    unmountOnce: () => {
      mounted.unmount();
    },
  };
}

type WidgetProps = Record<string, unknown>;

function pressHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a press handler');
  }
  return value as () => void;
}

function textHandler(value: unknown): (text: string) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a change handler');
  }
  return value as (text: string) => void;
}

async function pressSave(root: ReactTestInstance): Promise<void> {
  const save = root
    .findAll(node => node.type === PRESSABLE && (node.props as WidgetProps).role === 'button')
    .at(0);
  if (save === undefined) {
    throw new Error('the save button was not rendered');
  }
  await act(async () => {
    pressHandler((save.props as WidgetProps).onPress)();
    await Promise.resolve();
  });
}

function changeName(root: ReactTestInstance, value: string): void {
  const field = root
    .findAll(node => (node.props as WidgetProps).label === i18n.t('organization.groups.nameLabel'))
    .at(0);
  if (field === undefined) {
    throw new Error('the name field was not rendered');
  }
  act(() => {
    textHandler((field.props as WidgetProps).onChangeText)(value);
  });
}

function theLeave(): () => void {
  const leave = guard.leave.at(-1);
  if (leave === undefined) {
    throw new Error('the save did not hand the guard a leave');
  }
  return leave;
}

/** Run the mutation's success callback, the way a landed save does. */
function settleSave(
  mutation: { mutate: { mock: { calls: unknown[][] } } },
  result?: unknown
): void {
  const call = mutation.mutate.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('the save mutation never ran');
  }
  const options = call[1] as { onSuccess: (result: unknown) => void } | undefined;
  if (options === undefined || typeof options.onSuccess !== 'function') {
    throw new Error('the save mutation carried no success callback');
  }
  act(() => {
    options.onSuccess(result);
  });
}

function selectMember(id: string): void {
  const toggle = picker.onToggleMember;
  if (toggle === undefined) {
    throw new Error('the member picker did not hand the suite a toggle');
  }
  act(() => {
    toggle(id, true);
  });
}

/** Press the destructive action and confirm the dialog it raises. */
async function pressDelete(root: ReactTestInstance): Promise<void> {
  const deleteButton = root
    .findAll(node => node.type === PRESSABLE && (node.props as WidgetProps).role === 'button')
    .at(1);
  if (deleteButton === undefined) {
    throw new Error('the delete button was not rendered');
  }
  await act(async () => {
    pressHandler((deleteButton.props as WidgetProps).onPress)();
    await Promise.resolve();
  });
  const request = confirmMock.mock.calls.at(-1)?.[0];
  if (
    request === undefined ||
    typeof request !== 'object' ||
    typeof (request as { onConfirm?: unknown }).onConfirm !== 'function'
  ) {
    throw new Error('the removal confirmation was not raised');
  }
  const onConfirm = (request as { onConfirm: () => void }).onConfirm;
  act(() => {
    onConfirm();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** The stack of a Groups list that pushed the form, with the form on top. */
function listThenForm(...formRoutes: { key: string; name: string }[]): void {
  nav.routes = [
    { key: 'tabs-1', name: '(tabs)' },
    { key: 'profile-1', name: '(3_profile)' },
    { key: 'groups-1', name: 'groups' },
    ...formRoutes,
  ];
  nav.index = nav.routes.length - 1;
}

beforeEach(() => {
  mutations.create.mutate.mockReset();
  mutations.updateDetails.mutate.mockReset();
  mutations.remove.mutate.mockReset();
  confirmMock.mockReset();
  guard.leave = [];
  resetLeaveSettle();
  members.data = undefined;
  members.isPending = false;
  members.isError = false;
  router.canGoBack.mockReturnValue(true);
  nav.isFocused = true;
  listThenForm({ key: 'form-1', name: 'group-form' });
});

describe('GroupForm create path', () => {
  it('swaps to the saved group’s form through the stack-safe replace', async () => {
    const { renderer, unmountOnce } = await mountForm(undefined);

    changeName(renderer.root, 'Workshop');
    await pressSave(renderer.root);

    expect(mutations.create.mutate).toHaveBeenCalledOnce();
    expect(mutations.create.mutate).toHaveBeenCalledWith(
      { name: 'Workshop', description: null },
      expect.anything()
    );
    act(() => {
      settleSave(mutations.create, { result: { id: 'group-9' } });
    });
    theLeave()();

    // The created group opens its own form for the member step; the retired
    // create form is dropped once that push settles (KILO-APP-25).
    expect(stackSafeReplace.replace).toHaveBeenCalledOnce();
    expect(stackSafeReplace.replace).toHaveBeenCalledWith({
      pathname: GROUP_FORM_PATH,
      params: { groupId: 'group-9' },
    });
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(popOnce).not.toHaveBeenCalled();

    unmountOnce();
  });
});

describe('GroupForm leave after a members save', () => {
  it('returns to the Groups list over the stale create form beneath', async () => {
    // The stack the first save left when the retire of the create form was
    // dropped: the edit form sits above a prefilled New-group form.
    listThenForm({ key: 'form-new', name: 'group-form' }, { key: 'form-edit', name: 'group-form' });
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    members.data = {
      members: [{ id: 'user-1', name: 'Amira', email: 'amira@example.com', status: 'active' }],
    };
    await act(async () => {
      await Promise.resolve();
    });

    selectMember('user-1');
    await pressSave(renderer.root);

    expect(mutations.updateDetails.mutate).toHaveBeenCalledOnce();
    expect(mutations.updateDetails.mutate).toHaveBeenCalledWith(
      {
        groupId: 'group-1',
        name: 'Workshop',
        description: 'The workshop group',
        userIds: ['user-1'],
      },
      expect.anything()
    );
    settleSave(mutations.updateDetails);
    theLeave()();

    // The dismissal arms the same one-Back window a self-pop arms, naming the
    // list route the pop-to reveals: a Back during the animation is spent, not
    // applied to the list.
    expect(insideLeaveSettle()).toBe(true);

    // The pop-to truncates the stale create form too: the reader lands on the
    // list, never on a prefilled New-group form.
    expect(router.dismissTo).toHaveBeenCalledOnce();
    expect(router.dismissTo).toHaveBeenCalledWith(GROUPS_LIST_PATH);
    expect(popOnce).not.toHaveBeenCalled();
    expect(stackSafeReplace.replace).not.toHaveBeenCalled();

    unmountOnce();
  });

  it('stays put when the save settles after the reader left for another tab', async () => {
    // The profile tab keeps its stack mounted but blurred while the reader
    // reads another tab, so a save that lands then must not dismiss a route
    // that is not the app's focused scene.
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    members.data = {
      members: [{ id: 'user-1', name: 'Amira', email: 'amira@example.com', status: 'active' }],
    };
    await act(async () => {
      await Promise.resolve();
    });

    selectMember('user-1');
    await pressSave(renderer.root);
    nav.isFocused = false;
    settleSave(mutations.updateDetails);
    theLeave()();

    // The leave is inert: nothing navigates, and no one-Back window is armed
    // for the blurred tab, so the reader's Back still closes the screen they
    // are reading.
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(popOnce).not.toHaveBeenCalled();
    expect(stackSafeReplace.replace).not.toHaveBeenCalled();
    expect(insideLeaveSettle()).toBe(false);

    nav.isFocused = true;
    unmountOnce();
  });

  it('returns to the Groups list on a clean stack', async () => {
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    members.data = {
      members: [{ id: 'user-1', name: 'Amira', email: 'amira@example.com', status: 'active' }],
    };
    await act(async () => {
      await Promise.resolve();
    });

    selectMember('user-1');
    await pressSave(renderer.root);
    settleSave(mutations.updateDetails);
    theLeave()();

    expect(router.dismissTo).toHaveBeenCalledWith(GROUPS_LIST_PATH);
    expect(popOnce).not.toHaveBeenCalled();

    unmountOnce();
  });

  it('pops once when no list is beneath and the stack has a route to unwind', async () => {
    nav.routes = [
      { key: 'tabs-1', name: '(tabs)' },
      { key: 'profile-1', name: '(3_profile)' },
      { key: 'form-1', name: 'group-form' },
    ];
    nav.index = 2;
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    members.data = {
      members: [{ id: 'user-1', name: 'Amira', email: 'amira@example.com', status: 'active' }],
    };
    await act(async () => {
      await Promise.resolve();
    });

    selectMember('user-1');
    await pressSave(renderer.root);
    settleSave(mutations.updateDetails);
    theLeave()();

    expect(popOnce).toHaveBeenCalledOnce();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(stackSafeReplace.replace).not.toHaveBeenCalled();

    unmountOnce();
  });

  it('replaces itself with the list when the form is the only route of its stack', async () => {
    nav.routes = [{ key: 'form-1', name: 'group-form' }];
    nav.index = 0;
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    members.data = {
      members: [{ id: 'user-1', name: 'Amira', email: 'amira@example.com', status: 'active' }],
    };
    await act(async () => {
      await Promise.resolve();
    });

    selectMember('user-1');
    await pressSave(renderer.root);
    settleSave(mutations.updateDetails);
    theLeave()();

    // Pop-to with no matching route rewrites the stack in one commit — the
    // Android Fabric crash shape — so the cold entry uses the stack-safe
    // replace instead.
    expect(stackSafeReplace.replace).toHaveBeenCalledOnce();
    expect(stackSafeReplace.replace).toHaveBeenCalledWith(GROUPS_LIST_PATH);
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(popOnce).not.toHaveBeenCalled();

    unmountOnce();
  });
});

describe('GroupForm delete path', () => {
  it('returns to the Groups list after the removal lands', async () => {
    listThenForm({ key: 'form-new', name: 'group-form' }, { key: 'form-edit', name: 'group-form' });
    const { renderer, unmountOnce } = await mountForm(storedGroup());
    await pressDelete(renderer.root);

    expect(mutations.remove.mutate).toHaveBeenCalledOnce();
    settleSave(mutations.remove);
    theLeave()();

    expect(router.dismissTo).toHaveBeenCalledWith(GROUPS_LIST_PATH);
    expect(popOnce).not.toHaveBeenCalled();

    unmountOnce();
  });
});
