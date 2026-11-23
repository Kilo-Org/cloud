import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  BenchmarkRun,
  PaidBenchmarkAdminPayer,
  PaidBenchmarkAdminRequest,
} from '@kilocode/auto-routing-contracts';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmProvider } from '@/components/ui/confirm';
import {
  BenchmarkRequestsList,
  PlatformQueueSummary,
  formatMicrodollars,
  payerSummary,
  requestCaseLine,
  requestCaseProgress,
  requestSpendLine,
  requesterLabel,
  type RequestsFilter,
} from './BenchmarkRequestsSection';

jest.mock('sonner', () => ({ toast: { success: () => {}, info: () => {}, error: () => {} } }));

/** The list reads the query client and the confirmation context, so both are real here. */
function withProviders(element: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ConfirmProvider, null, element))
  );
}

// Radix select mounts a portal the static render cannot host; the filter itself is not
// under test here.
jest.mock('@/components/ui/select', () => {
  const container = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children);
  return {
    Select: container,
    SelectTrigger: container,
    SelectContent: container,
    SelectItem: container,
    SelectValue: () => null,
  };
});

const now = '2026-11-20T13:00:00.000Z';

function request(overrides: Partial<PaidBenchmarkAdminRequest> = {}): PaidBenchmarkAdminRequest {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    router: 'efficient',
    routerId: '22222222-2222-4222-8222-222222222222',
    organizationId: null,
    requester: {
      kind: 'user',
      ownerId: 'user-1',
      actorUserId: 'user-1',
      ownerLabel: 'owner@example.com',
    },
    status: 'active',
    createdAt: now,
    activatedAt: now,
    pausedAt: null,
    completedAt: null,
    estimateMicrodollars: 1_100_000,
    maximumMicrodollars: 1_300_000,
    chargedMicrodollars: 420_000,
    billedModelRequests: 9,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    pauseReason: null,
    counts: { queued: 4, running: 2, reused: 3, done: 12, failed: 1, paused: 0 },
    payers: [
      {
        kind: 'user',
        ownerId: 'user-1',
        billedModelRequests: 9,
        chargedMicrodollars: 420_000,
        detachReason: null,
        ownerLabel: 'owner@example.com',
      },
    ],
    poolName: 'My pool',
    failureReason: null,
    failureRetryable: false,
    ...overrides,
  };
}

function renderList(
  requests: PaidBenchmarkAdminRequest[],
  emptyFilter: RequestsFilter = 'all'
): string {
  return withProviders(createElement(BenchmarkRequestsList, { requests, emptyFilter }));
}

describe('request spend and progress', () => {
  it('reads microdollars as dollars with the runs list precision', () => {
    expect(formatMicrodollars(420_000)).toBe('$0.42');
    expect(formatMicrodollars(0)).toBe('$0');
    expect(formatMicrodollars(400)).toBe('$0.0004');
  });

  it('counts settled cases against the planned total', () => {
    const progress = requestCaseProgress(request());
    expect(progress.total).toBe(22);
    expect(progress.settled).toBe(16);
    expect(progress.percent).toBeCloseTo((16 / 22) * 100);
    expect(requestCaseLine(request())).toBe(
      '16 / 22 cases settled · 2 running · 4 queued · 12 done · 3 reused · 1 failed'
    );
  });

  it('says so when a request has no cases planned yet', () => {
    const empty = request({
      counts: { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: 0 },
    });
    expect(requestCaseProgress(empty).percent).toBe(0);
    expect(requestCaseLine(empty)).toBe('No cases planned');
  });

  it('states actual spend beside the estimate and full-cost figure, never a cap', () => {
    expect(requestSpendLine(request())).toBe(
      '$0.42 spent · estimated $1.10 · full-cost $1.30 · 9 model requests'
    );
    expect(
      requestSpendLine(request({ kiloCoveredModelRequests: 3, kiloCoveredMicrodollars: 120_000 }))
    ).toContain('Kilo covered 3 requests ($0.12)');
  });
});

describe('payer breakdown', () => {
  const shared: PaidBenchmarkAdminPayer[] = [
    {
      kind: 'user',
      ownerId: 'u1',
      billedModelRequests: 6,
      chargedMicrodollars: 500_000,
      detachReason: null,
      ownerLabel: 'a@example.com',
    },
    {
      kind: 'user',
      ownerId: 'u2',
      billedModelRequests: 6,
      chargedMicrodollars: 500_000,
      detachReason: null,
      ownerLabel: 'b@example.com',
    },
  ];

  it('splits the billed spend between concurrent payers and names their request counts', () => {
    expect(payerSummary(shared)).toBe(
      'a@example.com 50% (6 requests) · b@example.com 50% (6 requests)'
    );
  });

  it('names the platform cover by covered model requests, not zero-cost payers', () => {
    expect(
      payerSummary([
        { kind: 'platform', kiloCoveredModelRequests: 8, kiloCoveredMicrodollars: 30_000 },
        ...shared,
      ])
    ).toBe(
      'a@example.com 50% (6 requests) · b@example.com 50% (6 requests) · Kilo covers 8 requests'
    );
    expect(
      payerSummary([
        { kind: 'platform', kiloCoveredModelRequests: 1, kiloCoveredMicrodollars: 5_000 },
      ])
    ).toBe('Kilo covers 1 request');
  });

  it('does not invent a split before anything was billed', () => {
    const pending: PaidBenchmarkAdminPayer[] = [
      {
        kind: 'user',
        ownerId: 'u1',
        billedModelRequests: 0,
        chargedMicrodollars: 0,
        detachReason: null,
        ownerLabel: 'a@example.com',
      },
      {
        kind: 'user',
        ownerId: 'u2',
        billedModelRequests: 0,
        chargedMicrodollars: 0,
        detachReason: null,
        ownerLabel: 'b@example.com',
      },
    ];
    expect(payerSummary(pending)).toBe('Spend settles on completion');
    expect(payerSummary([])).toBe('No assigned payer');
  });

  it('shows a detached payer reason while keeping its billed requests', () => {
    expect(
      payerSummary([
        {
          kind: 'user',
          ownerId: 'u1',
          billedModelRequests: 3,
          chargedMicrodollars: 200_000,
          detachReason: 'insufficient_balance',
          ownerLabel: 'a@example.com',
        },
      ])
    ).toBe('a@example.com 100% (3 requests) · detached: insufficient_balance');
  });

  it('falls back to the owner id when the label could not be resolved', () => {
    expect(
      payerSummary([
        {
          kind: 'org',
          ownerId: 'org-9',
          billedModelRequests: 1,
          chargedMicrodollars: 5_000,
          detachReason: null,
          ownerLabel: null,
        },
      ])
    ).toBe('Org org-9 100% (1 request)');
  });
});

describe('requester', () => {
  it('names the owner label and adds the actor when someone else started it', () => {
    expect(requesterLabel(request())).toBe('owner@example.com');
    expect(
      requesterLabel(
        request({
          requester: { kind: 'org', ownerId: 'org-1', actorUserId: 'user-7', ownerLabel: 'Acme' },
        })
      )
    ).toBe('Acme · started by user-7');
  });

  it('falls back to the owner id when no label resolved', () => {
    expect(
      requesterLabel(
        request({
          requester: { kind: 'org', ownerId: 'org-1', actorUserId: 'org-1', ownerLabel: null },
        })
      )
    ).toBe('Org org-1');
  });
});

describe('requests list', () => {
  it('renders the wide table and the narrow cards from the same request', () => {
    const html = renderList([request()]);
    expect(html).toContain('hidden overflow-x-auto rounded-md border md:block');
    expect(html).toContain('flex flex-col gap-3 md:hidden');
    expect(html).toContain('owner@example.com');
    expect(html).toContain('My pool');
    expect(html).toContain('$0.42');
    expect(html).toContain('16 / 22 cases settled');
    expect(html).toContain('owner@example.com 100% (9 requests)');
  });

  it('offers Pause only for a request that still spends', () => {
    const active = renderList([request()]);
    expect(active).toContain('aria-label="Pause request 11111111-1111-4111-8111-111111111111"');

    for (const status of ['completed', 'paused', 'failed'] as const) {
      const settled = renderList([request({ status })]);
      expect(settled).not.toContain('Pause request');
    }
  });

  it('states the failure reason on the failed row itself', () => {
    const html = renderList([
      request({
        status: 'failed',
        failureReason: 'lane dead-lettered: provider 503',
        failureRetryable: true,
      }),
    ]);
    // The reason is visible without expanding the row, and kept in a title for the full
    // text, so an operator reading the list is not left with a bare "failed".
    expect(html).toContain('lane dead-lettered: provider 503');
    expect(html).toContain('title="lane dead-lettered: provider 503"');
  });

  it('names the covered share once Kilo pays part of it', () => {
    const html = renderList([
      request({
        kiloCoveredModelRequests: 3,
        kiloCoveredMicrodollars: 120_000,
        payers: [
          { kind: 'platform', kiloCoveredModelRequests: 3, kiloCoveredMicrodollars: 120_000 },
          {
            kind: 'user',
            ownerId: 'user-1',
            billedModelRequests: 9,
            chargedMicrodollars: 420_000,
            detachReason: null,
            ownerLabel: 'owner@example.com',
          },
        ],
      }),
    ]);
    expect(html).toContain('3 model requests');
    expect(html).toContain('covered by Kilo');
    expect(html).toContain('Kilo covers 3 requests');
  });

  it('distinguishes an empty queue from an empty filter', () => {
    expect(renderList([], 'all')).toContain('No paid pool benchmarks yet');
    expect(renderList([], 'failed')).toContain('No request matches this filter');
  });
});

describe('platform queue summary', () => {
  const run: BenchmarkRun = {
    id: 'decider-9',
    router: 'efficient',
    kind: 'decider',
    purpose: 'platform',
    status: 'running',
    startedAt: '2026-11-20T12:30:00.000Z',
    completedAt: null,
    error: null,
    progress: { completedCases: 10, totalCases: 25, failedCases: 1 },
    totals: { totalCostUsd: 0.52, measuredCases: 10, erroredCases: 1 },
  };

  it('names Kilo as requester and payer and shows the run spend', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlatformQueueSummary, { runs: [run], runningRunIds: ['decider-9'] })
    );
    expect(html).toContain('Kilo platform');
    expect(html).toContain('Kilo (100%)');
    expect(html).toContain('1 run in flight');
    expect(html).toContain('$0.52');
    expect(html).toContain('10 / 25 cases');
  });

  it('never offers a pause on platform work: the operator lock stops dispatch', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlatformQueueSummary, { runs: [run], runningRunIds: ['decider-9'] })
    );
    expect(html).not.toContain('Pause request');
    expect(html).toContain('operator lock');
    expect(html).not.toContain('Cancel run');
  });

  it('offers the operator a destructive cancel for a running platform run', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlatformQueueSummary, {
        runs: [run],
        runningRunIds: ['decider-9'],
        onCancelRun: () => {},
        cancellingRunId: null,
      })
    );
    expect(html).toContain('aria-label="Cancel run decider-9"');
    expect(html).toContain('Cancel run');
    expect(html).not.toContain('Pause request');
  });

  it('shows the cancel in flight and disables it', () => {
    const html = renderToStaticMarkup(
      React.createElement(PlatformQueueSummary, {
        runs: [run],
        runningRunIds: ['decider-9'],
        onCancelRun: () => {},
        cancellingRunId: 'decider-9',
      })
    );
    expect(html).toContain('Cancelling');
    expect(html).toContain('disabled');
  });
});
