/**
 * The form's problem gating and the secret field's guidance copy.
 *
 * A trigger form opens on an empty draft, so every required field starts with a
 * problem; the form shows one only after the field was visited — a text field
 * on losing focus, a picker when its picker opened. Each test here drives the
 * real visit (`onBlur`, the row press, the selector's `onOpen`) and reads the
 * message off the rendered host, so a problem shown before its visit, or a
 * message resolving to the wrong key, fails.
 */

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { createTriggerDraft } from '@/lib/cloud-triggers/trigger-draft';
import { triggerProblemMessage } from '@/lib/cloud-triggers/trigger-problem-copy';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerFormAgent } from './trigger-form-agent';
import { TriggerFormBasics } from './trigger-form-basics';
import { TriggerFormBehaviour } from './trigger-form-behaviour';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));
// The harness stays a facade: real row/field components keep their contracts
// while the test host reads the props they carry (`vi.mock` factories hoist
// above this file's imports, so the form-field factory loads React itself).
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  ChevronDown: 'ChevronDown',
  Lock: 'Lock',
  RotateCcw: 'RotateCcw',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
// The form's failure rows render `QueryError` -> `StateAction`, whose centered
// variant measures the native surface; that module loads the Sentry RN SDK,
// which the Node test project cannot resolve react-native through.
vi.mock('@sentry/react-native', () => ({ captureException: () => undefined }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6f6a61' }),
}));
vi.mock('@/components/ui/form-field', async () => {
  const { createElement: h } = await import('react');
  return {
    FormField: (props: Record<string, unknown>) => h('FormField', props),
  };
});
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/profiles/repo-picker-sheet', () => ({ RepoPickerSheet: 'RepoPickerSheet' }));
vi.mock('./trigger-form-rows', () => ({
  TriggerSelectRow: 'TriggerSelectRow',
  TriggerSwitchRow: 'TriggerSwitchRow',
}));
vi.mock('@/lib/cloud-triggers/use-trigger-options', () => ({
  useTriggerRepositories: () => emptyOptions(),
  useTriggerEnvironments: () => emptyOptions(),
  useTriggerProfiles: () => emptyOptions(),
}));
vi.mock('@/components/agents/model-selector', () => ({ ModelSelector: 'ModelSelector' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
// The catalogue read each test describes; the mock reads the object live, so a
// test sets the state it renders instead of remocking the hook.
const availableModels = vi.hoisted(() => ({
  models: [] as { id: string; name: string; variants: string[]; isPreferred: boolean }[],
  isLoading: false,
  isError: false,
  isFetching: false,
  isFetched: false,
  refetch: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => availableModels,
}));
vi.mock('./trigger-choice-sheet', () => ({
  TriggerChoiceSheet: 'TriggerChoiceSheet',
}));

/** An idle options read every trigger form test starts from. */
const emptyOptions = () => ({
  repositories: [],
  environments: [],
  profiles: [],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});
vi.mock('@/components/agents/mode-options', () => ({
  getBuiltinModeLabelKey: (mode: string) => (mode.length === 0 ? null : `mode:${mode}`),
  getBuiltinModeDescriptionKey: () => null,
}));
vi.mock('@/components/agents/mode-normalize', () => ({ BUILTIN_AGENT_MODES: ['code'] }));

const FIELD = 'FormField' as ElementType;
const MODEL_SELECTOR = 'ModelSelector' as ElementType;

/** A draft change the suite under test never makes. */
const noop = () => {
  // not changed by this suite
};

beforeEach(() => {
  availableModels.models = [];
  availableModels.isLoading = false;
  availableModels.isError = false;
  availableModels.isFetching = false;
  availableModels.isFetched = false;
  availableModels.refetch.mockClear();
});

const HELPER_KEY_MAP = {
  set: 'cloudAgent.triggers.authSecretSet',
  keep: 'cloudAgent.triggers.authSecretKeep',
  creator: 'cloudAgent.triggers.authSecretCreator',
} as const;

describe('trigger secret helper copy', () => {
  const helperValues = new Set(Object.values(HELPER_KEY_MAP).map(key => i18n.t(key)));

  /** The muted `Text` under the secret field whose copy is one helper line. */
  function secretHelper(root: ReactTestRenderer['root']) {
    const found = root.findAll(
      node =>
        Object.is(node.type, 'Text') &&
        typeof node.props.children === 'string' &&
        helperValues.has(node.props.children)
    );
    const [only] = found;
    if (!only || found.length !== 1) {
      throw new Error(`expected one secret helper Text, found ${found.length}`);
    }
    return only;
  }

  for (const [name, key] of [
    ['a trigger without a saved secret', HELPER_KEY_MAP.set],
    ['a trigger whose secret is configured', HELPER_KEY_MAP.keep],
  ] as const) {
    it(`tells the person what the secret does for ${name}`, async () => {
      const view = await renderWithProviders(
        createElement(TriggerFormBehaviour, {
          mode: 'create',
          draft: { ...createTriggerDraft('UTC'), authEnabled: true },
          problems: {},
          authConfigured: key === HELPER_KEY_MAP.keep,
          secretResetKey: 0,
          onDraftChange: noop,
        })
      );
      try {
        expect(secretHelper(view.renderer.root).props.children).toBe(i18n.t(key));
      } finally {
        act(() => {
          view.renderer.unmount();
        });
      }
    });
  }

  it('tells the person the secret is held when the run is the creator', async () => {
    const view = await renderWithProviders(
      createElement(TriggerFormBehaviour, {
        mode: 'create',
        draft: { ...createTriggerDraft('UTC'), authEnabled: true, runAsCreator: true },
        problems: {},
        authConfigured: false,
        secretResetKey: 0,
        onDraftChange: noop,
      })
    );
    try {
      expect(secretHelper(view.renderer.root).props.children).toBe(i18n.t(HELPER_KEY_MAP.creator));
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });
});

describe('trigger form gated problems', () => {
  it('keeps untouched fields quiet and shows each problem after its own visit', async () => {
    const view = await renderWithProviders(
      createElement(TriggerFormBasics, {
        mode: 'create',
        draft: createTriggerDraft('UTC'),
        problems: { name: 'required', repository: 'repositoryRequired' },
        onDraftChange: noop,
        repositoryPickerOpen: false,
        onRepositoryPickerOpenChange: noop,
      })
    );
    const root = view.renderer.root;
    try {
      const name = root.findAll(
        node => Object.is(node.type, FIELD) && node.props.label === 'Trigger name'
      )[0];
      const repository = root.findAll(
        node => Object.is(node.type, 'Pressable') && node.props.accessibilityLabel === 'Repository'
      )[0];
      if (!name || !repository) {
        throw new Error('expected the name field and the repository row');
      }
      expect(name.props.error).toBeUndefined();
      expect(
        root.findAll(
          node =>
            Object.is(node.type, 'Text') &&
            node.props.children === triggerProblemMessage('repositoryRequired')
        )
      ).toHaveLength(0);

      act(() => {
        (name.props.onBlur as () => void)();
      });
      expect(
        root.findAll(node => Object.is(node.type, FIELD) && node.props.label === 'Trigger name')[0]
          ?.props.error
      ).toBe(triggerProblemMessage('required'));

      act(() => {
        (repository.props.onPress as () => void)();
      });
      expect(
        root.findAll(
          node =>
            Object.is(node.type, 'Text') &&
            node.props.children === triggerProblemMessage('repositoryRequired')
        )
      ).toHaveLength(1);
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });

  it('shows the model problem only after the selector opens', async () => {
    const view = await renderWithProviders(
      createElement(TriggerFormAgent, {
        draft: createTriggerDraft('UTC'),
        problems: { model: 'modelRequired' },
        onDraftChange: noop,
        openSheet: null,
        onOpenSheetChange: noop,
      })
    );
    const root = view.renderer.root;
    try {
      const modelSelector = root.findAll(node => Object.is(node.type, MODEL_SELECTOR))[0];
      if (!modelSelector) {
        throw new Error('expected one model selector');
      }

      /** The destructive `Text` carrying the model problem, when shown. */
      const shownModelProblem = () =>
        root
          .findAll(node => Object.is(node.type, 'Text'))
          .map(node => node.props.children)
          .filter(children => children === i18n.t('cloudAgent.triggers.problems.modelRequired'));
      expect(shownModelProblem()).toStrictEqual([]);

      act(() => {
        (modelSelector.props.onOpen as () => void)();
      });
      expect(shownModelProblem()).toStrictEqual([triggerProblemMessage('modelRequired')]);
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });
});
