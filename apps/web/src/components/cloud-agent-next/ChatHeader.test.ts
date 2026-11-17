import { describe, expect, it } from '@jest/globals';
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionCostBreakdown } from './session-cost-breakdown';
import type { SessionModelUsage, SessionTokenUsage } from './session-token-usage';
import type { SessionComputeCharges } from './SessionComputeRuns';

jest.mock('./ShareSessionDialog', () => ({ ShareSessionDialog: () => null }));
jest.mock('./SessionFailureHistory', () => ({
  ...jest.requireActual('./SessionFailureHistory'),
  SessionFailureHistory: () => null,
}));

let mockCompute: {
  data?: SessionComputeCharges;
  isError: boolean;
  error?: { data: { code: string } };
} = { isError: false };

jest.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === 'compute-session-charges' ? { ...mockCompute, refetch: jest.fn() } : {},
}));
jest.mock('@/lib/trpc/utils', () => ({
  useTRPC: () => ({
    cloudAgentNext: {
      getSessionMessagesPage: { queryOptions: () => ({ queryKey: ['session-messages'] }) },
    },
    computeBilling: {
      sessionCharges: { queryOptions: () => ({ queryKey: ['compute-session-charges'] }) },
      rates: { queryOptions: () => ({ queryKey: ['compute-rates'] }) },
    },
  }),
}));

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
  hasIncompleteHistory = false,
  sessionModelUsage?: SessionModelUsage[],
  computeBillingEnabled = false
): string {
  return renderToStaticMarkup(
    React.createElement(SessionInfoDialog, {
      open: true,
      onOpenChange: jest.fn(),
      sessionId: 'agent_session',
      sandboxScopeId: 'worktree_test',
      computeBillingEnabled,
      model: 'anthropic/claude-sonnet-4',
      sessionCostBreakdown,
      sessionTokenUsage,
      sessionModelUsage,
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

const workspaceCompute: SessionComputeCharges = {
  amountMicrodollars: 660_000,
  seconds: 1860,
  scope: 'workspace',
  runs: [
    {
      startedAt: '2026-11-10T14:40:00.000Z',
      stoppedAt: null,
      running: true,
      instance: 'standard-4',
      rateCentsPerSecond: 0.0333,
      seconds: 1200,
      amountMicrodollars: 399_600,
    },
    {
      startedAt: '2026-11-10T13:00:00.000Z',
      stoppedAt: '2026-11-10T13:10:00.000Z',
      running: false,
      instance: 'standard-4',
      rateCentsPerSecond: 0.0333,
      seconds: 600,
      amountMicrodollars: 199_800,
    },
  ],
  earlierRuns: { count: 1, seconds: 60, amountMicrodollars: 60_600 },
};

describe('SessionInfoDialog compute costs', () => {
  afterEach(() => {
    mockCompute = { isError: false };
  });

  const modelCost = {
    totalCostUsd: 1.25,
    rootCostUsd: 1.25,
    subagentCostUsd: 0,
    olderActivityCostUsd: 0,
  };
  const render = () => renderSessionInfo(modelCost, undefined, false, undefined, true);

  it('includes recorded workspace compute in the total and notes the shared scope', () => {
    mockCompute = { data: workspaceCompute, isError: false };
    const markup = render();
    expect(markup).toContain('Total cost');
    expect(markup).toContain('$1.91');
    expect(markup).toMatch(/>Model<\/dt>/);
    expect(markup).toContain('$1.25');
    expect(markup).toContain('Shared by all chats in this workspace');
    expect(markup).toContain('$0.66');
    expect(markup).toContain('Compute cost');
    expect(markup).not.toContain('arrive late');
    expect(markup).not.toContain('BYOC');
    expect(markup).not.toContain('Compute rate');
  });

  it('lists each sandbox run as duration times hourly rate, with earlier runs combined', () => {
    mockCompute = { data: workspaceCompute, isError: false };
    const markup = render();
    expect(markup).toMatch(/>3 runs<\/span>/);
    expect(markup).toMatch(
      / – now<\/span><span[^>]*>20 min × \$1\.20\/hr<\/span><span[^>]*>\$0\.40</
    );
    expect(markup).toMatch(/>10 min × \$1\.20\/hr<\/span><span[^>]*>\$0\.20</);
    expect(markup).toMatch(/>1 earlier run<\/span><span[^>]*>1 min<\/span><span[^>]*>\$0\.06</);
  });

  it('does not label an incomplete model-only amount as the total while compute loads', () => {
    const markup = render();
    expect(markup).toContain('Model cost');
    expect(markup).toContain('Loading…');
    expect(markup).not.toContain('Total cost');
    expect(markup).not.toContain('$0.00');
  });

  it('shows an actionable compute failure without treating missing charges as zero', () => {
    mockCompute = { isError: true };
    const markup = render();
    expect(markup).toContain('Unavailable');
    expect(markup).toContain('Compute charges could not load.');
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('Total cost');
    expect(markup).not.toContain('$0.00');
  });

  it('keeps the last recorded amount and total when a refresh fails', () => {
    mockCompute = {
      data: workspaceCompute,
      isError: true,
    };
    const markup = render();
    expect(markup).toContain('Total cost');
    expect(markup).toContain('$1.91');
    expect(markup).toContain('$0.66');
    expect(markup).toContain(
      'Compute charges could not refresh. Showing the last recorded amount.'
    );
    expect(markup).toContain('Retry');
    expect(markup).not.toContain('Unavailable');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])(
    'does not offer a retry or cached charges for %s',
    code => {
      mockCompute = {
        data: workspaceCompute,
        isError: true,
        error: { data: { code } },
      };
      const markup = render();
      expect(markup).toContain('Unavailable');
      expect(markup).toContain('You do not have access to this session&#x27;s compute charges.');
      expect(markup).not.toContain('Retry');
      expect(markup).not.toContain('Total cost');
      expect(markup).not.toContain('$0.66');
    }
  );

  it('includes a loaded zero compute charge without inventing usage', () => {
    mockCompute = {
      data: { amountMicrodollars: 0, seconds: 0, scope: 'session', runs: [], earlierRuns: null },
      isError: false,
    };
    const markup = render();
    expect(markup).toContain('Total cost');
    expect(markup).toMatch(/>Compute cost<\/dt>/);
    expect(markup).toContain('No usage yet');
    expect(markup).toContain('$0.00');
    expect(markup).not.toContain('Shared by all chats');
    expect(markup).not.toContain('<details');
  });
});

describe('SessionInfoDialog session costs', () => {
  it('renders the inclusive total and every positive cost component', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 1.23456,
      rootCostUsd: 0.65432,
      subagentCostUsd: 0.34567,
      olderActivityCostUsd: 0.23457,
    });

    expect(markup).toContain('Model cost');
    expect(markup).toContain('$1.23');
    expect(markup).toContain('Root session');
    expect(markup).toContain('$0.65');
    expect(markup).toContain('Subagents');
    expect(markup).toContain('$0.35');
    expect(markup).toContain('Older activity');
    expect(markup).toContain('$0.23');
    expect(markup).not.toContain('Compute');
    expect(markup).not.toContain('Token Usage');
  });

  it('formats boundary total, root, and older-activity costs using integer cents', () => {
    const markup = renderSessionInfo({
      totalCostUsd: 5.005,
      rootCostUsd: 5,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0.005,
    });

    expect(markup).toContain('Model cost');
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

    expect(markup).toContain('Model cost');
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

    expect(markup).toContain('Model cost');
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

      expect(markup).toContain('Model cost');
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

      expect(markup).toContain('Model cost');
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

    expect(markup).toContain('Model cost');
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

const modelUsage: SessionModelUsage[] = [
  {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4',
    costUsd: 1.23456,
    tokens: {
      input: 1_234,
      output: 89,
      reasoning: 7,
      cacheRead: 12_345,
      cacheWrite: 6_789,
    },
  },
  {
    providerID: 'kilo',
    modelID: 'anthropic/claude-opus-4.6',
    costUsd: 0.05,
    tokens: {
      input: 2,
      output: 3,
      reasoning: 5,
      cacheRead: 7,
      cacheWrite: 11,
    },
  },
];

describe('SessionInfoDialog model usage', () => {
  it('renders every model with its name, exact provider/model tuple, cost, and token counts', () => {
    const markup = renderSessionInfo(undefined, undefined, false, modelUsage);

    expect(markup).toContain('By model');
    expect(markup).toContain('claude-sonnet-4');
    expect(markup).toContain('anthropic / claude-sonnet-4');
    expect(markup).toContain('$1.23');
    expect(markup).toContain('claude-opus-4.6');
    expect(markup).toContain('kilo / anthropic/claude-opus-4.6');
    expect(markup).toContain('$0.05');

    for (const [label, value] of [
      ['Input', '1,234'],
      ['Output', '89'],
      ['Reasoning', '7'],
      ['Cache read', '12,345'],
      ['Cache write', '6,789'],
      ['Input', '2'],
      ['Output', '3'],
      ['Reasoning', '5'],
      ['Cache read', '7'],
      ['Cache write', '11'],
    ]) {
      expect(markup).toMatch(new RegExp(`${label}</dt><dd[^>]*>${value}</dd>`));
    }
  });

  it('uses native details and summary elements with five token buckets per model', () => {
    const markup = renderSessionInfo(undefined, undefined, false, modelUsage);

    expect(markup.match(/<details\b/g)).toHaveLength(2);
    expect(markup.match(/<\/details>/g)).toHaveLength(2);
    expect(markup.match(/<summary\b/g)).toHaveLength(2);
    expect(markup.match(/<\/summary>/g)).toHaveLength(2);

    for (const label of ['Input', 'Output', 'Reasoning', 'Cache read', 'Cache write']) {
      expect(markup.match(new RegExp(`>${label}</dt>`, 'g'))).toHaveLength(2);
    }
  });

  it.each([
    { label: 'missing', sessionModelUsage: undefined },
    { label: 'empty', sessionModelUsage: [] as SessionModelUsage[] },
  ])('hides the By model section when usage is $label', ({ sessionModelUsage }) => {
    const markup = renderSessionInfo(undefined, tokenUsage, false, sessionModelUsage);

    expect(markup).not.toContain('By model');
    expect(markup).not.toContain('Loaded main-agent activity only');
  });

  it('renders zero-cost and sub-cent models with their formatted costs', () => {
    const markup = renderSessionInfo(undefined, undefined, false, [
      {
        providerID: 'provider-zero',
        modelID: 'zero-cost-model',
        costUsd: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        providerID: 'provider-subcent',
        modelID: 'subcent-model',
        costUsd: 0.004999,
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cacheRead: 4,
          cacheWrite: 5,
        },
      },
    ]);

    expect(markup).toContain('zero-cost-model');
    expect(markup).toContain('$0.00');
    expect(markup).toContain('subcent-model');
    expect(markup).toContain('&lt;$0.01');
    expect(markup.match(/<details\b/g)).toHaveLength(2);
  });

  it('explains the loaded activity scope and labels the selected model', () => {
    const markup = renderSessionInfo(undefined, tokenUsage, false, modelUsage);

    expect(markup).toContain(
      'Loaded main-agent activity only. Subagent and older-activity costs are not attributed to models.'
    );
    expect(markup).toMatch(/Selected model<\/dt>/);
    expect(markup).not.toMatch(/>Model<\/dt>/);
  });
});
