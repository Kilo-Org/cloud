import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { type BriefingReport } from '@/lib/agent-briefing';
import { act, TestRenderer } from '@/test/renderer';
import { BriefingPeriodLabel } from './briefing-period-label';

const locale = vi.hoisted(() => ({ language: 'pt-BR' }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: locale }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['pt-BR', '20/10/2026'],
  ['de', '20.10.2026'],
])('renders the scheduled calendar day in %s even west of UTC', (language, expected) => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  locale.language = language;
  const report: BriefingReport = {
    id: 'report-1',
    kind: 'scheduled',
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
    scorecard: { sessions: 0, pullRequests: 0, blockers: 0, spendMicrodollars: 0 },
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
  };
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(createElement(BriefingPeriodLabel, { report }));
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Period label is not mounted');
  }
  try {
    const labels = mounted.root
      .findAll(node => (node.type as string) === 'Text')
      .map(node => node.props.children);
    expect(labels).toContain(expected);
    expect(labels).not.toContain('2026-10-20');
  } finally {
    act(() => {
      mounted.unmount();
    });
  }
});
