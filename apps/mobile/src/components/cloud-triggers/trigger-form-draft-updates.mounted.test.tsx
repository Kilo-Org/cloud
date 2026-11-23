/**
 * A field edit and a switch press batched into one commit must both land.
 *
 * A text change queues an `onChangeText` for the next commit, and a switch the
 * reader taps in that same commit runs from the same render. A handler that
 * reports a whole draft spread from the render's own copy overwrites the other
 * edit with it: the switch flips back, or the just-typed prompt is dropped from
 * the draft while the uncontrolled field still shows it. The form's contract is
 * a functional update, so each handler rewrites only its own fields.
 */

import { createElement, type ElementType, type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  createTriggerDraft,
  defaultPrompt,
  type TriggerDraft,
} from '@/lib/cloud-triggers/trigger-draft';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerFormBasics } from './trigger-form-basics';
import { TriggerFormBehaviour } from './trigger-form-behaviour';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6f6a61' }),
}));
vi.mock('@/components/ui/form-field', async () => {
  // `vi.mock` factories hoist above this file's imports, so the factory loads
  // React itself instead of closing over the top-level import.
  const { createElement: h } = await import('react');
  return { FormField: (props: Record<string, unknown>) => h('FormField', props) };
});
vi.mock('@/components/ui/field-select', () => ({ FieldSelect: 'FieldSelect' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/form-field-label', () => ({ FormFieldLabel: 'FormFieldLabel' }));
vi.mock('@/components/profiles/repo-picker-sheet', () => ({ RepoPickerSheet: 'RepoPickerSheet' }));
vi.mock('./trigger-form-rows', () => ({
  TriggerSelectRow: 'TriggerSelectRow',
  TriggerSwitchRow: 'TriggerSwitchRow',
}));
vi.mock('@/lib/cloud-triggers/use-trigger-options', () => ({
  useTriggerRepositories: () => ({
    repositories: [],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  }),
}));

const FIELD = 'FormField' as ElementType;
const SWITCH_ROW = 'TriggerSwitchRow' as ElementType;
const SEGMENTED = 'SegmentedControl' as ElementType;
const PROBE = 'DraftProbe' as ElementType;

/** The longest prompt the field takes, matching the server's cap. */
const LONG_PROMPT = 'p'.repeat(4454);

let renderer: ReactTestRenderer | undefined = undefined;

/** The behaviour block over one state-held draft, with the latest draft probed. */
function BehaviourHarness({ initial }: Readonly<{ initial: TriggerDraft }>) {
  const [draft, setDraft] = useState(initial);
  return createElement(
    'View',
    null,
    createElement(TriggerFormBehaviour, {
      mode: 'edit',
      draft,
      problems: {},
      authConfigured: false,
      secretResetKey: 0,
      onDraftChange: update => {
        setDraft(update);
      },
    }),
    createElement('DraftProbe', { draft })
  );
}

/** The basics block over one state-held draft, with the latest draft probed. */
function BasicsHarness({ initial }: Readonly<{ initial: TriggerDraft }>) {
  const [draft, setDraft] = useState(initial);
  return createElement(
    'View',
    null,
    createElement(TriggerFormBasics, {
      mode: 'create',
      draft,
      problems: {},
      onDraftChange: update => {
        setDraft(update);
      },
      repositoryPickerOpen: false,
      onRepositoryPickerOpenChange: () => {
        // no picker in this harness
      },
    }),
    createElement('DraftProbe', { draft })
  );
}

async function mount(element: ReactElement): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(element);
  renderer = view.renderer;
  return view.renderer.root;
}

/** The field the form labels `label`. */
function field(root: ReactTestRenderer['root'], label: string) {
  const [only] = root.findAll(node => Object.is(node.type, FIELD) && node.props.label === label);
  if (!only) {
    throw new Error(`the form did not render a field labelled ${label}`);
  }
  return only;
}

/** The switch row the form titles `title`. */
function switchRow(root: ReactTestRenderer['root'], title: string) {
  const [only] = root.findAll(
    node => Object.is(node.type, SWITCH_ROW) && node.props.title === title
  );
  if (!only) {
    throw new Error(`the form did not render a switch row titled ${title}`);
  }
  return only;
}

/** The draft the latest render holds. */
function probedDraft(root: ReactTestRenderer['root']): TriggerDraft {
  return (root.findByType(PROBE).props as { draft: TriggerDraft }).draft;
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('trigger form draft updates', () => {
  it('keeps a batched prompt edit and autoCommit press together', async () => {
    const initial: TriggerDraft = {
      ...createTriggerDraft('UTC'),
      prompt: LONG_PROMPT,
      autoCommit: false,
    };
    const root = await mount(createElement(BehaviourHarness, { initial }));

    // Both handlers come from the same render, so both would carry the same
    // snapshot if the contract were a whole-draft callback.
    const prompt = field(root, i18n.t('agentChat.partDetail.field.prompt'));
    const autoCommit = switchRow(root, i18n.t('cloudAgent.triggers.autoCommit'));
    const onChangeText = prompt.props.onChangeText as (text: string) => void;
    const onValueChange = autoCommit.props.onValueChange as (value: boolean) => void;
    const typed = 'q'.repeat(4454);

    act(() => {
      onChangeText(typed);
      onValueChange(true);
    });

    const draft = probedDraft(root);
    expect(draft.prompt).toBe(typed);
    expect(draft.autoCommit).toBe(true);
  });

  it('keeps a batched name edit and activation switch together', async () => {
    const initial: TriggerDraft = {
      ...createTriggerDraft('UTC'),
      activation: 'webhook',
      prompt: defaultPrompt('webhook'),
    };
    const root = await mount(createElement(BasicsHarness, { initial }));

    const name = field(root, i18n.t('cloudAgent.triggers.fieldName'));
    const activation = root.findByType(SEGMENTED);
    const onChangeText = name.props.onChangeText as (text: string) => void;
    const onActivate = activation.props.onChange as (value: 'scheduled') => void;

    act(() => {
      onChangeText('nightly-digest');
      onActivate('scheduled');
    });

    const draft = probedDraft(root);
    expect(draft.name).toBe('nightly-digest');
    expect(draft.activation).toBe('scheduled');
    expect(draft.prompt).toBe(defaultPrompt('scheduled'));
  });
});
