import { describe, expect, it } from '@jest/globals';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeBillingStatus } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { SessionCostBreakdown } from './session-cost-breakdown';

jest.mock('./ShareSessionDialog', () => ({ ShareSessionDialog: () => null }));

jest.mock('@/components/ui/dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const block =
    (tag: string) =>
    ({ children, className }: { children?: ReactNode; className?: string }) =>
      react.createElement(tag, { className }, children);

  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? react.createElement(react.Fragment, null, children) : null,
    DialogContent: block('div'),
    DialogDescription: block('p'),
    DialogFooter: block('div'),
    DialogHeader: block('div'),
    DialogTitle: block('h2'),
  };
});

import { computeBillingRefetchInterval } from './ChatHeader';
import { SessionInfoDialog } from './SessionInfoDialog';

Object.assign(globalThis, { React });

function renderSessionInfo(
  sessionCostBreakdown?: SessionCostBreakdown,
  computeStatus?: ComputeBillingStatus
): string {
  return renderToStaticMarkup(
    React.createElement(SessionInfoDialog, {
      open: true,
      onOpenChange: jest.fn(),
      sessionId: 'agent_session',
      model: 'anthropic/claude-sonnet-4',
      sessionCostBreakdown,
      computeStatus,
    })
  );
}

describe('computeBillingRefetchInterval', () => {
  it('stops polling while idle and resumes when the live session becomes active', () => {
    expect(computeBillingRefetchInterval(false, 'idle')).toBe(false);
    expect(computeBillingRefetchInterval(true, 'idle')).toBe(5_000);
  });
});

describe('SessionInfoDialog session costs', () => {
  it('distinguishes model charges from separately billed compute', () => {
    const markup = renderSessionInfo(
      {
        totalCostUsd: 0.05,
        rootCostUsd: 0.05,
        subagentCostUsd: 0,
        olderActivityCostUsd: 0,
      },
      {
        payer: { type: 'user', id: 'user-1' },
        attribution: 'session',
        phase: 'active',
        estimatedHourlyRateMicrodollars: 100_000,
        estimatedIntervalAmountMicrodollars: 100_000,
        billingMode: 'paid',
        interval: null,
      }
    );

    expect(markup).toContain('Token Usage');
    expect(markup).not.toContain('Total cost');
    expect(markup).toContain('Compute');
  });

  it('renders the inclusive total and every positive cost component', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 1.23456,
      rootCostUsd: 0.65432,
      subagentCostUsd: 0.34567,
      olderActivityCostUsd: 0.23457,
    });

    expect(markup).toContain('Token Usage');
    expect(markup).toContain('$1.23');
    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.65');
    expect(markup).toContain('Subagents');
    expect(markup).toContain('$0.35');
    expect(markup).toContain('Older activity');
    expect(markup).toContain('$0.23');
    expect(markup).not.toContain('Model cost');
  });

  it('formats boundary total, root, and older-activity costs using integer cents', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 5.005,
      rootCostUsd: 5,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0.005,
    });

    expect(markup).toContain('Token Usage');
    expect(markup).toContain('$5.01');
    expect(markup).toContain('Root session');
    expect(markup).toContain('$5.00');
    expect(markup).toContain('Older activity');
    expect(markup).toContain('$0.01');
    expect(markup).not.toContain('Subagents');
  });

  it('renders a computed half-cent subagent residual without floating-point loss', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.105,
      rootCostUsd: 0.1,
      subagentCostUsd: 0.105 - 0.1,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Token Usage');
    expect(markup).toContain('$0.11');
    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.10');
    expect(markup).toContain('Subagents');
    expect(markup).toContain('$0.01');
    expect(markup).not.toContain('Older activity');
  });

  it('keeps rounded component rows reconciled to the displayed model cost', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.01,
      rootCostUsd: 0.005,
      subagentCostUsd: 0.005,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Token Usage');
    expect(markup).toContain('Root session');
    expect(markup).toContain('Subagents');
    expect([...markup.matchAll(/\$(\d+\.\d{2})/g)].map(match => match[1])).toEqual([
      '0.01',
      '0.00',
      '0.01',
    ]);
  });

  it('omits residual rows when only the root session has a cost', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.25,
      rootCostUsd: 0.25,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.25');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });

  it.each([
    { microdollars: 4_999, shouldRender: false },
    { microdollars: 5_000, shouldRender: true },
  ])(
    'applies the two-decimal display threshold to a $microdollars-microdollar subagent residual',
    ({ microdollars, shouldRender }) => {
      const subagentCostUsd = microdollars / 1_000_000;
      const markup = renderSessionInfo({
        totalCostUsd: 1 + subagentCostUsd,
        rootCostUsd: 1,
        subagentCostUsd,
        olderActivityCostUsd: 0,
      });

      expect(markup).toContain('Root session');

      if (shouldRender) {
        expect(markup).toContain('Subagents');
        expect(markup).toContain('$0.01');
      } else {
        expect(markup).not.toContain('Subagents');
        expect(markup).not.toContain('$0.00');
      }
    }
  );

  it.each([
    { microdollars: 4_999, shouldRender: false },
    { microdollars: 5_000, shouldRender: true },
  ])(
    'applies the two-decimal display threshold to a $microdollars-microdollar older-activity residual',
    ({ microdollars, shouldRender }) => {
      const olderActivityCostUsd = microdollars / 1_000_000;
      const markup = renderSessionInfo({
        totalCostUsd: 1 + olderActivityCostUsd,
        rootCostUsd: 1,
        subagentCostUsd: 0,
        olderActivityCostUsd,
      });

      expect(markup).toContain('Root session');

      if (shouldRender) {
        expect(markup).toContain('Older activity');
        expect(markup).toContain('$0.01');
      } else {
        expect(markup).not.toContain('Older activity');
        expect(markup).not.toContain('$0.00');
      }
    }
  );

  it('keeps a root-only reconciliation visible when the total reaches display precision', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.005,
      rootCostUsd: 0.005,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.01');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });

  it.each([
    {
      totalCostUsd: 0.004999,
      rootCostUsd: 0.004999,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    },
    {
      totalCostUsd: 0.004999,
      rootCostUsd: 0,
      subagentCostUsd: 0.004999,
      olderActivityCostUsd: 0,
    },
    {
      totalCostUsd: 0.004999,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0.004999,
    },
  ])('omits the total-cost section for totals below display precision', sessionCostBreakdown => {
    const markup = renderSessionInfo(sessionCostBreakdown);

    expect(markup).not.toContain('Token Usage');
    expect(markup).not.toContain('$0.00');
    expect(markup).not.toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
    expect(markup).toContain('Status unavailable');
  });

  it('includes a zero-cost root session when subagents have a positive cost', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.25,
      rootCostUsd: 0,
      subagentCostUsd: 0.25,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.00');
    expect(markup).toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });

  it('includes a zero-cost root session when older activity has a positive cost', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.25,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0.25,
    });

    expect(markup).toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).toContain('Older activity');
  });

  it.each([
    undefined,
    {
      totalCostUsd: 0,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    },
    {
      totalCostUsd: 0,
      rootCostUsd: 0.25,
      subagentCostUsd: 0.25,
      olderActivityCostUsd: 0.25,
    },
  ])('omits the total-cost section when the total is absent or zero', sessionCostBreakdown => {
    const markup = renderSessionInfo(sessionCostBreakdown);

    expect(markup).not.toContain('Token Usage');
    expect(markup).not.toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
    expect(markup).toContain('Status unavailable');
  });

  it('shows a renderable total without misleading detail rows when component costs are absent', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.25,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Token Usage');
    expect(markup).toContain('$0.25');
    expect(markup).not.toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });
});
