import {
  BenchmarkRoutingTableResponseSchema,
  BenchmarkConfigResponseSchema,
  BenchmarkRunsResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkKind,
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

export function listBenchmarkRuns() {
  return fetchBenchmarkAdmin('/admin/runs', { method: 'GET' }, BenchmarkRunsResponseSchema);
}

export function startBenchmarkRun(kind: BenchmarkKind, force: boolean) {
  return fetchBenchmarkAdmin(
    '/admin/runs',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, force }),
    },
    StartBenchmarkRunResponseSchema
  );
}

export function getBenchmarkRoutingTable() {
  return fetchBenchmarkAdmin(
    '/admin/routing-table',
    { method: 'GET' },
    BenchmarkRoutingTableResponseSchema
  );
}
