import { describe, expect, it } from '@jest/globals';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionCostBreakdown } from './session-cost-breakdown';
import type { SessionTokenUsage } from './session-token-usage';

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

import { SessionInfoDialog } from './SessionInfoDialog';

Object.assign(globalThis, { React });

function renderSessionInfo(
  sessionCostBreakdown?: SessionCostBreakdown,
  sessionTokenUsage?: SessionTokenUsage,
  hasIncompleteHistory = false
): string {
  return renderToStaticMarkup(
    React.createElement(SessionInfoDialog, {
      open: true,
      onOpenChange: jest.fn(),
      sessionId: 'agent_session',
      model: 'anthropic/claude-sonnet-4',
      sessionCostBreakdown,
      sessionTokenUsage,
      hasIncompleteHistory,
    })
  );
}

const tokenUsage: SessionTokenUsage = {
  input: 1_234_567,
  output: 89,
  reasoning: 7,
  cacheRead: 12_345,
  cacheWrite: 6_789,
};

describe('SessionInfoDialog session costs', () => {
  it('renders the inclusive total and every positive cost component', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 1.23456,
      rootCostUsd: 0.65432,
      subagentCostUsd: 0.34567,
      olderActivityCostUsd: 0.23457,
    });

    expect(markup).toContain('Total cost');
    expect(markup).toContain('$1.23');
    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.65');
    expect(markup).toContain('Subagents');
    expect(markup).toContain('$0.35');
    expect(markup).toContain('Older activity');
    expect(markup).toContain('$0.23');
    expect(markup).not.toContain('Model cost');
    expect(markup).not.toContain('Token Usage');
  });

  it('formats boundary total, root, and older-activity costs using integer cents', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 5.005,
      rootCostUsd: 5,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0.005,
    });

    expect(markup).toContain('Total cost');
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

    expect(markup).toContain('Total cost');
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

    expect(markup).toContain('Total cost');
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
  ])(
    'shows a sub-cent total for supplied breakdowns below display precision',
    sessionCostBreakdown => {
      const markup = renderSessionInfo(sessionCostBreakdown);

      expect(markup).toContain('Total cost');
      expect(markup).toContain('&lt;$0.01');
      expect(markup).not.toContain('$0.00');
      expect(markup).not.toContain('Root session');
      expect(markup).not.toContain('Subagents');
      expect(markup).not.toContain('Older activity');
    }
  );

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

  it('omits the total-cost section when the breakdown is absent', () => {
    const markup = renderSessionInfo(undefined);

    expect(markup).not.toContain('Total cost');
    expect(markup).not.toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });

  it.each([
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
  ])(
    'shows a zero total without component rows for a supplied zero breakdown',
    sessionCostBreakdown => {
      const markup = renderSessionInfo(sessionCostBreakdown);

      expect(markup).toContain('Total cost');
      expect(markup).toContain('$0.00');
      expect(markup).not.toContain('Root session');
      expect(markup).not.toContain('Subagents');
      expect(markup).not.toContain('Older activity');
    }
  );

  it('shows a renderable total without misleading detail rows when component costs are absent', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 0.25,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });

    expect(markup).toContain('Total cost');
    expect(markup).toContain('$0.25');
    expect(markup).not.toContain('Root session');
    expect(markup).not.toContain('Subagents');
    expect(markup).not.toContain('Older activity');
  });
});

describe('SessionInfoDialog token usage', () => {
  it('renders each main-agent token count with thousands separators', () => {
    const markup = renderSessionInfo(undefined, tokenUsage);

    expect(markup).toContain('Main agent tokens');
    for (const [label, value] of [
      ['Input', '1,234,567'],
      ['Output', '89'],
      ['Reasoning', '7'],
      ['Cache read', '12,345'],
      ['Cache write', '6,789'],
    ]) {
      expect(markup).toMatch(new RegExp(`${label}</dt><dd[^>]*>${value}</dd>`));
    }
    expect(markup).toContain('excluding subagents');
  });

  it('renders zero token counts when every count is zero', () => {
    const markup = renderSessionInfo(undefined, {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });

    expect(markup).toContain('Main agent tokens');
    expect([...markup.matchAll(/>0<\/dd>/g)]).toHaveLength(5);
  });

  it('omits token usage when no token usage is supplied', () => {
    const markup = renderSessionInfo(undefined, undefined, true);

    expect(markup).not.toContain('Main agent tokens');
    expect(markup).not.toContain('Token counts cover loaded activity only');
  });

  it('shows the partial-history notice when older history is not loaded', () => {
    const markup = renderSessionInfo(undefined, tokenUsage, true);

    expect(markup).toContain('Token counts cover loaded activity only');
    expect(markup).toContain('role="status"');
  });

  it.each([0.004999, 0.05])(
    'shows the partial-history notice when the breakdown includes older activity of %s USD',
    olderActivityCostUsd => {
      const markup = renderSessionInfo(
        {
          totalCostUsd: 0.25,
          rootCostUsd: 0.25 - olderActivityCostUsd,
          subagentCostUsd: 0,
          olderActivityCostUsd,
        },
        tokenUsage
      );

      expect(markup).toContain('Token counts cover loaded activity only');
    }
  );

  it('omits the partial-history notice when history is complete and no older activity exists', () => {
    const markup = renderSessionInfo(
      {
        totalCostUsd: 0.25,
        rootCostUsd: 0.25,
        subagentCostUsd: 0,
        olderActivityCostUsd: 0,
      },
      tokenUsage
    );

    expect(markup).not.toContain('Token counts cover loaded activity only');
  });
});
