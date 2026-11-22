/**
 * What the row under the file-name field shows, and how the preview inside it is
 * cut. The row is reserved by the rule sentence, so the preview must stay inside
 * that room; the preview carries the only new information on the line, so it is
 * cut in the middle rather than at its tail, which would hide the end of the
 * name a save writes. These cases pin one preview line cut in the middle, and
 * the rule stated in the same row when the fold leaves nothing to store.
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

    const preview = findAll(renderer.root, 'Text').filter(
      node =>
        node.props.children ===
        i18n.t('profiles.instructionNamePreview', {
          name: 'release-notes-for-the-nightly-dependency-upgrade-reviewer-with-extra-words',
        })
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]?.props.numberOfLines).toBe(1);
    expect(preview[0]?.props.ellipsizeMode).toBe('middle');

    unmount();
  });

  it('states the rule instead when the fold leaves no file name to store', async () => {
    const { renderer, unmount } = await mountSheet();

    typeName(renderer.root, 'पुणे कार्यालय नियम');

    const rule = i18n.t('profiles.instructionNameInvalid');
    const announced = findAll(renderer.root, 'AccessibleStatus').filter(
      node => node.props.message === rule
    );
    expect(announced).toHaveLength(1);
    expect(announced[0]?.props.tone).toBe('status');

    unmount();
  });
});
