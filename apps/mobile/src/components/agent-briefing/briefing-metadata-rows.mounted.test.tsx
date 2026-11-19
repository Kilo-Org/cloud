import { type TFunction } from 'i18next';
import { createElement, type ElementType } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import {
  BriefingMetadataRows,
  briefingMetadataTexts,
  type BriefingSourceMetadata,
} from './briefing-metadata-rows';

const t = ((key: string, values?: Readonly<Record<string, unknown>>) =>
  values ? [key, ...Object.values(values)].join(' ') : key) as unknown as TFunction;
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

function renderLines(metadata: BriefingSourceMetadata): string[] {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingMetadataRows, { metadata, t, language: 'en' })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Metadata rows are not mounted');
  }
  try {
    return mounted.root
      .findAllByType('Text' as ElementType)
      .map(node => node.props.children as string);
  } finally {
    act(() => {
      mounted.unmount();
    });
  }
}

it('renders every present member in display order with localized numbers', () => {
  expect(
    renderLines({
      plan: { done: 1, total: 3, current: 'Editing auth.ts' },
      changes: { files: 2, added: 1200, removed: 4 },
      failure: { kind: 'tool' },
    })
  ).toEqual([
    'agentBriefing.metadataPlan 3 1 3',
    'agentBriefing.metadataPlanCurrent Editing auth.ts',
    'agentBriefing.metadataFiles 2 2',
    'agentBriefing.metadataLinesAdded 1200 1,200',
    'agentBriefing.metadataLinesRemoved 4 4',
    'agentBriefing.metadataFailure agentBriefing.metadataFailureTool',
  ]);
});

it('omits an absent current step and still renders zero counts', () => {
  expect(
    renderLines({
      plan: { done: 1, total: 2, current: null },
      changes: { files: 1, added: 0, removed: 0 },
    })
  ).toEqual([
    'agentBriefing.metadataPlan 2 1 2',
    'agentBriefing.metadataFiles 1 1',
    'agentBriefing.metadataLinesAdded 0 0',
    'agentBriefing.metadataLinesRemoved 0 0',
  ]);
});

it('renders no line for a payload without any member', () => {
  expect(renderLines({})).toEqual([]);
});

it('names every failure kind', () => {
  const kinds = [
    ['provider', 'agentBriefing.metadataFailureProvider'],
    ['tool', 'agentBriefing.metadataFailureTool'],
    ['cancelled', 'agentBriefing.metadataFailureCancelled'],
    ['other', 'agentBriefing.metadataFailureOther'],
  ] as const satisfies readonly [NonNullable<BriefingSourceMetadata['failure']>['kind'], string][];
  for (const [kind, expected] of kinds) {
    expect(briefingMetadataTexts({ failure: { kind } }, t, 'en')).toEqual([
      `agentBriefing.metadataFailure ${expected}`,
    ]);
  }
});
