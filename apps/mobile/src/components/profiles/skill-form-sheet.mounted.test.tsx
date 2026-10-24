import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillFormSheet } from '@/components/profiles/skill-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  confirm: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern this suite's harness already relies on). The
// stub exposes `scrollTo`, which a refused Save drives, so tests can observe it.
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    View: 'View',
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
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
  }),
}));

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** The sheet's dismissal request answers whether it may close. */
function booleanHandler(value: unknown): () => boolean {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => boolean;
}

/** A field stub's onChangeText arrives untyped from the host element. */
function textHandler(value: unknown): (text: string) => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a text handler');
  }
  return value as (text: string) => void;
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

function changeText(root: ReactTestInstance, label: string, value: string): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  const onChangeText = textHandler(field.props.onChangeText);
  act(() => {
    onChangeText(value);
  });
}

function pressCancel(root: ReactTestInstance): void {
  const onCancel = voidHandler(findOne(root, 'SheetHeader').props.onCancel);
  act(() => {
    onCancel();
  });
}

/** Save through the header's done control. */
function pressDone(root: ReactTestInstance): void {
  const onDone = voidHandler(findOne(root, 'SheetHeader').props.onDone);
  act(() => {
    onDone();
  });
}

/** A host stub's layout prop, read from the renderer's untyped props. */
type ContainerLayout = (event: { nativeEvent: { layout: { y: number } } }) => void;

/** Register a field block's offset the way the scroll view reports it after layout. */
function layoutField(root: ReactTestInstance, label: string, y: number): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  const handler: unknown = field.props.containerOnLayout;
  if (typeof handler !== 'function') {
    throw new TypeError(`field ${label} has no layout handler`);
  }
  // Checked to be a function above; the stub props carry no call signature.
  const onLayout = handler as ContainerLayout;
  act(() => {
    onLayout({ nativeEvent: { layout: { y } } });
  });
}

/** The name field as rendered after the latest prefill. */
function nameField(root: ReactTestInstance): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === 'Skill name');
  if (!field) {
    throw new Error('field Skill name was not rendered');
  }
  return field;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet(skill: { name: string; rawMarkdown: string } | null = null) {
  return renderWithProviders(
    createElement(SkillFormSheet, {
      skill,
      isSaving: false,
      onClose: () => {
        h.onClose();
      },
      onSave: (submission: unknown) => {
        h.onSave(submission);
      },
    })
  );
}

describe('SkillFormSheet dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes an untouched sheet without asking', async () => {
    const { renderer, unmount } = await mountSheet();

    pressCancel(renderer.root);

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();

    unmount();
  });

  it('asks before Cancel drops typed markdown, and refuses Android Back while dirty', async () => {
    const { renderer, unmount } = await mountSheet();

    changeText(renderer.root, 'Skill name', 'reviewer');
    changeText(renderer.root, 'Skill content', '# Reviewer');

    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );
    expect(requestDismiss()).toBe(false);

    pressCancel(renderer.root);

    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.confirm.mock.calls[1]?.[0]).toMatchObject({
      title: i18n.t('common.discardChangesTitle'),
      message: i18n.t('common.discardChangesMessage'),
      confirmLabel: i18n.t('common.discard'),
      cancelLabel: i18n.t('common.keepEditing'),
    });
    expect(h.onClose).not.toHaveBeenCalled();

    unmount();
  });
});

describe('SkillFormSheet name fill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fills the name from frontmatter and clears the empty-name error', async () => {
    const { renderer, unmount } = await mountSheet();

    pressDone(renderer.root);
    expect(nameField(renderer.root).props.error).toBe(i18n.t('profiles.skillNameRequired'));

    changeText(renderer.root, 'Skill content', ['---', 'name: My Skill', '---', 'Body'].join('\n'));

    expect(nameField(renderer.root).props.defaultValue).toBe('my-skill');
    expect(nameField(renderer.root).props.error).toBeUndefined();

    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledWith({
      name: 'my-skill',
      rawMarkdown: ['---', 'name: My Skill', '---', 'Body'].join('\n'),
    });

    unmount();
  });

  it('leaves the name empty for a frontmatter name the server rejects', async () => {
    const { renderer, unmount } = await mountSheet();

    changeText(
      renderer.root,
      'Skill content',
      ['---', 'name: مراجعة الجودة', '---', 'Body'].join('\n')
    );

    expect(nameField(renderer.root).props.defaultValue).toBe('');

    pressDone(renderer.root);
    expect(h.onSave).not.toHaveBeenCalled();
    expect(nameField(renderer.root).props.error).toBe(i18n.t('profiles.skillNameRequired'));

    unmount();
  });

  it('keeps a typed name when frontmatter arrives later', async () => {
    const { renderer, unmount } = await mountSheet();

    changeText(renderer.root, 'Skill name', 'my-review');
    changeText(
      renderer.root,
      'Skill content',
      ['---', 'name: other-skill', '---', 'Body'].join('\n')
    );

    expect(nameField(renderer.root).props.defaultValue).toBe('');
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledWith({
      name: 'my-review',
      rawMarkdown: ['---', 'name: other-skill', '---', 'Body'].join('\n'),
    });

    unmount();
  });
});

describe('SkillFormSheet refused save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls to the name field when the name is missing', async () => {
    const { renderer, unmount } = await mountSheet();
    layoutField(renderer.root, 'Skill name', 420);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 408, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('scrolls to the content field when only the content is missing', async () => {
    const { renderer, unmount } = await mountSheet();
    changeText(renderer.root, 'Skill name', 'my-skill');
    layoutField(renderer.root, 'Skill content', 900);

    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 888, animated: true });
    expect(h.onSave).not.toHaveBeenCalled();

    unmount();
  });

  it('leaves the sheet alone for a save that passes or a field that never laid out', async () => {
    const { renderer, unmount } = await mountSheet();

    pressDone(renderer.root);
    expect(h.scrollTo).not.toHaveBeenCalled();

    changeText(renderer.root, 'Skill name', 'my-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    layoutField(renderer.root, 'Skill name', 200);
    layoutField(renderer.root, 'Skill content', 300);
    pressDone(renderer.root);

    expect(h.scrollTo).not.toHaveBeenCalled();
    expect(h.onSave).toHaveBeenCalledWith({ name: 'my-skill', rawMarkdown: 'Body' });

    unmount();
  });
});
