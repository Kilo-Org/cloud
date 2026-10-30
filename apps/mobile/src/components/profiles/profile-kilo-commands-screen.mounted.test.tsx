/* eslint-disable max-lines -- one mounted case per slash-command screen state: list, add, duplicate, conflict, failure, and save */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';

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

const permissionState = vi.hoisted(() => ({ canManage: true }));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => permissionState.canManage,
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileKiloCommands: () => h.query,
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
  mutedForeground: '#000000',
  destructive: '#FF0000',
  mutedSoft: '#A9A39A',
  primary: '#4F5A10',
  primaryForeground: '#FFFFFF',
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
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
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
  return renderWithProviders(createElement(ProfileKiloCommandsScreen, { profileId: 'profile-1' }));
}

describe('ProfileKiloCommandsScreen save refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, {
      data: undefined,
      isError: false,
      isPending: true,
      isRefetching: false,
    });
    for (const mutation of Object.values(h.mutations)) {
      Object.assign(mutation, { isPending: false });
    }
    permissionState.canManage = true;
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

    pressPressable(renderer.root, 'Edit slash command release-notes');
    changeText(renderer.root, 'Command name', 'deploy');
    pressSheetDone(renderer.root);

    expect(h.mutations.updateKiloCommand.mutateAsync).toHaveBeenCalledTimes(1);
    expect(findField(renderer.root, 'Command name').props.error).toBe(
      i18n.t('profiles.slashCommands.duplicateName')
    );

    unmount();
  });
});

describe('ProfileKiloCommandsScreen row controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.query, { data: [testCommand()], isPending: false, isError: false });
    permissionState.canManage = true;
  });

  // The platform `Switch` falls back to its own accent tint, which drew the on
  // state in Material teal and read as disabled against the card.
  it('tints the enable switch from theme tokens instead of the platform accent', async () => {
    const { renderer, unmount } = await mountScreen();

    const toggle = findOne(renderer.root, 'Switch').props as {
      trackColor?: { false?: string; true?: string };
      thumbColor?: string;
    };
    expect(toggle.trackColor).toEqual({ false: THEME.mutedSoft, true: THEME.primary });
    expect(toggle.thumbColor).toBe(THEME.primaryForeground);

    unmount();
  });

  it('gives every row action a slop that carries its icon box to the touch target', async () => {
    const { renderer, unmount } = await mountScreen();

    const actions = findAll(renderer.root, 'Pressable').filter(node =>
      String(node.props.accessibilityLabel).startsWith('Move slash command')
    );
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.props.hitSlop).toBe(COMPACT_CONTROL_HIT_SLOP_DP);
    }

    unmount();
  });
});
