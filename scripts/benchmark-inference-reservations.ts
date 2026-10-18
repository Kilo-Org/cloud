import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  lockInferenceReservationForSettlement,
  reserveInferenceCredits,
  settleInferenceCredits,
} from '@kilocode/db/inference-reservations';
import {
  inference_reservations,
  kilocode_users,
  microdollar_usage,
  organizations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
} from '@kilocode/db/schema';

const help = `Isolated PostgreSQL component benchmark; no external provider calls.
Prerequisites: Node 24, pnpm install, a disposable local PostgreSQL database named
inference_reservation_bench_<suffix>, with all repository migrations applied.
Run from the repository root (never load a real .env file):
BENCHMARK_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/inference_reservation_bench_local pnpm exec tsx scripts/benchmark-inference-reservations.ts
Optional: BENCH_CLIENTS=16 BENCH_POOL_SIZE=8 BENCH_OPERATIONS=1000 BENCH_PAYERS=32 BENCH_HISTORY=1000
History is per payer, per scenario. Eight scenarios compare personal/org and
distributed/same-payer workloads, each with and without holds. The baseline uses
an unlocked available-balance read, then identical usage insertion/payer debit;
it is NOT an alternative concurrency-safe admission design.
Latency includes pool acquisition and transaction commit; failed stage latency
is included. Lock waits and pool waiting are point samples, NOT wait durations.
This is NOT proof of production CPU/storage headroom or actual SFO-FRA RTT.
Only this invocation's uniquely prefixed fake users and associated rows are deleted.
Normal failures clean up; a killed process can leave its uniquely named fixtures.`;

function integer(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0 && value <= maximum, `Invalid ${name}`);
  return value;
}

function databaseUrl(): string {
  assert(
    !process.env.USE_PRODUCTION_DB || process.env.USE_PRODUCTION_DB === 'false',
    'Refusing USE_PRODUCTION_DB'
  );
  assert(
    process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV,
    'Refusing deployed environment'
  );
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
    !url.search && !url.hash && url.port,
    'Explicit port, no query options or fragment required'
  );
  return raw;
}

function latency(values: number[]) {
  values.sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    values.length
      ? Number((values[Math.ceil(values.length * fraction) - 1] ?? 0).toFixed(3))
      : null;
  return {
    samples: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(help);
    return;
  }
  const connectionString = databaseUrl();
  const clients = integer('BENCH_CLIENTS', 16, 128);
  const poolSize = integer('BENCH_POOL_SIZE', 8, 64);
  const operations = integer('BENCH_OPERATIONS', 1000, 100000);
  const payerCount = integer('BENCH_PAYERS', 32, 256);
  const history = integer('BENCH_HISTORY', 1000, 100000);
  const prefix = `inference-reservation-bench-${randomUUID()}`;
  const { db, pool } = createDrizzleClient({
    connectionString,
    ssl: false,
    poolConfig: {
      max: poolSize,
      application_name: prefix,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      lock_timeout: 3000,
    },
  });
  const observer = createDrizzleClient({
    connectionString,
    ssl: false,
    poolConfig: {
      max: 1,
      application_name: `${prefix}-observer`,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    },
  });
  const ownedUsers: string[] = [];
  const ownedOrgs: string[] = [];
  const results = [];
  let cleanupComplete = false;
  try {
    const identity = await pool.query<{ address: string; database: string }>(
      'SELECT inet_server_addr()::text AS address, current_database() AS database'
    );
    assert.match(
      identity.rows[0]?.address ?? '',
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
      'Refusing public PostgreSQL server address'
    );
    assert.equal(identity.rows[0]?.database, new URL(connectionString).pathname.slice(1));
    const isolation = await pool.query<{ safe: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM kilocode_users WHERE id NOT LIKE 'inference-reservation-bench-%' AND id NOT LIKE 'inference-reservation-smoke-%') AND NOT EXISTS (SELECT 1 FROM organizations WHERE name NOT LIKE 'inference-reservation-bench-%') AS safe"
    );
    assert.equal(isolation.rows[0]?.safe, true, 'Database contains non-benchmark accounts');
    for (const organization of [false, true]) {
      for (const hot of [false, true]) {
        for (const holds of [false, true]) {
          const scenario = `${organization ? 'organization' : 'personal'}-${hot ? 'same-payer' : 'distributed'}-${holds ? 'holds' : 'baseline'}`;
          const payers = Array.from({ length: hot ? 1 : payerCount }, (_, index) => ({
            userId: `${prefix}-${scenario}-${index}`,
            organizationId: organization ? randomUUID() : undefined,
          }));
          for (const payer of payers) {
            ownedUsers.push(payer.userId);
            await db.insert(kilocode_users).values({
              id: payer.userId,
              google_user_email: `${payer.userId}@example.invalid`,
              google_user_name: prefix,
              google_user_image_url: '',
              stripe_customer_id: payer.userId,
              total_microdollars_acquired: 1_000_000_000,
              microdollars_used: history,
              inference_microdollars_held: organization ? 0 : Math.ceil(history / 20),
            });
            if (payer.organizationId) {
              ownedOrgs.push(payer.organizationId);
              await db.insert(organizations).values({
                id: payer.organizationId,
                name: payer.userId,
                require_seats: false,
                total_microdollars_acquired: 1_000_000_000,
                microdollars_used: history,
                inference_microdollars_held: Math.ceil(history / 20),
              });
              await db.insert(organization_memberships).values({
                organization_id: payer.organizationId,
                kilo_user_id: payer.userId,
                role: 'owner',
              });
              await db.insert(organization_user_limits).values({
                organization_id: payer.organizationId,
                kilo_user_id: payer.userId,
                limit_type: 'daily',
                microdollar_limit: 1_000_000_000,
              });
              await db.insert(organization_user_usage).values({
                organization_id: payer.organizationId,
                kilo_user_id: payer.userId,
                limit_type: 'daily',
                usage_date: sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
                microdollar_usage: history,
              });
            }
            for (let start = 0; start < history; start += 500) {
              const rows = Array.from({ length: Math.min(500, history - start) }, (_, offset) => {
                const index = start + offset;
                return {
                  id: randomUUID(),
                  index,
                  created: new Date(Date.now() - (index % 30) * 86400000).toISOString(),
                };
              });
              await db.insert(microdollar_usage).values(
                rows.map(row => ({
                  id: row.id,
                  kilo_user_id: payer.userId,
                  organization_id: payer.organizationId,
                  cost: 1,
                  input_tokens: 10,
                  output_tokens: 10,
                  cache_write_tokens: 0,
                  cache_hit_tokens: 0,
                  created_at: row.created,
                  provider: prefix,
                  model: 'synthetic-component-benchmark',
                }))
              );
              await db.insert(inference_reservations).values(
                rows.map(row => ({
                  request_id: row.id,
                  kilo_user_id: payer.userId,
                  organization_id: payer.organizationId,
                  amount_microdollars: 1,
                  created_at: row.created,
                  ...(row.index % 20 === 0
                    ? { status: 'reserved' as const }
                    : {
                        status: 'settled' as const,
                        actual_cost_microdollars: 1,
                        finalized_at: row.created,
                      }),
                }))
              );
            }
          }
          const requests = Array.from({ length: operations }, (_, index) => {
            const payer = payers[index % payers.length];
            assert(payer);
            return { requestId: randomUUID(), ...payer };
          });
          const admission: number[] = [];
          const settlement: number[] = [];
          const fullOperation: number[] = [];
          const errors: Record<string, number> = {};
          let next = 0;
          let completed = 0;
          let poolWaitingMax = 0;
          let poolWaitingSamples = 0;
          let lockWaitSamples = 0;
          let lockWaitMax = 0;
          let observations = 0;
          const started = performance.now();
          const workers = await Promise.allSettled(
            Array.from({ length: clients }, async () => {
              for (;;) {
                const index = next++;
                const request = requests[index];
                if (!request) break;
                const operationStarted = performance.now();
                let stage: 'admission' | 'settlement' = 'admission';
                let stageStarted = operationStarted;
                poolWaitingMax = Math.max(poolWaitingMax, pool.waitingCount);
                if (pool.waitingCount > 0) poolWaitingSamples++;
                try {
                  if (holds) {
                    const result = await reserveInferenceCredits(db, {
                      ...request,
                      amountMicrodollars: 100,
                    });
                    assert.equal(result.kind, 'reserved');
                  } else {
                    const payerTable = organization ? organizations : kilocode_users;
                    const [balance] = await db
                      .select({
                        available: sql<number>`${payerTable.total_microdollars_acquired} - ${payerTable.microdollars_used} - ${payerTable.inference_microdollars_held}`,
                      })
                      .from(payerTable)
                      .where(eq(payerTable.id, request.organizationId ?? request.userId));
                    assert(balance && Number(balance.available) >= 100);
                  }
                  admission.push(performance.now() - stageStarted);
                  stage = 'settlement';
                  stageStarted = performance.now();
                  await db.transaction(async tx => {
                    const prepared = holds ? { ...request, actualCostMicrodollars: 75 } : undefined;
                    if (prepared) await lockInferenceReservationForSettlement(tx, prepared);
                    await tx.insert(microdollar_usage).values({
                      id: request.requestId,
                      kilo_user_id: request.userId,
                      organization_id: request.organizationId,
                      cost: 75,
                      input_tokens: 10,
                      output_tokens: 10,
                      cache_write_tokens: 0,
                      cache_hit_tokens: 0,
                      provider: prefix,
                      model: 'synthetic-component-benchmark',
                    });
                    if (request.organizationId) {
                      await tx
                        .update(organization_user_usage)
                        .set({
                          microdollar_usage: sql`${organization_user_usage.microdollar_usage} + 75`,
                        })
                        .where(
                          and(
                            eq(organization_user_usage.organization_id, request.organizationId),
                            eq(organization_user_usage.kilo_user_id, request.userId),
                            eq(organization_user_usage.limit_type, 'daily'),
                            sql`${organization_user_usage.usage_date} = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`
                          )
                        );
                      await tx
                        .update(organizations)
                        .set({
                          microdollars_used: sql`${organizations.microdollars_used} + 75`,
                          microdollars_balance: sql`${organizations.microdollars_balance} - 75`,
                        })
                        .where(eq(organizations.id, request.organizationId));
                    } else {
                      await tx
                        .update(kilocode_users)
                        .set({ microdollars_used: sql`${kilocode_users.microdollars_used} + 75` })
                        .where(eq(kilocode_users.id, request.userId));
                    }
                    if (prepared) await settleInferenceCredits(tx, prepared);
                  });
                  settlement.push(performance.now() - stageStarted);
                  completed++;
                } catch (error) {
                  (stage === 'admission' ? admission : settlement).push(
                    performance.now() - stageStarted
                  );
                  const code =
                    error instanceof Error && 'code' in error
                      ? String(error.code)
                      : error instanceof Error
                        ? error.name
                        : 'unknown';
                  const key = `${stage}:${code}`;
                  errors[key] = (errors[key] ?? 0) + 1;
                } finally {
                  fullOperation.push(performance.now() - operationStarted);
                }
                if (index % 50 === 0) {
                  const sample = await observer.pool.query<{ locks: number }>(
                    "SELECT count(*)::int AS locks FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
                    [prefix]
                  );
                  const count = sample.rows[0]?.locks ?? 0;
                  observations++;
                  if (count > 0) lockWaitSamples++;
                  lockWaitMax = Math.max(lockWaitMax, count);
                }
              }
            })
          );
          const failedWorker = workers.find(worker => worker.status === 'rejected');
          if (failedWorker?.status === 'rejected') throw failedWorker.reason;
          const elapsedSeconds = (performance.now() - started) / 1000;
          results.push({
            scenario,
            attempted: operations,
            completed,
            errors,
            elapsedSeconds,
            completedOperationsPerSecond: completed / elapsedSeconds,
            admission: latency(admission),
            settlement: latency(settlement),
            fullOperation: latency(fullOperation),
            pool: {
              waitingMax: poolWaitingMax,
              operationStartSamplesWithWaiters: poolWaitingSamples,
            },
            locks: {
              observations,
              samplesWithLockWaiters: lockWaitSamples,
              maxWaitingSessions: lockWaitMax,
            },
          });
        }
      }
    }
  } finally {
    try {
      for (let start = 0; start < ownedUsers.length; start += 100) {
        const ids = ownedUsers.slice(start, start + 100);
        assert(ids.every(id => id.startsWith(`${prefix}-`)));
        await db.transaction(async tx => {
          await tx
            .delete(inference_reservations)
            .where(inArray(inference_reservations.kilo_user_id, ids));
          await tx.delete(microdollar_usage).where(inArray(microdollar_usage.kilo_user_id, ids));
          await tx
            .delete(organization_user_usage)
            .where(inArray(organization_user_usage.kilo_user_id, ids));
          await tx
            .delete(organization_user_limits)
            .where(inArray(organization_user_limits.kilo_user_id, ids));
          await tx
            .delete(organization_memberships)
            .where(inArray(organization_memberships.kilo_user_id, ids));
          await tx.delete(kilocode_users).where(inArray(kilocode_users.id, ids));
        });
      }
      for (const id of ownedOrgs)
        await db
          .delete(organizations)
          .where(and(eq(organizations.id, id), sql`${organizations.name} LIKE ${`${prefix}-%`}`));
      cleanupComplete = true;
    } finally {
      await Promise.all([pool.end(), observer.pool.end()]);
    }
  }
  console.log(
    JSON.stringify({
      scope: 'isolated-component-only',
      caveat:
        'Not production CPU/storage headroom or actual SFO-FRA RTT. Sequential cold fixture scenarios; no synthetic network delay. Observation queries add bounded measurement load.',
      config: { clients, poolSize, operations, payerCount, historyPerPayer: history },
      cleanupComplete,
      results,
    })
  );
  if (results.some(result => result.completed !== operations)) process.exitCode = 1;
}

main().catch(error => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : 'unknown',
      message:
        'Benchmark failed; inspect local database prerequisites and isolated fixture cleanup.',
    })
  );
  process.exitCode = 1;
});
