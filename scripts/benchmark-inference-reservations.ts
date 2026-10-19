import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { pg } from '@kilocode/db/client';
import type { MicrodollarUsage } from '@kilocode/db/schema';
import type { UsageMetaData } from '../packages/web-shared/src/lib/ai-gateway/processUsage.types';
import type * as DatabaseClient from '@kilocode/db/client';
import type * as DatabaseSchema from '@kilocode/db/schema';
import type * as Reservations from '@kilocode/db/inference-reservations';
import type * as ApplicationDatabase from '../packages/web-shared/src/lib/drizzle';
import type * as UsageWriter from '../packages/web-shared/src/lib/ai-gateway/processUsage';
import type * as DrizzleOrm from 'drizzle-orm';

const help = `Isolated PostgreSQL benchmark of the actual insertUsageRecord writer and public reserveInferenceCredits API.
Prerequisites: Node 24, pnpm install, all repository migrations in an otherwise synthetic database named inference_reservation_bench_<suffix>.
Run from the checkout being measured; never load .env.local or other real environment files:
BENCHMARK_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/inference_reservation_bench_local pnpm exec tsx --tsconfig apps/web/tsconfig.scripts.json scripts/benchmark-inference-reservations.ts
Options (environment): BENCH_CLIENTS=16 BENCH_POOL_SIZE=8 BENCH_OPERATIONS=1000 BENCH_PAYERS=32 BENCH_HISTORY=100 BENCH_REPETITIONS=3 BENCH_LOCK_SAMPLE_MS=20
Filters: BENCH_MODES=baseline,held,mixed,denied BENCH_SCOPES=personal,organization BENCH_DISTRIBUTIONS=distributed,hot
BENCH_ROOT defaults to cwd; imports must resolve to that checkout, with its apps/web/tsconfig.scripts.json.
BENCH_PIPELINE=0 or 1 overrides only this benchmark's pool; enabled mode must verify native client support.
BENCH_MEMBERS sets members per organization independently of payer count.
BENCH_KILO_PASS=steady or unlock requires BENCH_SCOPES=organization, non-denied BENCH_MODES, and BENCH_HISTORY=0.
KiloPass uses synthetic active tier_19 monthly agreements with real source credits and qualifying-spend snapshots.
Steady records ordinary qualifying debits without unlocking. Unlock triggers each payer's bonus on its first request, then records ordinary debits.
KiloPass additionally reports ordinary qualifying-debit and bonus-unlock-trigger request timings separately; failed attempts remain included, as in the lane timings.
Baseline is writer-only, not an alternative concurrency-safe admission implementation. Held calls reserve then writer. Mixed alternates held and writer-only operations against the same payers.
Denied mode measures insufficient-credit decisions only; it performs no usage settlement and is not billing throughput.
Distributed uses BENCH_PAYERS payers. Hot uses one payer.
Without BENCH_MEMBERS, hot organizations use BENCH_PAYERS members and distributed organizations use one member each.
History is per payer; 5% of historical reservations remain held.
Each repetition creates fresh fixtures and rotates scenario order. Connections and metadata lookup values are warmed before timing.
Fixture creation, cleanup, and accounting assertions are excluded.
Stage/full wall time includes acquisition and commit. Driver query latency includes server work, locks, network, and client queueing.
Query busy-wall time counts overlapping queries once. Summed query latencies can exceed stage wall time under pipelining.
Query counts include BEGIN/COMMIT, retries, and post-commit database work. Instrumentation adds benchmark-only overhead.
Lock/pool observations are periodic point samples, not wait durations. Sparse samples and tail percentiles are labeled. Local throughput is not production CPU/storage capacity or cross-region RTT.
Enforcement stays OFF. Runtime environment is replaced with synthetic defaults before application imports. All outbound sockets except the explicit loopback PostgreSQL endpoint are refused.
Only this invocation's uniquely named fixtures and lookup values are cleaned up. A killed process can leave fixtures; no global truncate or cleanup of previous runs is performed.`;

type Mode = 'baseline' | 'held' | 'mixed' | 'denied';
type Scope = 'personal' | 'organization';
type Distribution = 'distributed' | 'hot';
type Stage = 'reserve' | 'usage';
type Lane = 'held' | 'baseline';
type KiloPassFixture = {
  agreementId: string;
  planId: string;
  runId: string;
  snapshotId: string;
  baseCreditId: string;
  topUpCreditId: string;
};
type KiloPassAccounting = {
  sourceCreditRows: number;
  consumptionCreditRows: number;
  qualifyingEvents: number;
  qualifyingSpendMicrodollars: number;
  unlockedBonuses: number;
  bonusMicrodollars: number;
  firstRequestCostMicrodollars: number;
};
type Payer = { id: string; organizationId?: string; userIds: string[]; kiloPass?: KiloPassFixture };
type Scenario = { mode: Mode; scope: Scope; distribution: Distribution };
type Measurement = {
  wallMs: number;
  acquisitionMs: number[];
  queryMs: number[];
  queryBusyMs: number;
  queryBusyStartedAt: number;
  queriesInFlight: number;
  failedQueries: number;
};
type StageMeasurements = { reserve: Measurement[]; usage: Measurement[]; fullMs: number[] };

function integer(name: string, fallback: number, maximum: number, minimum = 1): number {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Invalid ${name}`);
  return value;
}

function selection<T extends string>(name: string, choices: readonly T[]): T[] {
  const values = (process.env[name] ?? choices.join(',')).split(',');
  assert(values.length > 0 && new Set(values).size === values.length, `Invalid ${name}`);
  return values.map(value => {
    const choice = choices.find(candidate => candidate === value);
    assert(choice, `Invalid ${name}`);
    return choice;
  });
}

function databaseUrl(): URL {
  assert(
    !process.env.USE_PRODUCTION_DB || process.env.USE_PRODUCTION_DB === 'false',
    'Refusing USE_PRODUCTION_DB'
  );
  assert(
    process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV,
    'Refusing deployed environment'
  );
  assert(!process.env.JEST_WORKER_ID, 'Refusing Jest database suffixing');
  const raw = process.env.BENCHMARK_DATABASE_URL;
  assert(raw, 'BENCHMARK_DATABASE_URL must be explicit');
  const url = new URL(raw);
  assert(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required');
  assert(url.hostname === '127.0.0.1', 'Only explicit IPv4 loopback is permitted');
  assert(
    /^\/inference_reservation_bench_[a-z0-9_]+$/.test(url.pathname),
    'Disposable benchmark database name required'
  );
  assert(
    !url.search && !url.hash && url.port && url.username,
    'Explicit port/account, no query options or fragment required'
  );
  return url;
}

function syntheticEnvironment(connectionString: string) {
  for (const key of Object.keys(process.env)) {
    if (
      !/^(BENCH[A-Z_]*|PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_.*|TERM|NO_COLOR|FORCE_COLOR|TZ|TSX_TSCONFIG_PATH)$/.test(
        key
      )
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, {
    NODE_ENV: 'development',
    IS_SCRIPT: 'true',
    IS_IN_AUTOMATED_TEST: 'true',
    USE_PRODUCTION_DB: 'false',
    GATEWAY_PREPAID_RESERVATIONS_ENABLED: 'false',
    USAGE_SHADOW_PUBLISH_ENABLED: 'false',
    POSTGRES_URL: connectionString,
    POSTGRES_SCRIPT_URL: connectionString,
    POSTGRES_CONNECT_TIMEOUT: '5000',
    POSTGRES_MAX_QUERY_TIME: '10000',
    NEXTAUTH_URL: 'http://127.0.0.1:1',
    NEXTAUTH_SECRET: 'synthetic-inference-reservation-benchmark',
    APP_URL_OVERRIDE: 'http://127.0.0.1:1',
    BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    STRIPE_SECRET_KEY: 'sk_test_synthetic_inference_reservation_benchmark',
    SKIP_STRIPE_API: 'true',
  });
  for (const tier of [19, 49, 199]) {
    for (const cadence of ['MONTHLY', 'YEARLY']) {
      process.env[`STRIPE_KILO_PASS_TIER_${tier}_${cadence}_PRICE_ID`] =
        `price_synthetic_${tier}_${cadence.toLowerCase()}`;
    }
  }
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted.length
      ? Number((sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0).toFixed(3))
      : null;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    p95Sparse: sorted.length < 100,
    p99Sparse: sorted.length < 1000,
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function summarizeStage(samples: Measurement[]) {
  const queryCounts = samples.map(sample => sample.queryMs.length);
  return {
    wall: latency(samples.map(sample => sample.wallMs)),
    acquisitionWaitPerCheckout: latency(samples.flatMap(sample => sample.acquisitionMs)),
    acquisitionWaitTotalPerCall: latency(samples.map(sample => sum(sample.acquisitionMs))),
    sqlExecutionPerQuery: latency(samples.flatMap(sample => sample.queryMs)),
    sqlExecutionTotalPerCall: latency(samples.map(sample => sample.queryBusyMs)),
    summedQueryLatencyPerCall: latency(samples.map(sample => sum(sample.queryMs))),
    nonSqlNonAcquisitionPerCall: latency(
      samples.map(sample =>
        Math.max(0, sample.wallMs - sum(sample.acquisitionMs) - sample.queryBusyMs)
      )
    ),
    queries: {
      total: sum(queryCounts),
      meanPerCall: samples.length ? sum(queryCounts) / samples.length : null,
      minPerCall: samples.length ? Math.min(...queryCounts) : null,
      maxPerCall: samples.length ? Math.max(...queryCounts) : null,
      failed: samples.reduce((total, sample) => total + sample.failedQueries, 0),
    },
  };
}

function instrumentPool(pool: pg.Pool, context: AsyncLocalStorage<Measurement>) {
  const originalConnect = pool.connect;
  pool.connect = new Proxy(originalConnect, {
    apply(target, receiver, args: unknown[]) {
      const measurement = context.getStore();
      if (!measurement) return Reflect.apply(target, receiver, args);
      const started = performance.now();
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        measurement.acquisitionMs.push(performance.now() - started);
      };
      const callback = args[0];
      if (typeof callback === 'function') {
        args[0] = (...values: unknown[]) => {
          finish();
          return Reflect.apply(callback, undefined, values);
        };
      }
      try {
        const result: unknown = Reflect.apply(target, receiver, args);
        return result instanceof Promise
          ? result.then(
              value => {
                finish();
                return value;
              },
              error => {
                finish();
                throw error;
              }
            )
          : result;
      } catch (error) {
        finish();
        throw error;
      }
    },
  });
  const onConnect = (client: pg.PoolClient) => {
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        const measurement = context.getStore();
        if (!measurement) return Reflect.apply(target, receiver, args);
        const started = performance.now();
        if (measurement.queriesInFlight++ === 0) measurement.queryBusyStartedAt = started;
        let recorded = false;
        const finish = (failed: boolean) => {
          if (recorded) return;
          recorded = true;
          const finished = performance.now();
          measurement.queryMs.push(finished - started);
          if (--measurement.queriesInFlight === 0) {
            measurement.queryBusyMs += finished - measurement.queryBusyStartedAt;
          }
          if (failed) measurement.failedQueries++;
        };
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          args[args.length - 1] = (...values: unknown[]) => {
            finish(Boolean(values[0]));
            return Reflect.apply(callback, undefined, values);
          };
        }
        try {
          const result: unknown = Reflect.apply(target, receiver, args);
          return result instanceof Promise
            ? result.then(
                value => {
                  finish(false);
                  return value;
                },
                error => {
                  finish(true);
                  throw error;
                }
              )
            : result;
        } catch (error) {
          finish(true);
          throw error;
        }
      },
    });
  };
  pool.on('connect', onConnect);
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(help);
    return;
  }
  const url = databaseUrl();
  const root = resolve(process.env.BENCH_ROOT ?? process.cwd());
  const clients = integer('BENCH_CLIENTS', 16, 128);
  const poolSize = integer('BENCH_POOL_SIZE', 8, 64);
  const operations = integer('BENCH_OPERATIONS', 1000, 100000);
  const payerCount = integer('BENCH_PAYERS', 32, 256);
  const membersPerOrganization =
    process.env.BENCH_MEMBERS === undefined ? undefined : integer('BENCH_MEMBERS', 1, 1000);
  const history = integer('BENCH_HISTORY', 100, 100000, 0);
  const repetitions = integer('BENCH_REPETITIONS', 3, 100);
  const lockSampleMs = integer('BENCH_LOCK_SAMPLE_MS', 20, 10000);
  const pipelineOverride = process.env.BENCH_PIPELINE;
  assert(
    pipelineOverride === undefined || pipelineOverride === '0' || pipelineOverride === '1',
    'Invalid BENCH_PIPELINE'
  );
  const modes = selection('BENCH_MODES', ['baseline', 'held', 'mixed', 'denied'] as const);
  const scopes = selection('BENCH_SCOPES', ['personal', 'organization'] as const);
  const distributions = selection('BENCH_DISTRIBUTIONS', ['distributed', 'hot'] as const);
  const kiloPass = process.env.BENCH_KILO_PASS;
  assert(
    kiloPass === undefined || kiloPass === 'steady' || kiloPass === 'unlock',
    'Invalid BENCH_KILO_PASS'
  );
  if (kiloPass) {
    assert(
      scopes.length === 1 && scopes[0] === 'organization',
      'BENCH_KILO_PASS requires BENCH_SCOPES=organization'
    );
    assert(!modes.includes('denied'), 'BENCH_KILO_PASS does not support denied mode');
    assert.equal(history, 0, 'BENCH_KILO_PASS requires BENCH_HISTORY=0');
  }
  const scenarios: Scenario[] = scopes.flatMap(scope =>
    distributions.flatMap(distribution => modes.map(mode => ({ scope, distribution, mode })))
  );
  const prefix = `inference-reservation-bench-${randomUUID()}`;
  const applicationName = `irb-${randomUUID()}`;
  const sourceFingerprint = createHash('sha256');
  for (const file of [
    'packages/db/src/inference-reservations.ts',
    'packages/db/src/client.ts',
    'packages/db/src/schema.ts',
    'scripts/benchmark-inference-reservations.ts',
    'packages/web-shared/src/lib/drizzle.ts',
    'packages/web-shared/src/lib/ai-gateway/processUsage.ts',
    'packages/web-shared/src/lib/ai-gateway/usage-daily-rollup-repairs.ts',
    'packages/web-shared/src/lib/kilo-pass-org/consumption.ts',
    'packages/web-shared/src/lib/organizations/organization-usage.ts',
    'packages/db/src/bouncer-usage-event-outbox.ts',
  ])
    sourceFingerprint
      .update(file)
      .update('\0')
      .update(readFileSync(resolve(root, file)))
      .update('\0');
  const sourceDigest = sourceFingerprint.digest('hex');
  syntheticEnvironment(url.href);
  let blockedNetworkAttempts = 0;
  const originalSocketConnect = Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  Socket.prototype.connect = new Proxy(originalSocketConnect, {
    apply(target, receiver, args: unknown[]) {
      const first = args[0];
      const host =
        typeof first === 'object' && first !== null && 'host' in first ? first.host : args[1];
      const port =
        typeof first === 'object' && first !== null && 'port' in first ? first.port : first;
      if (host !== '127.0.0.1' || Number(port) !== Number(url.port)) {
        blockedNetworkAttempts++;
        throw new Error('Benchmark refused a non-database network connection');
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  globalThis.fetch = async () => {
    blockedNetworkAttempts++;
    throw new Error('Benchmark refused an outbound HTTP request');
  };
  const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
  const requireDatabase = createRequire(resolve(root, 'packages/db/package.json'));
  const { version: driverVersion } = requireDatabase('pg/package.json') as { version: string };
  assert.equal(
    requireWeb.resolve('@kilocode/db/client'),
    resolve(root, 'packages/db/src/client.ts'),
    'Script tsconfig resolves to a different checkout'
  );
  assert.equal(
    requireWeb.resolve('@kilocode/web-shared/lib/drizzle'),
    resolve(root, 'packages/web-shared/src/lib/drizzle.ts'),
    'Script tsconfig resolves to a different checkout'
  );
  const { db, pool, closeAllDrizzleConnections, usesSeparateReplica } = requireWeb(
    resolve(root, 'packages/web-shared/src/lib/drizzle.ts')
  ) as typeof ApplicationDatabase;
  assert.equal(usesSeparateReplica, false, 'Benchmark cannot use a replica');
  Object.assign(pool.options, {
    max: poolSize,
    application_name: applicationName,
    statement_timeout: 10000,
    lock_timeout: 3000,
  });
  if (pipelineOverride !== undefined)
    Object.assign(pool.options, { pipeline: pipelineOverride === '1' });
  const pipelineRequested = 'pipeline' in pool.options && pool.options.pipeline === true;
  const { createDrizzleClient } = requireWeb('@kilocode/db/client') as typeof DatabaseClient;
  const observer = createDrizzleClient({
    connectionString: url.href,
    ssl: false,
    poolConfig: {
      max: 1,
      application_name: `${applicationName}-observer`,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    },
  });
  const measurementContext = new AsyncLocalStorage<Measurement>();
  instrumentPool(pool, measurementContext);
  const results = [];
  let cleanupComplete = true;
  let isolationVerified = false;
  let pipelineActive = false;
  let preparedNamedStatementsOnSampledConnection = 0;
  let reservationIndexes: string[] = [];
  let serverSettings: Record<string, string> = {};
  try {
    const identity = await pool.query<{
      address: string;
      database: string;
      account: string;
      replica: boolean;
    }>(
      'SELECT inet_server_addr()::text AS address, current_database() AS database, current_user AS account, pg_is_in_recovery() AS replica'
    );
    const server = identity.rows[0];
    assert(server);
    assert.match(
      server.address,
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
      'Refusing public PostgreSQL server address'
    );
    assert.equal(server.database, url.pathname.slice(1));
    assert.equal(server.account, decodeURIComponent(url.username), 'Unexpected PostgreSQL account');
    assert.equal(server.replica, false, 'Benchmark requires a writable primary');
    const isolation = await pool.query<{ safe: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM kilocode_users WHERE id NOT LIKE 'inference-reservation-bench-%' OR google_user_email NOT LIKE '%@example.invalid') AND NOT EXISTS (SELECT 1 FROM organizations WHERE name NOT LIKE 'inference-reservation-bench-%') AS safe"
    );
    assert.equal(isolation.rows[0]?.safe, true, 'Database contains non-benchmark accounts');
    isolationVerified = true;
    const indexes = await pool.query<{ definition: string }>(
      "SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = 'inference_reservations'::regclass ORDER BY indexrelid::regclass::text"
    );
    reservationIndexes = indexes.rows.map(row => row.definition);
    const settings = await pool.query<{ name: string; setting: string }>(
      'SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])',
      [
        [
          'server_version',
          'synchronous_commit',
          'fsync',
          'full_page_writes',
          'track_io_timing',
          'track_wal_io_timing',
          'wal_sync_method',
          'wal_compression',
        ],
      ]
    );
    serverSettings = Object.fromEntries(settings.rows.map(row => [row.name, row.setting]));
    assert(
      ['on', 'local', 'remote_write', 'remote_apply'].includes(
        serverSettings.synchronous_commit ?? ''
      ),
      'Refusing nondurable commits'
    );
    assert(
      serverSettings.fsync === 'on' && serverSettings.full_page_writes === 'on',
      'Refusing unsafe WAL settings'
    );
    const { reserveInferenceCredits } = requireWeb(
      '@kilocode/db/inference-reservations'
    ) as typeof Reservations;
    const { insertUsageRecord } = requireWeb(
      resolve(root, 'packages/web-shared/src/lib/ai-gateway/processUsage.ts')
    ) as typeof UsageWriter;
    const { inArray } = requireWeb('drizzle-orm') as typeof DrizzleOrm;
    const {
      kilocode_users,
      organizations,
      organization_memberships,
      organization_user_limits,
      organization_user_usage,
      inference_reservations,
      microdollar_usage,
      credit_transactions,
      kilo_pass_org_term_versions,
      kilo_pass_org_agreements,
      kilo_pass_org_allocation_plans,
      kilo_pass_org_processing_runs,
      kilo_pass_org_issuance_snapshots,
      kilo_pass_org_qualifying_spend_events,
      SCHEMA_CHECK_ENUMS,
    } = requireWeb('@kilocode/db/schema') as typeof DatabaseSchema;
    const {
      KiloPassTier,
      KiloPassCadence,
      KiloPassOrgAgreementState,
      KiloPassOrgPurchaseChannel,
      KiloPassOrgProcessingRunState,
      KiloPassOrgBonusMode,
      KiloPassOrgIssuanceKind,
    } = SCHEMA_CHECK_ENUMS;
    const warmed = await Promise.allSettled(Array.from({ length: poolSize }, () => pool.connect()));
    for (const result of warmed) if (result.status === 'fulfilled') result.value.release();
    const failedWarmup = warmed.find(result => result.status === 'rejected');
    if (failedWarmup?.status === 'rejected') throw failedWarmup.reason;
    pipelineActive = warmed.every(
      result =>
        result.status === 'fulfilled' &&
        'pipeline' in result.value &&
        result.value.pipeline === true
    );
    if (pipelineOverride === '1')
      assert(pipelineActive, 'Installed PostgreSQL driver did not enable pipelining');
    const metadataTables = [
      'http_user_agent',
      'ja4_digest',
      'system_prompt_prefix',
      'finish_reason',
      'editor_name',
      'feature',
      'mode',
      'auto_model',
      'reasoning_setting',
    ];

    for (let repetition = 0; repetition < repetitions; repetition++) {
      const offset = repetition % scenarios.length;
      const ordered = [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
      for (const scenario of ordered) {
        const scenarioName = `${scenario.scope}-${scenario.distribution}-${scenario.mode}`;
        const fixturePrefix = `${prefix}-${repetition}-${scenarioName}`;
        const payers: Payer[] = Array.from(
          { length: scenario.distribution === 'hot' ? 1 : payerCount },
          (_, index) => ({
            id: `${fixturePrefix}-${index}`,
            organizationId: scenario.scope === 'organization' ? randomUUID() : undefined,
            userIds: Array.from(
              {
                length:
                  scenario.scope === 'organization'
                    ? (membersPerOrganization ?? (scenario.distribution === 'hot' ? payerCount : 1))
                    : 1,
              },
              (_, member) => `${fixturePrefix}-${index}-${member}`
            ),
            kiloPass: kiloPass
              ? {
                  agreementId: randomUUID(),
                  planId: randomUUID(),
                  runId: randomUUID(),
                  snapshotId: randomUUID(),
                  baseCreditId: randomUUID(),
                  topUpCreditId: randomUUID(),
                }
              : undefined,
          })
        );
        const userIds = payers.flatMap(payer => payer.userIds);
        const organizationIds = payers.flatMap(payer =>
          payer.organizationId ? [payer.organizationId] : []
        );
        const credit = scenario.mode === 'denied' ? 0 : 1_000_000_000;
        const historyHeld = Math.ceil(history / 20);
        const now = new Date().toISOString();
        const passTermId = kiloPass ? randomUUID() : undefined;
        const passBase = 19_000_000;
        const passBonus = 4_000_000;
        const fixtureDate = new Date(now);
        const passWindowStart = new Date(
          Date.UTC(fixtureDate.getUTCFullYear(), fixtureDate.getUTCMonth(), 1)
        ).toISOString();
        const passWindowEnd = new Date(
          Date.UTC(fixtureDate.getUTCFullYear(), fixtureDate.getUTCMonth() + 1, 1)
        ).toISOString();
        const createdUsage = (
          id: string,
          userId: string,
          organizationId: string | undefined,
          cost: number,
          createdAt: string
        ): MicrodollarUsage => ({
          id,
          kilo_user_id: userId,
          organization_id: organizationId ?? null,
          cost,
          input_tokens: 10,
          output_tokens: 10,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: createdAt,
          provider: 'synthetic-writer-benchmark',
          model: 'synthetic-writer-benchmark',
          requested_model: 'synthetic-writer-benchmark',
          cache_discount: 0,
          has_error: false,
          abuse_classification: 0,
          inference_provider: null,
          project_id: null,
        });
        const metadata = (id: string, held: boolean, cost: number): UsageMetaData => ({
          id,
          message_id: id,
          created_at: now,
          prepaid_reservation_id: held ? id : null,
          prepaid_usage_final: held,
          http_x_forwarded_for: null,
          http_x_vercel_ip_city: null,
          http_x_vercel_ip_country: null,
          http_x_vercel_ip_latitude: null,
          http_x_vercel_ip_longitude: null,
          http_x_vercel_ja4_digest: fixturePrefix,
          user_prompt_prefix: 'synthetic benchmark prompt',
          system_prompt_prefix: fixturePrefix,
          system_prompt_length: 32,
          http_user_agent: fixturePrefix,
          max_tokens: 128,
          has_middle_out_transform: false,
          status_code: 200,
          upstream_id: id,
          finish_reason: fixturePrefix,
          latency: 1,
          moderation_latency: null,
          generation_time: 1,
          is_byok: false,
          is_user_byok: false,
          streamed: true,
          cancelled: false,
          editor_name: fixturePrefix,
          api_kind: null,
          has_tools: false,
          machine_id: null,
          feature: fixturePrefix,
          session_id: null,
          mode: fixturePrefix,
          auto_model: fixturePrefix,
          reasoning_setting: fixturePrefix,
          market_cost: cost,
          is_free: false,
          abuse_delay: null,
          abuse_downgraded_from: null,
        });
        cleanupComplete = false;
        try {
          for (const table of metadataTables)
            await pool.query(`INSERT INTO ${table} (${table}) VALUES ($1)`, [fixturePrefix]);
          if (passTermId) {
            await db.insert(kilo_pass_org_term_versions).values({
              id: passTermId,
              version_key: `${fixturePrefix}-kilo-pass`,
              tier: KiloPassTier.Tier19,
              cadence: KiloPassCadence.Monthly,
              billing_price_microdollars_per_pass: passBase,
              base_credit_microdollars_per_pass: passBase,
              bonus_credit_microdollars_per_pass: passBonus,
              unlock_spend_microdollars_per_pass: passBase,
              bonus_mode: KiloPassOrgBonusMode.AfterBase,
            });
          }
          for (const payer of payers) {
            await db.insert(kilocode_users).values(
              payer.userIds.map(userId => ({
                id: userId,
                google_user_email: `${userId}@example.invalid`,
                google_user_name: fixturePrefix,
                google_user_image_url: '',
                stripe_customer_id: userId,
                kilo_pass_threshold: null,
                total_microdollars_acquired: credit,
                microdollars_used: payer.organizationId ? 0 : history,
                inference_microdollars_held: payer.organizationId ? 0 : historyHeld,
              }))
            );
            const organizationId = payer.organizationId;
            if (organizationId) {
              await db.insert(organizations).values({
                id: organizationId,
                name: payer.id,
                require_seats: false,
                settings: {},
                total_microdollars_acquired: credit,
                microdollars_used: history,
                microdollars_balance: credit - history,
                inference_microdollars_held: historyHeld,
              });
              await db
                .insert(organization_memberships)
                .values(
                  payer.userIds.map(userId => ({
                    organization_id: organizationId,
                    kilo_user_id: userId,
                    role: 'owner' as const,
                  }))
                );
              await db
                .insert(organization_user_limits)
                .values(
                  payer.userIds.map(userId => ({
                    organization_id: organizationId,
                    kilo_user_id: userId,
                    limit_type: 'daily' as const,
                    microdollar_limit: credit,
                  }))
                );
              await db.insert(organization_user_usage).values(
                payer.userIds.map((userId, index) => ({
                  organization_id: organizationId,
                  kilo_user_id: userId,
                  limit_type: 'daily' as const,
                  usage_date: now.slice(0, 10),
                  microdollar_usage:
                    Math.floor(history / payer.userIds.length) +
                    (index < history % payer.userIds.length ? 1 : 0),
                }))
              );
              const pass = payer.kiloPass;
              if (pass) {
                assert(passTermId);
                const ownerId = payer.userIds[0];
                assert(ownerId);
                await db.insert(kilo_pass_org_agreements).values({
                  id: pass.agreementId,
                  parent_organization_id: organizationId,
                  term_version_id: passTermId,
                  state: KiloPassOrgAgreementState.Active,
                  purchase_channel: KiloPassOrgPurchaseChannel.SelfServe,
                  cadence: KiloPassCadence.Monthly,
                  purchased_pass_capacity: 1,
                  paid_from: passWindowStart,
                  paid_until: passWindowEnd,
                  issuance_anchor_at: passWindowStart,
                  provider_subscription_id: `${fixturePrefix}-${organizationId}-subscription`,
                  provider_seat_add_on_item_id: `${fixturePrefix}-${organizationId}-seat`,
                });
                await db.insert(kilo_pass_org_allocation_plans).values({
                  id: pass.planId,
                  agreement_id: pass.agreementId,
                  effective_window_start: passWindowStart,
                  version: 1,
                  created_by_kilo_user_id: ownerId,
                });
                await db.insert(kilo_pass_org_processing_runs).values({
                  id: pass.runId,
                  agreement_id: pass.agreementId,
                  window_start: passWindowStart,
                  window_end: passWindowEnd,
                  state: KiloPassOrgProcessingRunState.Succeeded,
                  attempt_count: 1,
                  idempotency_key: `${fixturePrefix}-${organizationId}-issuance`,
                });
                await db.insert(credit_transactions).values([
                  {
                    id: pass.baseCreditId,
                    kilo_user_id: ownerId,
                    organization_id: organizationId,
                    amount_microdollars: passBase,
                    is_free: true,
                    check_category_uniqueness: true,
                    description: 'Kilo Pass organization base issuance',
                    created_at: passWindowStart,
                    credit_category: `kpo:base:${pass.agreementId}:${organizationId}:${passWindowStart}`,
                    original_baseline_microdollars_used: 0,
                  },
                  {
                    id: pass.topUpCreditId,
                    kilo_user_id: ownerId,
                    organization_id: organizationId,
                    amount_microdollars: credit - passBase,
                    is_free: false,
                    check_category_uniqueness: true,
                    description: 'Synthetic benchmark opening purchased balance',
                    created_at: passWindowStart,
                    credit_category: `${fixturePrefix}-${organizationId}-opening-credit`,
                    original_baseline_microdollars_used: 0,
                  },
                ]);
                await db.insert(kilo_pass_org_issuance_snapshots).values({
                  id: pass.snapshotId,
                  agreement_id: pass.agreementId,
                  processing_run_id: pass.runId,
                  allocation_plan_id: pass.planId,
                  term_version_id: passTermId,
                  allocation_container_organization_id: organizationId,
                  window_start: passWindowStart,
                  window_end: passWindowEnd,
                  qualifying_spend_starts_at: passWindowStart,
                  kind: KiloPassOrgIssuanceKind.Regular,
                  tranche_key: 'base',
                  allocated_pass_capacity: 1,
                  base_credit_microdollars: passBase,
                  bonus_credit_microdollars: passBonus,
                  unlock_spend_microdollars: passBase,
                  bonus_mode: KiloPassOrgBonusMode.AfterBase,
                  base_credit_transaction_id: pass.baseCreditId,
                });
              }
            }
            for (let start = 0; start < history; start += 500) {
              const rows = Array.from({ length: Math.min(500, history - start) }, (_, offset) => {
                const index = start + offset;
                const userId = payer.userIds[index % payer.userIds.length];
                assert(userId);
                return {
                  index,
                  core: createdUsage(randomUUID(), userId, payer.organizationId, 1, now),
                };
              });
              await db.insert(microdollar_usage).values(rows.map(row => row.core));
              await db.insert(inference_reservations).values(
                rows.map(({ index, core }) => ({
                  request_id: core.id,
                  kilo_user_id: core.kilo_user_id,
                  organization_id: core.organization_id,
                  amount_microdollars: 1,
                  created_at: now,
                  ...(index % 20 === 0
                    ? { status: 'reserved' as const }
                    : {
                        status: 'settled' as const,
                        actual_cost_microdollars: 1,
                        finalized_at: now,
                      }),
                }))
              );
            }
          }
          const requests = Array.from({ length: operations }, (_, index) => {
            const payer = payers[index % payers.length];
            assert(payer);
            const userId = payer.userIds[Math.floor(index / payers.length) % payer.userIds.length];
            assert(userId);
            const held =
              scenario.mode === 'held' ||
              scenario.mode === 'denied' ||
              (scenario.mode === 'mixed' &&
                ((index % payers.length) + Math.floor(index / payers.length)) % 2 === 0);
            const cost = kiloPass === 'unlock' && index < payers.length ? passBase : 75;
            const core = createdUsage(randomUUID(), userId, payer.organizationId, cost, now);
            return { payer, userId, held, core, metadata: metadata(core.id, held, cost) };
          });
          const measurements: Record<Lane, StageMeasurements> = {
            baseline: { reserve: [], usage: [], fullMs: [] },
            held: { reserve: [], usage: [], fullMs: [] },
          };
          const kiloPassMeasurements:
            | Record<'ordinaryQualifyingDebit' | 'bonusUnlock', StageMeasurements>
            | undefined = kiloPass
            ? {
                ordinaryQualifyingDebit: { reserve: [], usage: [], fullMs: [] },
                bonusUnlock: { reserve: [], usage: [], fullMs: [] },
              }
            : undefined;
          const errors: Record<string, number> = {};
          const lockEvents: Record<string, number> = {};
          const serverWaitEvents: Record<string, number> = {};
          let next = 0;
          let completed = 0;
          let observations = 0;
          let samplesWithLockWaiters = 0;
          let maxWaitingSessions = 0;
          let maxPoolWaiters = 0;
          let poolSamplesWithWaiters = 0;
          let samplingErrors = 0;
          let sampling: Promise<void> | undefined;
          const observeLocks = () => {
            if (sampling) return;
            sampling = (async () => {
              try {
                maxPoolWaiters = Math.max(maxPoolWaiters, pool.waitingCount);
                if (pool.waitingCount > 0) poolSamplesWithWaiters++;
                const sample = await observer.pool.query<{
                  wait_event_type: string | null;
                  wait_event: string | null;
                  locktype: string | null;
                  mode: string | null;
                  sessions: number;
                }>(
                  "SELECT a.wait_event_type, a.wait_event, l.locktype, l.mode, count(DISTINCT a.pid)::int AS sessions FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted WHERE a.application_name = $1 AND a.state = 'active' GROUP BY a.wait_event_type, a.wait_event, l.locktype, l.mode",
                  [applicationName]
                );
                observations++;
                let waiting = 0;
                for (const row of sample.rows) {
                  const event = row.wait_event_type
                    ? `${row.wait_event_type}:${row.wait_event ?? 'unknown'}`
                    : 'active-unreported';
                  serverWaitEvents[event] = (serverWaitEvents[event] ?? 0) + row.sessions;
                  if (row.wait_event_type !== 'Lock') continue;
                  waiting += row.sessions;
                  const key = [row.wait_event, row.locktype, row.mode].join(':');
                  lockEvents[key] = (lockEvents[key] ?? 0) + row.sessions;
                }
                if (waiting > 0) samplesWithLockWaiters++;
                maxWaitingSessions = Math.max(maxWaitingSessions, waiting);
              } catch {
                samplingErrors++;
              } finally {
                sampling = undefined;
              }
            })();
          };
          const started = performance.now();
          const sampler = setInterval(observeLocks, lockSampleMs);
          observeLocks();
          await Promise.all(
            Array.from({ length: clients }, async () => {
              for (;;) {
                const request = requests[next++];
                if (!request) break;
                const lane = request.held ? 'held' : 'baseline';
                const passPath =
                  kiloPassMeasurements?.[
                    request.core.cost === passBase ? 'bonusUnlock' : 'ordinaryQualifyingDebit'
                  ];
                const operationStarted = performance.now();
                let stage: Stage = request.held ? 'reserve' : 'usage';
                const measure = async <T>(
                  stageName: Stage,
                  action: () => Promise<T>
                ): Promise<T> => {
                  stage = stageName;
                  const sample: Measurement = {
                    wallMs: 0,
                    acquisitionMs: [],
                    queryMs: [],
                    failedQueries: 0,
                    queryBusyMs: 0,
                    queryBusyStartedAt: 0,
                    queriesInFlight: 0,
                  };
                  const stageStarted = performance.now();
                  try {
                    return await measurementContext.run(sample, action);
                  } finally {
                    assert.equal(
                      sample.queriesInFlight,
                      0,
                      'Stage ended before its queries drained'
                    );
                    sample.wallMs = performance.now() - stageStarted;
                    measurements[lane][stageName].push(sample);
                    passPath?.[stageName].push(sample);
                  }
                };
                try {
                  if (request.held) {
                    await measure('reserve', async () => {
                      const reserved = await reserveInferenceCredits(db, {
                        requestId: request.core.id,
                        userId: request.userId,
                        organizationId: request.payer.organizationId,
                        amountMicrodollars: request.core.cost + 25,
                      });
                      assert.equal(
                        reserved.kind,
                        scenario.mode === 'denied' ? 'insufficient' : 'reserved',
                        'Unexpected admission decision'
                      );
                    });
                  }
                  if (scenario.mode !== 'denied') {
                    await measure('usage', async () => {
                      const inserted = await insertUsageRecord(request.core, request.metadata);
                      assert(
                        inserted && inserted.usageId === request.core.id && !inserted.wasRedelivery,
                        'Writer did not insert usage'
                      );
                    });
                  }
                  completed++;
                } catch (error) {
                  const code =
                    error instanceof Error && 'code' in error
                      ? String(error.code)
                      : error instanceof Error
                        ? error.name
                        : 'unknown';
                  const key = `${lane}:${stage}:${code}`;
                  errors[key] = (errors[key] ?? 0) + 1;
                } finally {
                  const fullMs = performance.now() - operationStarted;
                  measurements[lane].fullMs.push(fullMs);
                  passPath?.fullMs.push(fullMs);
                }
              }
            })
          );
          const elapsedSeconds = (performance.now() - started) / 1000;
          clearInterval(sampler);
          await sampling;
          const accounting = await pool.query<{
            usage_rows: number;
            cost: string;
            payer_used: string;
            held: string;
            unsettled: number;
            member_used: string;
            personal_member_used: string;
          }>(
            `SELECT
              (SELECT count(*)::int FROM microdollar_usage WHERE kilo_user_id = ANY($1::text[])) AS usage_rows,
              (SELECT COALESCE(sum(cost), 0)::text FROM microdollar_usage WHERE kilo_user_id = ANY($1::text[])) AS cost,
              (CASE WHEN $3 THEN (SELECT COALESCE(sum(microdollars_used), 0) FROM organizations WHERE id = ANY($2::uuid[])) ELSE (SELECT COALESCE(sum(microdollars_used), 0) FROM kilocode_users WHERE id = ANY($1::text[])) END)::text AS payer_used,
              (CASE WHEN $3 THEN (SELECT COALESCE(sum(inference_microdollars_held), 0) FROM organizations WHERE id = ANY($2::uuid[])) ELSE (SELECT COALESCE(sum(inference_microdollars_held), 0) FROM kilocode_users WHERE id = ANY($1::text[])) END)::text AS held,
              (SELECT count(*)::int FROM inference_reservations WHERE kilo_user_id = ANY($1::text[]) AND status = 'reserved') AS unsettled,
              (SELECT COALESCE(sum(microdollar_usage), 0)::text FROM organization_user_usage WHERE kilo_user_id = ANY($1::text[]) AND limit_type = 'daily') AS member_used,
              (SELECT COALESCE(sum(microdollars_used), 0)::text FROM kilocode_users WHERE id = ANY($1::text[])) AS personal_member_used`,
            [userIds, organizationIds, scenario.scope === 'organization']
          );
          const actual = accounting.rows[0];
          assert(actual);
          assert.equal(
            Number(actual.cost),
            Number(actual.payer_used),
            'Usage/payer accounting mismatch'
          );
          if (scenario.scope === 'organization') {
            assert.equal(
              Number(actual.member_used),
              Number(actual.cost),
              'Organization member accounting mismatch'
            );
            assert.equal(
              Number(actual.personal_member_used),
              0,
              'Organization usage debited personal balances'
            );
          }
          if (completed === operations) {
            const billed = scenario.mode === 'denied' ? 0 : operations;
            assert.equal(actual.usage_rows, history * payers.length + billed);
            assert.equal(
              Number(actual.cost),
              history * payers.length +
                (scenario.mode === 'denied' ? 0 : sum(requests.map(request => request.core.cost)))
            );
            assert.equal(Number(actual.held), historyHeld * payers.length);
            assert.equal(actual.unsettled, historyHeld * payers.length);
          }
          let kiloPassAccounting: KiloPassAccounting | undefined;
          if (kiloPass) {
            const [credits, snapshots, events, organizationRows, usageRows] = await Promise.all([
              db
                .select()
                .from(credit_transactions)
                .where(inArray(credit_transactions.organization_id, organizationIds)),
              db
                .select()
                .from(kilo_pass_org_issuance_snapshots)
                .where(
                  inArray(
                    kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
                    organizationIds
                  )
                ),
              db
                .select()
                .from(kilo_pass_org_qualifying_spend_events)
                .where(
                  inArray(
                    kilo_pass_org_qualifying_spend_events.allocation_container_organization_id,
                    organizationIds
                  )
                ),
              db.select().from(organizations).where(inArray(organizations.id, organizationIds)),
              db
                .select({
                  id: microdollar_usage.id,
                  userId: microdollar_usage.kilo_user_id,
                  organizationId: microdollar_usage.organization_id,
                  cost: microdollar_usage.cost,
                })
                .from(microdollar_usage)
                .where(inArray(microdollar_usage.organization_id, organizationIds)),
            ]);
            const creditById = new Map(credits.map(row => [row.id, row]));
            const debitBySource = new Map(
              credits
                .filter(row => row.amount_microdollars < 0)
                .map(row => [row.credit_category, row])
            );
            const eventByCredit = new Map(events.map(row => [row.credit_transaction_id, row]));
            const snapshotByOrganization = new Map(
              snapshots.map(row => [row.allocation_container_organization_id, row])
            );
            const organizationById = new Map(organizationRows.map(row => [row.id, row]));
            const requestById = new Map(requests.map(request => [request.core.id, request]));
            const spendByOrganization = new Map<string, number>();
            assert.equal(snapshots.length, payers.length, 'KiloPass snapshot count mismatch');
            assert.equal(
              snapshotByOrganization.size,
              payers.length,
              'Duplicate KiloPass snapshots'
            );
            assert.equal(
              organizationRows.length,
              payers.length,
              'KiloPass organization count mismatch'
            );
            assert.equal(
              debitBySource.size,
              usageRows.length,
              'KiloPass consumption credit count mismatch'
            );
            assert.equal(
              events.length,
              usageRows.length,
              'KiloPass qualifying event count mismatch'
            );
            assert.equal(eventByCredit.size, events.length, 'Duplicate KiloPass source events');
            for (const usage of usageRows) {
              assert(usage.organizationId);
              const request = requestById.get(usage.id);
              assert(request, 'KiloPass usage has no benchmark request');
              assert.equal(usage.cost, request.core.cost);
              assert.equal(usage.userId, request.userId);
              assert.equal(usage.organizationId, request.payer.organizationId);
              const debit = debitBySource.get(`kpo:consumption:ai-gateway:${usage.id}`);
              assert(debit, 'KiloPass usage has no source debit');
              assert.equal(debit.kilo_user_id, usage.userId);
              assert.equal(debit.organization_id, usage.organizationId);
              assert.equal(debit.amount_microdollars, -usage.cost);
              assert.equal(debit.is_free, false);
              assert.equal(debit.check_category_uniqueness, true);
              assert.equal(debit.expiry_date, null);
              assert.equal(debit.original_baseline_microdollars_used, null);
              assert.equal(debit.expiration_baseline_microdollars_used, null);
              assert.equal(new Date(debit.created_at).toISOString(), now);
              const event = eventByCredit.get(debit.id);
              assert(event, 'KiloPass source debit has no qualifying event');
              assert.equal(event.issuance_snapshot_id, request.payer.kiloPass?.snapshotId);
              assert.equal(event.allocation_container_organization_id, usage.organizationId);
              assert.equal(event.spent_microdollars, usage.cost);
              assert.equal(new Date(event.occurred_at).toISOString(), now);
              spendByOrganization.set(
                usage.organizationId,
                (spendByOrganization.get(usage.organizationId) ?? 0) + usage.cost
              );
            }
            let unlockedBonuses = 0;
            for (const payer of payers) {
              const pass = payer.kiloPass;
              const organizationId = payer.organizationId;
              assert(pass && organizationId);
              const organization = organizationById.get(organizationId);
              const snapshot = snapshotByOrganization.get(organizationId);
              const base = creditById.get(pass.baseCreditId);
              const topUp = creditById.get(pass.topUpCreditId);
              assert(
                organization && snapshot && base && topUp,
                'Incomplete KiloPass source accounting'
              );
              const spend = spendByOrganization.get(organizationId) ?? 0;
              assert.equal(snapshot.id, pass.snapshotId);
              assert.equal(snapshot.agreement_id, pass.agreementId);
              assert.equal(snapshot.processing_run_id, pass.runId);
              assert.equal(snapshot.allocation_plan_id, pass.planId);
              assert.equal(snapshot.term_version_id, passTermId);
              assert.equal(snapshot.kind, KiloPassOrgIssuanceKind.Regular);
              assert.equal(snapshot.tranche_key, 'base');
              assert.equal(snapshot.allocated_pass_capacity, 1);
              assert.equal(snapshot.bonus_mode, KiloPassOrgBonusMode.AfterBase);
              assert.equal(snapshot.base_credit_transaction_id, base.id);
              assert.equal(snapshot.base_credit_microdollars, passBase);
              assert.equal(snapshot.bonus_credit_microdollars, passBonus);
              assert.equal(snapshot.unlock_spend_microdollars, passBase);
              assert.equal(
                snapshot.qualifying_spend_microdollars,
                spend,
                'KiloPass snapshot/event spend mismatch'
              );
              assert.equal(snapshot.repair_completed_at, null);
              assert.equal(new Date(snapshot.window_start).toISOString(), passWindowStart);
              assert.equal(
                new Date(snapshot.qualifying_spend_starts_at).toISOString(),
                passWindowStart
              );
              assert.equal(new Date(snapshot.window_end).toISOString(), passWindowEnd);
              assert.equal(
                base.credit_category,
                `kpo:base:${pass.agreementId}:${organizationId}:${passWindowStart}`
              );
              assert.equal(base.amount_microdollars, passBase);
              assert.equal(base.is_free, true);
              assert.equal(topUp.amount_microdollars, credit - passBase);
              assert.equal(
                topUp.credit_category,
                `${fixturePrefix}-${organizationId}-opening-credit`
              );
              assert.equal(topUp.is_free, false);
              for (const source of [base, topUp]) {
                assert.equal(source.organization_id, organizationId);
                assert.equal(source.kilo_user_id, payer.userIds[0]);
                assert.equal(source.original_baseline_microdollars_used, 0);
                assert.equal(source.expiration_baseline_microdollars_used, null);
                assert.equal(source.expiry_date, null);
                assert.equal(source.check_category_uniqueness, true);
              }
              const unlocked = spend >= passBase;
              assert(
                kiloPass === 'unlock' || !unlocked,
                'Steady KiloPass workload unexpectedly unlocked'
              );
              if (unlocked) {
                unlockedBonuses++;
                assert(snapshot.bonus_credit_transaction_id && snapshot.bonus_unlocked_at);
                const bonus = creditById.get(snapshot.bonus_credit_transaction_id);
                assert(bonus, 'KiloPass snapshot bonus credit missing');
                assert.equal(bonus.credit_category, `kpo:bonus-unlock:${snapshot.id}`);
                assert.equal(bonus.organization_id, organizationId);
                assert.equal(
                  bonus.kilo_user_id,
                  payer.userIds[0],
                  'KiloPass bonus was not granted by threshold consumption'
                );
                assert.equal(bonus.amount_microdollars, passBonus);
                assert.equal(bonus.is_free, true);
                assert.equal(bonus.check_category_uniqueness, true);
                assert(bonus.expiry_date);
                assert.equal(new Date(bonus.expiry_date).toISOString(), passWindowEnd);
                assert.equal(new Date(snapshot.bonus_unlocked_at).toISOString(), now);
                assert.equal(new Date(bonus.created_at).toISOString(), now);
                assert.equal(
                  bonus.original_baseline_microdollars_used,
                  bonus.expiration_baseline_microdollars_used
                );
                assert(bonus.original_baseline_microdollars_used !== null);
                assert(
                  bonus.original_baseline_microdollars_used >= passBase &&
                    bonus.original_baseline_microdollars_used <= spend,
                  'KiloPass bonus baseline excludes threshold consumption'
                );
                assert.equal((bonus.original_baseline_microdollars_used - passBase) % 75, 0);
                assert(organization.next_credit_expiration_at);
                assert.equal(
                  new Date(organization.next_credit_expiration_at).toISOString(),
                  passWindowEnd
                );
              } else {
                assert.equal(snapshot.bonus_credit_transaction_id, null);
                assert.equal(snapshot.bonus_unlocked_at, null);
                assert.equal(organization.next_credit_expiration_at, null);
              }
              const acquired = credit + (unlocked ? passBonus : 0);
              assert.equal(
                organization.total_microdollars_acquired,
                acquired,
                'KiloPass bonus acquisition mismatch'
              );
              assert.equal(organization.microdollars_used, spend);
              assert.equal(
                organization.microdollars_balance,
                acquired - spend,
                'KiloPass balance double-debited'
              );
              if (completed === operations)
                assert.equal(organization.inference_microdollars_held, 0);
            }
            assert.equal(
              credits.length,
              payers.length * 2 + usageRows.length + unlockedBonuses,
              'Unexpected or duplicate KiloPass credits'
            );
            if (completed === operations && kiloPass === 'unlock') {
              assert.equal(
                unlockedBonuses,
                Math.min(operations, payers.length),
                'KiloPass bonus did not unlock exactly once per active payer'
              );
            }
            kiloPassAccounting = {
              sourceCreditRows: payers.length * 2,
              consumptionCreditRows: usageRows.length,
              qualifyingEvents: events.length,
              qualifyingSpendMicrodollars: sum([...spendByOrganization.values()]),
              unlockedBonuses,
              bonusMicrodollars: unlockedBonuses * passBonus,
              firstRequestCostMicrodollars: kiloPass === 'unlock' ? passBase : 75,
            };
          }
          results.push({
            repetition: repetition + 1,
            order: ordered.indexOf(scenario) + 1,
            scenario: scenarioName,
            kiloPass: kiloPass ?? null,
            payers: payers.length,
            membersPerPayer: payers[0]?.userIds.length,
            attempted: operations,
            completed,
            operationKind: scenario.mode === 'denied' ? 'admission-only-denial' : 'settled-billing',
            completedBillingOperations: scenario.mode === 'denied' ? 0 : completed,
            deniedAdmissions: scenario.mode === 'denied' ? completed : 0,
            errors,
            elapsedSeconds,
            completedOperationsPerSecond: completed / elapsedSeconds,
            lanes: Object.fromEntries(
              Object.entries(measurements).map(([lane, values]) => [
                lane,
                {
                  fullOperation: latency(values.fullMs),
                  reserve: summarizeStage(values.reserve),
                  usage: summarizeStage(values.usage),
                },
              ])
            ),
            kiloPassPaths: kiloPassMeasurements
              ? Object.fromEntries(
                  Object.entries(kiloPassMeasurements).map(([path, values]) => [
                    path,
                    {
                      fullOperation: latency(values.fullMs),
                      reserve: summarizeStage(values.reserve),
                      usage: summarizeStage(values.usage),
                    },
                  ])
                )
              : null,
            pool: {
              observations,
              maxWaiters: maxPoolWaiters,
              samplesWithWaiters: poolSamplesWithWaiters,
            },
            locks: {
              observations,
              sparse: observations < 100,
              sampleIntervalMs: lockSampleMs,
              samplesWithLockWaiters,
              maxWaitingSessions,
              waitingSessionSamplesByEvent: lockEvents,
              samplingErrors,
            },
            serverActivity: { observations, groupedSessionSamplesByWaitEvent: serverWaitEvents },
            accounting: {
              usageRows: actual.usage_rows,
              postedCostMicrodollars: Number(actual.cost),
              heldMicrodollars: Number(actual.held),
              reservedRows: actual.unsettled,
              kiloPass: kiloPassAccounting ?? null,
            },
          });
        } finally {
          const cleanupScenario = async () => {
            assert(
              isolationVerified && userIds.every(id => id.startsWith(`${prefix}-`)),
              'Cleanup ownership not established'
            );
            const cleanup = await pool.connect();
            try {
              await cleanup.query('BEGIN');
              if (passTermId) {
                const agreementIds = payers.flatMap(payer =>
                  payer.kiloPass ? [payer.kiloPass.agreementId] : []
                );
                const snapshotIds = payers.flatMap(payer =>
                  payer.kiloPass ? [payer.kiloPass.snapshotId] : []
                );
                await cleanup.query(
                  'DELETE FROM kilo_pass_org_qualifying_spend_events WHERE issuance_snapshot_id = ANY($1::uuid[]) AND allocation_container_organization_id = ANY($2::uuid[])',
                  [snapshotIds, organizationIds]
                );
                await cleanup.query(
                  'DELETE FROM kilo_pass_org_audit_records WHERE agreement_id = ANY($1::uuid[])',
                  [agreementIds]
                );
                await cleanup.query(
                  'DELETE FROM kilo_pass_org_issuance_snapshots WHERE id = ANY($1::uuid[]) AND agreement_id = ANY($2::uuid[])',
                  [snapshotIds, agreementIds]
                );
                await cleanup.query(
                  'DELETE FROM kilo_pass_org_agreements WHERE id = ANY($1::uuid[]) AND parent_organization_id = ANY($2::uuid[])',
                  [agreementIds, organizationIds]
                );
                await cleanup.query(
                  'DELETE FROM credit_transactions WHERE organization_id = ANY($1::uuid[]) AND kilo_user_id = ANY($2::text[])',
                  [organizationIds, userIds]
                );
                await cleanup.query(
                  'DELETE FROM kilo_pass_org_term_versions WHERE id = $1 AND version_key = $2',
                  [passTermId, `${fixturePrefix}-kilo-pass`]
                );
                const remaining = await cleanup.query<{ clean: boolean }>(
                  `SELECT
                  NOT EXISTS (SELECT 1 FROM kilo_pass_org_term_versions WHERE id = $1)
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_agreements WHERE id = ANY($2::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_allocation_plans WHERE agreement_id = ANY($2::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_processing_runs WHERE agreement_id = ANY($2::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_audit_records WHERE agreement_id = ANY($2::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_issuance_snapshots WHERE id = ANY($3::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM kilo_pass_org_qualifying_spend_events WHERE issuance_snapshot_id = ANY($3::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM credit_transactions WHERE organization_id = ANY($4::uuid[])) AS clean`,
                  [passTermId, agreementIds, snapshotIds, organizationIds]
                );
                assert.equal(
                  remaining.rows[0]?.clean,
                  true,
                  'Owned KiloPass fixture cleanup incomplete'
                );
              }
              await cleanup.query(
                'DELETE FROM microdollar_usage_metadata WHERE id IN (SELECT id FROM microdollar_usage WHERE kilo_user_id = ANY($1::text[]))',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM inference_reservations WHERE kilo_user_id = ANY($1::text[])',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM microdollar_usage WHERE kilo_user_id = ANY($1::text[])',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM organization_user_usage WHERE kilo_user_id = ANY($1::text[])',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM organization_user_limits WHERE kilo_user_id = ANY($1::text[])',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM organization_memberships WHERE kilo_user_id = ANY($1::text[])',
                [userIds]
              );
              await cleanup.query(
                'DELETE FROM organizations WHERE id = ANY($1::uuid[]) AND name LIKE $2',
                [organizationIds, `${prefix}-%`]
              );
              await cleanup.query('DELETE FROM kilocode_users WHERE id = ANY($1::text[])', [
                userIds,
              ]);
              for (const table of metadataTables)
                await cleanup.query(`DELETE FROM ${table} WHERE ${table} = $1`, [fixturePrefix]);
              await cleanup.query('COMMIT');
            } catch (error) {
              await cleanup.query('ROLLBACK');
              throw error;
            } finally {
              cleanup.release();
            }
            cleanupComplete = true;
          };
          await cleanupScenario();
        }
      }
    }
    const prepared = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_prepared_statements WHERE name <> ''"
    );
    preparedNamedStatementsOnSampledConnection = prepared.rows[0]?.count ?? 0;
    assert.equal(blockedNetworkAttempts, 0, 'Application attempted non-database network traffic');
  } finally {
    await Promise.all([closeAllDrizzleConnections(), observer.pool.end()]);
    Socket.prototype.connect = originalSocketConnect;
    globalThis.fetch = originalFetch;
  }
  console.log(
    JSON.stringify({
      scope: 'isolated-actual-writer-and-public-reserve',
      caveat:
        'Warm local PostgreSQL only, no provider work or artificial RTT. Stage SQL/acquisition instrumentation and a dedicated observer add measurement overhead. Lock observations are sparse point samples, not lock wait durations. Tail estimates below 100/1000 samples are sparse. Repetitions are raw independent fixture runs, not production capacity estimates.',
      config: {
        clients,
        poolSize,
        operations,
        payerCount,
        membersPerOrganization,
        kiloPass: kiloPass ?? null,
        historyPerPayer: history,
        repetitions,
        lockSampleMs,
        modes,
        scopes,
        distributions,
        driverVersion,
        pipelineRequested,
        pipelineActive,
        preparedNamedStatementsOnSampledConnection,
        sourceDigest,
        reservationIndexes,
        serverSettings,
      },
      cleanupComplete,
      enforcementEnabled: false,
      blockedNetworkAttempts,
      results,
    })
  );
  if (results.some(result => result.completed !== operations || result.locks.samplingErrors > 0))
    process.exitCode = 1;
}

main().catch(error => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : 'unknown',
      message:
        error instanceof assert.AssertionError
          ? error.message
          : 'Benchmark failed; inspect synthetic environment, migration prerequisites, and owned fixture cleanup.',
    })
  );
  process.exitCode = 1;
});
