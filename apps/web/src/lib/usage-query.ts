import { sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { db } from '@/lib/drizzle';
import { getEnvVariable } from '@/lib/dotenvx';

type DbInstance = typeof db;

type UsageQueryParams = {
  db: DbInstance;
  route: string;
  queryLabel: string;
  scope: 'user' | 'org' | 'admin';
  period: string | null;
  timeoutMs?: number;
};

function parseTimeoutEnv(envKey: string, fallback: number): number {
  const raw = getEnvVariable(envKey);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function defaultTimeoutForScope(scope: 'user' | 'org' | 'admin'): number {
  if (scope === 'admin') return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_ADMIN_MS', 20_000);
  if (scope === 'org') return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_ORG_MS', 10_000);
  return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_USER_MS', 5_000);
}

export async function timedUsageQuery<T>(
  params: UsageQueryParams,
  queryFn: (tx: DbInstance) => Promise<T>
): Promise<T> {
  const rawTimeout = params.timeoutMs ?? defaultTimeoutForScope(params.scope);
  const timeoutMs = Math.max(0, Math.trunc(rawTimeout));
  if (!Number.isFinite(timeoutMs)) {
    throw new Error(`Invalid statement_timeout: ${String(rawTimeout)}`);
  }
  const start = performance.now();
  let rowCount = 0;

  try {
    const result = await params.db.transaction(async tx => {
      // SET doesn't accept parameterized values in PostgreSQL; timeoutMs is
      // validated as a finite integer above, so raw interpolation is safe here.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}'`));
      return queryFn(tx as unknown as DbInstance);
    });

    rowCount = Array.isArray(result) ? result.length : 1;
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        type: 'usage_query_error',
        route: params.route,
        queryLabel: params.queryLabel,
        scope: params.scope,
        period: params.period,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Usage data temporarily unavailable',
    });
  } finally {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    console.log(
      JSON.stringify({
        type: 'usage_query',
        route: params.route,
        queryLabel: params.queryLabel,
        scope: params.scope,
        period: params.period,
        durationMs,
        rowCount,
      })
    );
  }
}
