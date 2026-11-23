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
 * choice, its status and its download control, and adds a muted `Limitations`
 * heading that owns the hairline divider, then its lines as the card's own
 * children — no wrapper element between the heading and the lines.
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
const LIMITATIONS_TEST_ID = 'local-model-limitations-';

/** The muted heading each row draws above its notes, under the hairline divider. */
function limitationHeadings(root: TestRenderer.ReactTestInstance) {
  return root.findAll(
    node =>
      Object.is(node.type, 'Text') &&
      String(node.props.testID ?? '').startsWith(LIMITATIONS_TEST_ID)
  );
}

/** The heading of the one row that draws notes, which the divider belongs to. */
function limitationHeading(root: TestRenderer.ReactTestInstance) {
  const headings = limitationHeadings(root);
  expect(headings).toHaveLength(1);
  const heading = headings[0];
  if (!heading) {
    throw new Error('Missing limitations heading');
  }
  return heading;
}

/**
 * The `View` that wraps the heading in the row's card, found by its rounded
 * border, rather than whatever element happens to hold the heading.
 */
function rowCard(heading: TestRenderer.ReactTestInstance) {
  let node = heading.parent;
  while (node !== null) {
    if (Object.is(node.type, 'View') && String(node.props.className ?? '').includes('rounded-xl')) {
      return node;
    }
    node = node.parent;
  }
  throw new Error('Missing the row card around the limitations heading');
}

/**
 * The heading and its note lines as the row card's own children, in render
 * order.
 *
 * Nothing wraps them any more: the heading owns the hairline divider and each
 * note line is the next child of the same card, so the run is read from the
 * heading forward and stops at the first child that is not part of it. Reading
 * the card, not the heading's immediate parent, means a wrapper element around
 * the heading and its lines cannot hide behind the anchoring: the heading would
 * no longer be a direct child of the card, and a wrapper between two notes
 * would end the run early, so the expectations below miss the line it hides.
 */
function noteChildren(root: TestRenderer.ReactTestInstance) {
  const heading = limitationHeading(root);
  const card = rowCard(heading);
  const start = card.children.indexOf(heading);
  if (start === -1) {
    throw new Error('The heading is not a child of the row card');
  }
  const run: TestRenderer.ReactTestInstance[] = [];
  for (const node of card.children.slice(start)) {
    if (typeof node === 'string') {
      break;
    }
    const testID = String(node.props.testID ?? '');
    if (![LIMITATIONS_TEST_ID, NOTE_LINE_TEST_ID].some(prefix => testID.startsWith(prefix))) {
      break;
    }
    run.push(node);
  }
  return run;
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
  it('draws the heading and the two note lines after it, with no wrapper between them', () => {
    const root = mount([appleStatus({ kind: 'some', tools: ['settings_set'], option: true })]);
    const heading = limitationHeading(root);
    // The heading carries the catalog's own label and owns the hairline divider
    // the notes used to sit inside.
    expect(heading.props.children).toEqual('modelChat.localModels.limitations');
    expect(heading.props.variant).toEqual('caption');
    // The divider the notes used to sit inside: the colour token and the half
    // point width that draws the visible hairline.
    expect(String(heading.props.className)).toContain('border-hair-soft');
    expect(String(heading.props.className)).toContain('border-t-[0.5px]');
    expect(
      root.findAll(
        node =>
          Object.is(node.type, 'View') && String(node.props.className).includes('border-hair-soft')
      )
    ).toEqual([]);
    expect(noteChildren(root).map(node => node.props.testID)).toEqual([
      'local-model-limitations-apple',
      'local-model-unusable-apple',
      'local-model-unusable-options-apple',
    ]);
    expect(noteChildren(root).map(node => node.props.variant)).toEqual([
      'caption',
      'caption',
      'caption',
    ]);
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
  });

  it('joins the tools with the catalog separator, never a literal comma', () => {
    // Two tools: `join` inserts nothing for one, so a single-item list would
    // pass whatever separator the row used. The mock's joiner is ` + `, which a
    // literal comma cannot produce.
    const root = mount([
      appleStatus({ kind: 'some', tools: ['time', 'settings_set'], option: true }),
    ]);
    expect(noteChildren(root).map(node => node.props.testID)).toEqual([
      'local-model-limitations-apple',
      'local-model-unusable-apple',
      'local-model-unusable-options-apple',
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

  it('draws only the tools line under the heading when the model can fill in every option', () => {
    const root = mount([appleStatus({ kind: 'some', tools: ['settings_list'], option: false })]);
    expect(noteChildren(root).map(node => node.props.testID)).toEqual([
      'local-model-limitations-apple',
      'local-model-unusable-apple',
    ]);
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

  it('draws only the options line under the heading when every tool still reaches the model', () => {
    const root = mount([appleStatus({ kind: 'some', tools: [], option: true })]);
    expect(noteChildren(root).map(node => node.props.testID)).toEqual([
      'local-model-limitations-apple',
      'local-model-unusable-options-apple',
    ]);
    expect(noteLines(root)).toEqual([
      ['local-model-unusable-options-apple', 'modelChat.localModels.cannotUseOptions'],
    ]);
    expect(root.findAll(node => node.props.testID === 'local-model-unusable-apple')).toEqual([]);
  });

  it('draws no heading when the model takes every offered tool', () => {
    const root = mount([appleStatus({ kind: 'none' })]);
    expect(limitationHeadings(root)).toEqual([]);
    expect(noteLines(root)).toEqual([]);
  });

  it('draws no heading before the model has answered', () => {
    const root = mount([appleStatus({ kind: 'unknown' })]);
    expect(limitationHeadings(root)).toEqual([]);
    expect(noteLines(root)).toEqual([]);
  });
});
