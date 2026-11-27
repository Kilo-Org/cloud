import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { captureException } from '@sentry/nextjs';
import { parseDatabaseMetrics, type DatabaseMetrics } from '@/lib/supabase-pool-metrics';

/**
 * Comma-separated Supabase project refs (primary + read replicas).
 * Each entry is a ref that has a Prometheus metrics endpoint at
 * https://{ref}.supabase.co/customer/v1/privileged/metrics
 *
 * Env var: SUPABASE_DATABASE_REFS
 *
 * Update this in Vercel env vars when adding/removing Supabase read replicas.
 */
function getDatabaseRefs(): string[] {
  const raw = getEnvVariable('SUPABASE_DATABASE_REFS');
  if (!raw) return [];
  return raw
    .split(',')
    .map(ref => ref.trim())
    .filter(Boolean);
}

type PoolMetrics = DatabaseMetrics & {
  type: 'db_pool_metrics';
  database: string;
  ref: string;
};

/** Derive a human-readable label from a Supabase ref, e.g. "nfg...-rr-eu-central-1-cdhuu" → "replica-eu-central-1-cdhuu" */
function labelFromRef(ref: string): string {
  const rrIndex = ref.indexOf('-rr-');
  if (rrIndex === -1) return 'primary';
  return `replica-${ref.slice(rrIndex + 4)}`;
}

async function scrapeDatabase(
  ref: string,
  serviceRoleKey: string
): Promise<{ metrics: PoolMetrics | null; error: string | null }> {
  const label = labelFromRef(ref);
  const url = `https://${ref}.supabase.co/customer/v1/privileged/metrics`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(`service_role:${serviceRoleKey}`)}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const error = `HTTP ${response.status} from ${label} (${ref})`;
    captureException(new Error(error));
    return { metrics: null, error };
  }

  const text = await response.text();
  const parsed = parseDatabaseMetrics(text);

  return {
    metrics: { type: 'db_pool_metrics', database: label, ref, ...parsed },
    error: null,
  };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceRoleKey = getEnvVariable('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY not configured' },
      { status: 500 }
    );
  }

  const refs = getDatabaseRefs();
  if (refs.length === 0) {
    return NextResponse.json({ error: 'SUPABASE_DATABASE_REFS not configured' }, { status: 500 });
  }

  const results = await Promise.allSettled(refs.map(ref => scrapeDatabase(ref, serviceRoleKey)));

  const errors: string[] = [];

  for (const result of results) {
    if (result.status === 'rejected') {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(message);
      captureException(result.reason);
      continue;
    }

    const { metrics, error } = result.value;
    if (error) {
      errors.push(error);
      continue;
    }

    // Emitted as structured JSON → picked up by Vercel log drain → Axiom.
    console.log(JSON.stringify(metrics));
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({ type: 'db_pool_metrics_errors', errors }));
  }

  return NextResponse.json({
    success: errors.length === 0,
    scraped: refs.length - errors.length,
    errors,
    timestamp: new Date().toISOString(),
  });
}
