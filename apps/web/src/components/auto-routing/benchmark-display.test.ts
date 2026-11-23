import { describe, expect, it } from '@jest/globals';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import type {
  PaidBenchmarkCase,
  PaidBenchmarkCaseStatus,
  PaidBenchmarkProgress,
  PaidBenchmarkQuote,
  RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import { TRPCClientError } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import {
  applyCasePage,
  beginCasePage,
  benchmarkRequestErrorCopy,
  blockedModelCopy,
  casePageState,
  failCasePage,
  formatUsd,
  mergeCases,
  progressTotals,
  quoteBreakdown,
  quoteCaseCount,
  routeReason,
  routingRows,
  startFailureCopy,
  type BenchmarkFailureCopy,
} from './benchmark-display';

function clientError(code: TRPC_ERROR_CODE_KEY, message: string) {
  return TRPCClientError.from<RootRouter>({
    error: { code: -32600, message, data: { code, httpStatus: 400, zodError: null } },
  });
}

const READY_QUOTE: PaidBenchmarkQuote = {
  status: 'ready',
  id: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2026-11-20T13:00:00.000Z',
  estimateMicrodollars: 1_234_000,
  maximumMicrodollars: 1_500_000,
  cases: { reused: 4, covered: 2, shared: 3, exclusive: 1 },
  aliases: [{ model: '~vendor/model-latest', target: 'vendor/model-2' }],
};

function candidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  return {
    model: 'vendor/a',
    accuracy: 0.9,
    avgCostUsd: 0.002,
    meetsThreshold: true,
    ...overrides,
  };
}

type CaseCounts = Partial<Record<PaidBenchmarkCaseStatus, number>>;

const ZERO_CASE_COUNTS: Record<PaidBenchmarkCaseStatus, number> = {
  queued: 0,
  running: 0,
  reused: 0,
  done: 0,
  failed: 0,
  paused: 0,
};

function progress(
  status: Exclude<PaidBenchmarkProgress['status'], 'empty'>,
  counts: CaseCounts
): PaidBenchmarkProgress {
  const fields = {
    id: '00000000-0000-4000-8000-000000000002',
    estimateMicrodollars: 1_000_000,
    maximumMicrodollars: 1_200_000,
    chargedMicrodollars: 0,
    billedModelRequests: 0,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    counts: { ...ZERO_CASE_COUNTS, ...counts },
    cases: [] as PaidBenchmarkCase[],
    nextCursor: null,
  };
  return status === 'failed'
    ? { ...fields, status, reason: 'credit unavailable', retryable: true }
    : status === 'paused'
      ? { ...fields, status, reason: null }
      : { ...fields, status };
}

describe('formatUsd', () => {
  it('keeps sub-cent totals from reading as free', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0000004)).toBe('<$0.000001');
    expect(formatUsd(0.00042)).toBe('$0.00042');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('quote breakdown', () => {
  it('counts every selected case once', () => {
    expect(quoteCaseCount(READY_QUOTE)).toBe(10);
  });

  it('names the reuse, Kilo coverage, shared and exclusive buckets', () => {
    const rows = quoteBreakdown(READY_QUOTE);
    expect(rows.map(row => [row.label, row.count])).toEqual([
      ['Reused results', 4],
      ['Covered by Kilo', 2],
      ['Shared with other pools', 3],
      ['Only this pool', 1],
    ]);
  });

  it('has no breakdown without a quote', () => {
    expect(quoteBreakdown({ status: 'empty' })).toEqual([]);
  });
});

describe('blockedModelCopy', () => {
  it('names the asked model, the human reason, and the failing pair', () => {
    const copy = blockedModelCopy({
      model: '~vendor/model-latest',
      pair: { model: 'vendor/model-2', variant: 'high' },
      failure: {
        kind: 'permanent',
        failureClass: 'model_not_found',
        reason: 'the provider removed this model',
        attempts: 4,
        firstFailedAt: '2026-11-18T00:00:00.000Z',
        lastFailedAt: '2026-11-19T00:00:00.000Z',
        cause: 'terminal_class',
      },
    });
    expect(copy).toContain('~vendor/model-latest cannot be added');
    expect(copy).toContain('the provider removed this model');
    expect(copy).toContain('vendor/model-2 (high)');
    expect(copy).not.toContain('model_not_found');
  });

  it('names the retry time of a retryable block and still refuses the add', () => {
    const copy = blockedModelCopy({
      model: 'vendor/a',
      pair: { model: 'vendor/a', variant: null },
      failure: {
        kind: 'retryable',
        failureClass: 'provider_unavailable',
        reason: 'the provider is down',
        attempts: 1,
        firstFailedAt: '2026-11-20T00:00:00.000Z',
        lastFailedAt: '2026-11-20T00:00:00.000Z',
        retryAfter: '2026-11-20T06:00:00.000Z',
      },
    });
    expect(copy).toContain('vendor/a cannot be added');
    expect(copy).toContain('the provider is down');
    expect(copy).toContain('retried after 2026-11-20T06:00:00.000Z');
  });
});

describe('start failure copy', () => {
  it('reports nothing for a started request', () => {
    expect(
      startFailureCopy({ status: 'started', request: progress('active', { queued: 1 }) })
    ).toBeNull();
  });

  it('names required and available amounts only when the server sends them', () => {
    const withAmounts = startFailureCopy({
      status: 'insufficient_balance',
      requiredMicrodollars: 2_500_000,
      availableMicrodollars: 300_000,
    });
    expect(withAmounts?.title).toBe('Not enough credits');
    expect(withAmounts?.description).toContain('$2.50');
    expect(withAmounts?.description).toContain('$0.30');
    expect(withAmounts?.retryable).toBe(false);

    const withoutAmounts = startFailureCopy({ status: 'insufficient_balance' });
    expect(withoutAmounts?.description).toContain('Add credits');
    expect(withoutAmounts?.description).not.toContain('$');
  });

  it('asks for a new estimate instead of replaying an expired or stale quote', () => {
    for (const result of [
      { status: 'quote_expired' as const },
      { status: 'quote_mismatch' as const, reason: 'The pool changed.' },
    ]) {
      const copy = startFailureCopy(result);
      expect(copy?.retryable).toBe(false);
      expect(copy?.description).toContain('Nothing was charged');
      expect(copy?.description).toContain('estimate');
    }
  });

  it('shows the running request instead of an error when a start finds one live', () => {
    const copy = startFailureCopy({
      status: 'already_in_progress',
      request: progress('preparing', { queued: 3 }),
    });
    expect(copy?.title).toBe('A benchmark is already running for this pool');
    expect(copy?.description).toContain('already in progress');
    expect(copy?.description).toContain('Nothing new was started or charged');
    expect(copy?.retryable).toBe(false);
  });

  it('keeps the server retryability of a blocked request', () => {
    expect(
      startFailureCopy({ status: 'blocked', reason: 'Busy', retryable: true })?.retryable
    ).toBe(true);
    expect(
      startFailureCopy({ status: 'blocked', reason: 'Model banned', retryable: false })?.retryable
    ).toBe(false);
  });
});

describe('benchmarkRequestErrorCopy', () => {
  it('treats an unclassified failure as a transport retry', () => {
    const copy = benchmarkRequestErrorCopy(new Error('socket hang up'));
    expect(copy.retryable).toBe(true);
    expect(copy.description).toContain('Nothing was charged');
  });

  it('names insufficient credit and asks for a fresh estimate', () => {
    const copy = benchmarkRequestErrorCopy(
      clientError(
        'PRECONDITION_FAILED',
        'This benchmark needs more credit than the pool owner has available.'
      )
    );
    expect(copy.title).toBe('Not enough credits');
    expect(copy.retryable).toBe(false);
    expect(copy.description).toContain('fresh estimate');
    expect(copy.description).not.toContain('benchmark again');
  });

  it('asks for a fresh estimate when the pool outgrew the quote', () => {
    const copy = benchmarkRequestErrorCopy(clientError('CONFLICT', 'The pool changed.'));
    expect(copy.title).toBe('This estimate is no longer valid');
    expect(copy.retryable).toBe(false);
    expect(copy.description).toContain('Nothing was charged');
  });

  it('offers the same request again after a timeout or a busy service', () => {
    const retryableCodes: TRPC_ERROR_CODE_KEY[] = [
      'TIMEOUT',
      'TOO_MANY_REQUESTS',
      'INTERNAL_SERVER_ERROR',
    ];
    for (const code of retryableCodes) {
      const copy = benchmarkRequestErrorCopy(clientError(code, 'Try later.'));
      expect(copy.retryable).toBe(true);
      expect(copy.description).toContain('Nothing was charged');
    }
  });

  it('treats a refused request as non-retryable', () => {
    const copy = benchmarkRequestErrorCopy(clientError('FORBIDDEN', 'You do not own this pool.'));
    expect(copy.retryable).toBe(false);
    expect(copy.description).toContain('You do not own this pool.');
    expect(copy.description).toContain('can start a paid benchmark');
    expect(copy.description).toContain('can pause one');
  });
});

describe('progress totals', () => {
  it('zero-fills all six case states', () => {
    const totals = progressTotals(progress('active', { done: 3, running: 1 }));
    expect(totals.counts).toEqual({
      queued: 0,
      running: 1,
      reused: 0,
      done: 3,
      failed: 0,
      paused: 0,
    });
    expect(totals.total).toBe(4);
    expect(totals.finished).toBe(3);
  });

  it('counts a failed case as finished work', () => {
    const totals = progressTotals(progress('failed', { done: 1, failed: 1, paused: 2 }));
    expect(totals.finished).toBe(2);
    expect(totals.total).toBe(4);
    expect(totals.percent).toBe(50);
  });

  it('reports nothing for an empty progress', () => {
    expect(progressTotals({ status: 'empty' }).total).toBe(0);
    expect(progressTotals(undefined).percent).toBe(0);
  });
});

describe('case accumulation', () => {
  const first: PaidBenchmarkCase = {
    id: 'a',
    model: 'vendor/a',
    variant: null,
    caseId: 'case-1',
    repetition: 0,
    status: 'done',
    billedModelRequests: 1,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    coveredByKilo: false,
    chargedMicrodollars: 10,
    reason: null,
  };
  const second: PaidBenchmarkCase = { ...first, id: 'b', caseId: 'case-2', status: 'queued' };

  it('appends a page without duplicating an overlapping case', () => {
    expect(mergeCases([first], [first, second]).map(item => item.id)).toEqual(['a', 'b']);
  });
});

describe('case page state', () => {
  const caseA: PaidBenchmarkCase = {
    id: 'a',
    model: 'vendor/a',
    variant: null,
    caseId: 'case-1',
    repetition: 0,
    status: 'done',
    billedModelRequests: 1,
    kiloCoveredModelRequests: 0,
    kiloCoveredMicrodollars: 0,
    coveredByKilo: false,
    chargedMicrodollars: 10,
    reason: null,
  };
  const caseB: PaidBenchmarkCase = { ...caseA, id: 'b', caseId: 'case-2', status: 'queued' };
  const failure: BenchmarkFailureCopy = {
    title: 'Could not reach the benchmark service',
    description: 'Check your connection and try again. Nothing was charged.',
    retryable: true,
  };

  it('starts a new request at its first page', () => {
    const state = casePageState(null, 'req-1');
    expect(state).toEqual({ kind: 'first', requestId: 'req-1' });
    expect(casePageState(state, 'req-1')).toBe(state);
    expect(casePageState(state, 'req-2')).toEqual({ kind: 'first', requestId: 'req-2' });
  });

  it('applies a page to the loading state of the request that asked', () => {
    const loading = beginCasePage(casePageState(null, 'req-1'), 'req-1', 'cursor-2');
    const applied = applyCasePage(loading, 'req-1', 'cursor-2', {
      cases: [caseA],
      nextCursor: 'cursor-3',
    });
    expect(applied).toMatchObject({ kind: 'paged', requestId: 'req-1', cursor: 'cursor-3' });
    expect(applied.kind === 'paged' ? applied.cases.map(item => item.id) : []).toEqual(['a']);
  });

  it('drops a late page after switching to another request', () => {
    const loading = beginCasePage(casePageState(null, 'req-1'), 'req-1', 'cursor-2');
    const nextRequest = casePageState(loading, 'req-2');
    expect(
      applyCasePage(nextRequest, 'req-1', 'cursor-2', { cases: [caseB], nextCursor: 'cursor-3' })
    ).toBe(nextRequest);
    expect(failCasePage(nextRequest, 'req-1', 'cursor-2', failure)).toBe(nextRequest);
  });

  it('drops a page for a cursor that is no longer the one in flight', () => {
    const paged = applyCasePage(
      beginCasePage(casePageState(null, 'req-1'), 'req-1', 'cursor-2'),
      'req-1',
      'cursor-2',
      { cases: [caseA], nextCursor: 'cursor-3' }
    );
    // The answer for the previous cursor arrives after the next page is shown.
    expect(applyCasePage(paged, 'req-1', 'cursor-2', { cases: [caseB], nextCursor: null })).toBe(
      paged
    );
  });

  it('keeps the cursor after a failed page so the same click retries', () => {
    const loading = beginCasePage(casePageState(null, 'req-1'), 'req-1', 'cursor-2');
    const failed = failCasePage(loading, 'req-1', 'cursor-2', failure);
    expect(failed).toMatchObject({ kind: 'failed', requestId: 'req-1', cursor: 'cursor-2' });
    expect(beginCasePage(failed, 'req-1', 'cursor-2')).toMatchObject({
      kind: 'loading',
      cursor: 'cursor-2',
    });
  });

  it('ends pagination at the last page', () => {
    const loading = beginCasePage(casePageState(null, 'req-1'), 'req-1', 'cursor-2');
    const applied = applyCasePage(loading, 'req-1', 'cursor-2', {
      cases: [caseA],
      nextCursor: null,
    });
    expect(applied).toMatchObject({ kind: 'paged', cursor: null });
  });

  it('ignores a begin for another request', () => {
    const first = casePageState(null, 'req-1');
    expect(beginCasePage(first, 'req-2', 'cursor-2')).toBe(first);
  });
});

describe('route reasons', () => {
  it('explains the accuracy pick against the floor and the runner-up', () => {
    const reason = routeReason(
      [
        candidate({ model: 'vendor/a', accuracy: 0.93 }),
        candidate({ model: 'vendor/b', accuracy: 0.9 }),
      ],
      'best_accuracy',
      0.7
    );
    expect(reason).toContain('Highest accuracy (93.0%)');
    expect(reason).toContain('meets the 70.0% floor');
    expect(reason).toContain('+3.0 pts vs vendor/b');
  });

  it('flags an accuracy pick below the floor', () => {
    const reason = routeReason(
      [candidate({ accuracy: 0.5, meetsThreshold: false })],
      'best_accuracy',
      0.7
    );
    expect(reason).toContain('Best available accuracy (50.0%)');
    expect(reason).toContain('below the 70.0% floor');
  });

  it('explains the cheapest pick by cost', () => {
    const reason = routeReason([candidate({ avgCostUsd: 0.00042 })], 'cheapest', 0.7);
    expect(reason).toContain('Lowest average cost per case ($0.00042)');
    expect(reason).toContain('meets the 70.0% floor');
  });

  it('explains the accuracy-per-dollar pick', () => {
    const reason = routeReason(
      [candidate({ accuracy: 0.8, avgCostUsd: 0.004 })],
      'cost_per_accuracy',
      0.7
    );
    expect(reason).toContain('Best accuracy per dollar');
    expect(reason).toContain('$0.005');
  });

  it('marks an older measurement and names the case count', () => {
    const reason = routeReason([candidate({ cases: 12, stale: true })], 'best_accuracy', 0.7);
    expect(reason).toContain('12 benchmark cases');
    expect(reason).toContain('measured with an older benchmark');
  });

  it('falls back for a route the table omits', () => {
    const rows = routingRows(
      {
        version: 'run-1',
        generatedAt: '2026-11-20T12:00:00.000Z',
        minAccuracy: 0.7,
        switchCostFactor: 2,
        bestAccuracySwitchThreshold: 0.05,
        source: 'benchmark',
        routes: { 'implementation/feature_development': [candidate({})] },
      },
      ['implementation/feature_development', 'debugging/bug_fixing'],
      'cost_per_accuracy',
      'vendor/default'
    );
    expect(rows[0]?.reason).toContain('Best accuracy per dollar');
    expect(rows[1]?.candidates).toBeNull();
    expect(rows[1]?.reason).toContain('falls back to its default model (vendor/default)');
  });
});
