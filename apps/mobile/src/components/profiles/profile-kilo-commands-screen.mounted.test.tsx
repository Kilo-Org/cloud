import { type Href } from 'expo-router';
/* eslint-disable max-lines -- one mounted case per slash-command screen state: list, add, duplicate, conflict, failure, and save */
import { createElement, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { MAX_PROFILE_KILO_COMMANDS } from '@/lib/agent-profile-forms';
import { isolateLtrBidiText } from '@/lib/bidi';
import { resetFormDraftsForTests } from '@/lib/form-draft';

/** The default destination the Profile tab's routes pass: their own Profiles list. */
const PROFILES_LIST_HREF = '/(app)/(tabs)/(3_profile)/profiles' as Href;

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  scrollTo: vi.fn(),
  query: {
    data: undefined as unknown,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    updateKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    deleteKiloCommand: { mutateAsync: vi.fn(), isPending: false },
    setKiloCommandEnabled: { mutate: vi.fn(), isPending: false },
    reorderKiloCommands: { mutate: vi.fn(), isPending: false },
  },
}));

const permissionState = vi.hoisted(() => ({
  permission: 'allowed' as 'resolving' | 'allowed' | 'read-only',
}));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => permissionState.permission,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileKiloCommands: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' } }),
  useAgentProfileSectionMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    View: 'View',
    Pressable: 'Pressable',
    Switch: 'Switch',
    ScrollView: forwardRef(function ScrollViewStub(
      props: { children?: ReactNode },
      ref: Ref<{ scrollTo: typeof h.scrollTo }>
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: h.scrollTo }));
      return createMockElement('ScrollView', props, props.children);
    }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const THEME = vi.hoisted(() => ({
  foreground: '#0E0E10',
  mutedForeground: '#000000',
  destructive: '#FF0000',
  primary: '#4F5A10',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => THEME,
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: 'SessionPageSheet',
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScrollView' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', async () => {
  // vi.mock factories are hoisted above the module's imports, so the React
  // helpers must be loaded inside the factory.
  const { createElement: createMockElement } = await import('react');
  return {
    // The real state renders its `action` below the title, so the manage slot's
    // sentence or the manager's CTA reaches the tree the way the screen hands it over.
    EmptyState: (props: { action?: ReactNode }) =>
      createMockElement('EmptyState', props, props.action),
  };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Pencil: 'Pencil',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));

type TestCommand = {
  id: string;
  name: string;
  description: string | null;
  template: string;
  subtask: boolean;
  agent: string | null;
  model: string | null;
  enabled: boolean;
};

function testCommand(overrides: Partial<TestCommand> = {}): TestCommand {
  return {
    id: 'cmd-1',
    name: 'release-notes',
    description: 'Draft the release notes',
    template: 'Summarize $ARGUMENTS',
    subtask: false,
    agent: 'reviewer',
    model: null,
    enabled: true,
    ...overrides,
  };
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findOne(root: ReactTestInstance, type: string): ReactTestInstance {
  const node = findAll(root, type)[0];
  if (!node) {
    throw new Error(`${type} was not rendered`);
  }
  return node;
}

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function changeText(root: ReactTestInstance, label: string, value: string): void {
  const handler: unknown = findField(root, label).props.onChangeText;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no change handler`);
  }
  act(() => {
    (handler as (text: string) => void)(value);
  });
}

function pressPressable(root: ReactTestInstance, label: string): void {
  const node = findAll(root, 'Pressable').find(item => item.props.accessibilityLabel === label);
  if (!node) {
    throw new Error(`pressable ${label} was not rendered`);
  }
  const press = node.props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError(`pressable ${label} has no press handler`);
  }
  act(() => {
    (press as () => void)();
  });
}

/** Press the list's Add slash command button, the only Button a populated list renders. */
function pressAddButton(root: ReactTestInstance): void {
  const node = findOne(root, 'Button');
  const press = node.props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError('Add slash command button has no press handler');
  }
  act(() => {
    (press as () => void)();
  });
}

function pressSheetDone(root: ReactTestInstance): void {
  const done = findOne(root, 'SheetHeader').props.onDone;
  if (typeof done !== 'function') {
    throw new TypeError('SheetHeader has no done handler');
  }
  act(() => {
    (done as () => void)();
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountScreen() {
  return renderWithProviders(
    createElement(ProfileKiloCommandsScreen, {
      profileId: 'profile-1',
      backFallback: PROFILES_LIST_HREF,
    })
  );
}

/**
 * Run `action` past the row tap guard window. The screen drops row presses for
 * a short span after its form sheet closed, so a test that presses a row right
 * after closing the sheet moves the clock past that span.
 */
function afterTapGuardWindow(action: () => void): void {
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
  try {
    action();
  } finally {
    now.mockRestore();
  }
}

describe('ProfileKiloCommandsScreen save refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The open form is a draft now, so no case may reopen on an earlier one.
    resetFormDraftsForTests();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
    permissionState.permission = 'allowed';
  });

  it('a save that settles onto another command’s form leaves that form open', async () => {
    h.query.data = [testCommand(), testCommand({ id: 'cmd-2', name: 'deploy' })];
    h.query.isPending = false;
    const held = Promise.withResolvers<unknown>();
    h.mutations.updateKiloCommand.mutateAsync.mockReturnValue(held.promise);

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit slash command release-notes');
    pressSheetDone(renderer.root);
    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    // The reader cancels A on the real clock (a save in flight closes without
    // asking) and opens B once the row guard's window has passed.
    act(() => {
      (findOne(renderer.root, 'SheetHeader').props.onCancel as () => void)();
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);
    afterTapGuardWindow(() => {
      pressPressable(renderer.root, 'Edit slash command deploy');
    });
    expect(findAll(renderer.root, 'SheetHeader')).toHaveLength(1);

    await act(async () => {
      held.resolve({ success: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    // A's success landed after its form was replaced: B's sheet stays open.
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('refuses a second save of the command whose save is already pending', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    const held = Promise.withResolvers<unknown>();
    h.mutations.updateKiloCommand.mutateAsync.mockReturnValue(held.promise);

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit slash command release-notes');
    pressSheetDone(renderer.root);
    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    afterTapGuardWindow(() => {
      (findOne(renderer.root, 'SheetHeader').props.onCancel as () => void)();
    });
    afterTapGuardWindow(() => {
      pressPressable(renderer.root, 'Edit slash command release-notes');
    });

    // Reopening the same command keeps its admission, so Save stays down.
    expect(findOne(renderer.root, 'SheetHeader').props.doneDisabled).toBe(true);
    pressSheetDone(renderer.root);
    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.resolve({ success: true });
      await Promise.resolve();
    });
    unmount();
  });

  it('does not open the reopened command on the refusal of the form it replaced', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    const held = Promise.withResolvers<unknown>();
    h.mutations.updateKiloCommand.mutateAsync.mockReturnValue(held.promise);

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit slash command release-notes');
    changeText(renderer.root, 'Command name', 'renamed');
    pressSheetDone(renderer.root);
    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    // A save in flight closes without asking, and the reader reopens the same
    // command once the row guard's window has passed.
    act(() => {
      (findOne(renderer.root, 'SheetHeader').props.onCancel as () => void)();
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);
    afterTapGuardWindow(() => {
      pressPressable(renderer.root, 'Edit slash command release-notes');
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 1);

    await act(async () => {
      held.reject(
        Object.assign(new Error('A command with this name already exists in this profile'), {
          data: { code: 'CONFLICT' },
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // The refusal belonged to the form that closed: the reopened one is clean.
    expect(findField(renderer.root, 'Command name').props.error).toBeUndefined();

    unmount();
  });

  it('clears the refusal of the command it reopens, not the closed add form’s', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    h.mutations.updateKiloCommand.mutateAsync.mockRejectedValue(new Error('Internal server error'));

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit slash command release-notes');
    pressSheetDone(renderer.root);
    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    act(() => {
      (findOne(renderer.root, 'SheetHeader').props.onCancel as () => void)();
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);
    afterTapGuardWindow(() => {
      pressPressable(renderer.root, 'Edit slash command release-notes');
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 1);

    // Reopening the refused command retires that refusal: the fresh form starts
    // clean instead of carrying the closed form's line.
    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    ).toBe(false);

    unmount();
  });

  it('leaves a reopened add form alone when the previous add form’s save settles', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    const held = Promise.withResolvers<unknown>();
    h.mutations.createKiloCommand.mutateAsync.mockReturnValue(held.promise);

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'first');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);
    expect(h.mutations.createKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    act(() => {
      (findOne(renderer.root, 'SheetHeader').props.onCancel as () => void)();
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);
    afterTapGuardWindow(() => {
      pressAddButton(renderer.root);
    });
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 1);

    // Reopening the add form does not reset the running save's admission: Save
    // stays down and a second save is refused until the first settles.
    expect(findOne(renderer.root, 'SheetHeader').props.doneDisabled).toBe(true);
    pressSheetDone(renderer.root);
    expect(h.mutations.createKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      held.resolve({ id: 'cmd-9' });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The settle closes nothing: the generation it captured belongs to the
    // previous form, so the reopened add form stays on screen.
    expect(findAll(renderer.root, 'SheetHeader')).toHaveLength(1);

    unmount();
  });

  it('refuses a name a loaded command already uses, without calling the server', async () => {
    h.query.data = [testCommand(), testCommand({ id: 'cmd-2', name: 'deploy' })];
    h.query.isPending = false;

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'release-notes');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);

    expect(h.mutations.createKiloCommand.mutateAsync).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('shows a conflict the server reported under the name field, not only a toast', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    h.mutations.createKiloCommand.mutateAsync.mockRejectedValue(
      Object.assign(new Error('A command with this name already exists in this profile'), {
        data: { code: 'CONFLICT' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'deploy');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'FormField').some(
        node => node.props.label === 'Command name' && node.props.error !== undefined
      )
    );
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );
    expect(h.error).not.toHaveBeenCalled();

    unmount();
  });

  it('shows another refused save as one line inside the sheet with the typed values kept', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    h.mutations.createKiloCommand.mutateAsync.mockRejectedValue(new Error('Internal server error'));

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'deploy');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);

    await waitFor(() =>
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    );
    expect(findOne(renderer.root, 'SheetHeader')).toBeTruthy();

    unmount();
  });

  it('closes the sheet once the server accepts the command', async () => {
    h.query.data = [testCommand()];
    h.query.isPending = false;
    h.mutations.createKiloCommand.mutateAsync.mockResolvedValue({ id: 'cmd-9' });

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'deploy');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);

    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);
    expect(h.mutations.createKiloCommand.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      name: 'deploy',
      template: 'Do it',
      subtask: false,
    });

    unmount();
  });

  it('lets an edit keep its own name and refuses one another command owns', async () => {
    h.query.data = [testCommand(), testCommand({ id: 'cmd-2', name: 'deploy' })];
    h.query.isPending = false;
    h.mutations.updateKiloCommand.mutateAsync.mockResolvedValue({ success: true });

    const { renderer, unmount } = await mountScreen();
    pressPressable(renderer.root, 'Edit slash command release-notes');
    pressSheetDone(renderer.root);

    // The edited command is left out of the duplicate check, so its own name
    // reaches the server instead of being refused here.
    await waitFor(() => h.mutations.updateKiloCommand.mutateAsync.mock.calls.length === 1);
    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        commandId: 'cmd-1',
        name: 'release-notes',
      })
    );

    afterTapGuardWindow(() => {
      pressPressable(renderer.root, 'Edit slash command release-notes');
    });
    changeText(renderer.root, 'Command name', 'deploy');
    pressSheetDone(renderer.root);

    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );

    unmount();
  });
});

describe('ProfileKiloCommandsScreen open form draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    Object.assign(h.query, {
      data: [testCommand()],
      isError: false,
      isPending: false,
      isRefetching: false,
    });
    permissionState.permission = 'allowed';
  });

  afterEach(() => {
    // The draft is module-level: a later case in this file must not reopen on it.
    resetFormDraftsForTests();
  });

  it('reopens the add form on what was typed after a remount', async () => {
    const first = await mountScreen();
    pressAddButton(first.renderer.root);
    changeText(first.renderer.root, 'Command name', 'summarize');
    changeText(first.renderer.root, 'Template', 'Summarize the diff');
    first.unmount();

    // An Android activity recreation opens the same form again: the claim the
    // screen's draft makes is that the reader's fields survive it.
    const second = await mountScreen();
    expect(findField(second.renderer.root, 'Command name').props.defaultValue).toBe('summarize');
    expect(findField(second.renderer.root, 'Template').props.defaultValue).toBe(
      'Summarize the diff'
    );

    second.unmount();
  });
});

describe('ProfileKiloCommandsScreen row controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, { data: [testCommand()], isPending: false, isError: false });
    permissionState.permission = 'allowed';
  });

  it('gives every row action a slop that carries its icon box to the touch target', async () => {
    const { renderer, unmount } = await mountScreen();

    const labels = [
      'Move slash command release-notes up',
      'Move slash command release-notes down',
      'Edit slash command release-notes',
      'Delete slash command release-notes',
    ];
    const actions = findAll(renderer.root, 'Pressable').filter(node =>
      labels.includes(String(node.props.accessibilityLabel))
    );
    expect(actions.map(node => node.props.accessibilityLabel)).toEqual(labels);
    for (const action of actions) {
      expect(action.props.hitSlop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    }

    unmount();
  });
});

/**
 * Press the `at`-th row control whose accessibility label starts with `prefix`.
 * The test renderer exposes its handler untyped; the screen passes it.
 */
function pressRow(root: ReactTestInstance, prefix: string, at = 0): void {
  const control = findAll(root, 'Pressable').filter(node =>
    String(node.props.accessibilityLabel).startsWith(prefix)
  )[at];
  const press = control?.props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError(`row control ${prefix} was not rendered`);
  }
  act(() => {
    (press as () => void)();
  });
}

/** The `at`-th row's enabled switch handler, which the screen passes untyped through the host. */
function toggleRow(root: ReactTestInstance, value: boolean, at = 0): void {
  const toggle = findAll(root, 'Switch')[at]?.props.onValueChange;
  if (typeof toggle !== 'function') {
    throw new TypeError('row switch has no value change handler');
  }
  act(() => {
    (toggle as (next: boolean) => void)(value);
  });
}

describe('ProfileKiloCommandsScreen after the form sheet closes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.data = [testCommand(), testCommand({ id: 'cmd-2', name: 'deploy' })];
    h.query.isPending = false;
    h.query.isError = false;
    permissionState.permission = 'allowed';
  });

  // The sheet dismisses natively and the list sits underneath it, so the rest
  // of the burst that closed the sheet would act on the row it uncovered.
  it('drops the row presses of the burst that closed the sheet', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Edit');
    pressSheetDone(renderer.root);
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    pressRow(renderer.root, 'Delete');
    pressRow(renderer.root, 'Move', 1);
    toggleRow(renderer.root, false);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.mutations.setKiloCommandEnabled.mutate).not.toHaveBeenCalled();
    expect(h.mutations.reorderKiloCommands.mutate).not.toHaveBeenCalled();

    unmount();
  });

  it('accepts the same row presses once the guard window has passed', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, 'Edit');
    pressSheetDone(renderer.root);
    await waitFor(() => findAll(renderer.root, 'SheetHeader').length === 0);

    afterTapGuardWindow(() => {
      pressRow(renderer.root, 'Delete');
      pressRow(renderer.root, 'Move', 1);
    });

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.mutations.reorderKiloCommands.mutate.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      orderedIds: ['cmd-2', 'cmd-1'],
    });

    unmount();
  });
});

describe('ProfileKiloCommandsScreen without the manage role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.permission = 'read-only';
    Object.assign(h.query, { data: [testCommand()], isPending: false, isError: false });
  });

  it('names the required role where a manager would find the add control', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.organizationRoleRequired')
    );

    unmount();
  });

  it('names the required role in place of the add CTA when the list is empty', async () => {
    h.query.data = [];

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Button')).toHaveLength(0);
    expect(findAll(renderer.root, 'Text').map(node => node.props.children)).toContain(
      i18n.t('profiles.organizationRoleRequired')
    );

    unmount();
  });
});

/** The command name the fixture row holds; the dialog must isolate exactly this run. */
const COMMAND_NAME = 'release-notes';

/** The confirm sheet's request, as the screen hands it to `useConfirmDialog`. */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/** Read the request the screen raised, without answering it. */
function deleteRequest(): ConfirmRequest {
  const request = h.confirm.mock.calls[0]?.[0] as ConfirmRequest | undefined;
  if (!request) {
    throw new Error('the screen asked for no confirmation');
  }
  return request;
}

describe('ProfileKiloCommandsScreen delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.data = [testCommand({ name: COMMAND_NAME })];
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    permissionState.permission = 'allowed';
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  // The dialog used to read "Delete" as both its title and its confirm label,
  // with the bare name as the message, so the reader was never told what
  // removing the command would do.
  it('asks for consent with the command name in the title and states the consequence', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, `Delete slash command ${COMMAND_NAME}`);
    const request = deleteRequest();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({
      title: i18n.t('profiles.slashCommands.deleteTitle', {
        name: isolateLtrBidiText(COMMAND_NAME),
      }),
      message: i18n.t('profiles.slashCommands.deleteMessage'),
      confirmLabel: i18n.t('profiles.slashCommands.deleteConfirm'),
    });
    expect(request.confirmLabel).not.toBe(i18n.t('common.delete'));
    expect(request.title).not.toBe(request.message);
    expect(request.title).not.toBe(COMMAND_NAME);
    expect(request.message).not.toBe(COMMAND_NAME);

    unmount();
  });

  // A command name is compared character by character, so a right-to-left
  // sentence must not reorder it: one explicit left-to-right run, no more.
  it('keeps the command name in exactly one left-to-right isolate pair', async () => {
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, `Delete slash command ${COMMAND_NAME}`);
    const { title } = deleteRequest();

    expect(title).toContain(`\u2066${COMMAND_NAME}\u2069`);
    expect(title.split('\u2066')).toHaveLength(2);
    expect(title.split('\u2069')).toHaveLength(2);

    unmount();
  });

  it('deletes nothing until the reader confirms, then deletes that command', async () => {
    h.mutations.deleteKiloCommand.mutateAsync.mockResolvedValue({ success: true });
    const { renderer, unmount } = await mountScreen();

    pressRow(renderer.root, `Delete slash command ${COMMAND_NAME}`);
    const request = deleteRequest();

    expect(h.mutations.deleteKiloCommand.mutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      request.onConfirm();
      await Promise.resolve();
    });

    expect(h.mutations.deleteKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutations.deleteKiloCommand.mutateAsync.mock.calls[0]?.[0]).toEqual({
      profileId: 'profile-1',
      commandId: 'cmd-1',
    });

    unmount();
  });
});

/** The translated cap line, as the footer and the sheet render it. */
function capMessage(): string {
  return i18n.t('profiles.slashCommands.limitReached', { max: MAX_PROFILE_KILO_COMMANDS });
}

/** True for the rendered `Text` that carries the cap line. */
function isCapLine(node: ReactTestInstance): boolean {
  return node.props.children === capMessage();
}

/** `length` distinct commands, so the list holds exactly the count the server caps. */
function commandsAt(length: number): TestCommand[] {
  return Array.from({ length }, (_, index) =>
    testCommand({ id: `cmd-${index}`, name: `command-${index}`, description: null })
  );
}

describe('ProfileKiloCommandsScreen command cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    permissionState.permission = 'allowed';
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
  });

  it('states the cap above the Add action and disables it at the cap', async () => {
    h.query.data = commandsAt(MAX_PROFILE_KILO_COMMANDS);
    const { renderer, unmount } = await mountScreen();

    // One pre-order walk, so the indexes compare the footer's own order.
    const ordered = renderer.root.findAll(
      node => String(node.type) === 'Text' || String(node.type) === 'Button'
    );
    const noticeIndex = ordered.findIndex(node => isCapLine(node));
    const addIndex = ordered.findIndex(node => String(node.type) === 'Button');

    expect(noticeIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(addIndex);
    expect(ordered[noticeIndex]?.props.className).toContain('text-warn');
    expect(findOne(renderer.root, 'Button').props.disabled).toBe(true);

    unmount();
  });

  it('offers the Add action without a notice one command below the cap', async () => {
    h.query.data = commandsAt(MAX_PROFILE_KILO_COMMANDS - 1);
    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'Text').some(node => isCapLine(node))).toBe(false);
    expect(findOne(renderer.root, 'Button').props.disabled).toBe(false);

    unmount();
  });

  it('reports a create the cap refuses as the cap line, not a generic failure', async () => {
    h.query.data = [testCommand()];
    h.mutations.createKiloCommand.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Profiles are limited to 50 custom commands'), {
        data: { code: 'PRECONDITION_FAILED' },
      })
    );

    const { renderer, unmount } = await mountScreen();
    pressAddButton(renderer.root);
    changeText(renderer.root, 'Command name', 'deploy');
    changeText(renderer.root, 'Template', 'Do it');
    pressSheetDone(renderer.root);

    await waitFor(() => findAll(renderer.root, 'Text').some(node => isCapLine(node)));
    const status = findAll(renderer.root, 'Text').find(node => isCapLine(node));
    expect(status?.props.className).toContain('text-warn');
    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === i18n.t('profiles.slashCommands.saveFailed')
      )
    ).toBe(false);

    unmount();
  });
});
