import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { type BriefingReport } from '@/lib/agent-briefing';
import { act, TestRenderer } from '@/test/renderer';
import { BriefingPeriodLabel } from './briefing-period-label';

const locale = vi.hoisted(() => ({ language: 'pt-BR' }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Readonly<Record<string, string>>) =>
      values ? `${key} ${Object.values(values).join(' – ')}` : key,
    i18n: locale,
  }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./briefing-window', () => ({
  formatBriefingTimestamp: (value: string, language: string, timeZone: string) =>
    `${value} ${language} ${timeZone}`,
}));

it('shows each window endpoint in the briefing zone and no separate date line', () => {
  const report: BriefingReport = {
    id: 'report-1',
    createdAt: '2026-10-20T08:00:00Z',
    capturedAt: '2026-10-20T08:00:00Z',
    truncated: false,
    localDate: '2026-10-20',
    nightStartAt: '2026-10-19T22:00:00Z',
    cutoffAt: '2026-10-20T08:00:00Z',
    timezone: 'Europe/Berlin',
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    morningEndAt: '2026-10-20T12:00:00Z',
    publishedAt: '2026-10-20T08:00:00Z',
    updatedAt: '2026-10-20T08:00:00Z',
    expiresAt: '2026-10-20T12:00:00Z',
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 0, pullRequests: 0, blockers: 0 },
    coverage: {
      activity: 'partial',
      pullRequests: 'partial',
      blockers: 'partial',
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
    const lines = mounted.root
      .findAll(node => (node.type as string) === 'Text')
      .map(node => node.props.children);
    expect(lines).toEqual([
      'agentBriefing.window 2026-10-19T22:00:00Z pt-BR Europe/Berlin – 2026-10-20T08:00:00Z pt-BR Europe/Berlin',
      'Europe/Berlin',
      'agentBriefing.capturedAt 2026-10-20T08:00:00Z pt-BR Europe/Berlin',
    ]);
  } finally {
    act(() => {
      mounted.unmount();
    });
  }
});
