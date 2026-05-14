import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { model_eval_ingest } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { recomputeModelStatsKiloBench } from './recompute.js';
import { PromotionRecordsSchema, type PromotionRecordInput } from './promotion-record.js';

const PROMOTION_PULL_LIMIT = 1_000;

type PromotionIdentity = {
  provider: string;
  model: string;
  variant: string | null;
};

const PromotionIdentityKeySchema = z.tuple([z.string(), z.string(), z.string().nullable()]);

export type SyncFromBenchResult = {
  inserted: number;
  alreadyHad: number;
  fetched: number;
  recomputed: number;
  sinceMs: number;
};

function encodePromotionIdentity(identity: PromotionIdentity): string {
  return JSON.stringify([identity.provider, identity.model, identity.variant]);
}

function decodePromotionIdentity(value: string): PromotionIdentity {
  const [provider, model, variant] = PromotionIdentityKeySchema.parse(JSON.parse(value));
  return { provider, model, variant };
}

async function getPromotionWatermark(db: WorkerDb): Promise<number> {
  const result = await db.execute<{ max_promoted_at_ms: string | null }>(sql`
    SELECT EXTRACT(EPOCH FROM MAX(${model_eval_ingest.promoted_at})) * 1000 AS max_promoted_at_ms
    FROM ${model_eval_ingest}
  `);

  const value = result.rows[0]?.max_promoted_at_ms;
  if (!value) return 0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

function mapPromotionInsertValues(promotion: PromotionRecordInput) {
  return {
    bench_eval_name: promotion.bench_eval_name,
    bench_eval_url: promotion.bench_eval_url,
    provider: promotion.provider,
    model: promotion.model,
    variant: promotion.variant,
    task_source: promotion.task_source,
    n_total_trials: promotion.n_total_trials,
    total_score: String(promotion.total_score),
    overall_score: String(promotion.overall_score),
    n_errored: promotion.n_errored,
    avg_cost_usd: promotion.avg_cost_usd === null ? null : String(promotion.avg_cost_usd),
    avg_input_tokens:
      promotion.avg_input_tokens === null ? null : String(promotion.avg_input_tokens),
    avg_output_tokens:
      promotion.avg_output_tokens === null ? null : String(promotion.avg_output_tokens),
    avg_cache_read_tokens:
      promotion.avg_cache_read_tokens === null ? null : String(promotion.avg_cache_read_tokens),
    avg_execution_ms:
      promotion.avg_execution_ms === null ? null : String(promotion.avg_execution_ms),
    promoted_at: new Date(promotion.promoted_at).toISOString(),
    promoted_by_email: promotion.promoted_by_email,
    promotion_note: promotion.promotion_note,
  } satisfies typeof model_eval_ingest.$inferInsert;
}

async function insertPromotion(db: WorkerDb, promotion: PromotionRecordInput): Promise<boolean> {
  const inserted = await db
    .insert(model_eval_ingest)
    .values(mapPromotionInsertValues(promotion))
    .onConflictDoNothing({ target: model_eval_ingest.bench_eval_name })
    .returning({ id: model_eval_ingest.id });

  return inserted.length > 0;
}

export async function syncFromBench(
  env: CloudflareEnv,
  db: WorkerDb = getWorkerDb(env.HYPERDRIVE.connectionString)
): Promise<SyncFromBenchResult> {
  const sinceMs = await getPromotionWatermark(db);
  const promotions = PromotionRecordsSchema.parse(
    await env.BENCH_DASHBOARD.listPromotions({
      sinceMs,
      limit: PROMOTION_PULL_LIMIT,
    })
  );

  const touchedIdentities = new Set<string>();
  let inserted = 0;
  let alreadyHad = 0;

  for (const promotion of promotions) {
    if (await insertPromotion(db, promotion)) {
      inserted += 1;
      touchedIdentities.add(
        encodePromotionIdentity({
          provider: promotion.provider,
          model: promotion.model,
          variant: promotion.variant,
        })
      );
    } else {
      alreadyHad += 1;
    }
  }

  for (const identityKey of touchedIdentities) {
    await recomputeModelStatsKiloBench(db, decodePromotionIdentity(identityKey));
  }

  if (promotions.length === PROMOTION_PULL_LIMIT) {
    console.warn(
      `[model-eval-ingest] promotion pull hit limit=${PROMOTION_PULL_LIMIT}; remaining promotions will be picked up by the next cron`
    );
  }

  return {
    inserted,
    alreadyHad,
    fetched: promotions.length,
    recomputed: touchedIdentities.size,
    sinceMs,
  };
}
