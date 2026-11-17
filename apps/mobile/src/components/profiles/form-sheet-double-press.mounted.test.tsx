/* eslint-disable max-lines -- one file holds the double-press case of every profile form sheet */
import { createElement, type ReactNode, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFormSheet } from '@/components/profiles/agent-form-sheet';
import { InstructionFormSheet } from '@/components/profiles/instruction-form-sheet';
import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';
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

// The same host stubs the per-sheet suites use: the sheets render through the
// mocked primitives, and `ScrollView` exposes `scrollTo` for a refused save.
vi.mock('react-native', async () => {
  const {
    createElement: createMockElement,
    forwardRef,
    useImperativeHandle,
  } = await import('react');
  return {
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
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
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));
vi.mock('@/components/ui/agent-variant-picker', () => ({
  AgentVariantPicker: 'AgentVariantPicker',
}));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/segmented-control', () => ({
  SegmentedControl: 'SegmentedControl',
}));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      h.confirm(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [], isLoading: false }),
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

/** Save through the header's done control. */
function pressDone(root: ReactTestInstance): void {
  const onDone = voidHandler(findOne(root, 'SheetHeader').props.onDone);
  act(() => {
    onDone();
  });
}

/** The header's Done disabled state as the sheet renders it. */
function doneDisabled(root: ReactTestInstance): boolean {
  return findOne(root, 'SheetHeader').props.doneDisabled === true;
}

/**
 * The dismiss guard's confirm request, read back from the mocked dialog. One
 * double-press burst must never raise the "Discard changes?" question through
 * it.
 */
function confirmRequests(): unknown[] {
  return h.confirm.mock.calls.map(call => call[0]);
}

/** Flush the save promise the sheet rides, then let React settle. */
async function settleSave(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A save promise that stays in flight until the test unmounts the sheet. */
function neverSettles(): Promise<void> {
  return new Promise(resolve => {
    resolversRef.current = resolve;
  });
}

/** The pending resolver of the current `neverSettles()` promise. */
const resolversRef: { current: (() => void) | null } = { current: null };

beforeEach(() => {
  vi.clearAllMocks();
  resetFormDraftsForTests();
  resolversRef.current = null;
});

describe('InstructionFormSheet double press', () => {
  function mount() {
    return renderWithProviders(
      createElement(InstructionFormSheet, {
        instruction: { name: 'existing-rule', content: 'stored text' },
        isSaving: false,
        onClose: () => {
          h.onClose();
        },
        // A real save stays in flight until the parent settles it. The empty
        // executor is the point: this save never settles.
        onSave: (submission: unknown) => {
          h.onSave(submission);
          return new Promise<void>(() => {
            // This save never settles; the test unmounts first.
          });
        },
      })
    );
  }

  function fill(root: ReactTestInstance): void {
    changeText(root, 'File name', 'renamed-rule');
    changeText(root, 'Instruction content', 'edited text');
  }

  it('starts one save for a Save double press and never asks to discard', async () => {
    const { renderer, unmount } = await mount();

    fill(renderer.root);
    pressDone(renderer.root);
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(confirmRequests()).toHaveLength(0);

    unmount();
  });

  it('blocks the second press until the save settles, then saves again', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(InstructionFormSheet, {
        instruction: { name: 'existing-rule', content: 'stored text' },
        isSaving: false,
        onClose: () => {
          h.onClose();
        },
        onSave: (submission: unknown) => {
          h.onSave(submission);
          return neverSettles();
        },
      })
    );

    fill(renderer.root);
    pressDone(renderer.root);
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(1);

    await settleSave();
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(1);

    act(() => {
      resolversRef.current?.();
    });
    await settleSave();
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('refuses a save whose input is invalid without holding the admission', async () => {
    const { renderer, unmount } = await mount();

    changeText(renderer.root, 'File name', 'renamed-rule');
    changeText(renderer.root, 'Instruction content', '');
    pressDone(renderer.root);
    expect(h.onSave).not.toHaveBeenCalled();

    changeText(renderer.root, 'Instruction content', 'edited text');
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('does not raise the discard dialog while a save is running', async () => {
    const { renderer, unmount } = await mount();

    fill(renderer.root);
    pressDone(renderer.root);

    const requestDismiss = booleanHandler(
      findOne(renderer.root, 'SessionPageSheet').props.onRequestDismiss
    );
    expect(requestDismiss()).toBe(true);
    expect(confirmRequests()).toHaveLength(0);

    unmount();
  });
});

describe('SkillFormSheet double press', () => {
  function mount() {
    return renderWithProviders(
      createElement(SkillFormSheet, {
        skill: { name: 'stored-skill', rawMarkdown: 'stored body' },
        isSaving: false,
        onClose: () => {
          h.onClose();
        },
        // This save never settles; the test unmounts first.
        onSave: (submission: unknown) => {
          h.onSave(submission);
          return new Promise<void>(() => {
            // This save never settles; the test unmounts first.
          });
        },
      })
    );
  }

  it('starts one save for a Save double press and never asks to discard', async () => {
    const { renderer, unmount } = await mount();

    changeText(renderer.root, 'Skill name', 'renamed-skill');
    changeText(renderer.root, 'Skill content', 'edited body');
    pressDone(renderer.root);
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(confirmRequests()).toHaveLength(0);

    unmount();
  });

  it('releases the admission when the save refuses, so Save works again', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(SkillFormSheet, {
        skill: { name: 'stored-skill', rawMarkdown: 'stored body' },
        isSaving: false,
        onClose: () => {
          h.onClose();
        },
        onSave: (submission: unknown) => {
          h.onSave(submission);
          return Promise.reject(new Error('refused'));
        },
      })
    );

    changeText(renderer.root, 'Skill name', 'renamed-skill');
    changeText(renderer.root, 'Skill content', 'edited body');
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(1);

    await settleSave();
    pressDone(renderer.root);
    expect(h.onSave).toHaveBeenCalledTimes(2);

    unmount();
  });
});

describe('McpFormSheet double press', () => {
  function mount() {
    return renderWithProviders(
      createElement(McpFormSheet, {
        server: null,
        existingNames: [],
        isSaving: false,
        draftScope: 'test:mcp',
        onClose: () => {
          h.onClose();
        },
        // This save never settles; the test unmounts first.
        onSave: (payload: unknown) => {
          h.onSave(payload);
          return new Promise<void>(() => {
            // This save never settles; the test unmounts first.
          });
        },
      })
    );
  }

  function fill(root: ReactTestInstance): void {
    changeText(root, 'Server name', 'local-runner');
    changeText(root, 'Command line', 'npx -y fixture --serve');
  }

  it('starts one save for a Save double press and never asks to discard', async () => {
    const { renderer, unmount } = await mount();

    fill(renderer.root);
    pressDone(renderer.root);
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(confirmRequests()).toHaveLength(0);

    unmount();
  });
});

describe('AgentFormSheet double press', () => {
  function mount() {
    return renderWithProviders(
      createElement(AgentFormSheet, {
        agent: null,
        existingSlugs: [],
        isSaving: false,
        draftScope: 'test:agent',
        onClose: () => {
          h.onClose();
        },
        // This save never settles; the test unmounts first.
        onSave: (payload: unknown) => {
          h.onSave(payload);
          return new Promise<void>(() => {
            // This save never settles; the test unmounts first.
          });
        },
      })
    );
  }

  function fill(root: ReactTestInstance): void {
    changeText(root, 'Agent slug', 'review-agent');
    changeText(root, 'Agent name', 'Review agent');
  }

  it('starts one save for a Save double press and never asks to discard', async () => {
    const { renderer, unmount } = await mount();

    fill(renderer.root);
    pressDone(renderer.root);
    pressDone(renderer.root);

    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(confirmRequests()).toHaveLength(0);

    unmount();
  });

  it('keeps Done enabled until the sheet re-renders with the save pending', async () => {
    const { renderer, unmount } = await mount();

    fill(renderer.root);
    pressDone(renderer.root);
    pressDone(renderer.root);

    // The lagging prop is the reason the admission exists: both presses read
    // `doneDisabled === false` because no re-render has landed between them.
    expect(doneDisabled(renderer.root)).toBe(false);
    expect(h.onSave).toHaveBeenCalledTimes(1);

    unmount();
  });
});

describe('profile form sheet discard copy', () => {
  it('matches the dialog the explorer saw, so the test name tracks the guard', () => {
    expect(i18n.t('common.discardChangesTitle')).toBe('Discard changes?');
    expect(i18n.t('common.discardChangesMessage')).toBe('Your changes will be lost.');
  });
});
