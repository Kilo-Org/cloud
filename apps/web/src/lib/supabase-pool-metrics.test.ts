import { parseDatabaseMetrics, parsePrometheusText } from './supabase-pool-metrics';

const base = 'supabase_project_ref="ref",service_type="db"';

const scrape = [
  '# HELP pgbouncer_pools_client_active_connections Client connections linked to server',
  '# TYPE pgbouncer_pools_client_active_connections gauge',
  `pgbouncer_pools_client_active_connections{${base},database="pgbouncer",user="pgbouncer"} 1`,
  `pgbouncer_pools_client_active_connections{${base},database="postgres",user="kilocode_web"} 40`,
  `pgbouncer_pools_client_active_connections{${base},database="postgres",user="kilocode_worker"} 2`,
  `pgbouncer_pools_client_waiting_connections{${base},database="postgres",user="kilocode_web"} 3`,
  `pgbouncer_pools_server_active_connections{${base},database="postgres",user="kilocode_web"} 30`,
  `pgbouncer_pools_server_idle_connections{${base},database="postgres",user="kilocode_web"} 5`,
  `pgbouncer_pools_server_used_connections{${base},database="postgres",user="kilocode_web"} 1`,
  `pgbouncer_config_max_client_connections{${base}} 3000`,
  `pgbouncer_databases_pool_size{${base},database="postgres",name="postgres"} 320`,
  `pgbouncer_databases_pool_size{${base},database="pgbouncer",name="pgbouncer"} 2`,
  `pgbouncer_databases_current_connections{${base},database="postgres",name="postgres"} 119`,
  `pgbouncer_databases_pool_size{${base},database="postgres",name="postgres_alias"} 999`,
  `pgbouncer_databases_current_connections{${base},database="postgres",name="postgres_alias"} 50`,
  `pgbouncer_pools_server_active_connections{${base},database="postgres",user="kilocode_worker"} 4`,
  `node_cpu_seconds_total{${base},cpu="0",mode="idle"} 900`,
  `node_cpu_seconds_total{${base},cpu="0",mode="user"} 80`,
  `node_cpu_seconds_total{${base},cpu="0",mode="iowait"} 20`,
  `node_cpu_seconds_total{${base},cpu="1",mode="idle"} 800`,
  `node_cpu_seconds_total{${base},cpu="1",mode="user"} 200`,
  `node_load1{${base}} 1.5`,
  `node_load5{${base}} 1.25`,
  `node_load15{${base}} 1`,
  `node_memory_MemTotal_bytes{${base}} 8e+09`,
  `node_memory_MemAvailable_bytes{${base}} 2e+09`,
  `pg_stat_database_xact_commit_total{${base},server="localhost:5432"} 1000`,
  `pg_stat_database_tup_returned_total{${base},server="localhost:5432"} 5000`,
  `pg_stat_database_tup_fetched_total{${base},server="localhost:5432"} 4000`,
  `pg_stat_database_blks_hit_total{${base},server="localhost:5432"} 990`,
  `pg_stat_database_blks_read_total{${base},server="localhost:5432"} 10`,
  `pg_stat_database_num_backends{${base},server="localhost:5432"} 25`,
].join('\n');

describe('parsePrometheusText', () => {
  it('parses labels, escaped quotes, and scientific notation', () => {
    const samples = parsePrometheusText(
      ['# HELP m help', 'm{a="x \\"y\\"",b="2"} 1.5e+03 1700000000000', 'n 7'].join('\n')
    );
    expect(samples.get('m')).toEqual([{ labels: { a: 'x "y"', b: '2' }, value: 1500 }]);
    expect(samples.get('n')).toEqual([{ labels: {}, value: 7 }]);
  });

  it('accepts whitespace between tokens', () => {
    const samples = parsePrometheusText(
      [
        '  # TYPE m gauge',
        '\tm { database = "postgres" , user=\t"kilocode_web" }\t42',
        '  n 7',
        'o{a="line\\nbreak"} 1',
      ].join('\n')
    );
    expect(samples.get('m')).toEqual([
      { labels: { database: 'postgres', user: 'kilocode_web' }, value: 42 },
    ]);
    expect(samples.get('n')).toEqual([{ labels: {}, value: 7 }]);
    expect(samples.get('o')?.[0].labels.a).toBe('line\nbreak');
    expect(
      parseDatabaseMetrics(
        'pgbouncer_pools_client_active_connections{database = "postgres", user = "kilocode_web"} 42'
      ).client_active
    ).toBe(42);
  });

  it('matches label names exactly', () => {
    const samples = parsePrometheusText('m{xdatabase="postgres"} 1');
    expect(samples.get('m')?.[0].labels).toEqual({ xdatabase: 'postgres' });
  });
});

describe('parseDatabaseMetrics', () => {
  it('sums pool metrics over every user of the app database', () => {
    const metrics = parseDatabaseMetrics(scrape);
    expect(metrics).toMatchObject({
      client_active: 42,
      client_waiting: 3,
      server_active: 34,
      server_idle: 5,
      server_used: 1,
      max_client_connections: 3000,
      current_connections: 119,
    });
  });

  it('reports per-role capacity with the busiest role at the same scope', () => {
    const metrics = parseDatabaseMetrics(scrape);
    expect(metrics.pool_size).toBe(320);
    expect(metrics.server_max_per_role).toBe(36);
  });

  it('ignores other PgBouncer entries backed by the same database', () => {
    const metrics = parseDatabaseMetrics(
      [
        'pgbouncer_databases_pool_size{database="postgres",name="postgres_alias"} 999',
        'pgbouncer_databases_current_connections{database="postgres",name="postgres_alias"} 50',
      ].join('\n')
    );
    expect(metrics.pool_size).toBeNull();
    expect(metrics.current_connections).toBeNull();
    expect(metrics.server_max_per_role).toBeNull();
  });

  it('reports host and Postgres load', () => {
    expect(parseDatabaseMetrics(scrape)).toMatchObject({
      cpu_count: 2,
      load1: 1.5,
      load5: 1.25,
      load15: 1,
      memory_total_bytes: 8e9,
      memory_available_bytes: 2e9,
      cpu_seconds_total: 2000,
      cpu_idle_seconds_total: 1700,
      cpu_iowait_seconds_total: 20,
      xact_commit_total: 1000,
      tup_returned_total: 5000,
      tup_fetched_total: 4000,
      blks_hit_total: 990,
      blks_read_total: 10,
      num_backends: 25,
      missing_metrics: [],
    });
  });

  it('reports a missing metric as null rather than 0', () => {
    const metrics = parseDatabaseMetrics(
      `pgbouncer_pools_client_active_connections{database="pgbouncer",user="pgbouncer"} 1`
    );
    expect(metrics.client_active).toBeNull();
    expect(metrics.load1).toBeNull();
    expect(metrics.missing_metrics).toContain('pgbouncer_pools_client_active_connections');
    expect(metrics.missing_metrics).toContain('node_load1');
  });

  it('keeps a present zero as 0', () => {
    const metrics = parseDatabaseMetrics(
      `pgbouncer_pools_client_waiting_connections{database="postgres",user="kilocode_web"} 0`
    );
    expect(metrics.client_waiting).toBe(0);
    expect(metrics.missing_metrics).not.toContain('pgbouncer_pools_client_waiting_connections');
  });
});
