/**
 * What the helper row under the file-name field shows, and how the preview
 * inside it is cut. The row is always mounted and reserves the rule's wrapped
 * height in native layout, so the name `FormField` — and everything under it —
 * keeps one position whether the row shows the slug preview, the rule or
 * nothing at all. The preview carries the only new information it can hold, so
 * it is cut in the middle rather than at its tail, which would hide the end of
 * the name a save writes. These cases pin one mounted preview line cut in the
 * middle, the reservation that keeps the row's height in every state, and the
 * rule painted on that row (with the field's boundary following it and Done
 * dimmed) while the fold leaves nothing to store.
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
vi.mock('@/components/ui/accessible-status', async () => {
  const { createElement: createMockElement } = await import('react');
  return {
    // The real status renders its message as a `Text`, so the row's painted
    // copy lands in the same tree shape here.
    AccessibleStatus: ({
      message,
      className,
      tone = 'error',
    }: {
      message: string | null;
      className?: string;
      tone?: string;
    }) =>
      message === null ? null : createMockElement('Text', { className, tone, children: message }),
  };
});
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

/** The stubbed elements the sheet rendered under one element name. */
function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The helper row the sheet keeps under the name field, in every state. */
function hintRow(root: ReactTestInstance): ReactTestInstance {
  const row = findAll(root, 'View').find(node => node.props.className === '-mt-2');
  if (!row) {
    throw new Error('the helper row under the name field was not rendered');
  }
  return row;
}

/**
 * The row's copies of `copy`, split into the ones the reservation holds (the
 * zero-opacity copy in native layout) and the ones the caller can see.
 */
function rowCopies(
  row: ReactTestInstance,
  copy: string
): { hidden: ReactTestInstance[]; visible: ReactTestInstance[] } {
  const texts = findAll(row, 'Text').filter(node => node.props.children === copy);
  return {
    hidden: texts.filter(node => String(node.props.className).includes('opacity-0')),
    visible: texts.filter(node => !String(node.props.className).includes('opacity-0')),
  };
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

/** Presses the header's Done control the way the header reports the press. */
function pressDone(root: ReactTestInstance): void {
  const onDone: unknown = findAll(root, 'SheetHeader')[0]?.props.onDone;
  if (typeof onDone !== 'function') {
    throw new TypeError('the header has no done handler');
  }
  act(() => {
    (onDone as () => void)();
  });
}

describe('InstructionFormSheet file-name row', () => {
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

  it('keeps the row mounted in every state, reserving the rule while the preview comes and goes', async () => {
    const { renderer, unmount } = await mountSheet();

    const rule = i18n.t('profiles.instructionNameInvalid');
    // The row is mounted before a keystroke too: its reservation never arrives
    // late, so the content label never sits where the row was about to appear.
    expect(rowCopies(hintRow(renderer.root), rule).hidden).toHaveLength(1);

    // Only a name a save would rewrite paints the preview; the row holds its
    // height in every one of these states.
    const states: readonly (readonly [typed: string, slug: string | null])[] = [
      ['', null],
      ['release-notes', null],
      ['पुणे कार्यालय नियम', null],
      ['Release Notes', 'release-notes'],
    ];
    for (const [typed, slug] of states) {
      typeName(renderer.root, typed);

      const row = hintRow(renderer.root);
      const ruleIsShown = typed === 'पुणे कार्यालय नियम';
      // The rule's own copy is in the row in every state, and it is the row's
      // visible content exactly while the rule shows: the sentence holds the
      // slot then, so it is never painted twice in place.
      const copies = rowCopies(row, rule);
      expect(copies.hidden.length + copies.visible.length).toBeGreaterThanOrEqual(1);
      if (ruleIsShown) {
        expect(copies.hidden).toHaveLength(0);
        expect(copies.visible).toHaveLength(1);
      } else {
        expect(copies.hidden).toHaveLength(1);
        expect(copies.visible).toHaveLength(0);
        expect(copies.hidden[0]?.props.accessibilityElementsHidden).toBe(true);
        expect(copies.hidden[0]?.props.importantForAccessibility).toBe('no-hide-descendants');
      }

      // The visible line: the preview for a name a save would rewrite, and none
      // in the other states.
      const previews = findAll(row, 'Text').filter(node => node.props.ellipsizeMode === 'middle');
      if (slug === null) {
        expect(previews).toHaveLength(0);
      } else {
        expect(previews).toHaveLength(1);
        expect(previews[0]?.props.numberOfLines).toBe(1);
        expect(previews[0]?.props.children).toBe(
          i18n.t('profiles.instructionNamePreview', { name: slug })
        );
      }
    }

    unmount();
  });

  it('paints the rule on the row and dims Done when the fold leaves no file name', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'पुणे कार्यालय नियम');

    const rule = i18n.t('profiles.instructionNameInvalid');
    const row = hintRow(renderer.root);
    // The rule is painted in the row's own slot, at the row's caption size, in
    // the space the reservation keeps. The field contributes the boundary and
    // the spoken name, never a second sentence under the row.
    const painted = rowCopies(row, rule).visible;
    expect(painted).toHaveLength(1);
    expect(painted[0]?.props.className).toBe('text-xs');
    expect(nameField(renderer.root).props.outsideError).toBe(rule);
    expect(nameField(renderer.root).props.error).toBeUndefined();
    expect(doneDisabled(renderer.root)).toBe(true);

    unmount();
  });

  it('states the rule once when a refused save reports it too', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'पुणे कार्यालय नियम');
    // Done is dimmed for this input, but the header still reports a press, and
    // the refused save reports `bad-name` — the row's own sentence.
    pressDone(renderer.root);

    const rule = i18n.t('profiles.instructionNameInvalid');
    // One painted copy in the whole sheet: the row's. The field paints nothing
    // for `bad-name`, because the same sentence is already on the row, and the
    // row's reservation is not a second copy while the rule itself shows.
    const copies = rowCopies(renderer.root, rule);
    expect(copies.visible).toHaveLength(1);
    expect(copies.hidden).toHaveLength(0);
    expect(nameField(renderer.root).props.error).toBeUndefined();
    expect(nameField(renderer.root).props.outsideError).toBe(rule);
    expect(doneDisabled(renderer.root)).toBe(true);

    unmount();
  });

  it('leaves Done enabled for a name that saves', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'release-notes');

    expect(nameField(renderer.root).props.error).toBeUndefined();
    expect(nameField(renderer.root).props.outsideError).toBeUndefined();
    expect(doneDisabled(renderer.root)).toBe(false);

    unmount();
  });
});
