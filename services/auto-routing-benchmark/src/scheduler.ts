import {
  BENCHMARK_CONTAINER_BUDGET,
  BenchmarkSchedulerLimitSchema,
  type BenchmarkSchedulerConfigResponse,
  type BenchmarkSchedulerOverrides,
  type BenchmarkSchedulerSetting,
  type BenchmarkSchedulerSettingKey,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { PROMPT_TRANSPORT_REVISION } from './prompt-transport';

export type PaidExecutionKey = {
  runId: string;
  model: string;
  variant: string;
  rep: number;
  caseId: string;
  token: string;
  attemptStartedAt?: number;
};

const positiveLimit = BenchmarkSchedulerLimitSchema;
const SchedulerConfigSchema = z.object({
  slots: positiveLimit.default(BENCHMARK_CONTAINER_BUDGET),
  modelConcurrency: positiveLimit.default(12),
  modelLimits: z.record(z.string(), positiveLimit).default({}),
  shares: z
    .object({
      'efficient/platform': positiveLimit.default(2),
      'frontier/platform': positiveLimit.default(2),
      'efficient/user': positiveLimit.default(1),
      'frontier/user': positiveLimit.default(1),
    })
    .default({
      'efficient/platform': 2,
      'frontier/platform': 2,
      'efficient/user': 1,
      'frontier/user': 1,
    }),
});

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
export function schedulerConfig(raw?: string): SchedulerConfig {
  return SchedulerConfigSchema.parse(raw ? JSON.parse(raw) : {});
}

type ResolvedSchedulerConfig = {
  config: SchedulerConfig;
  settings: BenchmarkSchedulerConfigResponse['settings'];
};

/** Each overridable limit resolves admin override, then `BENCHMARK_SCHEDULER_CONFIG`, then default. */
export function resolveSchedulerConfig(
  envConfig: string | undefined,
  overrides: BenchmarkSchedulerOverrides
): ResolvedSchedulerConfig {
  const env = z.record(z.string(), z.unknown()).parse(envConfig ? JSON.parse(envConfig) : {});
  const fallback = SchedulerConfigSchema.parse(env);
  const setting = (key: BenchmarkSchedulerSettingKey): BenchmarkSchedulerSetting => {
    const override = overrides[key];
    return {
      effective: override ?? fallback[key],
      source: override !== null ? 'admin' : key in env ? 'env' : 'default',
      override,
      fallback: fallback[key],
    };
  };
  const settings = {
    slots: setting('slots'),
    modelConcurrency: setting('modelConcurrency'),
  };
  return {
    config: {
      ...fallback,
      slots: settings.slots.effective,
      modelConcurrency: settings.modelConcurrency.effective,
    },
    settings,
  };
}

type StoredSchedulerOverrides = {
  overrides: BenchmarkSchedulerOverrides;
  updatedAt: string | null;
  updatedBy: string | null;
};

type SchedulerSettingsRow = {
  slots: unknown;
  model_concurrency: unknown;
  updated_at: string;
  updated_by: string | null;
};

// A stored limit above a since-lowered container budget is ignored, not enforced.
function storedLimit(value: unknown): number | null {
  const parsed = BenchmarkSchedulerLimitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getSchedulerOverrides(db: D1Database): Promise<StoredSchedulerOverrides> {
  const row = await db
    .prepare(`
    SELECT slots, model_concurrency, updated_at, updated_by
    FROM scheduler_settings WHERE id = 1
  `)
    .first<SchedulerSettingsRow>();
  return {
    overrides: {
      slots: storedLimit(row?.slots),
      modelConcurrency: storedLimit(row?.model_concurrency),
    },
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

export async function saveSchedulerOverrides(
  db: D1Database,
  overrides: BenchmarkSchedulerOverrides,
  updatedBy: string | null
): Promise<StoredSchedulerOverrides> {
  const updatedAt = new Date().toISOString();
  await db
    .prepare(`
    INSERT INTO scheduler_settings (id, slots, model_concurrency, updated_at, updated_by)
    VALUES (1, ?1, ?2, ?3, ?4)
    ON CONFLICT (id) DO UPDATE SET slots = ?1, model_concurrency = ?2, updated_at = ?3,
      updated_by = ?4
  `)
    .bind(overrides.slots, overrides.modelConcurrency, updatedAt, updatedBy)
    .run();
  return { overrides, updatedAt, updatedBy };
}

export const SCHEDULER_ACTIVE_LEASE_MS = 20 * 60_000;
export const SCHEDULER_QUEUE_LEASE_MS = 30 * 60_000;
export const SCHEDULER_MAX_ATTEMPTS = 6;
/**
 * A provider throttle is not a chunk failure, so it refunds the claim's attempt and
 * counts here instead. With 15–300 second backoff, the budget gives a throttled chunk
 * about an hour before it falls back to ordinary attempts and can fail its lane.
 */
export const SCHEDULER_MAX_THROTTLE_DEFERRALS = 16;
export const SCHEDULER_DISPATCH_LEASE_MS = 20_000;
export const SCHEDULER_INIT_BUDGET_MS = 20_000;
export const SCHEDULER_INIT_LEASE_MS = 2 * 60_000;
const SCHEDULER_DISPATCH_ROUNDS = 8;
const SCHEDULER_DISPATCH_ROUND_LIMIT = 64;
const SCHEDULER_CLAIM_BATCH = 50;
const SCHEDULER_MATERIALIZE_BATCH = 50;
const DISPATCH_LEASE_ID = 1;
const INIT_LEASE_ID = 2;

export type SchedulerClaim = {
  id: string;
  run_id: string;
  model: string;
  variant: string;
  rep: number;
  chunk: number;
  case_ids: string;
  slot: number;
  token: string;
  attempts: number;
  throttle_deferrals: number;
};

type SchedulerLaneHead = {
  run_id: string;
  model: string;
  variant: string;
  rep: number;
  chunk: number;
  id: string;
  available_at: number;
  share: string;
  started_at: string;
};

type SchedulerLiveChunk = {
  model: string;
  slot: number | null;
  share: string;
};

export async function hasScheduledChunks(db: D1Database, runId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM scheduler_chunks WHERE run_id = ? LIMIT 1')
    .bind(runId)
    .first();
  return row !== null;
}

/** Rows each lane of a run already holds; exported for the query-plan regression test. */
export const SCHEDULER_MATERIALIZED_LANES_SQL = `
  SELECT model, variant, rep, COUNT(*) AS written, MAX(chunk) AS last
  FROM scheduler_chunks WHERE run_id = ? GROUP BY model, variant, rep
`;

/**
 * Inserts one chunk, already completed when every one of its cases has a result, so
 * a run never re-measures carried-over cases. Each case is a `case_results` primary
 * key probe, so the cost is bounded by the chunk rather than the run or its results.
 */
export const SCHEDULER_INSERT_CHUNK_SQL = `
  INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
  VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6, ?7, CASE WHEN EXISTS (
    SELECT 1 FROM json_each(?7) AS expected WHERE NOT EXISTS (
      SELECT 1 FROM case_results WHERE run_id = ?2 AND model = ?3 AND variant = ?4
        AND rep = ?5 AND case_id = expected.value
    )
  ) THEN 'pending' ELSE 'completed' END)
  ON CONFLICT (id) DO NOTHING
`;

/**
 * Materializes a run's chunks for at most {@link SCHEDULER_INIT_BUDGET_MS} and reports
 * whether the run is initialized. Every batch commits on its own, so a later pass
 * resumes after each lane's written prefix instead of rewriting the run. The
 * `scheduler_runs` marker commits with the last batch, once every chunk exists.
 */
export async function scheduleRunChunks(
  db: D1Database,
  run: {
    runId: string;
    entries: readonly { model: string; variant: string | null }[];
    repetitions: number;
    caseIds: readonly string[];
    chunkSize: number;
  }
): Promise<boolean> {
  const deadline = Date.now() + SCHEDULER_INIT_BUDGET_MS;
  const initialized = await db
    .prepare('SELECT run_id FROM scheduler_runs WHERE run_id = ?')
    .bind(run.runId)
    .first();
  if (initialized) return true;
  const lanes = await db
    .prepare(SCHEDULER_MATERIALIZED_LANES_SQL)
    .bind(run.runId)
    .all<{ model: string; variant: string; rep: number; written: number; last: number }>();
  // Batches commit in chunk order, so a lane's rows are the prefix 0..written-1;
  // a lane of any other shape is rewritten from its first chunk.
  const resumeAt = new Map(
    lanes.results.map(lane => [
      JSON.stringify([lane.model, lane.variant, lane.rep]),
      lane.written === lane.last + 1 ? lane.written : 0,
    ])
  );
  const statements: D1PreparedStatement[] = [];
  const writeBatch = async (final: boolean): Promise<boolean> => {
    const status = await db
      .prepare('SELECT status FROM benchmark_runs WHERE id = ?')
      .bind(run.runId)
      .first<{ status: string }>();
    if (status?.status !== 'running') return false;
    await db.batch([
      ...statements,
      ...(final
        ? [
            db
              .prepare('INSERT INTO scheduler_runs (run_id) VALUES (?) ON CONFLICT DO NOTHING')
              .bind(run.runId),
          ]
        : []),
    ]);
    statements.length = 0;
    return true;
  };
  const chunks = Math.ceil(run.caseIds.length / run.chunkSize);
  for (const entry of run.entries) {
    const variant = entry.variant ?? '';
    for (let rep = 0; rep < run.repetitions; rep++) {
      const start = resumeAt.get(JSON.stringify([entry.model, variant, rep])) ?? 0;
      for (let chunk = start; chunk < chunks; chunk++) {
        const offset = chunk * run.chunkSize;
        statements.push(
          db
            .prepare(SCHEDULER_INSERT_CHUNK_SQL)
            .bind(
              JSON.stringify([run.runId, entry.model, variant, rep, chunk]),
              run.runId,
              entry.model,
              variant,
              rep,
              chunk,
              JSON.stringify(run.caseIds.slice(offset, offset + run.chunkSize))
            )
        );
        if (statements.length < SCHEDULER_MATERIALIZE_BATCH) continue;
        if (!(await writeBatch(false)) || Date.now() >= deadline) return false;
      }
    }
  }
  return writeBatch(true);
}

/** Live reservations read by one dispatch pass; bounded by the slot budget. */
export const SCHEDULER_LIVE_SQL = `
  SELECT chunk.model, chunk.slot, run.router || '/' || run.purpose AS share
  FROM scheduler_chunks AS chunk JOIN benchmark_runs AS run ON run.id = chunk.run_id
  WHERE chunk.status IN ('queued', 'active')
`;

/**
 * One row per lane's next runnable chunk. A lane is a (run, model, variant, rep)
 * chunk chain; a lane's head is its earliest `(available_at, chunk)`, so a chunk
 * waiting out a deferral does not hold back the rest of its lane. Candidate rows
 * are the lanes of running, initialized runs whose lane has not dead-lettered.
 *
 * The walk seeks each lane through `IX_scheduler_chunks_lane` instead of ordering
 * all candidates: `c3` continues in the same lane, and `c2`/`c1`/`c0` are the next
 * lane of the same run at increasing scope. Those branches are disjoint and
 * already in index order, so the first non-null one is the next lane. Cost is one
 * seek per lane, independent of the backlog size.
 */
export const SCHEDULER_LANE_HEADS_SQL = `
  WITH RECURSIVE lane(run_id, model, variant, rep, chunk, id, available_at) AS (
    SELECT * FROM (
      SELECT c.run_id, c.model, c.variant, c.rep, c.chunk, c.id, c.available_at
      FROM scheduler_chunks AS c
      WHERE c.status = 'pending'
      ORDER BY c.run_id, c.model, c.variant, c.rep, c.available_at, c.chunk
      LIMIT 1
    )
    UNION ALL
    SELECT c.run_id, c.model, c.variant, c.rep, c.chunk, c.id, c.available_at
    FROM lane JOIN scheduler_chunks AS c ON c.rowid = COALESCE(
      (SELECT c3.rowid FROM scheduler_chunks AS c3
        WHERE c3.status = 'pending' AND c3.run_id = lane.run_id AND c3.model = lane.model
          AND c3.variant = lane.variant AND c3.rep > lane.rep
        ORDER BY c3.rep, c3.available_at, c3.chunk LIMIT 1),
      (SELECT c2.rowid FROM scheduler_chunks AS c2
        WHERE c2.status = 'pending' AND c2.run_id = lane.run_id AND c2.model = lane.model
          AND c2.variant > lane.variant
        ORDER BY c2.variant, c2.rep, c2.available_at, c2.chunk LIMIT 1),
      (SELECT c1.rowid FROM scheduler_chunks AS c1
        WHERE c1.status = 'pending' AND c1.run_id = lane.run_id AND c1.model > lane.model
        ORDER BY c1.model, c1.variant, c1.rep, c1.available_at, c1.chunk LIMIT 1),
      (SELECT c0.rowid FROM scheduler_chunks AS c0
        WHERE c0.status = 'pending' AND c0.run_id > lane.run_id
        ORDER BY c0.run_id, c0.model, c0.variant, c0.rep, c0.available_at, c0.chunk LIMIT 1))
  )
  SELECT lane.run_id, lane.model, lane.variant, lane.rep, lane.chunk, lane.id, lane.available_at,
    run.router || '/' || run.purpose AS share, run.started_at
  FROM lane JOIN benchmark_runs AS run ON run.id = lane.run_id
  WHERE run.status = 'running'
    AND EXISTS (SELECT 1 FROM scheduler_runs WHERE scheduler_runs.run_id = run.id)
    AND NOT EXISTS (
      SELECT 1 FROM run_lane_failures AS failure
      WHERE failure.run_id = lane.run_id AND failure.model = lane.model
        AND failure.variant = lane.variant AND failure.rep = lane.rep
    )
`;

/**
 * Picks the highest-priority chunks that fit the free slots. Ordering mirrors the
 * pre-lane scheduler: least-served share first (weighted, so an idle lane's share
 * is borrowed), then the least-used model, then run start, chunk, repetition and
 * chunk id. Only slots and the per-model cap bound a claim: the gateway sends each
 * request to one upstream its aggregator picks, so the catalog's provider list
 * says nothing about which provider a chunk will load.
 */
function selectScheduledChunks(input: {
  config: SchedulerConfig;
  live: readonly SchedulerLiveChunk[];
  heads: readonly SchedulerLaneHead[];
  coolModels: ReadonlySet<string>;
  free: number;
  now: number;
}): { head: SchedulerLaneHead; slot: number }[] {
  const shareCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  const usedSlots = new Set<number>();
  const tally = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const chunk of input.live) {
    tally(shareCounts, chunk.share);
    tally(modelCounts, chunk.model);
    if (chunk.slot !== null) usedSlots.add(chunk.slot);
  }
  const modelLimits: Readonly<Record<string, number>> = input.config.modelLimits;
  const shareWeights: Readonly<Record<string, number>> = input.config.shares;
  const remaining = input.heads.filter(
    head => head.available_at <= input.now && !input.coolModels.has(head.model)
  );
  const better = (candidate: SchedulerLaneHead, best: SchedulerLaneHead) => {
    const shareDelta =
      (shareCounts.get(candidate.share) ?? 0) * (shareWeights[best.share] ?? 1) -
      (shareCounts.get(best.share) ?? 0) * (shareWeights[candidate.share] ?? 1);
    if (shareDelta !== 0) return shareDelta < 0;
    const modelDelta = (modelCounts.get(candidate.model) ?? 0) - (modelCounts.get(best.model) ?? 0);
    if (modelDelta !== 0) return modelDelta < 0;
    if (candidate.started_at !== best.started_at) return candidate.started_at < best.started_at;
    if (candidate.chunk !== best.chunk) return candidate.chunk < best.chunk;
    if (candidate.rep !== best.rep) return candidate.rep < best.rep;
    return candidate.id < best.id;
  };
  const selected: { head: SchedulerLaneHead; slot: number }[] = [];
  while (selected.length < input.free) {
    let best: SchedulerLaneHead | null = null;
    for (const candidate of remaining) {
      const atModelCap =
        (modelCounts.get(candidate.model) ?? 0) >=
        (modelLimits[candidate.model] ?? input.config.modelConcurrency);
      if (!atModelCap && (best === null || better(candidate, best))) best = candidate;
    }
    if (best === null) break;
    remaining.splice(remaining.indexOf(best), 1);
    let slot = 0;
    while (usedSlots.has(slot)) slot++;
    usedSlots.add(slot);
    tally(shareCounts, best.share);
    tally(modelCounts, best.model);
    selected.push({ head: best, slot });
  }
  return selected;
}

/** Takes a scheduler lease row, or reports that another pass holds it. */
async function acquireLease(
  db: D1Database,
  id: number,
  token: string,
  until: number,
  now: number
): Promise<boolean> {
  const acquired = await db
    .prepare(`
    INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (?1, ?2, ?3)
    ON CONFLICT (id) DO UPDATE SET token = ?2, lease_until = ?3
    WHERE scheduler_dispatch_lock.lease_until <= ?4
    RETURNING token
  `)
    .bind(id, token, until, now)
    .first<{ token: string }>();
  return acquired !== null;
}

async function releaseLease(db: D1Database, id: number, token: string): Promise<void> {
  await db
    .prepare(
      'UPDATE scheduler_dispatch_lock SET token = NULL, lease_until = 0 WHERE id = ? AND token = ?'
    )
    .bind(id, token)
    .run();
}

/**
 * One initialization pass at a time: every dispatcher would otherwise materialize the
 * same uninitialized run concurrently and contend with claims for the database.
 */
export function acquireInitializationLease(
  db: D1Database,
  token: string,
  now: number
): Promise<boolean> {
  return acquireLease(db, INIT_LEASE_ID, token, now + SCHEDULER_INIT_LEASE_MS, now);
}

export function releaseInitializationLease(db: D1Database, token: string): Promise<void> {
  return releaseLease(db, INIT_LEASE_ID, token);
}

/**
 * Claims up to the free slot budget in one pass, holding the dispatch lease while
 * it reads live occupancy, so slot and model caps are applied to a
 * stable snapshot. A dispatcher that finds the lease held returns no claims
 * immediately: the holding pass has already read that wake's completions, and the
 * per-minute cron retries if the lease expired without a release.
 */
export async function claimScheduledChunks(
  db: D1Database,
  config: SchedulerConfig,
  now: number,
  token: string
): Promise<SchedulerClaim[]> {
  if (!(await acquireLease(db, DISPATCH_LEASE_ID, token, now + SCHEDULER_DISPATCH_LEASE_MS, now))) {
    return [];
  }
  // One round claims at most one chunk per lane. A model's own concurrency cap
  // bounds how many chunks of a lane can run at once, so that cap also bounds the
  // rounds needed to fill the budget when few lanes have pending work.
  const rounds = Math.min(
    SCHEDULER_DISPATCH_ROUND_LIMIT,
    Math.max(
      SCHEDULER_DISPATCH_ROUNDS,
      config.modelConcurrency,
      ...Object.values(config.modelLimits)
    )
  );
  const claims: SchedulerClaim[] = [];
  try {
    for (let round = 0; round < rounds; round++) {
      const live = await db.prepare(SCHEDULER_LIVE_SQL).all<SchedulerLiveChunk>();
      const free = config.slots - live.results.length;
      if (free <= 0) break;
      const [heads, cooldowns] = await Promise.all([
        db.prepare(SCHEDULER_LANE_HEADS_SQL).all<SchedulerLaneHead>(),
        db
          .prepare("SELECT key FROM scheduler_cooldowns WHERE scope = 'model' AND until > ?")
          .bind(now)
          .all<{ key: string }>(),
      ]);
      const selection = selectScheduledChunks({
        config,
        live: live.results,
        heads: heads.results,
        coolModels: new Set(cooldowns.results.map(row => row.key)),
        free,
        now,
      });
      if (selection.length === 0) break;
      let claimed = 0;
      for (const batch of batches(selection, SCHEDULER_CLAIM_BATCH)) {
        const results = await db.batch<SchedulerClaim>(
          batch.map(({ head, slot }) =>
            db
              .prepare(`
              UPDATE scheduler_chunks SET status = 'queued', token = ?1, slot = ?2,
                lease_until = ?3, attempts = attempts + 1
              WHERE id = ?4 AND status = 'pending'
                AND EXISTS (SELECT 1 FROM scheduler_dispatch_lock WHERE id = 1 AND token = ?1)
              RETURNING *
            `)
              .bind(token, slot, now + SCHEDULER_QUEUE_LEASE_MS, head.id)
          )
        );
        for (const result of results) {
          claimed += result.results.length;
          claims.push(...result.results);
        }
      }
      if (claimed === 0) break;
    }
  } finally {
    await releaseLease(db, DISPATCH_LEASE_ID, token);
  }
  return claims;
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Starts a queued claim, or resumes the executing claim this token still owns when its
 * delivery is redelivered after the previous invocation was canceled. Resuming keeps
 * the running lease; the paid-execution ledger, not this transition, keeps a resumed
 * delivery from repeating inference.
 */
export async function startChunk(
  db: D1Database,
  id: string,
  token: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(`
    UPDATE scheduler_chunks SET status = 'active',
      lease_until = CASE status WHEN 'queued' THEN ? ELSE lease_until END
    WHERE id = ? AND token = ? AND status IN ('queued', 'active') AND lease_until > ?
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

export async function deferThrottledChunk(
  db: D1Database,
  id: string,
  token: string,
  availableAt: number
): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET status = 'pending', attempts = MAX(attempts - 1, 0),
    throttle_deferrals = throttle_deferrals + 1, available_at = ?, slot = NULL, token = NULL,
    lease_until = 0
    WHERE id = ? AND token = ? AND status IN ('queued', 'active')`)
    .bind(availableAt, id, token)
    .run();
}

export async function failChunk(db: D1Database, id: string, token: string): Promise<void> {
  await db
    .prepare(`UPDATE scheduler_chunks SET status = 'failed', slot = NULL, lease_until = 0
    WHERE id = ? AND token = ? AND status IN ('queued', 'active')`)
    .bind(id, token)
    .run();
}

export async function failScheduledEntry(
  db: D1Database,
  claim: SchedulerClaim,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  await db.batch([
    db
      .prepare(`
        INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at)
        SELECT run_id, model, variant, rep, MIN(chunk), 0, ?
        FROM scheduler_chunks
        WHERE run_id = ? AND model = ? AND variant = ?
          AND EXISTS (
            SELECT 1 FROM scheduler_chunks AS owner
            WHERE owner.id = ? AND owner.token = ? AND owner.status = 'active'
          )
        GROUP BY run_id, model, variant, rep
        ON CONFLICT DO NOTHING
      `)
      .bind(nowIso, claim.run_id, claim.model, claim.variant, claim.id, claim.token),
    db
      .prepare(`
        WITH owned AS MATERIALIZED (
          SELECT id FROM scheduler_chunks WHERE id = ? AND token = ? AND status = 'active'
        )
        UPDATE scheduler_chunks SET status = 'failed', slot = NULL, lease_until = 0
        WHERE run_id = ? AND model = ? AND variant = ?
          AND (status IN ('pending', 'queued') OR (id = ? AND token = ? AND status = 'active'))
          AND EXISTS (SELECT 1 FROM owned)
      `)
      .bind(claim.id, claim.token, claim.run_id, claim.model, claim.variant, claim.id, claim.token),
  ]);
}

/**
 * Failed chunks of running runs whose lane death is not recorded yet. Starts from the
 * running runs, so it reads only their failed chunks rather than every failed chunk kept
 * until pruning. Exported, like the prune statements below, for the query-plan test.
 */
export const SCHEDULER_UNRECORDED_FAILED_CHUNKS_SQL = `
  SELECT chunk.* FROM benchmark_runs AS run
  CROSS JOIN scheduler_chunks AS chunk
  WHERE run.status = 'running' AND chunk.run_id = run.id AND chunk.status = 'failed'
    AND NOT EXISTS (SELECT 1 FROM run_lane_failures WHERE run_id = chunk.run_id
      AND model = chunk.model AND variant = chunk.variant AND rep = chunk.rep)
  LIMIT 250
`;

// Terminal runs past the retention window, found from their few scheduler markers rather
// than by scanning benchmark_runs.
const STALE_MARKED_RUNS_CTE = `
  stale_run(run_id) AS MATERIALIZED (
    SELECT marker.run_id FROM scheduler_runs AS marker
    CROSS JOIN benchmark_runs AS run
    WHERE run.id = marker.run_id AND run.status != 'running' AND run.completed_at < ?
    LIMIT 100
  )
`;

export const SCHEDULER_PRUNE_EXECUTIONS_SQL = `
  WITH ${STALE_MARKED_RUNS_CTE}
  DELETE FROM scheduler_executions WHERE rowid IN (
    SELECT execution.rowid FROM scheduler_executions AS execution
    WHERE execution.run_id IN (SELECT run_id FROM stale_run)
      AND NOT EXISTS (SELECT 1 FROM scheduler_chunks WHERE run_id = execution.run_id AND status = 'active')
    LIMIT 1000
  )
`;

/**
 * A run that stopped before its initialization finished holds chunks but never got a
 * marker, so chunk owners are walked one distinct run id at a time instead. Such a run
 * failed by the stale sweep has no completion time, so it ages from its start.
 */
export const SCHEDULER_PRUNE_CHUNKS_SQL = `
  WITH RECURSIVE chunk_run(run_id) AS (
    SELECT * FROM (SELECT run_id FROM scheduler_chunks ORDER BY run_id LIMIT 1)
    UNION ALL
    SELECT (SELECT c.run_id FROM scheduler_chunks AS c
      WHERE c.run_id > chunk_run.run_id ORDER BY c.run_id LIMIT 1)
    FROM chunk_run WHERE chunk_run.run_id IS NOT NULL
  ),
  stale_run(run_id) AS MATERIALIZED (
    SELECT chunk_run.run_id FROM chunk_run
    CROSS JOIN benchmark_runs AS run
    WHERE run.id = chunk_run.run_id AND run.status != 'running'
      AND COALESCE(run.completed_at, run.started_at) < ?
    LIMIT 100
  )
  DELETE FROM scheduler_chunks WHERE id IN (
    SELECT chunk.id FROM scheduler_chunks AS chunk
    WHERE chunk.run_id IN (SELECT run_id FROM stale_run)
      AND chunk.status IN ('completed', 'failed')
    LIMIT 1000
  )
`;

export const SCHEDULER_PRUNE_MARKERS_SQL = `
  WITH ${STALE_MARKED_RUNS_CTE}
  DELETE FROM scheduler_runs WHERE run_id IN (
    SELECT marker.run_id FROM scheduler_runs AS marker
    WHERE marker.run_id IN (SELECT run_id FROM stale_run)
      AND NOT EXISTS (SELECT 1 FROM scheduler_chunks WHERE run_id = marker.run_id)
      AND NOT EXISTS (SELECT 1 FROM scheduler_executions WHERE run_id = marker.run_id)
    LIMIT 1000
  )
`;

export async function recoverChunks(db: D1Database, now: number): Promise<SchedulerClaim[]> {
  const pruneBefore = new Date(now - 24 * 3600_000).toISOString();
  const results = await db.batch<SchedulerClaim>([
    db.prepare(`WITH RECURSIVE busy_run(run_id) AS (
        SELECT * FROM (
          SELECT c.run_id FROM scheduler_chunks AS c WHERE c.status = 'pending'
          ORDER BY c.run_id LIMIT 1
        )
        UNION ALL
        SELECT (SELECT c.run_id FROM scheduler_chunks AS c
          WHERE c.status = 'pending' AND c.run_id > busy_run.run_id ORDER BY c.run_id LIMIT 1)
        FROM busy_run WHERE busy_run.run_id IS NOT NULL
      )
      UPDATE scheduler_chunks SET status = 'completed', slot = NULL, token = NULL, lease_until = 0
      WHERE status IN ('pending', 'queued')
        AND run_id IN (
          SELECT candidate.run_id FROM (
            SELECT run_id FROM busy_run WHERE run_id IS NOT NULL
            UNION SELECT DISTINCT run_id FROM scheduler_chunks WHERE status = 'queued'
          ) AS candidate
          WHERE NOT EXISTS (
            SELECT 1 FROM benchmark_runs WHERE id = candidate.run_id AND status = 'running')
        )`),
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
    db.prepare(SCHEDULER_UNRECORDED_FAILED_CHUNKS_SQL),
    db.prepare(SCHEDULER_PRUNE_EXECUTIONS_SQL).bind(pruneBefore),
    db.prepare(SCHEDULER_PRUNE_CHUNKS_SQL).bind(pruneBefore),
    db.prepare(SCHEDULER_PRUNE_MARKERS_SQL).bind(pruneBefore),
    db.prepare('DELETE FROM scheduler_cooldowns WHERE until <= ?').bind(now),
  ]);
  return results[2]?.results ?? [];
}

const UNSETTLED_CHUNK_PREDICATE = `
  chunk.status IN ('pending', 'queued', 'active')
    AND (chunk.status = 'active' OR NOT EXISTS (
      SELECT 1 FROM run_lane_failures AS failure
      WHERE failure.run_id = chunk.run_id AND failure.model = chunk.model
        AND failure.variant = chunk.variant AND failure.rep = chunk.rep))
`;

/** SQL for {@link hasUnsettledChunks}; exported for the query-plan regression test. */
export const SCHEDULER_UNSETTLED_SQL = `
  SELECT 1 FROM scheduler_chunks AS chunk
  WHERE chunk.run_id = ? AND ${UNSETTLED_CHUNK_PREDICATE}
  LIMIT 1
`;

/** SQL for {@link listSettledSchedulerRuns}; exported for the query-plan regression test. */
export const SCHEDULER_SETTLED_RUNS_SQL = `
  SELECT id FROM benchmark_runs WHERE kind = 'decider' AND status = 'running'
    AND EXISTS (SELECT 1 FROM scheduler_runs WHERE run_id = benchmark_runs.id)
    AND NOT EXISTS (SELECT 1 FROM scheduler_chunks AS chunk
      WHERE chunk.run_id = benchmark_runs.id AND ${UNSETTLED_CHUNK_PREDICATE})
  LIMIT ?
`;

/**
 * Whether a run still has scheduled work that could settle it: an active chunk,
 * or a pending or queued chunk in a lane that has not dead-lettered. Active calls
 * retain their slots and keep runs unsettled even after their entry fails. Runs
 * without scheduler chunks (legacy whole-run work) are always settled.
 */
export async function hasUnsettledChunks(db: D1Database, runId: string): Promise<boolean> {
  const row = await db.prepare(SCHEDULER_UNSETTLED_SQL).bind(runId).first();
  return row !== null;
}

/**
 * Running scheduler-initialized decider runs with no unsettled chunk left, by the
 * same rule as {@link hasUnsettledChunks}. Dispatch finalizes these, since no chunk
 * completion remains to do it.
 */
export async function listSettledSchedulerRuns(db: D1Database, limit: number): Promise<string[]> {
  const rows = await db.prepare(SCHEDULER_SETTLED_RUNS_SQL).bind(limit).all<{ id: string }>();
  return rows.results.map(row => row.id);
}

export async function beginPaidCase(
  db: D1Database,
  key: PaidExecutionKey,
  now: number = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(`
    INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token, started_at,
      prompt_revision)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM scheduler_chunks WHERE run_id = ? AND model = ? AND variant = ? AND rep = ?
        AND token = ? AND status = 'active' AND lease_until > ?
        AND EXISTS (SELECT 1 FROM json_each(case_ids) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM benchmark_runs WHERE id = scheduler_chunks.run_id AND status = 'running')
        AND NOT EXISTS (
          SELECT 1 FROM run_lane_failures AS failure
          WHERE failure.run_id = scheduler_chunks.run_id AND failure.model = scheduler_chunks.model
            AND failure.variant = scheduler_chunks.variant AND failure.rep = scheduler_chunks.rep
        )
    ) ON CONFLICT DO NOTHING
  `)
    .bind(
      key.runId,
      key.model,
      key.variant,
      key.rep,
      key.caseId,
      key.token,
      now,
      PROMPT_TRANSPORT_REVISION,
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

/**
 * The prompt transport that opened this case's paid call, or null when no paid call is
 * ledgered. An execution first opened before this transport existed keeps its default.
 */
export async function getPaidCasePromptRevision(
  db: D1Database,
  key: PaidExecutionKey
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT prompt_revision FROM scheduler_executions
    WHERE run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ? AND token = ?
      AND (? IS NULL OR started_at = ?)`)
    .bind(
      key.runId,
      key.model,
      key.variant,
      key.rep,
      key.caseId,
      key.token,
      key.attemptStartedAt ?? null,
      key.attemptStartedAt ?? null
    )
    .first<{ prompt_revision: number }>();
  return row?.prompt_revision ?? null;
}

/** When the ledgered paid call for this case started, whichever claim token opened it. */
export async function getPaidCaseStartedAt(
  db: D1Database,
  key: Omit<PaidExecutionKey, 'token'>
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT started_at FROM scheduler_executions
    WHERE run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ?`)
    .bind(key.runId, key.model, key.variant, key.rep, key.caseId)
    .first<{ started_at: number }>();
  return row?.started_at ?? null;
}

/** Moves a ledgered case's start to a further paid call its own token makes. */
export async function restartPaidCase(
  db: D1Database,
  key: PaidExecutionKey,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE scheduler_executions SET started_at = ?
    WHERE run_id = ? AND model = ? AND variant = ? AND rep = ? AND case_id = ? AND token = ?
      AND (? IS NULL OR started_at = ?)
      AND EXISTS (
        SELECT 1 FROM scheduler_chunks AS chunk
        WHERE chunk.run_id = scheduler_executions.run_id AND chunk.model = scheduler_executions.model
          AND chunk.variant = scheduler_executions.variant AND chunk.rep = scheduler_executions.rep
          AND chunk.token = scheduler_executions.token AND chunk.status = 'active' AND chunk.lease_until > ?
      )
      AND EXISTS (
        SELECT 1 FROM benchmark_runs
        WHERE id = scheduler_executions.run_id AND status = 'running'
      )
      AND NOT EXISTS (
        SELECT 1 FROM run_lane_failures AS failure
        WHERE failure.run_id = scheduler_executions.run_id AND failure.model = scheduler_executions.model
          AND failure.variant = scheduler_executions.variant AND failure.rep = scheduler_executions.rep
      )`)
    .bind(
      now,
      key.runId,
      key.model,
      key.variant,
      key.rep,
      key.caseId,
      key.token,
      key.attemptStartedAt ?? null,
      key.attemptStartedAt ?? null,
      now
    )
    .run();
  return result.meta.changes > 0;
}

export function schedulerBackoffSeconds(attempts: number): number {
  return Math.min(300, 15 * 2 ** Math.min(attempts - 1, 5));
}

export async function clearUnbilledCase(
  db: D1Database,
  key: Omit<PaidExecutionKey, 'token'> & { token?: string }
): Promise<void> {
  if (key.token === undefined && key.attemptStartedAt === undefined) {
    throw new Error('Unbilled cleanup requires a claim token or attempt generation.');
  }
  const bindings = [
    key.runId,
    key.model,
    key.variant,
    key.rep,
    key.caseId,
    key.token ?? null,
    key.attemptStartedAt ?? null,
  ];
  await db.batch([
    db
      .prepare(`
        DELETE FROM pending_decider_outputs
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND rep = ?4 AND case_id = ?5
          AND EXISTS (
            SELECT 1 FROM scheduler_executions
            WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND rep = ?4 AND case_id = ?5
              AND (?6 IS NULL OR token = ?6) AND (?7 IS NULL OR started_at = ?7)
          )
      `)
      .bind(...bindings),
    db
      .prepare(`
        DELETE FROM scheduler_executions
        WHERE run_id = ?1 AND model = ?2 AND variant = ?3 AND rep = ?4 AND case_id = ?5
          AND (?6 IS NULL OR token = ?6) AND (?7 IS NULL OR started_at = ?7)
      `)
      .bind(...bindings),
  ]);
}

/**
 * Cools the throttled model, keeping the later deadline when a cooldown is already
 * active. Other models stay claimable: a throttle names no upstream, because the
 * gateway's aggregator picks one per request. Cooldowns are matched by the dispatch
 * pass instead of stamped on each pending chunk, so one throttle event never
 * rewrites the whole backlog.
 */
export async function cooldownModel(db: D1Database, model: string, until: number): Promise<void> {
  await db
    .prepare(`INSERT INTO scheduler_cooldowns (scope, key, until) VALUES ('model', ?, ?)
      ON CONFLICT (scope, key) DO UPDATE SET until = MAX(until, excluded.until)`)
    .bind(model, until)
    .run();
}
