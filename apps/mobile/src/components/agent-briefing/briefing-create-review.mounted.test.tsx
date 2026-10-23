import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { type PreparedBriefing } from '@/lib/hooks/use-create-briefing';
import { act, TestRenderer } from '@/test/renderer';

import { BriefingCreateReview } from './briefing-create-review';

const catalog = vi.hoisted(() => ({
  models: [{ id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash Latest' }],
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: catalog.models, isLoading: false }),
}));
vi.mock('./briefing-card', () => ({ BriefingScorecard: 'Scorecard' }));
vi.mock('./briefing-period-label', () => ({ BriefingPeriodLabel: 'PeriodLabel' }));

afterEach(() => {
  catalog.models = [{ id: '~deepseek/deepseek-flash-latest', name: 'DeepSeek Flash Latest' }];
});

const prepared: PreparedBriefing = {
  report: {
    id: 'report-1',
    kind: 'one_off',
    createdAt: '2026-10-20T08:00:00Z',
    localDate: '2026-10-20',
    nightStartAt: '2026-10-19T22:00:00Z',
    cutoffAt: '2026-10-20T08:00:00Z',
    timezone: 'Europe/Berlin',
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    morningEndAt: '2026-10-20T12:00:00Z',
    publishedAt: '2026-10-20T08:00:00Z',
    updatedAt: '2026-10-20T08:00:00Z',
    expiresAt: '2026-10-20T12:00:00Z',
    revision: 1,
    revised: false,
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 4, pullRequests: 1, blockers: 0, spendMicrodollars: 0 },
    coverage: {
      activity: 'complete',
      pullRequests: 'complete',
      blockers: 'complete',
      spend: 'complete',
    },
    sessions: [],
    sources: [],
    summary: {
      status: 'disabled',
      text: null,
      model: null,
      costMicrodollars: 0,
      chargeStatus: 'settled',
      estimatedCostMicrodollars: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      canRetry: false,
    },
  },
  estimate: {
    model: '~deepseek/deepseek-flash-latest',
    estimatedCostMicrodollars: 1_000,
    maximumCostMicrodollars: 2_000_000,
    maxDurationSeconds: 600,
    estimateToken: 'estimate-token',
    canGenerate: true,
    unavailableReason: null,
  },
};

function renderedText(): string[] {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingCreateReview, {
        prepared,
        disabled: false,
        creating: false,
        onCreate: vi.fn<() => void>(),
        onReviewAgain: vi.fn<() => void>(),
      })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Review is not mounted');
  }
  try {
    return mounted.root
      .findAll(node => (node.type as string) === 'Text')
      .map(node => [node.props.children].flat(Infinity).join(''));
  } finally {
    act(() => {
      mounted.unmount();
    });
  }
}

it('names the estimate model the way the model picker does', () => {
  const lines = renderedText();
  expect(lines).toContain('common.model: DeepSeek Flash Latest');
  expect(lines.join('\n')).not.toContain('~deepseek');
});

it('cleans the id when the catalog does not carry it', () => {
  catalog.models = [];
  expect(renderedText()).toContain('common.model: deepseek flash latest');
});
