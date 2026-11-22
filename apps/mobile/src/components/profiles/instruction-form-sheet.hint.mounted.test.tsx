/**
 * What the row under the file-name field shows, and how the preview inside it is
 * cut. The row exists only while a save would store a different slug, so every
 * other state leaves the section gap between the name field and the content
 * label untouched; the preview carries the only new information on that row, so
 * it is cut in the middle rather than at its tail, which would hide the end of
 * the name a save writes. These cases pin one mounted preview line cut in the
 * middle and its absence in the other states, and the rule the name field states
 * as its own error while the fold leaves nothing to store, with Done dimmed for
 * it.
 */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstructionFormSheet } from '@/components/profiles/instruction-form-sheet';
import { i18n } from '@/i18n';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern the sibling sheet suites rely on).
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
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

/** The stubbed elements the sheet rendered under one element name. */
function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** Types into the name field the way the field reports a keystroke. */
function typeName(root: ReactTestInstance, value: string): void {
  const onChangeText: unknown = findAll(root, 'FormField').find(
    node => node.props.label === i18n.t('profiles.instructionNameLabel')
  )?.props.onChangeText;
  if (typeof onChangeText !== 'function') {
    throw new TypeError('the name field has no change handler');
  }
  act(() => {
    (onChangeText as (text: string) => void)(value);
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSheet() {
  return renderWithProviders(
    createElement(InstructionFormSheet, {
      instruction: null,
      isSaving: false,
      onClose: () => {
        h.onClose();
      },
      onSave: (submission: unknown) => {
        h.onSave(submission);
        return Promise.resolve();
      },
    })
  );
}

/** The name field the sheet rendered, found by its label. */
function nameField(root: ReactTestInstance): ReactTestInstance {
  const field = findAll(root, 'FormField').find(
    node => node.props.label === i18n.t('profiles.instructionNameLabel')
  );
  if (!field) {
    throw new Error('the name field was not rendered');
  }
  return field;
}

/** The header's Done state as the sheet renders it. */
function doneDisabled(root: ReactTestInstance): boolean {
  const header = findAll(root, 'SheetHeader')[0];
  if (!header) {
    throw new Error('the header was not rendered');
  }
  return header.props.doneDisabled === true;
}

describe('InstructionFormSheet file-name line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('keeps a folded name on one line, cut in the middle so both ends stay readable', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(
      renderer.root,
      'Release Notes For The Nightly Dependency Upgrade Reviewer With Extra Words'
    );

    const previewCopy = i18n.t('profiles.instructionNamePreview', {
      name: 'release-notes-for-the-nightly-dependency-upgrade-reviewer-with-extra-words',
    });
    const line = findAll(renderer.root, 'Text').filter(node => node.props.children === previewCopy);
    // Exactly the one node the row spends on its single line.
    expect(line).toHaveLength(1);
    expect(line[0]?.props.ellipsizeMode).toBe('middle');
    expect(line[0]?.props.numberOfLines).toBe(1);

    unmount();
  });

  it('mounts the preview row only for a name a save would rewrite', async () => {
    const { renderer, unmount } = await mountSheet();

    // Only a name a save would rewrite gets a row. Every other state renders no
    // preview and no placeholder, so the gap between the name field's own error
    // and the content label stays the form's section gap.
    const states: readonly (readonly [typed: string, slug: string | null])[] = [
      ['', null],
      ['release-notes', null],
      ['पुणे कार्यालय नियम', null],
      ['Release Notes', 'release-notes'],
    ];
    for (const [typed, slug] of states) {
      typeName(renderer.root, typed);

      // The preview row is the one single-line, middle-cut line under the
      // field. A blank name, a name that saves as typed and an unusable name
      // render none of it, so no blank line separates the field from the label
      // below.
      const rows = findAll(renderer.root, 'Text').filter(
        node => node.props.ellipsizeMode === 'middle'
      );
      if (slug === null) {
        expect(rows).toHaveLength(0);
      } else {
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.numberOfLines).toBe(1);
        expect(rows[0]?.props.children).toBe(
          i18n.t('profiles.instructionNamePreview', { name: slug })
        );
      }
    }

    unmount();
  });

  it('states the rule as the field error and dims Done when the fold leaves no file name', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'पुणे कार्यालय नियम');

    const rule = i18n.t('profiles.instructionNameInvalid');
    expect(nameField(renderer.root).props.error).toBe(rule);
    expect(doneDisabled(renderer.root)).toBe(true);
    // The row no longer states the rule in its own line: the rule reaches the
    // screen only through the field's error, so no text the sheet renders
    // carries it. A Text that repeated the rule here would fail this check.
    const texts = findAll(renderer.root, 'Text').map(node => node.props.children);
    expect(texts).not.toContain(rule);

    unmount();
  });

  it('leaves Done enabled for a name that saves', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'release-notes');

    expect(nameField(renderer.root).props.error).toBeUndefined();
    expect(doneDisabled(renderer.root)).toBe(false);

    unmount();
  });
});
