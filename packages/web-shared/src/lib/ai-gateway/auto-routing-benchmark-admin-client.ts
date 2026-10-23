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
  CUSTOM_ROUTER_STATUS_PATH,
  CustomRouterStatusResponseSchema,
  RequeueBenchmarkRegistryResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkProfileQuotaError,
  type BenchmarkSchedulerOverrides,
  type BenchmarkKind,
  type BenchmarkQueueSelector,
  type BenchmarkRunPurpose,
  type CustomRouterBenchmarkContext,
  type CustomRouterScope,
  type PoolEntry,
} from '@kilocode/auto-routing-contracts';
import {
  AUTO_ROUTING_BENCHMARK_WORKER_URL,
  INTERNAL_API_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { createWorkerAdminFetch, ErrorBodySchema, type ErrorBody } from './worker-admin-fetch';

const fetchBenchmarkAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_BENCHMARK_WORKER_URL,
  unconfiguredError: 'Auto routing benchmark worker is not configured',
});

export function getBenchmarkConfig(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    `/admin/config?router=${router}`,
    { method: 'GET' },
    BenchmarkConfigResponseSchema
  );
}

export function updateBenchmarkConfig(config: BenchmarkConfig, updatedByEmail: string) {
  return fetchBenchmarkAdmin(
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
    `/admin/runs${suffix}`,
    { method: 'GET' },
    BenchmarkRunsResponseSchema
  );
}

export function startBenchmarkRun(
  kind: BenchmarkKind,
  force: boolean,
  queue: BenchmarkQueueSelector,
  router: AutoRouter = DEFAULT_AUTO_ROUTER
) {
  return fetchBenchmarkAdmin(
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
    `/admin/registry/requeue?router=${router}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, router }),
    },
    RequeueBenchmarkRegistryResponseSchema
  );
}

export function getBenchmarkRoutingTable(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(
    `/admin/routing-table?router=${router}`,
    { method: 'GET' },
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
    ownerType: CustomRouterScope;
    ownerId: string;
    entries: PoolEntry[];
  },
  signal: AbortSignal = AbortSignal.timeout(5_000)
): Promise<RegisterOwnerBenchmarkProfilesResult> {
  if (!AUTO_ROUTING_BENCHMARK_WORKER_URL || !INTERNAL_API_SECRET) {
    return {
      ok: false,
      status: 500,
      error: { error: 'Auto routing benchmark worker is not configured' },
    };
  }
  const response = await fetch(
    `${AUTO_ROUTING_BENCHMARK_WORKER_URL}/admin/profiles/register?router=${request.router}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${INTERNAL_API_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    }
  );
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
    CUSTOM_ROUTER_STATUS_PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    CustomRouterStatusResponseSchema
  );
}
