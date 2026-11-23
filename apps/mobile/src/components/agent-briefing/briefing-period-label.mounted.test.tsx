import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { type BriefingReport } from '@/lib/agent-briefing';
import { act, TestRenderer } from '@/test/renderer';
import { BriefingPeriodLabel } from './briefing-period-label';

const locale = vi.hoisted(() => ({ language: 'pt-BR' }));
// The zone the formatter reports is not the report's requested zone, so the
// caption's own line proves which of the two it printed.
const formatted = vi.hoisted(() => ({ zone: 'Asia/Tokyo' }));
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
  formatBriefingTimestamp: (value: string, language: string) => ({
    text: `${value} ${language}`,
    timeZone: formatted.zone,
  }),
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
    // The caption names the zone the formatter returned — the zone the times were
    // written in — not the report's requested zone: a zone the runtime refused
    // would otherwise be printed over a clock it did not produce.
    expect(lines).toEqual([
      'common.timeRange 2026-10-19T22:00:00Z pt-BR – 2026-10-20T08:00:00Z pt-BR',
      formatted.zone,
      'agentBriefing.capturedAt 2026-10-20T08:00:00Z pt-BR',
    ]);
    expect(lines).not.toContain(report.timezone);
    // The zone shares the range's line, and the range gives up width first:
    // the zone never wraps onto a line of its own.
    const row = mounted.root
      .findAll(node => (node.type as string) === 'View')
      .find(node => node.findAll(child => (child.type as string) === 'Text').length === 2);
    expect(row?.findAll(child => (child.type as string) === 'Text').length).toBe(2);
    const range = mounted.root
      .findAll(node => (node.type as string) === 'Text')
      .find(node => String(node.props.children).startsWith('common.timeRange'));
    expect(range?.props.numberOfLines).toBe(1);
  } finally {
    act(() => {
      mounted.unmount();
    });
  }
});
