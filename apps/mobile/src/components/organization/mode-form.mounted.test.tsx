/* eslint-disable max-lines -- the form's refused saves, its identifier hint and its durable draft share one mock harness. */
import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeForm } from '@/components/organization/mode-form';
import { type OrgMode, type OrgModeFormDraft } from '@/components/organization/org-mode-form-model';
import { FormField } from '@/components/ui/form-field';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { scrollTo } from '@/test/scroll-view-mock';

const mutations = vi.hoisted(() => ({
  create: { isPending: false, mutate: vi.fn() },
  update: { isPending: false, mutate: vi.fn() },
  remove: { isPending: false, mutate: vi.fn() },
}));

// The durable draft the wrapper reads: its state is swapped per test, and its
// write and clear are the suite's spies.
type DraftState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: unknown; save: (value: unknown) => void; clear: () => void };

const draft = vi.hoisted(
  (): { save: (value: unknown) => void; clear: () => void; state: DraftState } => ({
    save: vi.fn<(value: unknown) => void>(),
    clear: vi.fn<() => void>(),
    state: { kind: 'loading' },
  })
);

// The guard's props, so the suite reads the `onDiscard` the form handed it.
const leaveGuard = vi.hoisted((): { props: Record<string, unknown> } => ({ props: {} }));
// The removal confirmation, so a delete test can run its `onConfirm`.
const confirmMock = vi.hoisted(() => vi.fn());

// The real Save control loads its spinner policy through the Expo runtime
// (battery level and reanimated), which this Node project cannot import.
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// `vi.mock` factories are hoisted above this file's imports, so the scroll host
// comes in dynamically; the form's ref lands on it and records a Save's scroll.
vi.mock('react-native', async () => {
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return {
    I18nManager: { isRTL: false },
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    ScrollView: MockScrollView,
    TextInput: 'TextInput',
    View: 'View',
    useColorScheme: () => 'light',
  };
});
// Hoisted as well: the tab-screen wrapper is where the form's scroll ref lands.
vi.mock('@/components/tab-screen', async () => {
  const { MockScrollView } = await import('@/test/scroll-view-mock');
  return { TabScreenScrollView: MockScrollView };
});
// The button's label reads this context, so the stub needs a real one; texts stay
// host elements so the suite reads the hint line as the component rendered it.
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext(undefined) };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => false, replace: vi.fn() }),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, dialog: null }),
}));
vi.mock('@/lib/hooks/use-org-modes-queries', () => ({
  useOrgModeMutations: () => mutations,
}));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => vi.fn() }));
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: vi.fn() }),
}));
vi.mock('@/components/profiles/use-metadata-leave-guard', () => ({
  useMetadataLeaveGuard: (props: Record<string, unknown>) => {
    leaveGuard.props = props;
    return {
      handleDirtyChange: vi.fn(),
      leaveWithoutAsking: vi.fn(),
      dialog: null,
    };
  },
}));
// The draft store, the account id and the key helper are the wrapper's inputs:
// the store is a controllable state, so a test can hold the form in its loading
// phase and then settle it.
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1', isLoading: false }),
}));
vi.mock('@/lib/persist/use-form-draft', () => ({ useFormDraft: () => draft.state }));
// The real module opens the encrypted SQLite store, which this Node project
// cannot import; the form reads only its key helper.
vi.mock('@/lib/persist/drafts', () => ({
  orgModeFormDraftKey: (organizationId: string, modeId: string | null) =>
    `org-mode-form:${organizationId}:${modeId ?? 'new'}`,
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/organization/mode-tools-fields', () => ({
  ModeToolsFields: 'ModeToolsFields',
}));

/* `node.type` widens to `ElementType` across a tree that holds both component
 * and host nodes, so a literal comparison reads as an impossible one; the
 * unknown annotation widens the comparison instead of fighting the check. */
const TEXT: unknown = 'Text';
const PRESSABLE: unknown = 'Pressable';
/** `useFormFieldScroll` keeps this much above the field it reveals; it is not exported. */
const FIELD_TOP_MARGIN = 12;
const NAME_OFFSET = 40;
const IDENTIFIER_OFFSET = 120;
const ROLE_OFFSET = 260;

const nameLabel = i18n.t('organization.modes.nameLabel');
const identifierLabel = i18n.t('organization.modes.identifierLabel');
const roleLabel = i18n.t('organization.modes.roleLabel');
const identifierHint = i18n.t('organization.modes.identifierHint');

function storedMode(id: string, name: string, slug: string): OrgMode {
  return {
    id,
    organization_id: 'org-1',
    name,
    slug,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    config: {
      roleDefinition: `You are the ${name} mode.`,
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: ['read'],
    },
  };
}

const existingModes: readonly OrgMode[] = [
  storedMode('mode-1', 'Architect', 'architect'),
  storedMode('mode-2', 'Reviewer', 'reviewer'),
];

type WidgetProps = Record<string, unknown>;

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = root
    .findAll(node => node.type === FormField)
    .find(node => (node.props as WidgetProps).label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function fieldProps(root: ReactTestInstance, label: string): WidgetProps {
  return findField(root, label).props as WidgetProps;
}

/** A press prop, read from a component whose own props the renderer leaves untyped. */
function pressHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a press handler');
  }
  return value as () => void;
}

/** A field's text prop, read the same way. */
function textHandler(value: unknown): (text: string) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a change handler');
  }
  return value as (text: string) => void;
}

function changeField(root: ReactTestInstance, label: string, value: string): void {
  const onChangeText = textHandler(fieldProps(root, label).onChangeText);
  act(() => {
    onChangeText(value);
  });
}

type LayoutHandler = (event: { nativeEvent: { layout: { y: number } } }) => void;

/**
 * Register a field block's offset the way the scroll content reports it: the name
 * and identifier blocks own a wrapper `View`, while the role field hands its own
 * container to `containerOnLayout`.
 */
function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const field = findField(root, label);
  const wrapper = (field.parent?.props ?? {}) as WidgetProps;
  const handler = (field.props as WidgetProps).containerOnLayout ?? wrapper.onLayout;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  act(() => {
    (handler as LayoutHandler)({ nativeEvent: { layout: { y } } });
  });
}

function pressSave(root: ReactTestInstance): void {
  const [button, ...extra] = root.findAll(
    node => node.type === PRESSABLE && (node.props as WidgetProps).role === 'button'
  );
  if (button === undefined || extra.length > 0) {
    throw new Error(`expected one action button, received ${extra.length + 1}`);
  }
  const onPress = pressHandler((button.props as WidgetProps).onPress);
  act(() => {
    onPress();
  });
}

/** The strings the identifier block paints below the field: the hint line. */
function hintLines(root: ReactTestInstance): readonly string[] {
  const wrapper = findField(root, identifierLabel).parent;
  if (wrapper === null) {
    throw new Error('the identifier block was not rendered');
  }
  return wrapper
    .findAll(node => node.type === TEXT)
    .map(node => (node.props as WidgetProps).children)
    .filter(child => typeof child === 'string');
}

/* `renderWithProviders` returns no update path, so the modes list lives in props
 * of a test-owned wrapper: the test re-renders the same ModeForm instance with a
 * longer list by changing the wrapper's state, the way a refetched query would. */

/** The modes list a mounted create form sees, changeable through `renderWith`. */
type ModesBox = {
  modes: readonly OrgMode[];
  renderWith: (next: readonly OrgMode[]) => void;
};

function CreateFormHarness({ box }: Readonly<{ box: ModesBox }>) {
  const [, setVersion] = useState(0);
  box.renderWith = (next: readonly OrgMode[]) => {
    box.modes = next;
    act(() => {
      setVersion(version => version + 1);
    });
  };
  return createElement(ModeForm, {
    organizationId: 'org-1',
    mode: undefined,
    existingModes: box.modes,
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountCreateForm(modes: readonly OrgMode[] = existingModes) {
  const box: ModesBox = {
    modes,
    // Overwritten by the harness on mount; typed as a real body so the lint
    // rule for empty functions stays quiet.
    renderWith: () => undefined,
  };
  return renderWithProviders(createElement(CreateFormHarness, { box })).then(result => ({
    ...result,
    box,
  }));
}

/** The draft state the mounted form reads, settled through `settle`. */
type DraftBox = { settle: (value: OrgModeFormDraft | null) => void };

/**
 * A form whose draft state the test can settle: the mocked store is a plain
 * object, so swapping it needs a render of the same form instance.
 */
function DraftHarness({ box, mode }: Readonly<{ box: DraftBox; mode: OrgMode | undefined }>) {
  const [, setVersion] = useState(0);
  box.settle = value => {
    draft.state = { kind: 'ready', value, save: draft.save, clear: draft.clear };
    act(() => {
      setVersion(version => version + 1);
    });
  };
  return createElement(ModeForm, { organizationId: 'org-1', mode, existingModes });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountGatedForm(mode: OrgMode | undefined) {
  const box: DraftBox = {
    // Overwritten by the harness on mount; typed as a real body so the lint
    // rule for empty functions stays quiet.
    settle: () => undefined,
  };
  return renderWithProviders(createElement(DraftHarness, { box, mode })).then(result => ({
    ...result,
    box,
  }));
}

/** Run the mutation's success callback, the way a landed write does. */
function settleMutation(
  mutation: { mutate: { mock: { calls: unknown[][] } } },
  result?: unknown
): void {
  const call = mutation.mutate.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('the mutation never ran');
  }
  const options: unknown = call[1];
  if (
    options === null ||
    typeof options !== 'object' ||
    !('onSuccess' in options) ||
    typeof options.onSuccess !== 'function'
  ) {
    throw new Error('the mutation carried no success callback');
  }
  // Narrowing of a mutable property does not survive into a closure, so the
  // callback is captured once here.
  const onSuccess: (value: unknown) => void = options.onSuccess;
  act(() => {
    onSuccess(result);
  });
}

/** Press the destructive action and confirm the dialog it raises. */
function pressDelete(root: ReactTestInstance): void {
  const deleteButton = root
    .findAll(node => node.type === PRESSABLE && (node.props as WidgetProps).role === 'button')
    .at(1);
  if (deleteButton === undefined) {
    throw new Error('the delete button was not rendered');
  }
  act(() => {
    pressHandler((deleteButton.props as WidgetProps).onPress)();
  });
  const request: unknown = confirmMock.mock.calls.at(-1)?.[0];
  if (
    request === null ||
    request === undefined ||
    typeof request !== 'object' ||
    !('onConfirm' in request) ||
    typeof request.onConfirm !== 'function'
  ) {
    throw new Error('the removal confirmation was not raised');
  }
  const onConfirm: () => void = request.onConfirm;
  act(() => {
    onConfirm();
  });
}

/** A whole restored draft, with the one field a test cares about replaced. */
function restoredDraft(overrides: Partial<OrgModeFormDraft> = {}): OrgModeFormDraft {
  return {
    name: 'Drafted',
    slug: 'drafted',
    roleDefinition: 'Drafted role.',
    description: '',
    whenToUse: '',
    customInstructions: '',
    groups: [],
    editFileRegex: '',
    editRestrictionLabel: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every case starts with the store answering no draft, so the form renders
  // its fields at once; a case that needs the loading phase sets it first.
  draft.state = { kind: 'ready', value: null, save: draft.save, clear: draft.clear };
});

describe('ModeForm refused save', () => {
  it('reveals the identifier a Save refuses, past the fields above it', async () => {
    const { renderer, unmount } = await mountCreateForm();
    changeField(renderer.root, nameLabel, 'Security Reviewer');
    changeField(renderer.root, roleLabel, 'Reviews every change.');
    changeField(renderer.root, identifierLabel, 'Reviewer');
    layoutField(renderer.root, nameLabel, NAME_OFFSET);
    layoutField(renderer.root, identifierLabel, IDENTIFIER_OFFSET);
    layoutField(renderer.root, roleLabel, ROLE_OFFSET);

    pressSave(renderer.root);

    expect(fieldProps(renderer.root, identifierLabel).error).toBe(
      i18n.t('organization.modes.identifierInvalid')
    );
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({
      y: IDENTIFIER_OFFSET - FIELD_TOP_MARGIN,
      animated: true,
    });
    expect(mutations.create.mutate).not.toHaveBeenCalled();

    unmount();
  });

  it('reveals the role field when every field above it passes', async () => {
    const { renderer, unmount } = await mountCreateForm();
    changeField(renderer.root, nameLabel, 'Security Reviewer');
    layoutField(renderer.root, nameLabel, NAME_OFFSET);
    layoutField(renderer.root, identifierLabel, IDENTIFIER_OFFSET);
    layoutField(renderer.root, roleLabel, ROLE_OFFSET);

    pressSave(renderer.root);

    expect(fieldProps(renderer.root, identifierLabel).error).toBeUndefined();
    expect(fieldProps(renderer.root, roleLabel).error).toBe(
      i18n.t('organization.modes.roleRequired')
    );
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ y: ROLE_OFFSET - FIELD_TOP_MARGIN, animated: true });
    expect(mutations.create.mutate).not.toHaveBeenCalled();

    unmount();
  });
});

describe('ModeForm identifier hint', () => {
  it('offers the fallback identifier for a name with no Latin letters or digits', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'مراجع الأمن');

    expect(hintLines(renderer.root)).toContain(`mode · ${identifierHint}`);

    unmount();
  });

  it('keeps the folded suggestion for a name with Latin letters', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'Security Reviewer');

    expect(hintLines(renderer.root)).toContain(`security-reviewer · ${identifierHint}`);

    unmount();
  });

  it('folds an accented name to base letters in the suggested identifier', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'Revisor de Código');

    expect(hintLines(renderer.root)).toContain(`revisor-de-codigo · ${identifierHint}`);

    unmount();
  });

  it('saves a create with the folded identifier an accented name derives', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'Revisor de Código');
    changeField(renderer.root, roleLabel, 'Reviews every change.');

    pressSave(renderer.root);

    expect(mutations.create.mutate).toHaveBeenCalledOnce();
    expect(mutations.create.mutate).toHaveBeenCalledWith(
      { name: 'Revisor de Código', slug: 'revisor-de-codigo', config: expect.anything() },
      expect.anything()
    );

    unmount();
  });

  it('re-derives the suggestion when the modes list arrives after the name was typed', async () => {
    const { renderer, box, unmount } = await mountCreateForm([]);

    changeField(renderer.root, nameLabel, 'مراجع الأمن');
    expect(hintLines(renderer.root)).toContain(`mode · ${identifierHint}`);

    box.renderWith([...existingModes, storedMode('mode-3', 'The fallback', 'mode')]);
    expect(hintLines(renderer.root)).toContain(`mode-2 · ${identifierHint}`);

    unmount();
  });

  it('shows the plain hint again once the name is cleared', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'مراجع الأمن');
    changeField(renderer.root, nameLabel, '');

    const lines = hintLines(renderer.root);
    expect(lines).toContain(identifierHint);
    expect(lines).not.toContain(` · ${identifierHint}`);

    unmount();
  });

  it('saves a create with the derived identifier when the person left it empty', async () => {
    const { renderer, unmount } = await mountCreateForm();

    changeField(renderer.root, nameLabel, 'مراجع الأمن');
    changeField(renderer.root, roleLabel, 'Reviews every change.');

    pressSave(renderer.root);

    expect(mutations.create.mutate).toHaveBeenCalledOnce();
    expect(mutations.create.mutate).toHaveBeenCalledWith(
      { name: 'مراجع الأمن', slug: 'mode', config: expect.anything() },
      expect.anything()
    );

    unmount();
  });
});

describe('ModeForm durable draft', () => {
  it('holds a create back until the stored draft settles, then seeds every field', async () => {
    draft.state = { kind: 'loading' };
    const { renderer, box, unmount } = await mountGatedForm(undefined);

    // No server record exists, so the form shows its loading state rather than
    // an empty body a restored draft could no longer seed.
    expect(renderer.root.findAll(node => node.type === FormField)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton').length).toBeGreaterThan(
      0
    );

    box.settle(restoredDraft());

    expect(fieldProps(renderer.root, nameLabel).defaultValue).toBe('Drafted');
    expect(fieldProps(renderer.root, identifierLabel).defaultValue).toBe('drafted');
    expect(fieldProps(renderer.root, roleLabel).defaultValue).toBe('Drafted role.');

    unmount();
  });

  it('applies a late draft to an edit form the person has not touched', async () => {
    draft.state = { kind: 'loading' };
    const { renderer, box, unmount } = await mountGatedForm(existingModes[0]);

    // The server row is the content while the stored draft loads.
    expect(fieldProps(renderer.root, nameLabel).defaultValue).toBe('Architect');

    box.settle(restoredDraft());

    expect(fieldProps(renderer.root, nameLabel).defaultValue).toBe('Drafted');
    expect(fieldProps(renderer.root, identifierLabel).defaultValue).toBe('drafted');

    unmount();
  });

  it('never overwrites an edit form the person already typed into', async () => {
    draft.state = { kind: 'loading' };
    const { renderer, box, unmount } = await mountGatedForm(existingModes[0]);

    changeField(renderer.root, nameLabel, 'Typed now');
    box.settle(restoredDraft());

    // The person's text survives the late draft: the field still carries what
    // they typed, and the identifier stays the server row's, never the draft's
    // `drafted`. (`defaultValue` re-reads the mutated ref, so the assertion is
    // that the draft's value never replaced it.)
    expect(fieldProps(renderer.root, nameLabel).defaultValue).toBe('Typed now');
    expect(fieldProps(renderer.root, identifierLabel).defaultValue).toBe('architect');
    changeField(renderer.root, nameLabel, 'Typed now!');
    expect(draft.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Typed now!', slug: 'architect' })
    );

    unmount();
  });

  it('writes the whole form into the draft on every edit', async () => {
    const { renderer, unmount } = await mountGatedForm(undefined);

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    changeField(renderer.root, roleLabel, 'Reviews every change.');

    expect(draft.save).toHaveBeenCalledTimes(2);
    expect(draft.save).toHaveBeenLastCalledWith({
      name: 'Security Reviewer',
      slug: '',
      roleDefinition: 'Reviews every change.',
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: [],
      editFileRegex: '',
      editRestrictionLabel: '',
    });

    unmount();
  });

  it('clears the stored draft once the create lands', async () => {
    const { renderer, unmount } = await mountGatedForm(undefined);

    changeField(renderer.root, nameLabel, 'Security Reviewer');
    changeField(renderer.root, roleLabel, 'Reviews every change.');
    pressSave(renderer.root);
    settleMutation(mutations.create);

    expect(draft.clear).toHaveBeenCalledOnce();

    unmount();
  });

  it('clears the stored draft once the removal lands', async () => {
    const { renderer, unmount } = await mountGatedForm(existingModes[0]);

    pressDelete(renderer.root);
    settleMutation(mutations.remove);

    expect(draft.clear).toHaveBeenCalledOnce();

    unmount();
  });

  it('hands the leave guard the draft clear for a confirmed Discard', async () => {
    const { unmount } = await mountGatedForm(undefined);

    expect(leaveGuard.props.onDiscard).toBe(draft.clear);

    unmount();
  });
});
