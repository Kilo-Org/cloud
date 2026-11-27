/**
 * Parses the Supabase Prometheus metrics endpoint
 * (`https://{ref}.supabase.co/customer/v1/privileged/metrics`) into the fields that
 * `/api/cron/db-pool-metrics` logs for each database.
 *
 * A metric absent from the scrape is reported as `null` and named in
 * `missing_metrics`, never as 0: a filter that matched nothing used to report 0, which
 * looked like an idle pool for months.
 */

type Sample = {
  labels: Record<string, string>;
  value: number;
};

type Samples = Map<string, Sample[]>;

// The text format allows spaces and tabs between tokens, including around `=` in labels.
const SAMPLE_LINE = /^[ \t]*([a-zA-Z_:][a-zA-Z0-9_:]*)[ \t]*(?:\{(.*)\})?[ \t]+(\S+)/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/g;

export function parsePrometheusText(text: string): Samples {
  const samples: Samples = new Map();
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const match = SAMPLE_LINE.exec(line);
    if (!match) continue;
    const [, name, labelBlock = '', rawValue] = match;
    const value = Number(rawValue);
    if (Number.isNaN(value)) continue;

    const labels: Record<string, string> = {};
    for (const [, key, labelValue] of labelBlock.matchAll(LABEL_PAIR)) {
      labels[key] = labelValue.replace(/\\(.)/g, (_, char: string) => (char === 'n' ? '\n' : char));
    }
    const existing = samples.get(name);
    if (existing) existing.push({ labels, value });
    else samples.set(name, [{ labels, value }]);
  }
  return samples;
}

/** The database the app's PgBouncer pools serve; `pgbouncer` is the admin console. */
const APP_DATABASE = 'postgres';

export type DatabaseMetrics = {
  /**
   * PgBouncer pool counts for the app database, summed over every user. The app connects
   * as `kilocode_web` (and workers as `kilocode_worker`), so a single-user filter misses
   * part or all of the traffic.
   */
  client_active: number | null;
  client_waiting: number | null;
  server_active: number | null;
  server_idle: number | null;
  server_used: number | null;
  max_client_connections: number | null;
  /**
   * PgBouncer's server connection limit **per role** for the app database, not a total.
   * Compare it with `server_max_per_role`, never with the all-role `server_*` sums.
   */
  pool_size: number | null;
  /** The busiest role's server connections (active + idle + used), at `pool_size`'s scope. */
  server_max_per_role: number | null;
  current_connections: number | null;
  /** Host load. Load averages are gauges, so compare them with `cpu_count` directly. */
  cpu_count: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memory_total_bytes: number | null;
  memory_available_bytes: number | null;
  /**
   * Cumulative CPU counters, summed over all CPUs. Utilisation over an interval is
   * `1 - delta(cpu_idle_seconds_total) / delta(cpu_seconds_total)` between two samples
   * of the same database.
   */
  cpu_seconds_total: number | null;
  cpu_idle_seconds_total: number | null;
  cpu_iowait_seconds_total: number | null;
  /** Cumulative Postgres activity counters; rates come from deltas between samples. */
  xact_commit_total: number | null;
  tup_returned_total: number | null;
  tup_fetched_total: number | null;
  blks_hit_total: number | null;
  blks_read_total: number | null;
  num_backends: number | null;
  missing_metrics: string[];
};

function matching(samples: Samples, name: string, labels: Record<string, string>): Sample[] {
  return (samples.get(name) ?? []).filter(sample =>
    Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  );
}

export function parseDatabaseMetrics(text: string): DatabaseMetrics {
  const samples = parsePrometheusText(text);
  const missing: string[] = [];

  const aggregate =
    (combine: (values: number[]) => number) =>
    (name: string, labels: Record<string, string> = {}): number | null => {
      const found = matching(samples, name, labels);
      if (found.length === 0) {
        missing.push(name);
        return null;
      }
      return combine(found.map(sample => sample.value));
    };
  const sum = aggregate(values => values.reduce((total, value) => total + value, 0));
  const max = aggregate(values => Math.max(...values));
  const count = aggregate(values => values.length);

  // `SHOW POOLS` labels the configured PgBouncer entry `database`, while `SHOW DATABASES`
  // labels it `name` and uses `database` for the backing PostgreSQL database.
  const pool = { database: APP_DATABASE };
  const entry = { name: APP_DATABASE };

  const serverByRole = new Map<string, number>();
  for (const name of [
    'pgbouncer_pools_server_active_connections',
    'pgbouncer_pools_server_idle_connections',
    'pgbouncer_pools_server_used_connections',
  ]) {
    for (const sample of matching(samples, name, pool)) {
      const role = sample.labels.user ?? '';
      serverByRole.set(role, (serverByRole.get(role) ?? 0) + sample.value);
    }
  }

  return {
    client_active: sum('pgbouncer_pools_client_active_connections', pool),
    client_waiting: sum('pgbouncer_pools_client_waiting_connections', pool),
    server_active: sum('pgbouncer_pools_server_active_connections', pool),
    server_idle: sum('pgbouncer_pools_server_idle_connections', pool),
    server_used: sum('pgbouncer_pools_server_used_connections', pool),
    max_client_connections: max('pgbouncer_config_max_client_connections'),
    pool_size: max('pgbouncer_databases_pool_size', entry),
    server_max_per_role: serverByRole.size > 0 ? Math.max(...serverByRole.values()) : null,
    current_connections: sum('pgbouncer_databases_current_connections', entry),
    cpu_count: count('node_cpu_seconds_total', { mode: 'idle' }),
    load1: max('node_load1'),
    load5: max('node_load5'),
    load15: max('node_load15'),
    memory_total_bytes: max('node_memory_MemTotal_bytes'),
    memory_available_bytes: max('node_memory_MemAvailable_bytes'),
    cpu_seconds_total: sum('node_cpu_seconds_total'),
    cpu_idle_seconds_total: sum('node_cpu_seconds_total', { mode: 'idle' }),
    cpu_iowait_seconds_total: sum('node_cpu_seconds_total', { mode: 'iowait' }),
    xact_commit_total: sum('pg_stat_database_xact_commit_total'),
    tup_returned_total: sum('pg_stat_database_tup_returned_total'),
    tup_fetched_total: sum('pg_stat_database_tup_fetched_total'),
    blks_hit_total: sum('pg_stat_database_blks_hit_total'),
    blks_read_total: sum('pg_stat_database_blks_read_total'),
    num_backends: sum('pg_stat_database_num_backends'),
    missing_metrics: missing,
  };
}
