import {
  BenchmarkRoutingTableResponseSchema,
  BenchmarkConfigResponseSchema,
  BenchmarkRunsResponseSchema,
  StartBenchmarkRunResponseSchema,
  type BenchmarkConfig,
  type BenchmarkKind,
} from '@kilocode/auto-routing-contracts';

export {
  BenchmarkRoutingTableResponseSchema,
  type BenchmarkRoutingTableResponse,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_BENCHMARK_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import * as z from 'zod';

export type AutoRoutingAdminResult<T> = {
  status: number;
  body: T;
};

type ErrorBody = { error: string };
const ErrorBodySchema = z.object({ error: z.string() });

type AutoRoutingBenchmarkAdminRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

async function fetchBenchmarkAdmin<T>(
  path: string,
  init: AutoRoutingBenchmarkAdminRequestInit,
  schema: z.ZodType<T>
): Promise<AutoRoutingAdminResult<T | ErrorBody>> {
  if (!AUTO_ROUTING_BENCHMARK_WORKER_URL || !INTERNAL_API_SECRET) {
    return {
      status: 500,
      body: { error: 'Auto routing benchmark worker is not configured' },
    };
  }

  const response = await fetch(`${AUTO_ROUTING_BENCHMARK_WORKER_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${INTERNAL_API_SECRET}`,
      ...init.headers,
    },
  });

  const body: unknown = await response.json();
  if (!response.ok) {
    const parsedError = ErrorBodySchema.safeParse(body);
    return {
      status: response.status,
      body: parsedError.success
        ? parsedError.data
        : { error: `Request failed: ${response.status}` },
    };
  }

  return {
    status: response.status,
    body: schema.parse(body),
  };
}

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

export function startBenchmarkRun(kind: BenchmarkKind) {
  return fetchBenchmarkAdmin(
    '/admin/runs',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
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
