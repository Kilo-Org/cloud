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

/** Check whether a Prometheus line's label block contains all required key="value" pairs. */
function matchesLabels(labelBlock: string, requiredLabels: Record<string, string>): boolean {
  for (const [key, val] of Object.entries(requiredLabels)) {
    // Match key="value" with possible surrounding whitespace from split
    if (!labelBlock.includes(`${key}="${val}"`)) return false;
  }
  return true;
}

/**
 * Extract a numeric value from Prometheus text for a given metric name,
 * optionally filtering to lines whose labels contain all required key-value pairs.
 */
function extractMetricValue(
  lines: string[],
  metricName: string,
  requiredLabels?: Record<string, string>
): number {
  for (const line of lines) {
    if (!line.startsWith(metricName)) continue;
    // Exact name boundary: next char after the metric name must be '{' or ' '
    const nextChar = line[metricName.length];
    if (nextChar !== '{' && nextChar !== ' ') continue;

    if (requiredLabels) {
      const braceStart = line.indexOf('{');
      const braceEnd = line.indexOf('}');
      if (braceStart === -1 || braceEnd === -1) continue;
      const labelBlock = line.slice(braceStart + 1, braceEnd);
      if (!matchesLabels(labelBlock, requiredLabels)) continue;
    }

    const parts = line.split(/\s+/);
    const value = Number(parts[parts.length - 1]);
    if (!Number.isNaN(value)) return value;
  }
  return 0;
}

function parseMetricsForDatabase(
  prometheusText: string
): Omit<PoolMetrics, 'type' | 'database' | 'ref'> {
  const lines = prometheusText.split('\n');

  // Pool metrics: filter to the main app pool
  const appPoolLabels = { database: 'postgres', user: 'postgres' };

  // Config metrics: filter to the postgres database (not the pgbouncer admin db)
  const dbLabels = { database: 'postgres' };
  // pgbouncer_config_max_client_connections is a global scalar (no database label)

  return {
    client_active: extractMetricValue(
      lines,
      'pgbouncer_pools_client_active_connections',
      appPoolLabels
    ),
    client_waiting: extractMetricValue(
      lines,
      'pgbouncer_pools_client_waiting_connections',
      appPoolLabels
    ),
    server_active: extractMetricValue(
      lines,
      'pgbouncer_pools_server_active_connections',
      appPoolLabels
    ),
    server_idle: extractMetricValue(
      lines,
      'pgbouncer_pools_server_idle_connections',
      appPoolLabels
    ),
    server_used: extractMetricValue(
      lines,
      'pgbouncer_pools_server_used_connections',
      appPoolLabels
    ),
    max_client_connections: extractMetricValue(lines, 'pgbouncer_config_max_client_connections'),
    pool_size: extractMetricValue(lines, 'pgbouncer_databases_pool_size', dbLabels),
    current_connections: extractMetricValue(
      lines,
      'pgbouncer_databases_current_connections',
      dbLabels
    ),
  };
}

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
