/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalModelSection } from '@/components/chat/local-model-section';
import { act, TestRenderer } from '@/test/renderer';
import { type LocalModelStatus } from '@/lib/chat/local-models';

/**
 * The row that says what the selected on-device model cannot run.
 *
 * A model that runs no tool loop runs none of the enabled tools, and a model
 * that runs the loop names exactly what the schema converter leaves out. The
 * note is non-blocking copy: the row keeps its choice, its status and its
 * download control, and adds one muted line.
 */

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { items?: string }) => [key, values?.items ?? ''],
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
  it('names the enabled tools the model cannot run', () => {
    const notes = rows([
      appleStatus({ kind: 'some', unusable: ['settings_set', 'lookup.filter'] }),
    ]);
    expect(notes.map(node => node.props.children)).toEqual([
      ['modelChat.localModels.cannotUse', 'settings_set, lookup.filter'],
    ]);
  });

  it('draws no note when the model takes every offered tool', () => {
    expect(rows([appleStatus({ kind: 'none' })])).toEqual([]);
  });

  it('draws no note before the model has answered', () => {
    expect(rows([appleStatus({ kind: 'unknown' })])).toEqual([]);
  });
});
