import { createElement, type ElementType } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BriefingSummary } from './briefing-summary';

// One report field matters here: the model the summary was written with. The
// rest satisfy the `BriefingReport` shape the card reads.
const report = {
  context: { organizationId: null },
  summary: {
    status: 'ready',
    text: 'Overnight work',
    model: 'model-a',
    costMicrodollars: 0,
    chargeStatus: 'settled',
    startedAt: null,
  },
} as unknown as Parameters<typeof BriefingSummary>[0]['report'];

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { model?: string; cost?: string }) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/agent-briefing-format', () => ({ briefingMoney: () => '$0' }));
vi.mock('@/lib/agent-briefing-state', () => ({
  briefingSummaryStatusKey: () => 'agentBriefing.summary',
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: [] }),
}));
vi.mock('@/lib/model-display-name', () => ({
  resolveCatalogModelName: (model: string) => `Named ${model}`,
}));

function textsIn(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as ElementType)
    .map(node => node.props.children as string);
}

it('names the summary model with one interpolation, not two text parts', () => {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(createElement(BriefingSummary, { report }));
  });
  const renderer = holder.renderer;
  if (!renderer) {
    throw new Error('Summary did not mount');
  }
  const texts = textsIn(renderer);
  expect(texts).toContain('agentBriefing.summaryModel:{"model":"Named model-a"}');
  expect(texts).not.toContain('common.model');
  act(() => {
    renderer.unmount();
  });
});
