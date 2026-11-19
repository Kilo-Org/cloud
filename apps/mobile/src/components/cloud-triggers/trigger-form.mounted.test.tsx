/**
 * The create form's activation switch and the prompt beside it.
 *
 * The prompt is an uncontrolled field: it keeps the value it mounted with until
 * the person types. Switching activation rewrites the draft's prompt to the
 * other activation's default, so the field must remount on that default or the
 * form submits text the person never saw. The field stand-in here reproduces
 * that contract — it keeps its mount value and ignores later `defaultValue`
 * changes — and the suite reads what the field shows, not the draft.
 */

import { createElement, type ElementType, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { createTriggerDraft, defaultPrompt } from '@/lib/cloud-triggers/trigger-draft';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerFormBasics } from './trigger-form-basics';
import { TriggerFormBehaviour } from './trigger-form-behaviour';

// The scheduled fields' base direction comes from `ltrValueTextStyle`, which
// reads the interface direction; hoisted so a test can flip it per render.
const i18nManager = vi.hoisted(() => ({ isRTL: false }));

vi.mock('react-native', () => ({
  I18nManager: i18nManager,
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6f6a61' }),
}));
vi.mock('@/components/ui/form-field', async () => {
  // `vi.mock` factories hoist above this file's imports, so the factory loads
  // React itself instead of closing over the top-level import.
  const { createElement: h, useState: useMountValue } = await import('react');
  return {
    // Mount value only, like the real uncontrolled field: a later `defaultValue`
    // must not move what is on screen.
    FormField: (props: { label: string; defaultValue?: string; onChangeText?: unknown }) => {
      const [shownValue] = useMountValue(props.defaultValue ?? '');
      return h('FormField', { ...props, shownValue });
    },
  };
});
vi.mock('@/components/ui/segmented-control', async () => {
  // Hoisted factory: see the note on the form-field mock above.
  const { createElement: h } = await import('react');
  return {
    SegmentedControl: (props: {
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    }) =>
      h(
        'SegmentedControl',
        null,
        props.options.map(option =>
          h('Segment', {
            key: option.value,
            value: option.value,
            label: option.label,
            onPress: () => {
              props.onChange(option.value);
            },
          })
        )
      ),
  };
});
vi.mock('./trigger-form-rows', () => ({
  TriggerSelectRow: 'TriggerSelectRow',
  TriggerSwitchRow: 'TriggerSwitchRow',
}));
vi.mock('@/components/profiles/repo-picker-sheet', () => ({ RepoPickerSheet: 'RepoPickerSheet' }));
vi.mock('@/lib/cloud-triggers/use-trigger-options', () => ({
  useTriggerRepositories: () => ({
    repositories: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTriggerEnvironments: () => ({
    environments: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useTriggerProfiles: () => ({
    profiles: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const FIELD = 'FormField' as ElementType;
const SEGMENT = 'Segment' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

/** The two form blocks, driven by the same state a create screen holds. */
function CreateFormHarness() {
  const [draft, setDraft] = useState(() => createTriggerDraft('UTC'));
  return createElement(
    'View',
    null,
    createElement(TriggerFormBasics, {
      mode: 'create',
      draft,
      problems: {},
      onDraftChange: setDraft,
      repositoryPickerOpen: false,
      onRepositoryPickerOpenChange: () => {
        // no picker in this harness
      },
    }),
    createElement(TriggerFormBehaviour, {
      mode: 'create',
      draft,
      problems: {},
      authConfigured: false,
      secretResetKey: 0,
      onDraftChange: setDraft,
    })
  );
}

async function mount(): Promise<ReactTestRenderer['root']> {
  const view = await renderWithProviders(createElement(CreateFormHarness));
  renderer = view.renderer;
  return view.renderer.root;
}

function promptField(root: ReactTestRenderer['root']) {
  const found = root.findAll(node => Object.is(node.type, FIELD) && node.props.label === 'Prompt');
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one Prompt field, found ${found.length}`);
  }
  return only;
}

function pressActivation(root: ReactTestRenderer['root'], value: string): void {
  const segment = root.findAll(node => Object.is(node.type, SEGMENT) && node.props.value === value);
  const [only] = segment;
  if (!only || segment.length !== 1) {
    throw new Error(`expected one ${value} segment, found ${segment.length}`);
  }
  act(() => {
    (only.props.onPress as () => void)();
  });
}

function typePrompt(root: ReactTestRenderer['root'], value: string): void {
  act(() => {
    (promptField(root).props.onChangeText as (value: string) => void)(value);
  });
}

/** The one field a scheduled form labels with `key`. */
function scheduledField(root: ReactTestRenderer['root'], key: string) {
  const found = root.findAll(
    node => Object.is(node.type, FIELD) && node.props.label === i18n.t(key)
  );
  const [only] = found;
  if (!only || found.length !== 1) {
    throw new Error(`expected one ${key} field, found ${found.length}`);
  }
  return only;
}

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  i18nManager.isRTL = false;
});

describe('trigger create form prompt', () => {
  it('shows the scheduled default after switching activation', async () => {
    const root = await mount();
    expect(promptField(root).props.shownValue).toBe(defaultPrompt('webhook'));

    pressActivation(root, 'scheduled');

    expect(promptField(root).props.shownValue).toBe(defaultPrompt('scheduled'));
  });

  it('keeps a typed prompt across an activation switch', async () => {
    const root = await mount();
    typePrompt(root, 'Summarise the payload for me.');

    pressActivation(root, 'scheduled');

    expect(promptField(root).props.shownValue).toBe('Summarise the payload for me.');
  });
});

describe('trigger create form cron direction', () => {
  it('pins the cron field left to right in a left-to-right interface', async () => {
    const root = await mount();
    pressActivation(root, 'scheduled');

    expect(scheduledField(root, 'cloudAgent.triggers.fieldCron').props.style).toEqual({
      direction: 'ltr',
      writingDirection: 'ltr',
    });
  });

  it('keeps it left to right with the interface alignment in a right-to-left interface', async () => {
    i18nManager.isRTL = true;
    try {
      const root = await mount();
      pressActivation(root, 'scheduled');

      expect(scheduledField(root, 'cloudAgent.triggers.fieldCron').props.style).toEqual({
        direction: 'ltr',
        writingDirection: 'ltr',
        textAlign: 'right',
      });
    } finally {
      i18nManager.isRTL = false;
    }
  });
});
