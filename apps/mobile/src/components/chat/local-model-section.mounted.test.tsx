/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalModelSection } from '@/components/chat/local-model-section';
import { act, TestRenderer } from '@/test/renderer';
import { isolateBidiText } from '@/lib/bidi';
import { type LocalModelStatus } from '@/lib/chat/local-models';

/**
 * The row that says what the selected on-device model cannot run.
 *
 * A model that runs no tool loop runs none of the enabled tools, and a model
 * that runs the loop says exactly what the schema converter leaves out: whole
 * tools the model never sees, and whether a tool it still receives is missing
 * an optional argument. The notes are non-blocking copy: the row keeps its
 * choice, its status and its download control, and adds its lines in one
 * caption group under a hairline divider.
 */

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // A distinctive joiner, so the expectation proves the row joins with the
    // catalog's separator rather than a literal comma. A key asked for without
    // values stays one string, so a line that passes no payload has a single
    // string child.
    t: (key: string, values?: { items?: string }) => {
      if (key === 'common.listJoiner') {
        return ' + ';
      }
      return values === undefined ? key : [key, values.items ?? ''];
    },
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [] }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/chat/use-offered-tools', () => ({ useOfferedTools: () => [] }));
vi.mock('@/lib/chat/local-models', () => ({ useLocalModels: () => [] }));
vi.mock('@/lib/chat/android-model-download', () => ({ useAndroidModelDownload: () => null }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(statuses: Parameters<typeof LocalModelSection>[0]['statuses']) {
  act(() => {
    renderer = TestRenderer.create(
      createElement(LocalModelSection, { statuses, selectedModel: undefined })
    );
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root;
}

const NOTE_LINE_TEST_ID = 'local-model-unusable-';

/** The caption group each row draws its notes in, under the hairline divider. */
function noteGroups(root: TestRenderer.ReactTestInstance) {
  return root.findAll(
    node =>
      Object.is(node.type, 'View') && String(node.props.className).includes('border-hair-soft')
  );
}

/** The note lines in render order, each as its testID and its child. */
function noteLines(root: TestRenderer.ReactTestInstance) {
  return root
    .findAll(
      node =>
        Object.is(node.type, 'Text') &&
        String(node.props.testID ?? '').startsWith(NOTE_LINE_TEST_ID)
    )
    .map(node => [node.props.testID, node.props.children]);
}

const appleStatus = (toolUse: LocalModelStatus['toolUse']): LocalModelStatus => ({
  provider: 'apple' as const,
  targetId: 'local:apple',
  nameKey: 'modelChat.localModels.apple',
  availability: {
    status: 'available' as const,
    modelId: 'apple-system-language-model',
    contextWindow: 4096,
    maxOutputTokens: 512,
    systemInstructions: true,
    tools: true,
  },
  toolUse,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('the on-device model row', () => {
  it('draws the tools line and the options line in one caption group', () => {
    const root = mount([appleStatus({ kind: 'some', tools: ['settings_set'], option: true })]);
    const groups = noteGroups(root);
    expect(groups).toHaveLength(1);
    expect(noteLines(root)).toEqual([
      [
        'local-model-unusable-apple',
        [
          'modelChat.localModels.cannotUse',
          // The catalog mock answers with the key, and the row isolates it: a
          // tool name keeps its own direction inside a translated sentence.
          isolateBidiText('modelChat.localModels.tools.settingsSet'),
        ],
      ],
      // The options line carries no payload, so it is one string, not a list.
      ['local-model-unusable-options-apple', 'modelChat.localModels.cannotUseOptions'],
    ]);
    // Both lines belong to the one group, so the divider cannot split them.
    const lines = noteGroups(root)[0]?.findAll(
      node =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith(NOTE_LINE_TEST_ID)
    );
    expect(lines?.map(node => node.props.testID)).toEqual([
      'local-model-unusable-apple',
      'local-model-unusable-options-apple',
    ]);
    expect(lines?.map(node => node.props.variant)).toEqual(['caption', 'caption']);
  });

  it('joins the tools with the catalog separator, never a literal comma', () => {
    // Two tools: `join` inserts nothing for one, so a single-item list would
    // pass whatever separator the row used. The mock's joiner is ` + `, which a
    // literal comma cannot produce.
    const root = mount([
      appleStatus({ kind: 'some', tools: ['time', 'settings_set'], option: true }),
    ]);
    expect(noteLines(root)).toEqual([
      [
        'local-model-unusable-apple',
        [
          'modelChat.localModels.cannotUse',
          [
            isolateBidiText('modelChat.localModels.tools.time'),
            isolateBidiText('modelChat.localModels.tools.settingsSet'),
          ].join(' + '),
        ],
      ],
      ['local-model-unusable-options-apple', 'modelChat.localModels.cannotUseOptions'],
    ]);
  });

  it('draws only the tools line when the model can fill in every option', () => {
    const root = mount([appleStatus({ kind: 'some', tools: ['settings_list'], option: false })]);
    expect(noteGroups(root)).toHaveLength(1);
    expect(noteLines(root)).toEqual([
      [
        'local-model-unusable-apple',
        [
          'modelChat.localModels.cannotUse',
          isolateBidiText('modelChat.localModels.tools.settingsList'),
        ],
      ],
    ]);
    expect(
      root.findAll(node => node.props.testID === 'local-model-unusable-options-apple')
    ).toEqual([]);
  });

  it('draws only the options line when every tool still reaches the model', () => {
    const root = mount([appleStatus({ kind: 'some', tools: [], option: true })]);
    expect(noteGroups(root)).toHaveLength(1);
    expect(noteLines(root)).toEqual([
      ['local-model-unusable-options-apple', 'modelChat.localModels.cannotUseOptions'],
    ]);
    expect(root.findAll(node => node.props.testID === 'local-model-unusable-apple')).toEqual([]);
  });

  it('draws no group when the model takes every offered tool', () => {
    const root = mount([appleStatus({ kind: 'none' })]);
    expect(noteGroups(root)).toEqual([]);
    expect(noteLines(root)).toEqual([]);
  });

  it('draws no group before the model has answered', () => {
    const root = mount([appleStatus({ kind: 'unknown' })]);
    expect(noteGroups(root)).toEqual([]);
    expect(noteLines(root)).toEqual([]);
  });
});
