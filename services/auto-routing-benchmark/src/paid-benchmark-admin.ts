import {
  PaidBenchmarkCaseStatusSchema,
  type AutoRouter,
  type PaidBenchmarkAdminListResponse,
  type PaidBenchmarkAdminPayer,
  type PaidBenchmarkAdminRequest,
} from '@kilocode/auto-routing-contracts';
import { drainPaidBillingOutbox, type PaidBillingEnv } from './paid-billing';
import {
  pausePaidBenchmarkRequestStatements,
  readPaidBenchmarkProgress,
  readPaidBenchmarkRequest,
  type PaidBenchmarkRequestRow,
} from './paid-case-store';

/**
 * Admin reads over the just-in-time paid-request tables. Native billing writes the usage
 * receipt (`paid_attempt_usage`) per model request and the payer assignment
 * (`benchmark_case_payers`) that carried it, so the console reports actual billed model
 * requests and their spend, and the platform cover Kilo took from its join onward. Nothing
 * here holds or settles money: D1 only observes what native billing already charged.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const ADMIN_REQUEST_COLUMNS = `id, owner_type, owner_id, organization_id, router, router_id,
  status, created_at, activated_at, paused_at, completed_at, estimate_microdollars,
  maximum_microdollars, charged_microdollars, pause_reason, actor_user_id, failure_reason,
  failure_retryable`;

type AdminRequestRow = Omit<
  PaidBenchmarkRequestRow,
  'quote_id' | 'pool_version' | 'engine_identity' | 'context' | 'updated_at'
>;

type AdminCaseCounts = PaidBenchmarkAdminRequest['counts'];

type UsageTotalsRow = {
  request_id: string;
  billed: number;
  spend: number;
  kilo_covered_requests: number;
  kilo_covered_spend: number;
};

type PayerRow = {
  request_id: string;
  owner_type: 'user' | 'organization' | null;
  owner_id: string | null;
  billed: number;
  spend: number;
};

type DetachRow = {
  request_id: string;
  owner_type: 'user' | 'organization' | null;
  owner_id: string | null;
  detach_reason: string | null;
};

function detachKey(requestId: string, ownerType: string | null, ownerId: string | null) {
  return JSON.stringify([requestId, ownerType, ownerId]);
}

const ZERO_USAGE: Omit<UsageTotalsRow, 'request_id'> = {
  billed: 0,
  spend: 0,
  kilo_covered_requests: 0,
  kilo_covered_spend: 0,
};

function emptyCounts(): AdminCaseCounts {
  return { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: 0 };
}

/** Adds one grouped count to a bucket, ignoring a status the contract does not know. */
function applyStatusCount(counts: AdminCaseCounts, status: string, count: number): void {
  const parsed = PaidBenchmarkCaseStatusSchema.safeParse(status);
  if (parsed.success) counts[parsed.data] = count;
}

/**
 * Payer rows from the assignments of this request's case runs, joined to the usage receipt
 * each assignment produced. A detached payer keeps the requests it already billed, which is
 * exactly the retained pre-join spend an admin has to see; the platform cover is reported
 * separately from the usage rows Kilo took over.
 */
function payerBreakdown(
  payers: readonly PayerRow[],
  usage: UsageTotalsRow,
  detachReasons: ReadonlyMap<string, string | null>
): PaidBenchmarkAdminPayer[] {
  const rows: PaidBenchmarkAdminPayer[] = [];
  if (usage.kilo_covered_requests > 0) {
    rows.push({
      kind: 'platform',
      kiloCoveredModelRequests: Number(usage.kilo_covered_requests),
      kiloCoveredMicrodollars: Number(usage.kilo_covered_spend),
    });
  }
  for (const payer of payers) {
    if (payer.owner_id === null) continue;
    rows.push({
      kind: payer.owner_type === 'organization' ? 'org' : 'user',
      ownerId: payer.owner_id,
      billedModelRequests: Number(payer.billed),
      chargedMicrodollars: Number(payer.spend),
      detachReason:
        detachReasons.get(detachKey(payer.request_id, payer.owner_type, payer.owner_id)) ?? null,
      ownerLabel: null,
    });
  }
  return rows;
}

function requestFields(
  row: AdminRequestRow,
  counts: AdminCaseCounts,
  usage: Omit<UsageTotalsRow, 'request_id'>,
  payers: readonly PayerRow[],
  detachReasons: ReadonlyMap<string, string | null>
): PaidBenchmarkAdminRequest {
  return {
    id: row.id,
    router: row.router as AutoRouter,
    routerId: row.router_id,
    organizationId: row.organization_id,
    requester: {
      kind: row.owner_type === 'organization' ? 'org' : 'user',
      ownerId: row.owner_id,
      actorUserId: row.actor_user_id,
      ownerLabel: null,
    },
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
    estimateMicrodollars: row.estimate_microdollars,
    maximumMicrodollars: row.maximum_microdollars,
    chargedMicrodollars: Number(usage.spend),
    billedModelRequests: Number(usage.billed),
    kiloCoveredModelRequests: Number(usage.kilo_covered_requests),
    kiloCoveredMicrodollars: Number(usage.kilo_covered_spend),
    pauseReason: row.pause_reason,
    counts,
    payers: payerBreakdown(payers, { request_id: row.id, ...usage }, detachReasons),
    poolName: null,
    failureReason: row.failure_reason,
    failureRetryable: row.failure_retryable === 1,
  };
}

const USAGE_TOTALS_SQL = `SELECT u.request_id AS request_id,
  COUNT(DISTINCT CASE WHEN u.platform_covered = 0 THEN u.model_request_id END) AS billed,
  COALESCE(SUM(CASE WHEN u.platform_covered = 0 THEN u.microdollars ELSE 0 END), 0) AS spend,
  COUNT(DISTINCT CASE WHEN u.platform_covered = 1 THEN u.model_request_id END) AS kilo_covered_requests,
  COALESCE(SUM(CASE WHEN u.platform_covered = 1 THEN u.microdollars ELSE 0 END), 0) AS kilo_covered_spend
FROM paid_attempt_usage u`;

/**
 * Payer split from the one-time model-request assignment. `paid_model_requests` pins each
 * native call to one account (`assignment_id`), and its receipt carries the spend, so the
 * count is one per model request and never double-counts a retried HTTP delivery. A
 * refused candidate keeps its trail in `paid_model_request_attempts`: that is where the
 * detach / no-funds reason comes from, and it never bills.
 */
/**
 * A model request belongs to the request that actually pays it (`pool_request_id`), never
 * to every request that staged the same shared case. Joining by case key duplicated a
 * shared case's payer and spend across unrelated owner rows; this correlation is exact.
 */
const MODEL_REQUEST_KEYS = `m.pool_request_id = rc.request_id
  AND m.engine_identity = rc.engine_identity
  AND m.model = rc.model
  AND m.variant = rc.variant
  AND m.rep = rc.rep
  AND m.case_id = rc.case_id`;

const PAYER_SPLIT_SQL = `SELECT rc.request_id AS request_id, m.owner_type AS owner_type,
  m.owner_id AS owner_id, COUNT(DISTINCT r.model_request_id) AS billed,
  COALESCE(SUM(r.microdollars), 0) AS spend
FROM paid_benchmark_request_cases rc
JOIN paid_model_requests m ON ${MODEL_REQUEST_KEYS}
LEFT JOIN paid_attempt_usage r
  ON r.model_request_id = m.id AND r.platform_covered = 0
WHERE m.owner_id IS NOT NULL AND m.platform_covered = 0`;

/** Refused candidates of a payer, aggregated apart so a receipt is never multiplied. */
const PAYER_DETACH_SQL = `SELECT rc.request_id AS request_id, a.owner_type AS owner_type,
  a.owner_id AS owner_id, MAX(a.reason) AS detach_reason
FROM paid_benchmark_request_cases rc
JOIN paid_model_requests m ON ${MODEL_REQUEST_KEYS}
JOIN paid_model_request_attempts a
  ON a.model_request_id = m.id AND a.status = 'refused'
WHERE m.platform_covered = 0`;

/**
 * One request in the console's shape. `poolName` and owner labels stay null: the worker has
 * no PostgreSQL, so the web admin route resolves them.
 */
export async function readPaidBenchmarkAdminRequest(
  db: D1Database,
  requestId: string
): Promise<PaidBenchmarkAdminRequest | null> {
  const row = await db
    .prepare(`SELECT ${ADMIN_REQUEST_COLUMNS} FROM paid_benchmark_requests WHERE id = ?`)
    .bind(requestId)
    .first<AdminRequestRow>();
  if (!row) return null;
  const [counts, usage, payers, detachRows] = await Promise.all([
    db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM paid_benchmark_request_cases
        WHERE request_id = ? GROUP BY status`
      )
      .bind(requestId)
      .all<{ status: string; count: number }>(),
    db
      .prepare(`${USAGE_TOTALS_SQL} WHERE request_id = ? GROUP BY request_id`)
      .bind(requestId)
      .first<UsageTotalsRow>(),
    db
      .prepare(`${PAYER_SPLIT_SQL} AND rc.request_id = ?
      GROUP BY m.owner_type, m.owner_id`)
      .bind(requestId)
      .all<Omit<PayerRow, 'request_id'>>(),
    db
      .prepare(`${PAYER_DETACH_SQL} AND rc.request_id = ?
      GROUP BY rc.request_id, a.owner_type, a.owner_id`)
      .bind(requestId)
      .all<DetachRow>(),
  ]);
  const statusCounts = emptyCounts();
  for (const entry of counts.results) {
    applyStatusCount(statusCounts, entry.status, Number(entry.count));
  }
  const totals = usage ?? ZERO_USAGE;
  return requestFields(
    row,
    statusCounts,
    {
      billed: Number(totals.billed ?? 0),
      spend: Number(totals.spend ?? 0),
      kilo_covered_requests: Number(totals.kilo_covered_requests ?? 0),
      kilo_covered_spend: Number(totals.kilo_covered_spend ?? 0),
    },
    payers.results.map(entry => ({ ...entry, request_id: requestId })),
    new Map(
      detachRows.results.map(entry => [
        detachKey(entry.request_id, entry.owner_type, entry.owner_id),
        entry.detach_reason,
      ])
    )
  );
}

function encodeListCursor(row: { updated_at: string; id: string }): string {
  return encodeURIComponent(JSON.stringify([row.updated_at, row.id]));
}

function decodeListCursor(cursor: string): [string, string] {
  const parsed: unknown = JSON.parse(decodeURIComponent(cursor));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string'
  ) {
    throw new Error('invalid paid benchmark request cursor');
  }
  return [parsed[0], parsed[1]];
}

/**
 * Newest-first page of paid requests for one router. Usage totals, case counts and payer
 * splits are grouped reads keyed by request id, so a page stays four statements.
 */
export async function listPaidBenchmarkAdminRequests(
  db: D1Database,
  input: {
    router: AutoRouter;
    statuses?: readonly PaidBenchmarkAdminRequest['status'][];
    limit?: number;
    cursor?: string;
  }
): Promise<PaidBenchmarkAdminListResponse> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
  const statuses = input.statuses ?? [];
  const statusClause =
    statuses.length > 0 ? `AND status IN (${statuses.map(() => '?').join(', ')})` : '';
  const cursorClause = cursor ? `AND (updated_at < ? OR (updated_at = ? AND id < ?))` : '';
  const page = await db
    .prepare(
      `SELECT ${ADMIN_REQUEST_COLUMNS}, updated_at FROM paid_benchmark_requests
      WHERE router = ? ${statusClause} ${cursorClause}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`
    )
    .bind(
      input.router,
      ...statuses,
      ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []),
      limit + 1
    )
    .all<AdminRequestRow & { updated_at: string }>();
  const rows = page.results.slice(0, limit);
  if (rows.length === 0) return { requests: [], nextCursor: null };
  const requestIds = rows.map(row => row.id);
  const placeholders = requestIds.map(() => '?').join(', ');
  const [counts, usage, payers, detachRows] = await Promise.all([
    db
      .prepare(
        `SELECT request_id, status, COUNT(*) AS count FROM paid_benchmark_request_cases
        WHERE request_id IN (${placeholders}) GROUP BY request_id, status`
      )
      .bind(...requestIds)
      .all<{ request_id: string; status: string; count: number }>(),
    db
      .prepare(`${USAGE_TOTALS_SQL} WHERE request_id IN (${placeholders}) GROUP BY request_id`)
      .bind(...requestIds)
      .all<UsageTotalsRow>(),
    db
      .prepare(`${PAYER_SPLIT_SQL} AND rc.request_id IN (${placeholders})
      GROUP BY rc.request_id, m.owner_type, m.owner_id`)
      .bind(...requestIds)
      .all<PayerRow>(),
    db
      .prepare(`${PAYER_DETACH_SQL} AND rc.request_id IN (${placeholders})
      GROUP BY rc.request_id, a.owner_type, a.owner_id`)
      .bind(...requestIds)
      .all<DetachRow>(),
  ]);
  const countBuckets = new Map<string, AdminCaseCounts>();
  for (const entry of counts.results) {
    const bucket = countBuckets.get(entry.request_id) ?? emptyCounts();
    applyStatusCount(bucket, entry.status, Number(entry.count));
    countBuckets.set(entry.request_id, bucket);
  }
  const usageBuckets = new Map(usage.results.map(entry => [entry.request_id, entry]));
  const detachReasons = new Map(
    detachRows.results.map(entry => [
      detachKey(entry.request_id, entry.owner_type, entry.owner_id),
      entry.detach_reason,
    ])
  );
  const payerBuckets = new Map<string, PayerRow[]>();
  for (const entry of payers.results) {
    const bucket = payerBuckets.get(entry.request_id) ?? [];
    bucket.push(entry);
    payerBuckets.set(entry.request_id, bucket);
  }
  return {
    requests: rows.map(row =>
      requestFields(
        row,
        countBuckets.get(row.id) ?? emptyCounts(),
        usageBuckets.get(row.id) ?? ZERO_USAGE,
        payerBuckets.get(row.id) ?? [],
        detachReasons
      )
    ),
    nextCursor:
      page.results.length > limit && rows.length > 0
        ? encodeListCursor(rows[rows.length - 1])
        : null,
  };
}

/**
 * One request plus a page of its case rows, with each case's billed model requests and
 * spend. The page and its cursor come from the owner progress reader; the usage totals are
 * one grouped read over the request's receipts.
 */
export async function readPaidBenchmarkAdminProgress(
  db: D1Database,
  input: { requestId: string; cursor?: string; limit?: number }
) {
  const progress = await readPaidBenchmarkProgress(db, input);
  if (progress.status === 'empty') {
    return { status: 'empty' as const, request: null, cases: [], nextCursor: null };
  }
  const [request, usage] = await Promise.all([
    readPaidBenchmarkAdminRequest(db, input.requestId),
    db
      .prepare(
        `SELECT model, variant, rep, case_id,
          COUNT(DISTINCT CASE WHEN platform_covered = 0 THEN model_request_id END) AS billed,
          COALESCE(SUM(CASE WHEN platform_covered = 0 THEN microdollars ELSE 0 END), 0) AS spend
        FROM paid_attempt_usage WHERE request_id = ?
        GROUP BY model, variant, rep, case_id`
      )
      .bind(input.requestId)
      .all<{
        model: string;
        variant: string;
        rep: number;
        case_id: string;
        billed: number;
        spend: number;
      }>(),
  ]);
  if (!request) {
    return { status: 'empty' as const, request: null, cases: [], nextCursor: null };
  }
  const usageByCase = new Map(
    usage.results.map(entry => [
      JSON.stringify([entry.model, entry.variant, entry.rep, entry.case_id]),
      entry,
    ])
  );
  return {
    status: progress.status,
    request,
    cases: progress.cases.map(entry => {
      const totals = usageByCase.get(
        JSON.stringify([entry.model, entry.variant ?? '', entry.repetition, entry.caseId])
      );
      return {
        id: entry.id,
        model: entry.model,
        variant: entry.variant,
        caseId: entry.caseId,
        repetition: entry.repetition,
        status: entry.status,
        coveredByKilo: entry.coveredByKilo,
        billedModelRequests: Number(totals?.billed ?? 0),
        chargedMicrodollars: Number(totals?.spend ?? 0),
        reason: entry.reason,
      };
    }),
    nextCursor: progress.nextCursor,
  };
}

export type AdminPauseOutcome = 'paused' | 'already_paused' | 'not_active' | 'not_found';

/**
 * Stop one paid request at once: no new model request is assigned to it, and the case runs
 * it alone pays for are cancelled. Idempotent; the conditional batch decides whether this
 * call changed anything. Usage already billed stays billed — the pause cannot unspend it.
 */
export async function pausePaidBenchmarkAdminRequest(
  env: PaidBillingEnv,
  requestId: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<AdminPauseOutcome> {
  const db = env.BENCH_DB;
  const before = await readPaidBenchmarkRequest(db, requestId);
  if (!before) return 'not_found';
  if (before.status === 'paused') return 'already_paused';
  if (before.status !== 'preparing' && before.status !== 'active') return 'not_active';
  const [closed] = await db.batch(
    pausePaidBenchmarkRequestStatements(db, { requestId, reason: 'owner' })
  );
  await drainPaidBillingOutbox(env, { requestId, fetchImpl: options.fetchImpl });
  if ((closed.meta.changes ?? 0) > 0) return 'paused';
  const after = await readPaidBenchmarkRequest(db, requestId);
  return after?.status === 'paused' ? 'already_paused' : 'not_active';
}

/** The immutable pool context the request's quote was bound to. */
export async function readPaidBenchmarkAdminContext(
  db: D1Database,
  requestId: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT context FROM paid_benchmark_requests WHERE id = ?')
    .bind(requestId)
    .first<{ context: string }>();
  return row?.context ?? null;
}
