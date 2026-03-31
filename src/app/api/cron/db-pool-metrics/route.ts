import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@/lib/config.server';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureException } from '@sentry/nextjs';

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

type PoolMetrics = {
  type: 'db_pool_metrics';
  database: string;
  ref: string;
  client_active: number;
  client_waiting: number;
  server_active: number;
  server_idle: number;
  server_used: number;
  max_client_connections: number;
  pool_size: number;
  current_connections: number;
};

/**
 * Extract a numeric value from Prometheus text for a given metric name,
 * filtering to lines matching the provided label substring (or none for scalars).
 */
function extractMetricValue(lines: string[], metricName: string, labelFilter?: string): number {
  for (const line of lines) {
    if (line.startsWith('#') || !line.startsWith(metricName)) continue;
    if (labelFilter && !line.includes(labelFilter)) continue;

    const parts = line.split(/\s+/);
    const raw = parts[parts.length - 1];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isNaN(value)) return value;
  }
  return 0;
}

function parseMetricsForDatabase(
  prometheusText: string
): Omit<PoolMetrics, 'type' | 'database' | 'ref'> {
  const lines = prometheusText.split('\n');

  // Pool metrics: filter to database="postgres",user="postgres" (the main app pool)
  const appPoolFilter = 'database="postgres",user="postgres"';

  // Config metrics: filter to the postgres database (not the pgbouncer admin db)
  const dbFilter = 'database="postgres"';
  // pgbouncer_config_max_client_connections is a global scalar (no database label)

  return {
    client_active: extractMetricValue(
      lines,
      'pgbouncer_pools_client_active_connections',
      appPoolFilter
    ),
    client_waiting: extractMetricValue(
      lines,
      'pgbouncer_pools_client_waiting_connections',
      appPoolFilter
    ),
    server_active: extractMetricValue(
      lines,
      'pgbouncer_pools_server_active_connections',
      appPoolFilter
    ),
    server_idle: extractMetricValue(
      lines,
      'pgbouncer_pools_server_idle_connections',
      appPoolFilter
    ),
    server_used: extractMetricValue(
      lines,
      'pgbouncer_pools_server_used_connections',
      appPoolFilter
    ),
    max_client_connections: extractMetricValue(lines, 'pgbouncer_config_max_client_connections'),
    pool_size: extractMetricValue(lines, 'pgbouncer_databases_pool_size', dbFilter),
    current_connections: extractMetricValue(
      lines,
      'pgbouncer_databases_current_connections',
      dbFilter
    ),
  };
}

/** Derive a human-readable label from a Supabase ref, e.g. "nfg...-rr-us-west-1-drobh" → "replica-us-west-1" */
function labelFromRef(ref: string): string {
  const rrIndex = ref.indexOf('-rr-');
  if (rrIndex === -1) return 'primary';
  // Extract region from the "-rr-{region}-{suffix}" pattern
  const afterRr = ref.slice(rrIndex + 4); // "us-west-1-drobh"
  const parts = afterRr.split('-');
  // Region is everything except the last segment (the random suffix)
  const region = parts.slice(0, -1).join('-');
  return `replica-${region}`;
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
    return { metrics: null, error: `HTTP ${response.status} from ${label} (${ref})` };
  }

  const text = await response.text();
  const parsed = parseMetricsForDatabase(text);

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
