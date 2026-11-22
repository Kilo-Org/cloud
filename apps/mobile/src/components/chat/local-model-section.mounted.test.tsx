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
 * that runs the loop names exactly what the schema converter leaves out, split
 * in two: whole tools the model never sees, and optional arguments dropped from
 * tools that still reach it. The notes are non-blocking copy: the row keeps its
 * choice, its status and its download control, and adds one muted line per
 * non-empty list.
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
    // catalog's separator rather than a literal comma.
    t: (key: string, values?: { items?: string }) =>
      key === 'common.listJoiner' ? ' + ' : [key, values?.items ?? ''],
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

function rows(statuses: Parameters<typeof LocalModelSection>[0]['statuses']) {
  act(() => {
    renderer = TestRenderer.create(
      createElement(LocalModelSection, { statuses, selectedModel: undefined })
    );
  });
  if (!renderer) {
    throw new Error('Missing renderer');
  }
  return renderer.root.findAll(node => String(node.props.testID ?? '').startsWith('local-model-'));
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
  it('names the tools and the arguments the model cannot run, on their own lines', () => {
    const notes = rows([
      appleStatus({
        kind: 'some',
        tools: ['settings_set'],
        arguments: [{ tool: 'lookup', argument: 'filter' }],
      }),
    ]);
    expect(notes.map(node => [node.props.testID, node.props.children])).toEqual([
      [
        'local-model-unusable-apple',
        [
          'modelChat.localModels.cannotUse',
          // The catalog mock answers with the key, and the row isolates it: a
          // tool name keeps its own direction inside a translated sentence.
          isolateBidiText('modelChat.localModels.tools.settingsSet'),
        ],
      ],
      [
        'local-model-unusable-arguments-apple',
        [
          'modelChat.localModels.cannotUseOptions',
          // An unknown id stays raw, isolated; the argument rides beside it.
          isolateBidiText('lookup (filter)'),
        ],
      ],
    ]);
  });

  it('joins each list with the catalog separator, never a literal comma', () => {
    // Two items on each line: `join` inserts nothing for one, so a single-item
    // list would pass whatever separator the row used. The mock's joiner is
    // ` + `, which a literal comma cannot produce.
    const notes = rows([
      appleStatus({
        kind: 'some',
        tools: ['time', 'settings_set'],
        arguments: [
          { tool: 'lookup', argument: 'filter' },
          { tool: 'mcp_kilo_read-file', argument: 'where.lat' },
        ],
      }),
    ]);
    expect(notes.map(node => node.props.children)).toEqual([
      [
        'modelChat.localModels.cannotUse',
        [
          isolateBidiText('modelChat.localModels.tools.time'),
          isolateBidiText('modelChat.localModels.tools.settingsSet'),
        ].join(' + '),
      ],
      [
        'modelChat.localModels.cannotUseOptions',
        [
          isolateBidiText('lookup (filter)'),
          isolateBidiText('mcp_kilo_read-file (where.lat)'),
        ].join(' + '),
      ],
    ]);
  });

  it('draws only the tool line when the model takes every argument', () => {
    const notes = rows([appleStatus({ kind: 'some', tools: ['settings_list'], arguments: [] })]);
    expect(notes.map(node => [node.props.testID, node.props.children])).toEqual([
      [
        'local-model-unusable-apple',
        [
          'modelChat.localModels.cannotUse',
          isolateBidiText('modelChat.localModels.tools.settingsList'),
        ],
      ],
    ]);
  });

  it('draws only the argument line when every tool still reaches the model', () => {
    const notes = rows([
      appleStatus({ kind: 'some', tools: [], arguments: [{ tool: 'lookup', argument: 'filter' }] }),
    ]);
    expect(notes.map(node => [node.props.testID, node.props.children])).toEqual([
      [
        'local-model-unusable-arguments-apple',
        ['modelChat.localModels.cannotUseOptions', isolateBidiText('lookup (filter)')],
      ],
    ]);
  });

  it('draws no note when the model takes every offered tool', () => {
    expect(rows([appleStatus({ kind: 'none' })])).toEqual([]);
  });

  it('draws no note before the model has answered', () => {
    expect(rows([appleStatus({ kind: 'unknown' })])).toEqual([]);
  });
});
