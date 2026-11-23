/* eslint-disable max-lines -- one mounted harness drives the screen's list rows, its cap and both empty-state permissions */
import { type Href } from 'expo-router';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileInstructionsScreen } from '@/components/profiles/profile-instructions-screen';
import { isolateLtrBidiText } from '@/lib/bidi';
import { resetFormDraftsForTests } from '@/lib/form-draft';
import { MAX_PROFILE_INSTRUCTIONS } from '@/lib/agent-profile-forms';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

/** The default destination the Profile tab's routes pass: their own Profiles list. */
const PROFILES_LIST_HREF = '/(app)/(tabs)/(3_profile)/profiles' as Href;

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  connectivity: 'online' as string,
  query: {
    data: undefined as unknown,
    error: undefined as unknown,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createInstruction: { mutateAsync: vi.fn(), isPending: false },
    updateInstruction: { mutateAsync: vi.fn(), isPending: false },
    deleteInstruction: { mutateAsync: vi.fn(), isPending: false },
    setInstructionEnabled: { mutate: vi.fn(), isPending: false },
  },
}));

/** The manage permission the mocked profile hook reports; read-only drops every control. */
const permission = vi.hoisted(() => ({
  value: 'allowed' as 'allowed' | 'read-only' | 'resolving',
}));

// The screen's tap guard reads the route's focus. This suite drives the sheet's
// own guard, not a return from a pushed child, so the effect stays inert.
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useOrganizationProfilePermission: () => permission.value,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileInstructions: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' }, isPending: false }),
}));
vi.mock('@/lib/hooks/use-agent-profile-instruction-mutations', () => ({
  useAgentProfileInstructionMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => h.connectivity,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  // The font-scale module falls back to the window's scale outside its provider.
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: 'View',
  Pressable: 'Pressable',
  Switch: 'Switch',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const THEME = vi.hoisted(() => ({
  foreground: '#0E0E10',
  mutedForeground: '#6B6B6B',
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
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  Plus: 'Plus',
  Trash2: 'Trash2',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/empty-state', async () => {
  // vi.mock factories are hoisted above the module's imports, so the React
  // helper is loaded inside the factory. The real state renders its `action`
  // below the description, so the manage slot's sentence reaches the tree the
  // way the screen hands it over.
  const { createElement: create } = await import('react');
  return {
    EmptyState: (props: { action?: unknown }) => create('EmptyState', props, props.action as never),
    StateAction: 'StateAction',
  };
});
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScrollView' }));
vi.mock('@/components/profiles/profile-section-header', () => ({
  ProfileSectionHeader: 'ProfileSectionHeader',
}));
vi.mock('@/components/profiles/instruction-view-sheet', () => ({
  InstructionViewSheet: 'InstructionViewSheet',
}));
vi.mock('@/components/profiles/instruction-form-sheet', async () => {
  // vi.mock factories are hoisted above this module's imports, so the React,
  // i18n and draft helpers load inside the factory. The stand-in keeps the
  // screen's props on its host element and renders the two fields whose text the
  // sheet's own draft holds (`instruction-form-sheet.tsx` writes `name` and
  // `content`), so a case can type into them and read what a remount restores.
  const { createElement: create } = await import('react');
  const { i18n: translate } = await import('@/i18n');
  const { useFormDraftRef } = await import('@/lib/form-draft');
  function InstructionFormSheet(props: { draftScope?: string }) {
    const nameRef = useFormDraftRef(props.draftScope, 'name', '');
    const contentRef = useFormDraftRef(props.draftScope, 'content', '');
    return create(
      'InstructionFormSheet',
      props,
      create('FormField', {
        key: 'name',
        label: translate.t('profiles.instructionNameLabel'),
        defaultValue: nameRef.current,
        onChangeText: (value: string) => {
          nameRef.current = value;
        },
      }),
      create('FormField', {
        key: 'content',
        label: translate.t('profiles.instructionContentLabel'),
        defaultValue: contentRef.current,
        onChangeText: (value: string) => {
          contentRef.current = value;
        },
      })
    );
  }
  return { InstructionFormSheet };
});

/** The name the fixture row holds; the dialog must isolate exactly this run. */
const INSTRUCTION_NAME = 'zalgo-2026';

/** The longest file name the server stores, i.e. `INSTRUCTION_NAME_MAX_LENGTH`. */
const LONG_INSTRUCTION_NAME =
  'release-checklist-for-the-hindi-and-urdu-partner-team-handoff-before-every-quarter-close-safety-revi';

type TestInstruction = { id: string; name: string; content: string; enabled: boolean };

function testInstruction(overrides: Partial<TestInstruction> = {}): TestInstruction {
  return {
    id: 'inst-1',
    name: INSTRUCTION_NAME,
    content: '# Rules',
    enabled: true,
    ...overrides,
  };
}

/** The confirm sheet's request, as the screen hands it to `useConfirmDialog`. */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/**
 * A refusal the server sent with no reason the reader can act on. The screen's
 * `hasUsableMessage` reads a blank message as unusable, which is the case where
 * the screen owns the toast instead of the mutation hook.
 */
function messageLessRefusal(): Error {
  const error = new Error('Server refused the delete');
  error.message = '';
  return error;
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The row control whose accessibility label starts with `prefix`, untyped through the host. */
function findRowControl(root: ReactTestInstance, prefix: string): ReactTestInstance {
  const control = findAll(root, 'Pressable').find(node =>
    String(node.props.accessibilityLabel).startsWith(prefix)
  );
  if (!control) {
    throw new TypeError(`row control ${prefix} was not rendered`);
  }
  return control;
}

function pressRowControl(root: ReactTestInstance, prefix: string): void {
  const press = findRowControl(root, prefix).props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError(`row control ${prefix} has no press handler`);
  }
  act(() => {
    (press as () => void)();
  });
}

/** Press the row's Delete control and return the request it raised. */
function pressDelete(root: ReactTestInstance): ConfirmRequest {
  pressRowControl(root, i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME }));
  return confirmRequest();
}

function confirmRequest(): ConfirmRequest {
  const request = h.confirm.mock.calls[0]?.[0] as ConfirmRequest | undefined;
  if (!request) {
    throw new Error('the screen asked for no confirmation');
  }
  return request;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountScreen() {
  return renderWithProviders(
    createElement(ProfileInstructionsScreen, {
      profileId: 'profile-1',
      backFallback: PROFILES_LIST_HREF,
    })
  );
}

/**
 * Accept the confirm sheet's request and let the delete it starts settle. The
 * screen's `runDelete` awaits the mutation, so its catch runs a microtask after
 * the press; no timer is involved.
 */
async function confirmRequestAndSettle(request: ConfirmRequest): Promise<void> {
  await act(async () => {
    request.onConfirm();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rowControls(root: ReactTestInstance): string[] {
  return findAll(root, 'Pressable').map(node => String(node.props.accessibilityLabel));
}

/** The instruction the mocked detail sheet was handed, or `null` while it is closed. */
function sheetInstruction(root: ReactTestInstance): { name: string; content: string } | null {
  const sheet = findAll(root, 'InstructionViewSheet')[0];
  if (!sheet) {
    throw new TypeError('the detail sheet was not rendered');
  }
  return (sheet.props.instruction ?? null) as { name: string; content: string } | null;
}

/** Press the add control a loaded list renders in its footer. */
function pressAdd(root: ReactTestInstance): void {
  const button = findAll(root, 'Button')[0];
  const press = button?.props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError('the add control was not rendered');
  }
  act(() => {
    (press as () => void)();
  });
}

/** The props one sheet field stub carries; the renderer keeps them untyped. */
type FieldProps = { defaultValue?: string; onChangeText?: (text: string) => void };

/** The sheet field the stub renders under `label`. */
function findField(root: ReactTestInstance, label: string) {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

/** Type into one sheet field, which writes the scope's draft as the sheet does. */
function changeText(root: ReactTestInstance, label: string, value: string): void {
  const field = findField(root, label).props as FieldProps;
  act(() => {
    field.onChangeText?.(value);
  });
}

/** Re-render the mounted screen against fresh mock state, keeping the providers. */
function rerenderScreen(renderer: ReactTestRenderer, queryClient: QueryClient): void {
  renderer.update(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileInstructionsScreen, {
        profileId: 'profile-1',
        backFallback: PROFILES_LIST_HREF,
      })
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permission.value = 'allowed';
  h.connectivity = 'online';
  h.query.data = [testInstruction()];
  h.query.error = undefined;
  h.query.isError = false;
  h.query.isPending = false;
  h.query.isRefetching = false;
});

describe('ProfileInstructionsScreen delete confirmation', () => {
  beforeEach(() => {
    h.mutations.deleteInstruction.mutateAsync.mockReset();
    h.mutations.deleteInstruction.mutateAsync.mockResolvedValue({ success: true });
    h.mutations.setInstructionEnabled.mutate.mockReset();
  });

  // The dialog used to ask "Delete <name>" twice: a title and a label both read
  // `common.delete`, with the file name as the whole message, so the reader was
  // never told what deleting the file would do.
  it('asks for consent with the file name in the title and states the consequence', async () => {
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({
      title: i18n.t('profiles.instructionDeleteTitle', {
        name: isolateLtrBidiText(INSTRUCTION_NAME),
      }),
      message: i18n.t('profiles.instructionDeleteMessage'),
      confirmLabel: i18n.t('profiles.instructionDeleteConfirm'),
    });
    expect(request.confirmLabel).not.toBe(i18n.t('common.delete'));
    expect(request.title).not.toBe(request.message);
    expect(request.title).not.toBe(INSTRUCTION_NAME);
    expect(request.message).not.toBe(INSTRUCTION_NAME);

    unmount();
  });

  // A rules file name is compared character by character, so a right-to-left
  // sentence must not reorder it: one explicit left-to-right run, no more.
  it('keeps the file name in exactly one left-to-right isolate pair', async () => {
    const { renderer, unmount } = await mountScreen();

    const { title } = pressDelete(renderer.root);

    expect(title).toContain(`\u2066${INSTRUCTION_NAME}\u2069`);
    expect(title.split('\u2066')).toHaveLength(2);
    expect(title.split('\u2069')).toHaveLength(2);

    unmount();
  });

  it('deletes nothing until the reader confirms, then deletes that row', async () => {
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);

    expect(h.mutations.deleteInstruction.mutateAsync).not.toHaveBeenCalled();

    await confirmRequestAndSettle(request);

    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      instructionId: 'inst-1',
    });

    unmount();
  });

  it('leaves the row in place and stays quiet when the server sends a readable refusal', async () => {
    h.mutations.deleteInstruction.mutateAsync.mockRejectedValue(
      new Error('This instruction is still used by an active session')
    );
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);
    await confirmRequestAndSettle(request);

    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledTimes(1);
    // The mutation hook owns the toast for a message the reader can act on.
    expect(h.error).not.toHaveBeenCalled();
    expect(rowControls(renderer.root)).toContain(
      i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME })
    );
    expect(findAll(renderer.root, 'Switch')).toHaveLength(1);

    unmount();
  });

  // The hook toasts the server's message; when it sent nothing readable the
  // screen is the only place that can tell the reader the delete failed.
  it('toasts the fallback message when the server refuses without a readable reason', async () => {
    h.mutations.deleteInstruction.mutateAsync.mockRejectedValue(messageLessRefusal());
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);
    await confirmRequestAndSettle(request);

    await waitFor(() => h.error.mock.calls.length === 1);
    expect(h.error).toHaveBeenCalledWith(i18n.t('profiles.instructionDeleteFailed'));
    expect(rowControls(renderer.root)).toContain(
      i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME })
    );

    unmount();
  });
});

describe('ProfileInstructionsScreen instruction cap', () => {
  it('names the cap above the disabled add control', async () => {
    const capCopy = i18n.t('profiles.instructionLimitReached', { max: MAX_PROFILE_INSTRUCTIONS });
    h.query.data = Array.from({ length: MAX_PROFILE_INSTRUCTIONS }, (_, index) =>
      testInstruction({ id: `inst-${index}`, name: `instruction-${index}` })
    );

    const atCap = await mountScreen();
    const footer = atCap.renderer.root.findAll(
      node => String(node.type) === 'AccessibleStatus' || String(node.type) === 'Button'
    );
    expect(footer.map(node => node.type)).toEqual(['AccessibleStatus', 'Button']);
    expect(footer[0]?.props.message).toBe(capCopy);
    expect(footer[0]?.props.tone).toBe('warn');
    expect(footer[1]?.props.disabled).toBe(true);
    atCap.unmount();

    // One row below the cap the same control is offered and says nothing.
    h.query.data = Array.from({ length: MAX_PROFILE_INSTRUCTIONS - 1 }, (_, index) =>
      testInstruction({ id: `inst-${index}`, name: `instruction-${index}` })
    );
    const belowCap = await mountScreen();
    expect(findAll(belowCap.renderer.root, 'AccessibleStatus')).toHaveLength(0);
    expect(findAll(belowCap.renderer.root, 'Button')[0]?.props.disabled).toBe(false);
    belowCap.unmount();
  });
});

describe('ProfileInstructionsScreen empty state', () => {
  beforeEach(() => {
    permission.value = 'allowed';
    Object.assign(h.query, { data: [], isError: false, isPending: false, isRefetching: false });
  });

  // A member used to read an invitation to add rule files directly above the
  // sentence that says they cannot change the profile.
  it('picks the description and the action by the manage permission', async () => {
    const manager = await mountScreen();
    expect(findAll(manager.renderer.root, 'EmptyState')[0]?.props.description).toBe(
      i18n.t('profiles.instructionsEmptyDescription')
    );
    expect(findAll(manager.renderer.root, 'StateAction')).toHaveLength(1);
    manager.unmount();

    permission.value = 'read-only';
    const member = await mountScreen();
    expect(findAll(member.renderer.root, 'EmptyState')[0]?.props.description).toBe(
      i18n.t('profiles.instructionsEmptyDescriptionReadOnly')
    );
    const texts = findAll(member.renderer.root, 'Text').map(node => node.props.children);
    expect(texts).toContain(i18n.t('profiles.organizationRoleRequired'));
    expect(findAll(member.renderer.root, 'StateAction')).toHaveLength(0);
    member.unmount();
  });
});

describe('ProfileInstructionsScreen row controls', () => {
  it('names the path it opens after the file name', async () => {
    const { renderer, unmount } = await mountScreen();

    // The row paints the file name only; the path it applies as rides the
    // content press's spoken name instead of a second painted line.
    expect(rowControls(renderer.root)).toContain(
      [
        i18n.t('profiles.instructionEdit', { name: INSTRUCTION_NAME }),
        `.kilocode/rules/${INSTRUCTION_NAME}.md`,
      ].join(', ')
    );
    expect(
      findAll(renderer.root, 'Text').some(
        node => node.props.children === `.kilocode/rules/${INSTRUCTION_NAME}.md`
      )
    ).toBe(false);

    // The press opens the form that shows the whole name, so this row clamps
    // the name to the title's one line at the default font scale and cuts it in
    // the middle, where two names that share a long prefix still differ.
    const nameLine = findAll(renderer.root, 'Text').find(
      node => node.props.children === INSTRUCTION_NAME
    );
    expect(nameLine?.props.numberOfLines).toBe(1);
    expect(nameLine?.props.ellipsizeMode).toBe('middle');
    expect(nameLine?.props.children).toBe(INSTRUCTION_NAME);

    // The editable row's switch stays its own accessible stop with its own
    // checked state, so its content press carries no value of its own.
    expect(
      findRowControl(
        renderer.root,
        [
          i18n.t('profiles.instructionEdit', { name: INSTRUCTION_NAME }),
          `.kilocode/rules/${INSTRUCTION_NAME}.md`,
        ].join(', ')
      ).props.accessibilityValue
    ).toBeUndefined();

    unmount();
  });
});

describe('ProfileInstructionsScreen read-only row', () => {
  beforeEach(() => {
    permission.value = 'read-only';
  });

  it('drops the edit control and names the file on the row it presses', async () => {
    const { renderer, unmount } = await mountScreen();

    // The content is the edit action, so a read-only profile renders no edit
    // control. The row itself is the press, and it carries the name and path
    // the painted line used to speak.
    expect(rowControls(renderer.root)).not.toContain(
      i18n.t('profiles.instructionEdit', { name: INSTRUCTION_NAME })
    );
    const rowLabel = [INSTRUCTION_NAME, `.kilocode/rules/${INSTRUCTION_NAME}.md`].join(', ');
    expect(rowControls(renderer.root)).toContain(rowLabel);

    // The painted name is out of the accessibility tree because the row above
    // it now speaks the same name, and it clamps to the row's one line: the
    // press opens the detail sheet that paints it in full.
    const nameLine = findAll(renderer.root, 'Text').find(
      node => node.props.children === isolateLtrBidiText(INSTRUCTION_NAME)
    );
    expect(nameLine?.props.accessibilityLabel).toBeUndefined();
    expect(nameLine?.props.accessible).toBe(false);
    expect(nameLine?.props.importantForAccessibility).toBe('no');
    expect(nameLine?.props.numberOfLines).toBe(1);
    // The cut sits in the middle of the name, so two files that share a long
    // prefix still read differently on the row itself.
    expect(nameLine?.props.ellipsizeMode).toBe('middle');
    expect(nameLine?.props.children).toBe(isolateLtrBidiText(INSTRUCTION_NAME));
    expect(findAll(renderer.root, 'Switch')[0]?.props.accessibilityLabel).toBe(INSTRUCTION_NAME);

    unmount();
  });

  // The row's one accessible press swallows the switch on iOS, so the state the
  // switch carries has to ride the row's spoken value or a reader loses it.
  it('speaks the row state in its value, on the press that hides the switch', async () => {
    const rowLabel = [INSTRUCTION_NAME, `.kilocode/rules/${INSTRUCTION_NAME}.md`].join(', ');

    const enabled = await mountScreen();
    expect(findRowControl(enabled.renderer.root, rowLabel).props.accessibilityValue).toEqual({
      text: i18n.t('common.enabled'),
    });
    enabled.unmount();

    h.query.data = [testInstruction({ enabled: false })];
    const disabled = await mountScreen();
    expect(findRowControl(disabled.renderer.root, rowLabel).props.accessibilityValue).toEqual({
      text: i18n.t('common.disabled'),
    });
    disabled.unmount();
  });

  // A disclosure mark beside the switch used to take the width the title
  // needed, and the whole row is already one press: nothing else trails it.
  it('leaves the trailing cell to the switch its state belongs to', async () => {
    const { renderer, unmount } = await mountScreen();

    // The renderer keeps host props untyped; the frame's spec is the screen's own.
    const trailingCells = renderer.root
      .findAll(node => node.props.trailing !== undefined)
      .map(node => node.props.trailing as { kind: string; nodes?: readonly unknown[] });
    expect(trailingCells).toHaveLength(1);
    expect(trailingCells[0]?.kind).toBe('nodes');
    expect(trailingCells[0]?.nodes).toHaveLength(1);
    expect(findAll(renderer.root, 'Switch')).toHaveLength(1);

    unmount();
  });

  it('opens the detail sheet with the whole instruction on a row press', async () => {
    const { renderer, unmount } = await mountScreen();

    expect(sheetInstruction(renderer.root)).toBeNull();

    pressRowControl(
      renderer.root,
      [INSTRUCTION_NAME, `.kilocode/rules/${INSTRUCTION_NAME}.md`].join(', ')
    );

    expect(sheetInstruction(renderer.root)).toMatchObject({
      name: INSTRUCTION_NAME,
      content: '# Rules',
    });

    unmount();
  });

  // The row clamps the name to one line, so the longest file the server stores
  // reaches the sheet unchanged and the sheet is what makes it readable.
  it('hands a 100-character file name to the sheet unchanged', async () => {
    h.query.data = [testInstruction({ name: LONG_INSTRUCTION_NAME })];
    const { renderer, unmount } = await mountScreen();

    expect(LONG_INSTRUCTION_NAME).toHaveLength(100);

    // The row's own spoken name finds the press on either arm; the row no
    // longer wraps, so the cut and the untouched sheet value are what differ.
    const nameLine = findAll(renderer.root, 'Text').find(
      node => node.props.children === isolateLtrBidiText(LONG_INSTRUCTION_NAME)
    );
    expect(nameLine).toBeDefined();
    expect(nameLine?.props.numberOfLines).toBe(1);
    // A 100-character name that shares its prefix with a sibling stays
    // distinguishable on the row: the middle cut keeps its own ending.
    expect(nameLine?.props.ellipsizeMode).toBe('middle');

    pressRowControl(
      renderer.root,
      [LONG_INSTRUCTION_NAME, `.kilocode/rules/${LONG_INSTRUCTION_NAME}.md`].join(', ')
    );

    const shown = sheetInstruction(renderer.root);
    expect(shown?.name).toBe(LONG_INSTRUCTION_NAME);

    unmount();
  });
});

/** The props the mocked `QueryError` host element carries; the renderer keeps them untyped. */
type RenderedQueryError = {
  variant?: string;
  title?: string;
  placement?: string;
  onRetry?: () => void;
};

describe('ProfileInstructionsScreen load errors', () => {
  beforeEach(() => {
    h.connectivity = 'online';
    Object.assign(h.query, {
      data: undefined,
      error: undefined,
      isError: false,
      isPending: false,
      isRefetching: false,
    });
  });

  it('forbidden: names the permission state and offers no Retry', async () => {
    Object.assign(h.query, {
      isError: true,
      error: { data: { code: 'FORBIDDEN' } },
    });

    const { renderer, unmount } = await mountScreen();

    // The renderer keeps host props untyped; the stub's props are the screen's own.
    const queryError = findAll(renderer.root, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('permission');
    expect(queryError?.title).toBeUndefined();
    expect(queryError?.onRetry).toBeUndefined();
    // A read with nothing under it owns the surface, so it centres and no
    // tab scroller holds it.
    expect(queryError?.placement).toBe('center');
    expect(findAll(renderer.root, 'TabScrollView')).toHaveLength(0);

    unmount();
  });

  it('server: keeps the load-failure title and a Retry that refetches', async () => {
    Object.assign(h.query, {
      isError: true,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });

    const { renderer, unmount } = await mountScreen();

    const queryError = findAll(renderer.root, 'QueryError')[0]?.props as
      | RenderedQueryError
      | undefined;
    expect(queryError?.variant).toBe('server');
    expect(queryError?.title).toBe("Couldn't load profiles");
    expect(typeof queryError?.onRetry).toBe('function');
    act(() => {
      queryError?.onRetry?.();
    });
    expect(h.query.refetch).toHaveBeenCalledTimes(1);

    unmount();
  });
});

/** A sheet draft typed while the role allowed the write; the store keeps it past an unmount. */
async function seedSheetDraft(): Promise<void> {
  const first = await mountScreen();
  pressAdd(first.renderer.root);
  changeText(first.renderer.root, i18n.t('profiles.instructionNameLabel'), 'portal-rules');
  changeText(first.renderer.root, i18n.t('profiles.instructionContentLabel'), '# Portal rules');
  first.unmount();
}

describe('ProfileInstructionsScreen manage permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
    permission.value = 'allowed';
    h.query.data = [testInstruction()];
    h.query.error = undefined;
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
  });

  it('renders no sheet for a stored draft once the role is read-only, and states the role once', async () => {
    await seedSheetDraft();
    permission.value = 'read-only';

    const { renderer, unmount } = await mountScreen();

    expect(findAll(renderer.root, 'InstructionFormSheet')).toHaveLength(0);
    expect(
      findAll(renderer.root, 'Text').filter(
        node => node.props.children === i18n.t('profiles.organizationRoleRequired')
      )
    ).toHaveLength(1);

    unmount();
  });

  it('drops that draft with the denial, so a later allowed render stays closed', async () => {
    await seedSheetDraft();
    permission.value = 'read-only';

    const denied = await mountScreen();
    expect(findAll(denied.renderer.root, 'InstructionFormSheet')).toHaveLength(0);
    denied.unmount();

    permission.value = 'allowed';
    const allowed = await mountScreen();
    expect(findAll(allowed.renderer.root, 'InstructionFormSheet')).toHaveLength(0);
    allowed.unmount();
  });

  it('keeps the draft while the role resolves, then reopens on the typed fields', async () => {
    await seedSheetDraft();
    permission.value = 'resolving';

    const resolving = await mountScreen();
    expect(findAll(resolving.renderer.root, 'InstructionFormSheet')).toHaveLength(0);

    permission.value = 'allowed';
    await act(async () => {
      rerenderScreen(resolving.renderer, resolving.queryClient);
      await Promise.resolve();
    });

    expect(findAll(resolving.renderer.root, 'InstructionFormSheet')).toHaveLength(1);
    const name = findField(resolving.renderer.root, i18n.t('profiles.instructionNameLabel'))
      .props as FieldProps;
    const content = findField(resolving.renderer.root, i18n.t('profiles.instructionContentLabel'))
      .props as FieldProps;
    expect(name.defaultValue).toBe('portal-rules');
    expect(content.defaultValue).toBe('# Portal rules');

    resolving.unmount();
  });

  it('closes the open sheet when the role is denied and does not reopen it when it returns', async () => {
    const { renderer, queryClient, unmount } = await mountScreen();
    pressAdd(renderer.root);
    expect(findAll(renderer.root, 'InstructionFormSheet')).toHaveLength(1);
    changeText(renderer.root, i18n.t('profiles.instructionNameLabel'), 'portal-rules');

    permission.value = 'read-only';
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'InstructionFormSheet')).toHaveLength(0);

    permission.value = 'allowed';
    await act(async () => {
      rerenderScreen(renderer, queryClient);
      await Promise.resolve();
    });
    expect(findAll(renderer.root, 'InstructionFormSheet')).toHaveLength(0);

    unmount();
  });
});
