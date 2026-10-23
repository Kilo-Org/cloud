import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillFormSheet } from '@/components/profiles/skill-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
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
