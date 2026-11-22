// A council row names its concern in the app language. The persisted result
// carries the shared roster's English preset name, so a preset row must read
// its name from the catalog; only a custom specialist (an id with no preset)
// keeps the stored name it was configured with.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { CouncilSection } from './review-detail-sections';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The shared row paints its label column and then its value column; the stub
// keeps that order in the rendered text so the test reads the pair the screen
// shows, without the row frame's native pieces.
vi.mock('@/components/ui/kv-row', () => ({
  KvRow: (props: { label: string; value: string }) =>
    createElement(
      'KvRow',
      props,
      createElement('Text', { key: 'label' }, props.label),
      createElement('Text', { key: 'value' }, props.value)
    ),
}));
vi.mock('@/components/ui/section', () => ({
  Section: (props: { children?: ReactNode }) => createElement('Section', null, props.children),
}));
vi.mock('@/components/ui/row-group', () => ({
  RowGroup: (props: { children?: ReactNode }) => createElement('RowGroup', null, props.children),
}));

type CouncilResult = Parameters<typeof CouncilSection>[0]['councilResult'];

/** One persisted specialist: the row reads only `id`, `name` and `vote`. */
function specialist(over: { id: string; name: string }): CouncilResult['specialists'][number] {
  return {
    id: over.id,
    role: 'security',
    name: over.name,
    model: null,
    thinkingEffort: null,
    vote: 'pass',
    highestSeverity: null,
    findings: [],
  };
}

function councilWith(specialists: CouncilResult['specialists']): CouncilResult {
  return { decision: 'pass', aggregationStrategy: 'unanimous', specialists };
}

function collectText(node: unknown): string[] {
  if (node === null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText(node.children);
  }
  return [];
}

const renderers: TestRenderer.ReactTestRenderer[] = [];

function mountCouncil(councilResult: CouncilResult): string[] {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(CouncilSection, { councilResult }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('council section did not render');
  }
  renderers.push(renderer);
  return collectText(renderer.toJSON());
}

/** The pair one row reads: its name and then the vote beside it. */
function rowPair(texts: string[], name: string): string[] {
  const index = texts.indexOf(name);
  expect(index, `no row named ${name}`).toBeGreaterThanOrEqual(0);
  return texts.slice(index, index + 2);
}

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

describe('council rows in German', () => {
  beforeEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('de');
    });
  });

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('names a preset specialist from the catalog and a custom one from its stored name', () => {
    const texts = mountCouncil(
      councilWith([
        specialist({ id: 'security', name: 'Security' }),
        specialist({ id: 'testing', name: 'Test coverage' }),
        specialist({ id: 'payments', name: 'Payments gate' }),
      ])
    );

    expect(rowPair(texts, 'Sicherheit')).toEqual([
      'Sicherheit',
      i18n.t('codeReviewer.decision.pass'),
    ]);
    expect(rowPair(texts, 'Testabdeckung')).toEqual([
      'Testabdeckung',
      i18n.t('codeReviewer.decision.pass'),
    ]);
    expect(rowPair(texts, 'Payments gate')).toEqual([
      'Payments gate',
      i18n.t('codeReviewer.decision.pass'),
    ]);
    expect(texts).not.toContain('Security');
    expect(texts).not.toContain('Test coverage');
  });

  it('never trusts a stored name on a preset id', () => {
    const texts = mountCouncil(councilWith([specialist({ id: 'security', name: 'Rotstift' })]));

    expect(texts).toContain('Sicherheit');
    expect(texts).not.toContain('Rotstift');
  });
});
