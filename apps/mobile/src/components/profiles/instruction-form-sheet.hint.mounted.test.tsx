/**
 * What the row under the file-name field shows, and how the preview inside it is
 * cut. The row is reserved at one line of the catalog's preview copy, so the
 * preview must stay inside that one line; the preview carries the only new
 * information on the line, so it is cut in the middle rather than at its tail,
 * which would hide the end of the name a save writes. These cases pin one
 * preview line cut in the middle plus its one-line reserve, and the rule the
 * name field states as its own error while the fold leaves nothing to store,
 * with Done dimmed for it.
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
    // The reserve and the painted preview: exactly the two nodes the row spends
    // on its one line.
    expect(line).toHaveLength(2);

    const painted = line.filter(node => node.props.ellipsizeMode === 'middle');
    expect(painted).toHaveLength(1);
    expect(painted[0]?.props.numberOfLines).toBe(1);

    unmount();
  });

  it('reserves the row at one text line of the preview copy in every state', async () => {
    const { renderer, unmount } = await mountSheet();

    // Blank, a name that saves as typed, and a name with nothing left after the
    // fold: all three keep the same one-line reserve, and the reserve always
    // carries the preview sentence rather than the longer rule.
    const states: readonly (readonly [typed: string, slug: string])[] = [
      ['', ''],
      ['release-notes', ''],
      ['Release Notes', 'release-notes'],
      ['पुणे कार्यालय नियम', ''],
    ];
    for (const [typed, slug] of states) {
      typeName(renderer.root, typed);

      const reserve = findAll(renderer.root, 'Text').filter(
        node => node.props.pointerEvents === 'none' && node.props.importantForAccessibility
      );
      expect(reserve).toHaveLength(1);
      expect(reserve[0]?.props.numberOfLines).toBe(1);
      expect(reserve[0]?.props.className).toContain('opacity-0');
      expect(reserve[0]?.props.children).toBe(
        i18n.t('profiles.instructionNamePreview', { name: slug })
      );
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
