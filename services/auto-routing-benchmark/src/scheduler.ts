import { BENCHMARK_CONTAINER_BUDGET } from '@kilocode/auto-routing-contracts';
import * as z from 'zod';

const positiveLimit = z.number().int().min(1).max(BENCHMARK_CONTAINER_BUDGET);
const SchedulerConfigSchema = z.object({
  slots: positiveLimit.default(BENCHMARK_CONTAINER_BUDGET),
  modelConcurrency: positiveLimit.default(4),
  providerConcurrency: positiveLimit.default(16),
  unknownProviderConcurrency: positiveLimit.default(2),
  modelLimits: z.record(z.string(), positiveLimit).default({}),
  providerLimits: z.record(z.string(), positiveLimit).default({}),
  shares: z
    .object({
      'efficient/platform': positiveLimit.default(2),
      'frontier/platform': positiveLimit.default(2),
      'efficient/user': positiveLimit.default(1),
    })
    .default({ 'efficient/platform': 2, 'frontier/platform': 2, 'efficient/user': 1 }),
});

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
export function schedulerConfig(raw?: string): SchedulerConfig {
  return SchedulerConfigSchema.parse(raw ? JSON.parse(raw) : {});
}

export const SCHEDULER_ACTIVE_LEASE_MS = 20 * 60_000;
export const SCHEDULER_QUEUE_LEASE_MS = 30 * 60_000;
export const SCHEDULER_MAX_ATTEMPTS = 6;

export type SchedulerClaim = {
  id: string;
  run_id: string;
  model: string;
  variant: string;
  providers: string;
  rep: number;
  chunk: number;
  case_ids: string;
  slot: number;
  token: string;
  attempts: number;
};

export async function scheduleRunChunks(
  db: D1Database,
  run: {
    runId: string;
    entries: readonly { model: string; variant: string | null; providers: readonly string[] }[];
    repetitions: number;
    caseIds: readonly string[];
    chunkSize: number;
  }
): Promise<void> {
  const initialized = await db
    .prepare('SELECT run_id FROM scheduler_runs WHERE run_id = ?')
    .bind(run.runId)
    .first();
  if (initialized) return;
  let statements: D1PreparedStatement[] = [];
  for (const entry of run.entries) {
    for (let rep = 0; rep < run.repetitions; rep++) {
      for (let offset = 0; offset < run.caseIds.length; offset += run.chunkSize) {
        const chunk = offset / run.chunkSize;
        const variant = entry.variant ?? '';
        statements.push(
          db
            .prepare(`
          INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM benchmark_runs WHERE id = ? AND status = 'running')
          ON CONFLICT (id) DO NOTHING
        `)
            .bind(
              JSON.stringify([run.runId, entry.model, variant, rep, chunk]),
              run.runId,
              entry.model,
              variant,
              JSON.stringify([...new Set(entry.providers)].sort()),
              rep,
              chunk,
              JSON.stringify(run.caseIds.slice(offset, offset + run.chunkSize)),
              run.runId
            )
        );
        if (statements.length === 50) {
          await db.batch(statements);
          statements = [];
        }
      }
    }
  }
  statements.push(
    db
      .prepare(`
    UPDATE scheduler_chunks SET status = 'completed' WHERE run_id = ? AND status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(case_ids) AS expected WHERE NOT EXISTS (
          SELECT 1 FROM case_results WHERE run_id = scheduler_chunks.run_id
            AND model = scheduler_chunks.model AND variant = scheduler_chunks.variant
            AND rep = scheduler_chunks.rep AND case_id = expected.value
        )
      )
  `)
      .bind(run.runId)
  );
  statements.push(
    db
      .prepare('INSERT INTO scheduler_runs (run_id) VALUES (?) ON CONFLICT DO NOTHING')
      .bind(run.runId)
  );
  await db.batch(statements);
}
export async function claimNextChunk(
  db: D1Database,
  config: SchedulerConfig,
  now: number,
  token: string
): Promise<SchedulerClaim | null> {
  const result = await db
    .prepare(`
    WITH RECURSIVE slots(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM slots WHERE n + 1 < ?1
    ), live AS (
      SELECT chunk.*, run.router || '/' || run.purpose AS share
      FROM scheduler_chunks AS chunk JOIN benchmark_runs AS run ON run.id = chunk.run_id
      WHERE chunk.status IN ('queued', 'active')
    ), candidate AS (
      SELECT chunk.id FROM scheduler_chunks AS chunk
      JOIN benchmark_runs AS run ON run.id = chunk.run_id
      WHERE chunk.status = 'pending' AND chunk.available_at <= ?2 AND run.status = 'running'
        AND EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = run.id)
        AND NOT EXISTS (
          SELECT 1 FROM run_lane_failures AS failure
          WHERE failure.run_id = chunk.run_id AND failure.model = chunk.model
            AND failure.variant = chunk.variant AND failure.rep = chunk.rep
        )
        AND (SELECT COUNT(*) FROM live) < ?1
        AND (SELECT COUNT(*) FROM live WHERE model = chunk.model) < COALESCE(
          (SELECT value FROM json_each(?3) WHERE key = chunk.model), ?4)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_array_length(chunk.providers) = 0
            THEN '["unknown"]' ELSE chunk.providers END) AS provider
          WHERE (SELECT COUNT(*) FROM live WHERE EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_array_length(live.providers) = 0
              THEN '["unknown"]' ELSE live.providers END) AS active_provider
            WHERE active_provider.value = provider.value
          )) >= COALESCE((SELECT value FROM json_each(?5) WHERE key = provider.value),
            CASE WHEN provider.value = 'unknown' THEN ?6 ELSE ?7 END)
        )
      ORDER BY
        (SELECT COUNT(*) FROM live WHERE share = run.router || '/' || run.purpose) * 1.0 /
          COALESCE((SELECT value FROM json_each(?8) WHERE key = run.router || '/' || run.purpose), 1),
        (SELECT COUNT(*) FROM live WHERE model = chunk.model),
        run.started_at, chunk.chunk, chunk.rep, chunk.id
      LIMIT 1
    )
    UPDATE scheduler_chunks SET status = 'queued', token = ?9,
      slot = (SELECT n FROM slots WHERE NOT EXISTS (SELECT 1 FROM live WHERE slot = n) LIMIT 1),
      lease_until = ?10, attempts = attempts + 1
    WHERE id = (SELECT id FROM candidate) AND status = 'pending'
    RETURNING *
  `)
    .bind(
      config.slots,
      now,
      JSON.stringify(config.modelLimits),
      config.modelConcurrency,
      JSON.stringify(config.providerLimits),
      config.unknownProviderConcurrency,
      config.providerConcurrency,
      JSON.stringify(config.shares),
      token,
      now + SCHEDULER_QUEUE_LEASE_MS
    )
    .all<SchedulerClaim>();
  return result.results[0] ?? null;
}

export async function startChunk(
  db: D1Database,
  id: string,
  token: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(`
    UPDATE scheduler_chunks SET status = 'active', lease_until = ?
    WHERE id = ? AND token = ? AND status = 'queued' AND lease_until > ?
      AND EXISTS (SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status = 'running')
  `)
    .bind(now + SCHEDULER_ACTIVE_LEASE_MS, id, token, now)
    .run();
  return result.meta.changes > 0;
}

export async function getChunk(
  db: D1Database,
  id: string,
  token: string
): Promise<SchedulerClaim | null> {
  return db
    .prepare('SELECT * FROM scheduler_chunks WHERE id = ? AND token = ?')
    .bind(id, token)
    .first<SchedulerClaim>();
}

export async function finishChunk(db: D1Database, id: string, token: string): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET status = 'completed', slot = NULL, lease_until = 0
    WHERE id = ? AND token = ? AND status = 'active'`)
    .bind(id, token)
    .run();
}

export async function deferChunk(
  db: D1Database,
  id: string,
  token: string,
  availableAt: number,
  onlyQueued = false
): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
    available_at = ?, slot = NULL, token = NULL, lease_until = 0
    WHERE id = ? AND token = ? AND status IN ('queued', 'active') AND (? = 0 OR status = 'queued')`)
    .bind(SCHEDULER_MAX_ATTEMPTS, availableAt, id, token, onlyQueued ? 1 : 0)
    .run();
}

export async function failChunk(db: D1Database, id: string, token: string): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET status = 'failed', slot = NULL, lease_until = 0
    WHERE id = ? AND token = ? AND status IN ('queued', 'active')`)
    .bind(id, token)
    .run();
}

export async function recoverChunks(db: D1Database, now: number): Promise<SchedulerClaim[]> {
  const results = await db.batch<SchedulerClaim>([
    db.prepare(`UPDATE scheduler_chunks SET status = 'completed', slot = NULL, token = NULL, lease_until = 0
      WHERE status IN ('pending', 'queued') AND EXISTS (
        SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status != 'running')`),
    db
      .prepare(`UPDATE scheduler_chunks SET status = CASE WHEN EXISTS (
        SELECT 1 FROM run_lane_failures WHERE run_id = scheduler_chunks.run_id
          AND model = scheduler_chunks.model AND variant = scheduler_chunks.variant AND rep = scheduler_chunks.rep
      ) THEN 'failed' WHEN EXISTS (
        SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status != 'running'
      ) THEN 'completed' WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
      slot = NULL, token = NULL, lease_until = 0
      WHERE status IN ('queued', 'active') AND lease_until <= ?`)
      .bind(SCHEDULER_MAX_ATTEMPTS, now),
    db.prepare(`SELECT * FROM scheduler_chunks WHERE status = 'failed' AND EXISTS (
      SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status = 'running')
      AND NOT EXISTS (SELECT 1 FROM run_lane_failures WHERE run_id = scheduler_chunks.run_id
        AND model = scheduler_chunks.model AND variant = scheduler_chunks.variant AND rep = scheduler_chunks.rep)
      LIMIT 250`),
    db
      .prepare(`DELETE FROM scheduler_executions WHERE rowid IN (
      SELECT execution.rowid FROM scheduler_executions AS execution
      JOIN benchmark_runs AS run ON run.id = execution.run_id
      WHERE run.status != 'running' AND run.completed_at < ?
        AND NOT EXISTS (SELECT 1 FROM scheduler_chunks WHERE run_id = run.id AND status = 'active')
      LIMIT 1000
    )`)
      .bind(new Date(now - 24 * 3600_000).toISOString()),
    db
      .prepare(`DELETE FROM scheduler_chunks WHERE id IN (
      SELECT chunk.id FROM scheduler_chunks AS chunk JOIN benchmark_runs AS run ON run.id = chunk.run_id
      WHERE run.status != 'running' AND run.completed_at < ? AND chunk.status IN ('completed', 'failed')
      LIMIT 1000
    )`)
      .bind(new Date(now - 24 * 3600_000).toISOString()),
    db
      .prepare(`DELETE FROM scheduler_runs WHERE run_id IN (
      SELECT run.id FROM benchmark_runs AS run WHERE run.status != 'running' AND run.completed_at < ?
        AND NOT EXISTS (SELECT 1 FROM scheduler_chunks WHERE run_id = run.id)
        AND NOT EXISTS (SELECT 1 FROM scheduler_executions WHERE run_id = run.id)
      LIMIT 1000
    )`)
      .bind(new Date(now - 24 * 3600_000).toISOString()),
  ]);
  return results[2]?.results ?? [];
}

export async function beginPaidCase(
  db: D1Database,
  key: {
    runId: string;
    model: string;
    variant: string;
    rep: number;
    caseId: string;
    token: string;
  },
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(`
    INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM scheduler_chunks WHERE run_id = ? AND model = ? AND variant = ? AND rep = ?
        AND token = ? AND status = 'active' AND lease_until > ?
        AND EXISTS (SELECT 1 FROM json_each(case_ids) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status = 'running')
    ) ON CONFLICT DO NOTHING
  `)
    .bind(
      key.runId,
      key.model,
      key.variant,
      key.rep,
      key.caseId,
      key.token,
      key.runId,
      key.model,
      key.variant,
      key.rep,
      key.token,
      now,
      key.caseId
    )
    .run();
  return result.meta.changes > 0;
}

export function schedulerBackoffSeconds(attempts: number): number {
  return Math.min(300, 15 * 2 ** Math.min(attempts - 1, 5));
}

export async function clearUnbilledCase(
  db: D1Database,
  key: { runId: string; model: string; variant: string; rep: number; caseId: string; token: string }
): Promise<void> {
  await db
    .prepare(`DELETE FROM scheduler_executions
    WHERE run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ? AND token = ?`)
    .bind(key.runId, key.model, key.variant, key.rep, key.caseId, key.token)
    .run();
}

export async function cooldownProviders(
  db: D1Database,
  claim: SchedulerClaim,
  until: number
): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET available_at = MAX(available_at, ?)
    WHERE status = 'pending' AND (model = ? OR EXISTS (
      SELECT 1 FROM json_each(providers) AS provider
      JOIN json_each(?) AS throttled ON provider.value = throttled.value
    ))`)
    .bind(until, claim.model, claim.providers)
    .run();
}
