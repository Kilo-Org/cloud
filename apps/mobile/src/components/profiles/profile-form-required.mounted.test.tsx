/**
 * Pins the required marker on both profile sheets' markdown content fields.
 * Their validators refuse an empty value, so the field must announce required
 * the way the name field above it already does; without the prop the marker
 * never reaches the composed accessibility label.
 */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstructionFormSheet } from '@/components/profiles/instruction-form-sheet';
import { SkillFormSheet } from '@/components/profiles/skill-form-sheet';
import { i18n } from '@/i18n';
import { type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { resetFormDraftsForTests } from '@/lib/form-draft';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  onSave: vi.fn(),
  scrollTo: vi.fn(),
}));

// A mock factory is hoisted above this file's imports, so React comes in through a
// dynamic import there (the pattern the sheet suites' harness already relies on).
// The stub exposes `scrollTo`, which the sheets' field scroll helper holds.
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
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

/** A host stub's element name arrives as a string; the siblings' suites look one up the same way. */
function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The stubbed field the sheet rendered under `label`, found by that prop. */
function fieldByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountInstructionSheet() {
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

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountSkillSheet() {
  return renderWithProviders(
    createElement(SkillFormSheet, {
      skill: null,
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

describe('InstructionFormSheet required fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('marks the name and content fields required', async () => {
    const { renderer, unmount } = await mountInstructionSheet();

    const name = fieldByLabel(renderer.root, i18n.t('profiles.instructionNameLabel'));
    const content = fieldByLabel(renderer.root, i18n.t('profiles.instructionContentLabel'));

    expect(name.props.required).toBe(true);
    expect(content.props.required).toBe(true);

    unmount();
  });
});

describe('SkillFormSheet required fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFormDraftsForTests();
  });

  it('marks the name and markdown fields required', async () => {
    const { renderer, unmount } = await mountSkillSheet();

    const name = fieldByLabel(renderer.root, i18n.t('profiles.skillNameLabel'));
    const content = fieldByLabel(renderer.root, i18n.t('profiles.skillMarkdownLabel'));

    expect(name.props.required).toBe(true);
    expect(content.props.required).toBe(true);

    unmount();
  });
});
