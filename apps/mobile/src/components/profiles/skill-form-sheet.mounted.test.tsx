/* eslint-disable max-lines -- one mounted case per sheet state: dismissal, name fill, refused save, and save failure */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillFormSheet } from '@/components/profiles/skill-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

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
    Platform: { OS: 'ios' },
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
function mountSheet(
  skill: { name: string; rawMarkdown: string } | null = null,
  options: { saveFailure?: string | null; saveFailureTone?: 'error' | 'warn' } = {}
) {
  return renderWithProviders(
    createElement(SkillFormSheet, {
      skill,
      isSaving: false,
      saveFailure: options.saveFailure ?? null,
      saveFailureTone: options.saveFailureTone,
      onClose: () => {
        h.onClose();
      },
      onSave: (submission: unknown) => {
        h.onSave(submission);
      },
    })
  );
}

/** The block the sheet puts above its fields, which carries a save failure's line. */
function statusBlock(root: ReactTestInstance): ReactTestInstance {
  const [block] = findOne(root, 'ScrollView').children;
  if (block === undefined || typeof block === 'string') {
    throw new TypeError('the sheet rendered no status block above its fields');
  }
  return block;
}

describe('SkillFormSheet dismissal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
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
    resetFormDraftsForTests();
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
    resetFormDraftsForTests();
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

describe('SkillFormSheet save failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('shows the refused save above the fields and keeps the typed input', async () => {
    const { renderer, unmount } = await mountSheet(null, {
      saveFailure: i18n.t('profiles.skillSaveFailed'),
    });

    expect(findAll(statusBlock(renderer.root), 'Text').map(node => node.props.children)).toEqual([
      i18n.t('profiles.skillSaveFailed'),
    ]);
    expect(findOne(renderer.root, 'SheetHeader').props.doneDisabled).toBe(false);

    unmount();
  });

  it('scrolls the failure block into view once it lays out', async () => {
    const { renderer, unmount } = await mountSheet(null, {
      saveFailure: i18n.t('profiles.skillSaveFailed'),
    });

    const onLayout = statusBlock(renderer.root).props.onLayout as ContainerLayout | undefined;
    if (typeof onLayout !== 'function') {
      throw new TypeError('the status block has no layout handler');
    }
    act(() => {
      onLayout({ nativeEvent: { layout: { y: 150 } } });
    });

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 138, animated: true });

    unmount();
  });

  it('paints an expected limit as a warning and a refusal as an error', async () => {
    const limit = await mountSheet(null, {
      saveFailure: i18n.t('profiles.skillLimitReached', { max: 50 }),
      saveFailureTone: 'warn',
    });
    expect(String(findAll(statusBlock(limit.renderer.root), 'Text')[0]?.props.className)).toContain(
      'text-warn'
    );
    limit.unmount();

    const refusal = await mountSheet(null, {
      saveFailure: i18n.t('profiles.skillSaveFailed'),
    });
    expect(
      String(findAll(statusBlock(refusal.renderer.root), 'Text')[0]?.props.className)
    ).toContain('text-destructive');
    refusal.unmount();
  });

  it('scrolls back to a failure that stayed on screen when Save is pressed again', async () => {
    const { renderer, unmount } = await mountSheet(null, {
      saveFailure: i18n.t('profiles.skillSaveFailed'),
    });
    const onLayout = statusBlock(renderer.root).props.onLayout as ContainerLayout | undefined;
    if (typeof onLayout !== 'function') {
      throw new TypeError('the status block has no layout handler');
    }
    act(() => {
      onLayout({ nativeEvent: { layout: { y: 150 } } });
    });
    h.scrollTo.mockClear();

    changeText(renderer.root, 'Skill name', 'my-skill');
    changeText(renderer.root, 'Skill content', 'Body');
    pressDone(renderer.root);

    expect(h.scrollTo).toHaveBeenCalledWith({ y: 138, animated: true });
    expect(h.onSave).toHaveBeenCalledWith({ name: 'my-skill', rawMarkdown: 'Body' });

    unmount();
  });

  it('renders no block and does not scroll when no save failed', async () => {
    const { renderer, unmount } = await mountSheet();

    const [first] = findOne(renderer.root, 'ScrollView').children;
    if (first === undefined || typeof first === 'string') {
      throw new TypeError('the sheet rendered no content child');
    }
    expect(first.type).toBe('Text');
    expect(h.scrollTo).not.toHaveBeenCalled();

    unmount();
  });
});
