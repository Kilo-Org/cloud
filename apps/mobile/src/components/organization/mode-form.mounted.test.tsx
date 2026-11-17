import { createElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeForm } from '@/components/organization/mode-form';
import { type OrgMode } from '@/components/organization/org-mode-form-model';
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
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/lib/hooks/use-org-modes-queries', () => ({
  useOrgModeMutations: () => mutations,
}));
vi.mock('@/lib/navigation/pop-once', () => ({ usePopOnce: () => vi.fn() }));
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: vi.fn() }),
}));
vi.mock('@/components/profiles/use-metadata-leave-guard', () => ({
  useMetadataLeaveGuard: () => ({
    handleDirtyChange: vi.fn(),
    leaveWithoutAsking: vi.fn(),
    dialog: null,
  }),
}));
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

beforeEach(() => {
  vi.clearAllMocks();
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
