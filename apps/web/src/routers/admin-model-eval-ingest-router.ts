import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { model_eval_ingestions } from '@kilocode/db/schema';
import { desc, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import * as z from 'zod';
import { syncModelEvalPromotions } from '@/lib/model-eval-ingest-client';

const ModelEvalIngestListSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

export const adminModelEvalIngestRouter = createTRPCRouter({
  list: adminProcedure.input(ModelEvalIngestListSchema).query(async ({ input }) => {
    const offset = (input.page - 1) * input.limit;
    const rows = await db
      .select({
        id: model_eval_ingestions.id,
        benchEvalName: model_eval_ingestions.bench_eval_name,
        benchEvalUrl: model_eval_ingestions.bench_eval_url,
        provider: model_eval_ingestions.provider,
        model: model_eval_ingestions.model,
        variant: model_eval_ingestions.variant,
        taskSource: model_eval_ingestions.task_source,
        nTotalTrials: model_eval_ingestions.n_total_trials,
        totalScore: model_eval_ingestions.total_score,
        overallScore: model_eval_ingestions.overall_score,
        nErrored: model_eval_ingestions.n_errored,
        promotedAt: model_eval_ingestions.promoted_at,
        promotedByEmail: model_eval_ingestions.promoted_by_email,
        promotionNote: model_eval_ingestions.promotion_note,
        createdAt: model_eval_ingestions.created_at,
        modelStatsId: model_eval_ingestions.model_stats_id,
        total: sql<number>`count(*) OVER()::int`.as('total'),
      })
      .from(model_eval_ingestions)
      .orderBy(desc(model_eval_ingestions.promoted_at), desc(model_eval_ingestions.bench_eval_name))
      .limit(input.limit)
      .offset(offset);

    const total = rows[0]?.total ?? 0;
    return {
      rows: rows.map(({ total: _total, ...row }) => row),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }),

  syncNow: adminProcedure.mutation(async () => {
    const result = await syncModelEvalPromotions();
    revalidateModelStatsRoutes();
    return result;
  }),

  repullPromotion: adminProcedure
    .input(z.object({ promotionName: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const result = await syncModelEvalPromotions({ promotionName: input.promotionName });
      revalidateModelStatsRoutes();
      return result;
    }),
});

function revalidateModelStatsRoutes(): void {
  revalidatePath('/api/models/stats');
  revalidatePath('/api/models/stats/[slug]', 'page');
}
