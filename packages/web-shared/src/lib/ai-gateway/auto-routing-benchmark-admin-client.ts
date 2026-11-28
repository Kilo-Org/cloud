import {
  DEFAULT_AUTO_ROUTER,
  type AutoRouter,
  BenchmarkProfileQuotaErrorSchema,
  BenchmarkProfileStatusesResponseSchema,
  BenchmarkRegistryResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  BenchmarkConfigResponseSchema,
  BenchmarkSchedulerConfigResponseSchema,
  BenchmarkRunsResponseSchema,
  BenchmarkRunSummariesResponseSchema,
  BenchmarkRunCancelResponseSchema,
  BENCHMARK_ALIAS_PROMOTION_PATH,
  AliasPromotionAcquireResponseSchema,
  AliasPromotionReleaseResponseSchema,
  CUSTOM_ROUTER_BLOCKED_MODELS_PATH,
  CUSTOM_ROUTER_STATUS_PATH,
  CUSTOM_ROUTER_TABLE_PATH,
  CustomRouterBlockedModelsResponseSchema,
  CustomRouterStatusResponseSchema,
  CustomRoutingTableResponseSchema,
  PAID_BENCHMARK_ADMIN_PATH,
  PAID_BENCHMARK_ADMIN_PAUSE_PATH,
  PAID_BENCHMARK_ADMIN_PROGRESS_PATH,
  PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH,
  PAID_BENCHMARK_PATH,
  PLATFORM_MEASUREMENTS_PATH,
  PaidBenchmarkProgressSchema,
  PaidBenchmarkQuoteSchema,
  PaidBenchmarkStartResultSchema,
  PaidBenchmarkAdminListResponseSchema,
  PaidBenchmarkAdminPauseResponseSchema,
  PaidBenchmarkAdminProgressResponseSchema,
  PaidBenchmarkAdminRoutingTableResponseSchema,
  PlatformMeasurementsResponseSchema,
  RefreshBenchmarkProfilesResponseSchema,
  RequeueBenchmarkRegistryResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type AliasPromotionRequest,
  type BenchmarkPair,
  type BenchmarkProfileQuotaError,
  type BenchmarkSchedulerOverrides,
  type BenchmarkKind,
  type BenchmarkQueueSelector,
  type BenchmarkRunPurpose,
  type CustomRouterBenchmarkContext,
  type CustomRouterBlockedModelsRequest,
  type CustomRouterBlockedModelsResponse,
  type OwnerType,
  type PaidBenchmarkAdminRequestStatus,
  type PaidBenchmarkWorkerRequest,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_BENCHMARK_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { parseInternalServiceEndpoint } from '@kilocode/web-shared/lib/internal-service-url';
import * as z from 'zod';
import {
  createWorkerAdminFetch,
  ErrorBodySchema,
  WORKER_ADMIN_TIMEOUT_MS,
  WORKER_TOKEN_UNAVAILABLE_ERROR,
  workerAdminCredential,
  type ErrorBody,
} from './worker-admin-fetch';

/**
 * Each call names its route family, as the Worker's `GOVERNED_ROUTES` map it; the app's installed
 * sender (`auto-routing-sender.ts`) picks the credential: the internal secret, or an STS token of
 * `auto-routing-benchmark:routing-tables.read` (the routing table reads, from the web app or the
 * gateway), `auto-routing-benchmark:admin.read` or `admin.write` (the web app's other calls).
 */
const fetchBenchmarkAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_BENCHMARK_WORKER_URL,
  unconfiguredError: 'Auto routing benchmark worker is not configured',
});

export function getBenchmarkConfig(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `/admin/config?router=${router}`,
    { method: 'GET' },
    BenchmarkConfigResponseSchema
  );
}

export function updateBenchmarkConfig(config: BenchmarkConfig, updatedByEmail: string) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    `/admin/config?router=${config.router}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-updated-by': updatedByEmail,
      },
      body: JSON.stringify(config),
    },
    BenchmarkConfigResponseSchema
  );
}

export function getBenchmarkSchedulerConfig() {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    '/admin/scheduler-config',
    { method: 'GET' },
    BenchmarkSchedulerConfigResponseSchema
  );
}

export function updateBenchmarkSchedulerConfig(
  overrides: BenchmarkSchedulerOverrides,
  updatedByEmail: string
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    '/admin/scheduler-config',
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-updated-by': updatedByEmail,
      },
      body: JSON.stringify(overrides),
    },
    BenchmarkSchedulerConfigResponseSchema
  );
}

export function listBenchmarkRuns(
  filter: { router?: AutoRouter; kind?: BenchmarkKind; purpose?: BenchmarkRunPurpose } = {}
) {
  const query = new URLSearchParams({ router: filter.router ?? DEFAULT_AUTO_ROUTER });
  if (filter.kind) query.set('kind', filter.kind);
  if (filter.purpose) query.set('purpose', filter.purpose);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `/admin/runs${suffix}`,
    { method: 'GET' },
    BenchmarkRunsResponseSchema
  );
}

export function getBenchmarkRunSummaries(runId: string, router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `/admin/runs/${encodeURIComponent(runId)}/summaries?router=${router}`,
    { method: 'GET' },
    BenchmarkRunSummariesResponseSchema
  );
}

export function startBenchmarkRun(
  kind: BenchmarkKind,
  force: boolean,
  queue: BenchmarkQueueSelector,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    `/admin/runs?router=${router}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, force, queue, router }),
    },
    StartBenchmarkRunResponseSchema
  );
}

export function getBenchmarkRegistry(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `/admin/registry?router=${router}`,
    { method: 'GET' },
    BenchmarkRegistryResponseSchema
  );
}

export function requeueBenchmarkRegistry(
  scope: BenchmarkQueueSelector,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    `/admin/registry/requeue?router=${router}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, router }),
    },
    RequeueBenchmarkRegistryResponseSchema
  );
}

/**
 * Re-admit one failed registry pair, retryable or permanent: its failure history is
 * cleared and it measures again on the next drain, unless the catalog cannot run it.
 */
export function readmitBenchmarkProfile(
  entry: BenchmarkPair,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    `/admin/registry/refresh?router=${router}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ router, mode: 'refresh', entries: [entry] }),
    },
    RefreshBenchmarkProfilesResponseSchema
  );
}

export function getBenchmarkRoutingTable(
  router: AutoRouter = DEFAULT_AUTO_ROUTER,
  signal?: AbortSignal
) {
  return fetchBenchmarkAdmin(
    'benchmarkRoutingTablesRead',
    `/admin/routing-table?router=${router}`,
    { method: 'GET', signal },
    BenchmarkRoutingTableResponseSchema
  );
}

export type RegisterOwnerBenchmarkProfilesResult =
  | { ok: true }
  | { ok: false; status: 429; quota: BenchmarkProfileQuotaError }
  | { ok: false; status: number; error: ErrorBody };

export async function registerOwnerBenchmarkProfiles(
  request: {
    router: AutoRouter;
    ownerType: OwnerType;
    ownerId: string;
    entries: PoolEntry[];
  },
  signal: AbortSignal = AbortSignal.timeout(5_000)
): Promise<RegisterOwnerBenchmarkProfilesResult> {
  const endpoint = parseInternalServiceEndpoint(
    AUTO_ROUTING_BENCHMARK_WORKER_URL,
    `/admin/profiles/register?router=${request.router}`
  );
  const credential = endpoint
    ? await workerAdminCredential(endpoint, 'benchmarkAdminWrite', signal)
    : null;
  if (!endpoint || credential?.kind === 'unconfigured') {
    return {
      ok: false,
      status: 500,
      error: { error: 'Auto routing benchmark worker is not configured' },
    };
  }
  if (credential?.kind !== 'ready') {
    // A spent deadline answers as the request would have: an abort.
    signal.throwIfAborted();
    return { ok: false, status: 503, error: { error: WORKER_TOKEN_UNAVAILABLE_ERROR } };
  }
  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: {
      authorization: credential.authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    signal,
    ...(credential.redirect ? { redirect: credential.redirect } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && BenchmarkProfileStatusesResponseSchema.safeParse(body).success) {
    return { ok: true };
  }
  if (response.status === 429) {
    const quota = BenchmarkProfileQuotaErrorSchema.safeParse(body);
    if (quota.success) return { ok: false, status: 429, quota: quota.data };
  }
  const error = ErrorBodySchema.safeParse(body);
  return {
    ok: false,
    status: response.ok ? 502 : response.status,
    error: error.success ? error.data : { error: `Request failed: ${response.status}` },
  };
}

export function getCustomRouterStatus(request: CustomRouterBenchmarkContext) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    CUSTOM_ROUTER_STATUS_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    CustomRouterStatusResponseSchema
  );
}

/** The table the Worker serves for this pool, from its current measurements. */
export function getCustomRouterTable(context: CustomRouterBenchmarkContext) {
  return fetchBenchmarkAdmin(
    'benchmarkRoutingTablesRead',
    CUSTOM_ROUTER_TABLE_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(context),
    },
    CustomRoutingTableResponseSchema
  );
}

/**
 * Read-only registry lookup for the pool editor: resolves each asked model (an alias included) to
 * its exact gateway pairs at the live base router and reports the pairs that are permanently
 * unavailable. It never writes, admits, or spends; a router with no benchmark config answers an
 * empty list so a save is never blocked spuriously.
 */
export async function lookupCustomRouterBlockedModels(
  request: CustomRouterBlockedModelsRequest,
  options: { signal?: AbortSignal } = {}
): Promise<CustomRouterBlockedModelsResponse> {
  const result = await fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    CUSTOM_ROUTER_BLOCKED_MODELS_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      // A registry read sits in the pool editor's save path, so it gets a tighter deadline than an
      // admin mutation; an abort leaves the caller to decide (the editor fails open on it).
      signal: options.signal ?? AbortSignal.timeout(10_000),
    },
    CustomRouterBlockedModelsResponseSchema
  );
  if (result.status === 200 && 'blocked' in result.body) return result.body;
  const detail = 'error' in result.body ? result.body.error : `Request failed: ${result.status}`;
  throw new Error(`Blocked-model lookup failed: ${detail}`);
}

// A paid request reserves credit and may wait on the billing ledger, so it gets the same deadline
// as the slowest admin route. Reads answer from the request store alone.
const PAID_BENCHMARK_WRITE_TIMEOUT_MS = WORKER_ADMIN_TIMEOUT_MS;
const PAID_BENCHMARK_READ_TIMEOUT_MS = 10_000;

// The Worker returns domain refusals as a typed result; only transport and configuration failures
// arrive as an error body. Both shapes the benchmark Worker uses are accepted so a refusal keeps
// its machine-readable code.
const PaidBenchmarkErrorSchema = z.object({
  error: z.union([z.string(), z.object({ code: z.string(), message: z.string() })]),
  code: z.string().optional(),
  message: z.string().optional(),
});

export type PaidBenchmarkWorkerError = { code: string | null; message: string };

export type PaidBenchmarkWorkerResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; error: PaidBenchmarkWorkerError };

function readPaidBenchmarkError(status: number, body: unknown): PaidBenchmarkWorkerError {
  const parsed = PaidBenchmarkErrorSchema.safeParse(body);
  if (!parsed.success) return { code: null, message: `Request failed: ${status}` };
  if (typeof parsed.data.error === 'string') {
    return { code: parsed.data.code ?? null, message: parsed.data.message ?? parsed.data.error };
  }
  return parsed.data.error;
}

async function postPaidBenchmark<T>(
  request: PaidBenchmarkWorkerRequest,
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<PaidBenchmarkWorkerResult<T>> {
  const endpoint = parseInternalServiceEndpoint(
    AUTO_ROUTING_BENCHMARK_WORKER_URL,
    PAID_BENCHMARK_PATH
  );
  // One deadline covers the credential read (a cold STS mint included) and the request.
  const signal = AbortSignal.timeout(timeoutMs);
  const credential = endpoint
    ? await workerAdminCredential(endpoint, 'benchmarkAdminWrite', signal)
    : null;
  if (!endpoint || credential?.kind === 'unconfigured') {
    return {
      ok: false,
      status: 500,
      error: {
        code: 'not_configured',
        message: 'Auto routing benchmark worker is not configured',
      },
    };
  }
  if (credential?.kind !== 'ready') {
    return signal.aborted
      ? {
          ok: false,
          status: 504,
          error: { code: 'timeout', message: 'The benchmark worker did not answer in time' },
        }
      : {
          ok: false,
          status: 503,
          error: { code: 'token_unavailable', message: WORKER_TOKEN_UNAVAILABLE_ERROR },
        };
  }
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        authorization: credential.authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
      ...(credential.redirect ? { redirect: credential.redirect } : {}),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: {
        code: timedOut ? 'timeout' : 'transport',
        message: timedOut
          ? 'The benchmark worker did not answer in time'
          : 'Could not reach the benchmark worker',
      },
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: readPaidBenchmarkError(response.status, body),
    };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    status: 502,
    error: {
      code: 'invalid_response',
      message: 'The benchmark worker returned an invalid response',
    },
  };
}

export function requestPaidBenchmarkQuote(
  request: Extract<PaidBenchmarkWorkerRequest, { action: 'quote' }>
) {
  return postPaidBenchmark(request, PaidBenchmarkQuoteSchema, PAID_BENCHMARK_WRITE_TIMEOUT_MS);
}

export function startPaidBenchmark(
  request: Extract<PaidBenchmarkWorkerRequest, { action: 'start' }>
) {
  return postPaidBenchmark(
    request,
    PaidBenchmarkStartResultSchema,
    PAID_BENCHMARK_WRITE_TIMEOUT_MS
  );
}

export function getPaidBenchmarkProgress(
  request: Extract<PaidBenchmarkWorkerRequest, { action: 'progress' }>
) {
  return postPaidBenchmark(request, PaidBenchmarkProgressSchema, PAID_BENCHMARK_READ_TIMEOUT_MS);
}

export function pausePaidBenchmark(
  request: Extract<PaidBenchmarkWorkerRequest, { action: 'pause' }>
) {
  return postPaidBenchmark(request, PaidBenchmarkProgressSchema, PAID_BENCHMARK_WRITE_TIMEOUT_MS);
}

/**
 * Pauses whatever request this pool has outstanding, without first reading progress: a progress
 * read can stage the next plan, and a mutation fence must only stop work. `requestId` is omitted so
 * the Worker resolves and pauses the latest request under its own store, atomically.
 */
export function pausePoolBenchmark(ref: {
  ownerType: OwnerType;
  ownerId: string;
  routerId: string;
}) {
  return postPaidBenchmark(
    { action: 'pause', ...ref },
    PaidBenchmarkProgressSchema,
    PAID_BENCHMARK_WRITE_TIMEOUT_MS
  );
}

export function getPlatformMeasurements(baseRouter: AutoRouter) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `${PLATFORM_MEASUREMENTS_PATH}?router=${baseRouter}`,
    { method: 'GET', signal: AbortSignal.timeout(10_000) },
    PlatformMeasurementsResponseSchema
  );
}

/** Operator cancel of one platform run; `already_finished` means it ended first. */
export function cancelBenchmarkRun(runId: string, router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    `/admin/runs/${encodeURIComponent(runId)}/cancel?router=${router}`,
    { method: 'POST' },
    BenchmarkRunCancelResponseSchema
  );
}

// The admin console reads both queues: platform work stays automatic, and these calls
// cover the user-paid requests with the one control the console offers, a pause.
export function listPaidBenchmarkAdminRequests(filter: {
  router: AutoRouter;
  statuses?: readonly PaidBenchmarkAdminRequestStatus[];
  cursor?: string;
  limit?: number;
}) {
  const query = new URLSearchParams({ router: filter.router });
  if (filter.statuses && filter.statuses.length > 0) {
    query.set('status', filter.statuses.join(','));
  }
  if (filter.cursor) query.set('cursor', filter.cursor);
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `${PAID_BENCHMARK_ADMIN_PATH}?${query.toString()}`,
    { method: 'GET' },
    PaidBenchmarkAdminListResponseSchema
  );
}

export function getPaidBenchmarkAdminProgress(requestId: string, cursor?: string) {
  const query = new URLSearchParams({ requestId });
  if (cursor) query.set('cursor', cursor);
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    `${PAID_BENCHMARK_ADMIN_PROGRESS_PATH}?${query.toString()}`,
    { method: 'GET' },
    PaidBenchmarkAdminProgressResponseSchema
  );
}

export function pausePaidBenchmarkAdminRequest(requestId: string) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    PAID_BENCHMARK_ADMIN_PAUSE_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    },
    PaidBenchmarkAdminPauseResponseSchema
  );
}

/** The pool routing result the request's quote was bound to. */
export function getPaidBenchmarkAdminRoutingTable(requestId: string) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminRead',
    PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    },
    PaidBenchmarkAdminRoutingTableResponseSchema
  );
}

/**
 * The short readiness fence an alias move holds while it saves the observed concrete targets. The
 * reply is `busy` while another holder's lease is live; `held` lists the ready current-engine pairs
 * of the asked ids. It reads the registry only and never starts or admits a benchmark.
 */
export function acquireAliasPromotion(
  request: Extract<AliasPromotionRequest, { action: 'acquire' }>
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    BENCHMARK_ALIAS_PROMOTION_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    AliasPromotionAcquireResponseSchema
  );
}

/** Releases only this token's fence; another holder's lease is never cleared. */
export function releaseAliasPromotion(
  request: Extract<AliasPromotionRequest, { action: 'release' }>
) {
  return fetchBenchmarkAdmin(
    'benchmarkAdminWrite',
    BENCHMARK_ALIAS_PROMOTION_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    AliasPromotionReleaseResponseSchema
  );
}
