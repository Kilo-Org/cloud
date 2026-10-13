import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ProdMetricsSchema, type Dist, type ProdMetrics } from '../src/scoreboard/schema';

const requestPrefix =
  "['cloudflare-logpush'] | where ScriptName == 'auto-routing' and ['Event.Request.URL'] endswith '/decide'";
const decisionPrefix = `${requestPrefix} | mv-expand Logs | extend m=tostring(Logs.Message[0]) | where m startswith '{"event":"auto_routing_decision"' | extend j=parse_json(m)`;
const sampledPrefix = `${decisionPrefix} | where j.sampled == true and j.status == 'classified'`;
const phases = [
  'codingPlanMs',
  'settingsMs',
  'capabilitiesMs',
  'tableMs',
  'prepMs',
  'cacheReadMs',
  'classifierMs',
  'totalMs',
] as const;
const percentiles =
  '| summarize n=count(), p50=percentile(value, 50), p90=percentile(value, 90), p99=percentile(value, 99)';
const nullableNumber = z.number().finite().nullable();
const distributionSchema = z.object({
  n: z.number().int().nonnegative(),
  p50: nullableNumber,
  p90: nullableNumber,
  p99: nullableNumber,
});
const tabularSchema = z.object({
  status: z.object({ isPartial: z.boolean() }),
  tables: z.array(
    z.object({
      name: z.string(),
      fields: z.array(z.object({ name: z.string() })),
      columns: z.array(z.array(z.unknown())),
    })
  ),
});
const countSchema = z.object({ n: z.number().int().nonnegative() });
const groupedSchema = countSchema.extend({
  route: z.string(),
  cacheHit: z.boolean().nullable(),
  cost: nullableNumber,
});

type Window = ProdMetrics['window'];
type AxiomQuery = (apl: string) => Promise<Record<string, unknown>[]>;

class CollectionError extends Error {}

function warn(source: string, error: unknown): void {
  const reason = error instanceof CollectionError ? error.message : 'request or response failed';
  console.error(`Warning: ${source}: ${reason}; unavailable metrics will be null.`);
}

function distribution(rows: Record<string, unknown>[]): Dist | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new CollectionError('unexpected aggregate row count');
  const result = distributionSchema.parse(rows[0]);
  return result.n === 0 ? null : result;
}

function count(rows: Record<string, unknown>[]): number {
  if (rows.length === 0) return 0;
  if (rows.length !== 1) throw new CollectionError('unexpected aggregate row count');
  return countSchema.parse(rows[0]).n;
}

function axiomQuery(window: Window): AxiomQuery {
  const token = process.env.AXIOM_TOKEN;
  if (!token) throw new CollectionError('missing AXIOM_TOKEN');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (process.env.AXIOM_ORG_ID) headers['X-Axiom-Org-Id'] = process.env.AXIOM_ORG_ID;
  return async apl => {
    const response = await fetch('https://api.axiom.co/v1/datasets/_apl?format=tabular', {
      method: 'POST',
      headers,
      body: JSON.stringify({ apl, startTime: window.start, endTime: window.end }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new CollectionError(`HTTP ${response.status}`);
    const result = tabularSchema.parse(await response.json());
    if (result.status.isPartial) throw new CollectionError('partial query results');
    const tables = result.tables.filter(table => table.name !== '_totals');
    if (tables.length === 0) return [];
    if (tables.length !== 1) throw new CollectionError('unexpected result table count');
    const [table] = tables;
    if (table.fields.length !== table.columns.length) {
      throw new CollectionError('invalid tabular columns');
    }
    const length = table.columns[0]?.length ?? 0;
    if (table.columns.some(column => column.length !== length)) {
      throw new CollectionError('inconsistent tabular columns');
    }
    return Array.from({ length }, (_, row) =>
      Object.fromEntries(
        table.fields.map((field, column) => [field.name, table.columns[column][row]])
      )
    );
  };
}

async function workerMetrics(query: AxiomQuery): Promise<Partial<ProdMetrics>> {
  const [groups, requests, switched, workerDuration, timings] = await Promise.all([
    query(
      `${sampledPrefix} | extend route=strcat(tostring(j.taskType), '/', tostring(j.subtaskType)), cacheHit=tobool(j.cacheHit), cost=todouble(j.classifierCostCredits) | summarize n=count() by route, cacheHit, cost`
    ),
    query(`${requestPrefix} | summarize n=count()`),
    query(`${decisionPrefix} | where j.switched == true | summarize n=count()`),
    query(
      `${sampledPrefix} | extend value=coalesce(toreal(j.timings.totalMs), toreal(j.classifierDurationMs)) | where isnotnull(value) ${percentiles}`
    ),
    Promise.all(
      phases.map(async phase => {
        const rows = await query(
          `${sampledPrefix} | extend value=todouble(j.timings.${phase}) | where isnotnull(value) ${percentiles}`
        );
        return [phase, distribution(rows)] as const;
      })
    ),
  ]);
  let sampledCount = 0;
  let cacheCount = 0;
  let cacheHits = 0;
  let costCount = 0;
  let costTotal = 0;
  const routeCounts: Record<string, number> = {};
  for (const row of groups) {
    const group = groupedSchema.parse(row);
    sampledCount += group.n;
    routeCounts[group.route] = (routeCounts[group.route] ?? 0) + group.n;
    if (group.cacheHit !== null) {
      cacheCount += group.n;
      if (group.cacheHit) cacheHits += group.n;
    }
    if (group.cost !== null) {
      costCount += group.n;
      costTotal += group.cost * group.n;
    }
  }
  const requestCount = count(requests);
  const availablePhases = timings.filter(
    (entry): entry is readonly [(typeof phases)[number], Dist] => entry[1] !== null
  );
  return {
    workerDecideMs: distribution(workerDuration),
    workerPhasesMs: availablePhases.length ? Object.fromEntries(availablePhases) : null,
    cacheHitRate: cacheCount ? cacheHits / cacheCount : null,
    classifierPerRequestUsd: costCount ? costTotal / costCount : null,
    switchRate: requestCount ? count(switched) / requestCount : null,
    routeMix: Object.fromEntries(
      Object.entries(routeCounts).map(([route, n]) => [route, n / sampledCount])
    ),
  };
}

async function gatewayMetrics(query: AxiomQuery): Promise<Partial<ProdMetrics>> {
  const rows = await query(
    `['vercel'] | where message contains 'auto_routing_decide_client' | extend j=parse_json(message) | where j.event == 'auto_routing_decide_client' and j.outcome == 'ok' and j.sampled == true | extend value=todouble(j.durationMs) | where isnotnull(value) ${percentiles}`
  );
  return { gatewayDecideMs: distribution(rows) };
}

function postgresEnv(): NodeJS.ProcessEnv {
  const connection = process.env.READ_REPLICA_URL;
  if (!connection) throw new CollectionError('missing READ_REPLICA_URL');
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new CollectionError('invalid READ_REPLICA_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new CollectionError('invalid READ_REPLICA_URL');
  }
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGPASSFILE: '/dev/null',
      PGCONNECT_TIMEOUT: '10',
    };
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl']) {
      const value = url.searchParams.get(key);
      if (value) env[`PG${key.toUpperCase()}`] = value;
    }
    return env;
  } catch {
    throw new CollectionError('invalid READ_REPLICA_URL');
  }
}

async function postgresMetrics(window: Window): Promise<Partial<ProdMetrics>> {
  const env = postgresEnv();
  const sql = `BEGIN READ ONLY;
SET LOCAL statement_timeout='55s';
SELECT
  count(meta.latency) AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY meta.latency) AS p50,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY meta.latency) AS p90,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY meta.latency) AS p99,
  avg(usage.cost)::double precision / 1000000 AS mean_usd,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY usage.cost) / 1000000 AS p50_usd,
  sum(usage.cache_hit_tokens)::double precision / nullif(sum(usage.input_tokens), 0) AS cache_share
FROM microdollar_usage_metadata meta
JOIN auto_model am ON am.auto_model_id = meta.auto_model_id
JOIN microdollar_usage usage ON usage.id = meta.id
WHERE am.auto_model = 'kilo-auto/efficient'
  AND meta.created_at >= '${window.start}'::timestamptz
  AND meta.created_at < '${window.end}'::timestamptz
  AND usage.created_at >= '${window.start}'::timestamptz
  AND usage.created_at < '${window.end}'::timestamptz;
ROLLBACK;`;
  const csv = await new Promise<string>((resolve, reject) => {
    const child = spawn('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--csv', '-q', '-w'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 65_000,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () =>
      reject(new CollectionError('could not start psql; ensure it is installed'))
    );
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new CollectionError('psql failed; check READ_REPLICA_URL and replica access'));
    });
    child.stdin.on('error', () => reject(new CollectionError('could not send query to psql')));
    child.stdin.end(sql);
  });
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== 'n,p50,p90,p99,mean_usd,p50_usd,cache_share') {
    throw new CollectionError('invalid psql aggregate output');
  }
  const values = lines[1].split(',').map(value => (value === '' ? null : Number(value)));
  const [n, p50, p90, p99, mean, median, cacheShare] = z
    .array(nullableNumber)
    .length(7)
    .parse(values);
  const latency = distributionSchema.parse({ n, p50, p90, p99 });
  return {
    modelTtftMs: latency.n ? latency : null,
    prodPerRequestUsd: { mean, p50: median },
    prodCacheReadShare: cacheShare,
  };
}

async function main(): Promise<void> {
  const options = (() => {
    try {
      return parseArgs({
        options: { since: { type: 'string', default: '24' }, out: { type: 'string' } },
      });
    } catch {
      throw new CollectionError('usage: scoreboard:prod --since <hours> --out <file>');
    }
  })();
  const hours = Number(options.values.since);
  const out = options.values.out;
  if (!Number.isFinite(hours) || hours <= 0 || typeof out !== 'string' || !out) {
    throw new CollectionError('usage: scoreboard:prod --since <positive hours> --out <file>');
  }
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  if (!Number.isFinite(start.getTime()))
    throw new CollectionError('--since is outside the date range');
  const window = { start: start.toISOString(), end: end.toISOString() };
  const metrics: ProdMetrics = {
    kind: 'prod',
    window,
    gatewayDecideMs: null,
    workerDecideMs: null,
    workerPhasesMs: null,
    cacheHitRate: null,
    classifierPerRequestUsd: null,
    switchRate: null,
    routeMix: {},
    modelTtftMs: null,
    prodPerRequestUsd: { mean: null, p50: null },
    prodCacheReadShare: null,
  };
  const jobs: Promise<void>[] = [
    postgresMetrics(window)
      .then(result => {
        Object.assign(metrics, result);
      })
      .catch(error => warn('Postgres', error)),
  ];
  try {
    const query = axiomQuery(window);
    jobs.push(
      workerMetrics(query)
        .then(result => {
          Object.assign(metrics, result);
        })
        .catch(error => warn('Axiom worker', error)),
      gatewayMetrics(query)
        .then(result => {
          Object.assign(metrics, result);
        })
        .catch(error => warn('Axiom gateway', error))
    );
  } catch (error) {
    warn('Axiom', error);
  }
  await Promise.all(jobs);
  await writeFile(out, `${JSON.stringify(ProdMetricsSchema.parse(metrics), null, 2)}\n`, 'utf8');
}

main().catch(error => {
  console.error(
    error instanceof CollectionError ? error.message : 'Could not write production scoreboard.'
  );
  process.exitCode = 1;
});
