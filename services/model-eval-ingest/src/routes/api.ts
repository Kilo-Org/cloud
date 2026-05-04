import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import {
  model_eval_ingest,
  modelStats,
  type KiloBenchEval,
  type ModelStatsBenchmarks,
} from '@kilocode/db/schema';

import type { Env } from '../env';
import { hmacAuthMiddleware } from '../middleware/hmac-auth';

type ApiContext = {
  Bindings: Env;
  Variables: {
    rawBody: string;
  };
};

// -----------------------------------------------------------------------
// Submission schema
// -----------------------------------------------------------------------

// Shape the bench backend sends. Must stay in sync with the submission
// type in `backend/routes/promote.py` on the bench side (Phase D).
export const SubmissionSchema = z.object({
  bench_job_name: z.string().min(1).max(255),
  bench_job_url: z.url(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  variant: z.string().nullable(),
  task_source: z.string().min(1).max(128),
  task_source_display_name: z.string().optional(),
  aggregate: z.object({
    n_trials: z.number().int().positive(),
    // Reward is a mean in [0, 1] for binary-reward evals; some may
    // exceed 1 (partial-credit rubrics). Clamp at 10 to guard against
    // garbage data without rejecting legitimate edge cases.
    success_rate: z.number().min(0).max(10),
    avg_cost_usd: z.number().min(0),
    avg_input_tokens: z.number().int().min(0),
    avg_output_tokens: z.number().int().min(0),
    avg_cache_read_tokens: z.number().int().min(0),
    avg_execution_ms: z.number().int().min(0),
  }),
  review_note: z.string().nullable(),
  promoted_by_email: z.email(),
});

export type Submission = z.infer<typeof SubmissionSchema>;

// -----------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------

export const api = new Hono<ApiContext>();

// Every route on this router requires a valid HMAC from the bench service.
api.use('/*', hmacAuthMiddleware);

// POST /api/model-eval-ingest/submit
//
// 1. Parse + validate the payload.
// 2. Resolve `model_stats_id` by looking up the openrouter id (nullable;
//    promotions land before the model exists in model_stats for stealth
//    rollouts).
// 3. Insert the immutable ingest row.
// 4. Recompute modelStats.benchmarks.kiloBench for this model by
//    collapsing all ingest rows for the (provider, model, variant) tuple
//    into one JSONB object.
api.post('/submit', async c => {
  const rawBody = c.var.rawBody;

  let parsed: Submission;
  try {
    parsed = SubmissionSchema.parse(JSON.parse(rawBody));
  } catch (err) {
    const issues = err instanceof z.ZodError ? err.issues : undefined;
    return c.json({ success: false, error: 'Invalid submission payload', issues }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);

  const openrouterId = `${parsed.provider}/${parsed.model}`;
  const modelStatsRows = await db
    .select({ id: modelStats.id })
    .from(modelStats)
    .where(eq(modelStats.openrouterId, openrouterId))
    .limit(1);
  const modelStatsId = modelStatsRows[0]?.id ?? null;

  const [inserted] = await db
    .insert(model_eval_ingest)
    .values({
      bench_job_name: parsed.bench_job_name,
      bench_job_url: parsed.bench_job_url,
      provider: parsed.provider,
      model: parsed.model,
      model_stats_id: modelStatsId,
      variant: parsed.variant,
      task_source: parsed.task_source,
      task_source_display_name: parsed.task_source_display_name ?? null,
      n_trials: parsed.aggregate.n_trials,
      success_rate: parsed.aggregate.success_rate.toString(),
      avg_cost_usd: parsed.aggregate.avg_cost_usd.toString(),
      avg_input_tokens: parsed.aggregate.avg_input_tokens,
      avg_output_tokens: parsed.aggregate.avg_output_tokens,
      avg_cache_read_tokens: parsed.aggregate.avg_cache_read_tokens,
      avg_execution_ms: parsed.aggregate.avg_execution_ms,
      review_note: parsed.review_note,
      promoted_by_email: parsed.promoted_by_email,
    })
    .returning({ id: model_eval_ingest.id, promoted_at: model_eval_ingest.promoted_at });

  if (!inserted) {
    return c.json({ success: false, error: 'Insert failed' }, 500);
  }

  // Rebuild the JSONB cache on modelStats (if the model exists). If the
  // model isn't in model_stats yet, we still stored the ingest row — a
  // later sync-openrouter run that creates the model_stats row can
  // backfill via /admin/model-eval-ingest.
  if (modelStatsId) {
    await recomputeKiloBench(db, parsed.provider, parsed.model, parsed.variant, modelStatsId);
  }

  return c.json({
    success: true,
    id: inserted.id,
    promoted_at: inserted.promoted_at,
    model_stats_id: modelStatsId,
  });
});

// GET /api/model-eval-ingest/latest/:model
//
// Returns the latest ingest row for the given (provider, model, variant,
// task_source) tuple, or null if none. Used by the bench side to show
// the side-by-side delta on the promote dialog.
//
// Query params:
//   provider (required)  — e.g. "anthropic"
//   variant  (optional)  — empty string / omitted means "no variant"
//   task_source (required) — e.g. "terminal-bench"
api.get('/latest/:model{.+}', async c => {
  const model = c.req.param('model');
  const provider = c.req.query('provider');
  const variant = c.req.query('variant') || null;
  const taskSource = c.req.query('task_source');

  if (!provider || !taskSource) {
    return c.json({ success: false, error: 'provider and task_source query params required' }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const rows = await db
    .select()
    .from(model_eval_ingest)
    .where(
      and(
        eq(model_eval_ingest.provider, provider),
        eq(model_eval_ingest.model, model),
        variant === null
          ? sql`${model_eval_ingest.variant} IS NULL`
          : eq(model_eval_ingest.variant, variant),
        eq(model_eval_ingest.task_source, taskSource)
      )
    )
    .orderBy(desc(model_eval_ingest.promoted_at))
    .limit(1);

  return c.json({ success: true, row: rows[0] ?? null });
});

// GET /api/model-eval-ingest/:id
//
// Returns a single ingest record by id. Used by the admin audit page
// (rendered from tRPC) and by bench-side status lookups.
api.get('/:id', async c => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return c.json({ success: false, error: 'Invalid id' }, 400);
  }

  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  const rows = await db
    .select()
    .from(model_eval_ingest)
    .where(eq(model_eval_ingest.id, id))
    .limit(1);

  if (!rows[0]) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.json({ success: true, row: rows[0] });
});

// -----------------------------------------------------------------------
// Recompute — "latest wins" per (model, variant, task_source)
//
// Pulls the most-recent ingest row per task_source for this model tuple
// and merges them into modelStats.benchmarks.kiloBench. Uses a JSONB
// `||` merge so we don't stomp on other benchmark sources (e.g.
// artificialAnalysis).
//
// Exported for tests; called by the submit handler above.
// -----------------------------------------------------------------------

type WorkerDb = ReturnType<typeof getWorkerDb>;

export async function recomputeKiloBench(
  db: WorkerDb,
  provider: string,
  model: string,
  variant: string | null,
  modelStatsId: string
): Promise<void> {
  const latestPerTaskSource = await db.execute<{
    task_source: string;
    task_source_display_name: string | null;
    success_rate: string;
    avg_cost_usd: string | null;
    avg_input_tokens: number | null;
    avg_output_tokens: number | null;
    avg_cache_read_tokens: number | null;
    avg_execution_ms: number | null;
    n_trials: number;
    promoted_at: string;
  }>(sql`
    SELECT DISTINCT ON (task_source)
      task_source,
      task_source_display_name,
      success_rate,
      avg_cost_usd,
      avg_input_tokens,
      avg_output_tokens,
      avg_cache_read_tokens,
      avg_execution_ms,
      n_trials,
      promoted_at
    FROM model_eval_ingest
    WHERE provider = ${provider}
      AND model = ${model}
      AND ${variant === null ? sql`variant IS NULL` : sql`variant = ${variant}`}
    ORDER BY task_source, promoted_at DESC
  `);

  const evals: Record<string, KiloBenchEval> = {};
  for (const row of latestPerTaskSource.rows) {
    const entry: KiloBenchEval = {
      taskSource: row.task_source,
      successRate: Number(row.success_rate),
      avgCostUsd: Number(row.avg_cost_usd ?? 0),
      nTrials: row.n_trials,
      lastPromotedAt: row.promoted_at,
    };
    if (row.task_source_display_name !== null) entry.displayName = row.task_source_display_name;
    if (row.avg_input_tokens !== null) entry.avgInputTokens = row.avg_input_tokens;
    if (row.avg_output_tokens !== null) entry.avgOutputTokens = row.avg_output_tokens;
    if (row.avg_cache_read_tokens !== null) entry.avgCacheReadTokens = row.avg_cache_read_tokens;
    if (row.avg_execution_ms !== null) entry.avgExecutionMs = row.avg_execution_ms;
    evals[row.task_source] = entry;
  }

  const kiloBench: NonNullable<NonNullable<ModelStatsBenchmarks>['kiloBench']> = {
    evals,
    lastUpdated: new Date().toISOString(),
  };

  await db
    .update(modelStats)
    .set({
      benchmarks: sql`
        COALESCE(${modelStats.benchmarks}, '{}'::jsonb)
        || ${JSON.stringify({ kiloBench })}::jsonb
      `,
    })
    .where(eq(modelStats.id, modelStatsId));
}

// Exported so the schema test and future tooling can enumerate the
// recomputation surface. `isNotNull` is only imported for downstream
// consumers; Drizzle tree-shakes unused helpers.
export const _unused_isNotNull = isNotNull;
