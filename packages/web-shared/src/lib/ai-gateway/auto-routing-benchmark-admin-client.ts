import {
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
import { AUTO_ROUTING_BENCHMARK_WORKER_URL } from '@/lib/config.server';
import { createWorkerAdminFetch } from './worker-admin-fetch';

const fetchBenchmarkAdmin = createWorkerAdminFetch({
  workerUrl: AUTO_ROUTING_BENCHMARK_WORKER_URL,
  unconfiguredError: 'Auto routing benchmark worker is not configured',
});

export function getBenchmarkConfig() {
  return fetchBenchmarkAdmin('/admin/config', { method: 'GET' }, BenchmarkConfigResponseSchema);
}

export function updateBenchmarkConfig(config: BenchmarkConfig, updatedByEmail: string) {
  return fetchBenchmarkAdmin(
    '/admin/config',
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
  filter: { kind?: BenchmarkKind; purpose?: BenchmarkRunPurpose } = {}
) {
  const query = new URLSearchParams();
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
  queue: BenchmarkQueueSelector
) {
  return fetchBenchmarkAdmin(
    '/admin/runs',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, force, queue }),
    },
    StartBenchmarkRunResponseSchema
  );
}

export function getBenchmarkRegistry() {
  return fetchBenchmarkAdmin('/admin/registry', { method: 'GET' }, BenchmarkRegistryResponseSchema);
}

export function requeueBenchmarkRegistry(scope: BenchmarkQueueSelector) {
  return fetchBenchmarkAdmin(
    '/admin/registry/requeue',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope }),
    },
    RequeueBenchmarkRegistryResponseSchema
  );
}

export function getBenchmarkRoutingTable() {
  return fetchBenchmarkAdmin(
    '/admin/routing-table',
    { method: 'GET' },
    BenchmarkRoutingTableResponseSchema
  );
}
