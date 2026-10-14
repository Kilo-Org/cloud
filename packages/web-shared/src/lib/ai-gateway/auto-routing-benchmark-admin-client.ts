import {
  DEFAULT_AUTO_ROUTER,
  type AutoRouter,
  BenchmarkRegistryResponseSchema,
  BenchmarkRoutingTableResponseSchema,
  BenchmarkConfigResponseSchema,
  BenchmarkRunsResponseSchema,
  RequeueBenchmarkRegistryResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkKind,
  type BenchmarkQueueSelector,
  type BenchmarkRunPurpose,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_BENCHMARK_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { createWorkerAdminFetch } from './worker-admin-fetch';

const fetchBenchmarkAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_BENCHMARK_WORKER_URL,
  unconfiguredError: 'Auto routing benchmark worker is not configured',
});

export function getBenchmarkConfig(router: AutoRouter = DEFAULT_AUTO_ROUTER) {
  return fetchBenchmarkAdmin(`/admin/config?router=${router}`, { method: 'GET' }, BenchmarkConfigResponseSchema);
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
  return fetchBenchmarkAdmin(`/admin/registry?router=${router}`, { method: 'GET' }, BenchmarkRegistryResponseSchema);
}

export function requeueBenchmarkRegistry(scope: BenchmarkQueueSelector, router: AutoRouter = DEFAULT_AUTO_ROUTER) {
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
