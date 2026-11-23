import type {
  AutoRoutingMode,
  CustomRouterBlockedModelsResponse,
  CustomRoutingTable,
  PaidBenchmarkCase,
  PaidBenchmarkCaseStatus,
  PaidBenchmarkProgress,
  PaidBenchmarkQuote,
  PaidBenchmarkStartResult,
  RankedCandidate,
} from '@kilocode/auto-routing-contracts';
import { TRPCClientError } from '@trpc/client';

/** How often an in-flight request refreshes its case page. */
export const BENCHMARK_PROGRESS_POLL_INTERVAL_MS = 3000;

/** Slower refresh for a settled request that still waits on admitted call receipts. */
export const BENCHMARK_PENDING_RECEIPT_POLL_INTERVAL_MS = 20_000;

/** Display order of the six case states, independent of the wire order. */
export const CASE_STATUS_ORDER: readonly PaidBenchmarkCaseStatus[] = [
  'queued',
  'running',
  'reused',
  'done',
  'failed',
  'paused',
];

export const CASE_STATUS_LABELS: Record<PaidBenchmarkCaseStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  reused: 'Reused (free)',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
};

export const CASE_STATUS_BADGE_VARIANT: Record<
  PaidBenchmarkCaseStatus,
  'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'new'
> = {
  queued: 'outline',
  running: 'default',
  reused: 'new',
  done: 'new',
  failed: 'destructive',
  paused: 'warning',
};

/**
 * A USD amount for a benchmark surface: a total with ordinary precision, but a
 * sub-cent total keeps enough precision to never read as free.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  const small = Number(usd.toFixed(6));
  return small === 0 ? '<$0.000001' : `$${small}`;
}

export function formatBenchmarkMicrodollars(microdollars: number): string {
  return formatUsd(microdollars / 1_000_000);
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Total case runs a ready quote covers, across every priced bucket. */
export function quoteCaseCount(quote: PaidBenchmarkQuote): number {
  if (quote.status !== 'ready') return 0;
  const { reused, covered, shared, exclusive } = quote.cases;
  return reused + covered + shared + exclusive;
}

export type QuoteBreakdownRow = {
  label: string;
  count: number;
  detail: string;
};

/**
 * The quote's buckets in the words the owner needs before paying: what is
 * already measured, what Kilo covers, what is split with other pools, and what
 * this owner pays for alone.
 */
export function quoteBreakdown(quote: PaidBenchmarkQuote): QuoteBreakdownRow[] {
  if (quote.status !== 'ready') return [];
  const { reused, covered, shared, exclusive } = quote.cases;
  return [
    {
      label: 'Reused results',
      count: reused,
      detail: 'Already measured at this engine version, so they cost nothing.',
    },
    {
      label: 'Covered by Kilo',
      count: covered,
      detail: 'Kilo joins these cases, so it pays the model requests from then on.',
    },
    {
      label: 'Shared with other pools',
      count: shared,
      detail:
        'Another payer wants these cases too, so payers alternate model requests within each one.',
    },
    {
      label: 'Only this pool',
      count: exclusive,
      detail: 'This pool is the only current payer for these cases.',
    },
  ];
}

export type BenchmarkFailureCopy = {
  title: string;
  description: string;
  /** The same explicit action can succeed again without a new estimate. */
  retryable: boolean;
};

const RETRYABLE_CODES: Record<string, true> = {
  TIMEOUT: true,
  TOO_MANY_REQUESTS: true,
  CLIENT_CLOSED_REQUEST: true,
  INTERNAL_SERVER_ERROR: true,
};

/** Copy for a model the benchmark registry refuses to measure right now. */
export function blockedModelCopy(
  blocked: CustomRouterBlockedModelsResponse['blocked'][number]
): string {
  const variant = blocked.pair.variant === null ? '' : ` (${blocked.pair.variant})`;
  const reason = blocked.failure.reason ?? 'its benchmark is unavailable';
  const retry =
    blocked.failure.kind === 'retryable'
      ? ` It is retried after ${blocked.failure.retryAfter}.`
      : '';
  return `${blocked.model} cannot be added: ${reason}.${retry} The failing model is ${blocked.pair.model}${variant}.`;
}

/** Copy for a thrown request failure. Insufficient credit and a quote the pool
 * outgrew ask for a fresh estimate; a timeout or busy service may succeed again
 * as-is; anything else the server refuses is final until the owner changes
 * something. Neither path starts work by itself.
 */
export function benchmarkRequestErrorCopy(error: unknown): BenchmarkFailureCopy {
  if (error instanceof TRPCClientError) {
    const code = error.data?.code;
    if (code === 'PRECONDITION_FAILED') {
      return {
        title: 'Not enough credits',
        description: `${error.message} Add credits, then get a fresh estimate. Nothing was charged.`,
        retryable: false,
      };
    }
    if (code === 'CONFLICT') {
      return {
        title: 'This estimate is no longer valid',
        description: `${error.message} Get a fresh estimate. Nothing was charged and no benchmark ran.`,
        retryable: false,
      };
    }
    if (code === 'FORBIDDEN') {
      return {
        title: 'You do not have permission for this pool',
        description: `${error.message} Only the pool owner or an organization admin can start a paid benchmark; owners, admins and billing managers can pause one.`,
        retryable: false,
      };
    }
    if (code === 'NOT_FOUND') {
      return {
        title: 'This pool no longer exists',
        description: `${error.message} Reload the page to see the current pools.`,
        retryable: false,
      };
    }
    if (code !== undefined && RETRYABLE_CODES[code] === true) {
      return {
        title: 'The benchmark service is busy',
        description: `${error.message} Nothing was charged; try again in a moment.`,
        retryable: true,
      };
    }
    if (code !== undefined) {
      return {
        title: 'The benchmark request was refused',
        description: error.message || 'This request cannot be repeated as-is.',
        retryable: false,
      };
    }
  }
  return {
    title: 'Could not reach the benchmark service',
    description: 'Check your connection and try again. Nothing was charged.',
    retryable: true,
  };
}

/** Copy for a `start` result that did not start the request. */
export function startFailureCopy(result: PaidBenchmarkStartResult): BenchmarkFailureCopy | null {
  switch (result.status) {
    case 'started':
      return null;
    case 'already_in_progress':
      // Not a failure: the pool's live request is shown instead, and nothing was started or
      // charged. The dialog renders this as a notice, not an error.
      return {
        title: 'A benchmark is already running for this pool',
        description: 'Showing the request already in progress. Nothing new was started or charged.',
        retryable: false,
      };
    case 'insufficient_balance': {
      const required =
        result.requiredMicrodollars === undefined
          ? null
          : formatBenchmarkMicrodollars(result.requiredMicrodollars);
      const available =
        result.availableMicrodollars === undefined
          ? null
          : formatBenchmarkMicrodollars(result.availableMicrodollars);
      const amounts =
        required !== null && available !== null
          ? ` It needs ${required} and your balance is ${available}.`
          : required !== null
            ? ` It needs ${required}.`
            : '';
      return {
        title: 'Not enough credits',
        description: `${amounts} Add credits, then get a fresh estimate — an accepted estimate cannot be reused. Nothing was charged.`,
        retryable: false,
      };
    }
    case 'quote_expired':
      return {
        title: 'This estimate expired',
        description:
          'Get a fresh estimate to review the current cost. Nothing was charged and no benchmark ran.',
        retryable: false,
      };
    case 'quote_mismatch':
      return {
        title: 'This estimate no longer matches the pool',
        description: `${result.reason} Get a fresh estimate. Nothing was charged and no benchmark ran.`,
        retryable: false,
      };
    case 'blocked':
      return {
        title: result.retryable
          ? 'The benchmark could not start'
          : 'This pool cannot be benchmarked',
        description: result.retryable ? `${result.reason} Try again in a moment.` : result.reason,
        retryable: result.retryable,
      };
  }
}

export type ProgressTotals = {
  total: number;
  finished: number;
  percent: number;
  counts: Record<PaidBenchmarkCaseStatus, number>;
};

/** Counts for all six states, zero-filled so the summary never hides one. */
export function progressTotals(progress: PaidBenchmarkProgress | undefined): ProgressTotals {
  const counts = Object.fromEntries(CASE_STATUS_ORDER.map(status => [status, 0])) as Record<
    PaidBenchmarkCaseStatus,
    number
  >;
  if (progress === undefined || progress.status === 'empty') {
    return { total: 0, finished: 0, percent: 0, counts };
  }
  for (const status of CASE_STATUS_ORDER) {
    counts[status] = progress.counts[status] ?? 0;
  }
  const total = CASE_STATUS_ORDER.reduce((sum, status) => sum + counts[status], 0);
  const finished = counts.reused + counts.done + counts.failed;
  return {
    total,
    finished,
    percent: total === 0 ? 0 : Math.min(100, (finished / total) * 100),
    counts,
  };
}

/** The unique cases of one accumulated request, keyed by case-run id. */
export function mergeCases(
  current: readonly PaidBenchmarkCase[],
  page: readonly PaidBenchmarkCase[]
): PaidBenchmarkCase[] {
  const seen = new Set(current.map(item => item.id));
  const added = page.filter(item => !seen.has(item.id));
  return added.length === 0 ? [...current] : [...current, ...added];
}

export function filterCases(
  cases: readonly PaidBenchmarkCase[],
  filter: PaidBenchmarkCaseStatus | 'all'
): PaidBenchmarkCase[] {
  return filter === 'all' ? [...cases] : cases.filter(item => item.status === filter);
}

/**
 * Why this route is served by its first-ranked candidate. The table stores
 * ranked candidates, not a reason, so the sentence is derived from the same
 * numbers the ranking used: the pool mode, the accuracy floor, and the runner-up.
 */
export function routeReason(
  candidates: readonly RankedCandidate[],
  mode: AutoRoutingMode,
  minAccuracy: number | undefined
): string {
  const [pick, second] = candidates;
  if (pick === undefined) return '';
  const floor = minAccuracy === undefined ? null : formatPercent(minAccuracy);
  const parts: string[] = [];

  if (mode === 'best_accuracy') {
    parts.push(
      pick.meetsThreshold
        ? `Highest accuracy (${formatPercent(pick.accuracy)})`
        : `Best available accuracy (${formatPercent(pick.accuracy)})`
    );
    if (floor !== null) {
      parts.push(pick.meetsThreshold ? `meets the ${floor} floor` : `below the ${floor} floor`);
    }
  } else if (mode === 'cheapest') {
    parts.push(`Lowest average cost per case (${formatUsd(pick.avgCostUsd)})`);
    if (floor !== null) {
      parts.push(pick.meetsThreshold ? `meets the ${floor} floor` : `below the ${floor} floor`);
    }
  } else {
    const perPoint = pick.accuracy > 0 ? pick.avgCostUsd / pick.accuracy : Number.POSITIVE_INFINITY;
    parts.push(
      Number.isFinite(perPoint)
        ? `Best accuracy per dollar (${formatUsd(perPoint)} per accuracy point)`
        : `Best accuracy per dollar`
    );
    if (floor !== null && !pick.meetsThreshold) parts.push(`below the ${floor} floor`);
  }

  if (second !== undefined) {
    const delta = (pick.accuracy - second.accuracy) * 100;
    parts.push(`${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts vs ${second.model}`);
  }
  if (pick.cases != null) parts.push(`${pick.cases} benchmark cases`);
  if (pick.stale === true) parts.push('measured with an older benchmark');
  return parts.join(' · ');
}

export type RoutingRow = {
  routeKey: string;
  candidates: RankedCandidate[] | null;
  reason: string;
};

/**
 * Every taxonomy route in the table's own route set first, then the rows the
 * table omits (which fall back). The dialog decides which keys to ask for.
 */
export function routingRows(
  table: CustomRoutingTable | null,
  routeKeys: readonly string[],
  mode: AutoRoutingMode,
  defaultEntryLabel: string
): RoutingRow[] {
  return routeKeys.map(routeKey => {
    const candidates = table?.routes[routeKey] ?? null;
    return {
      routeKey,
      candidates,
      reason:
        candidates === null || candidates.length === 0
          ? `No measured model for this route, so the router falls back to its default model (${defaultEntryLabel}).`
          : routeReason(candidates, mode, table?.minAccuracy),
    };
  });
}

/** The extra case pages loaded after the first one, keyed to one request. */
export type CasePageState =
  | { kind: 'first'; requestId: string }
  | { kind: 'loading'; requestId: string; cursor: string; cases: PaidBenchmarkCase[] }
  | { kind: 'paged'; requestId: string; cases: PaidBenchmarkCase[]; cursor: string | null }
  | {
      kind: 'failed';
      requestId: string;
      cases: PaidBenchmarkCase[];
      cursor: string;
      failure: BenchmarkFailureCopy;
    };

/**
 * The page state that applies to the request being displayed. A page loaded
 * for an earlier request is not shown again: its cases and cursor belong to
 * that request.
 */
export function casePageState(
  current: CasePageState | null,
  requestId: string | undefined
): CasePageState {
  return current !== null && current.requestId === requestId
    ? current
    : { kind: 'first', requestId: requestId ?? '' };
}

export function beginCasePage(
  state: CasePageState,
  requestId: string,
  cursor: string
): CasePageState {
  if (state.requestId !== requestId) return state;
  return {
    kind: 'loading',
    requestId,
    cursor,
    cases: state.kind === 'first' ? [] : state.cases,
  };
}

/**
 * Applies a page only to the request that asked for it and only for the cursor
 * it asked for, so a late answer after switching requests or after a newer page
 * is dropped instead of publishing another page's cases.
 */
export function applyCasePage(
  state: CasePageState,
  expectedRequestId: string,
  expectedCursor: string,
  page: { cases: PaidBenchmarkCase[]; nextCursor: string | null }
): CasePageState {
  if (state.requestId !== expectedRequestId) return state;
  if (state.kind !== 'first' && state.cursor !== expectedCursor) return state;
  return {
    kind: 'paged',
    requestId: state.requestId,
    cases: mergeCases(state.kind === 'first' ? [] : state.cases, page.cases),
    cursor: page.nextCursor,
  };
}

export function failCasePage(
  state: CasePageState,
  expectedRequestId: string,
  expectedCursor: string,
  failure: BenchmarkFailureCopy
): CasePageState {
  if (state.requestId !== expectedRequestId) return state;
  if (state.kind !== 'first' && state.cursor !== expectedCursor) return state;
  return {
    kind: 'failed',
    requestId: state.requestId,
    cases: state.kind === 'first' ? [] : state.cases,
    cursor: expectedCursor,
    failure,
  };
}

/** "implementation/feature_development" → "Feature development". */
export function routeLabel(routeKey: string): string {
  const subtask = routeKey.slice(routeKey.lastIndexOf('/') + 1);
  const words = subtask.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function routeTaskLabel(routeKey: string): string {
  const task = routeKey.slice(0, routeKey.lastIndexOf('/'));
  const words = task.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
