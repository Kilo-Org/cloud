/**
 * The agent block's catalogue-failure state.
 *
 * A failed model read renders an alert and a retry at the alert's height; the
 * retry stays busy while its refetch runs (v5 resets a no-data query to
 * `pending` and clears `error`, so the failure state is held through the
 * refetch), and a selector holding a model from a cached read stays usable.
 */

import { createElement, type ElementType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { createTriggerDraft } from '@/lib/cloud-triggers/trigger-draft';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerFormAgent } from './trigger-form-agent';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
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
vi.mock('@/components/query-error', () => ({
  QueryError: (props: Record<string, unknown>) => createElement('QueryError', props),
}));
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
vi.mock('@/components/agents/mode-options', () => ({
  getBuiltinModeLabelKey: (mode: string) => (mode.length === 0 ? null : `mode:${mode}`),
  getBuiltinModeDescriptionKey: () => null,
}));
vi.mock('@/components/agents/mode-normalize', () => ({ BUILTIN_AGENT_MODES: ['code'] }));

/** An idle options read every trigger form test starts from. */
const emptyOptions = () => ({
  repositories: [],
  environments: [],
  profiles: [],
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

const MODEL_SELECTOR = 'ModelSelector' as ElementType;
const QUERY_ERROR = 'QueryError' as ElementType;

const CACHED_MODEL = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  variants: [],
  isPreferred: true,
};

beforeEach(() => {
  availableModels.models = [];
  availableModels.isLoading = false;
  availableModels.isError = false;
  availableModels.isFetching = false;
  availableModels.isFetched = false;
  availableModels.refetch.mockClear();
});

describe('trigger form model list failure', () => {
  const mountAgent = () =>
    renderWithProviders(
      createElement(TriggerFormAgent, {
        problems: {},
        onDraftChange: () => undefined,
        openSheet: null,
        onOpenSheetChange: () => undefined,
        draft: createTriggerDraft('UTC'),
      })
    );

  /** The block's one failure state while the catalogue read failed. */
  function failureState(root: ReactTestRenderer['root']) {
    return root.findAll(node => Object.is(node.type, QUERY_ERROR));
  }

  it('offers a retry in place of the failure and locks a selector with no model', async () => {
    availableModels.isError = true;
    const view = await mountAgent();
    const root = view.renderer.root;
    try {
      const [failure] = failureState(root);
      if (!failure) {
        throw new Error('expected a failure state');
      }
      // One short state under the field, not a full-surface block.
      expect(failure.props.title).toBe(i18n.t('common.couldNotLoadModels'));
      expect(failure.props.compact).toBe(true);
      expect(failure.props.placement).toBe('top');
      act(() => {
        (failure.props.onRetry as () => void)();
      });
      expect(availableModels.refetch).toHaveBeenCalledTimes(1);
      expect(root.findAll(node => Object.is(node.type, MODEL_SELECTOR))[0]?.props.disabled).toBe(
        true
      );
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });

  it('keeps the failure row in place with a busy retry while the refetch runs', async () => {
    // The state a no-data refetch produces mid-flight: v5 reset the query to
    // `pending`, so `error` is cleared and `isLoading` holds while `isFetched`
    // records the earlier settled failure. The row must stay with a busy retry.
    availableModels.models = [];
    availableModels.isError = false;
    availableModels.isLoading = true;
    availableModels.isFetching = true;
    availableModels.isFetched = true;
    const view = await mountAgent();
    const root = view.renderer.root;
    try {
      const [failure] = failureState(root);
      if (!failure) {
        throw new Error('expected a failure state');
      }
      expect(failure.props.isRetrying).toBe(true);
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });

  it.each([
    ['a loaded catalogue', false],
    ['a cached catalogue after a failure', true],
  ])('keeps a selector holding a model usable with %s', async (_name, isError) => {
    availableModels.models = [CACHED_MODEL];
    availableModels.isError = isError;
    const view = await mountAgent();
    const root = view.renderer.root;
    try {
      // A populated catalogue is usable whatever the last read answered, so no
      // failure state shows for it; the retry only serves a model-less block.
      expect(failureState(root)).toHaveLength(0);
      expect(root.findAll(node => Object.is(node.type, MODEL_SELECTOR))[0]?.props.disabled).toBe(
        false
      );
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });
});
