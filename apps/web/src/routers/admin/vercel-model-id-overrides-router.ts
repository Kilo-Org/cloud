import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { mapResolvedModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { vercel_model_id_overrides } from '@kilocode/db/schema';
import { VercelModelIdOverrideSchema } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import { asc, eq, sql } from 'drizzle-orm';

export const adminVercelModelIdOverridesRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    const rows = await db
      .select({
        openrouter_model_id: vercel_model_id_overrides.openrouter_model_id,
        vercel_model_id: vercel_model_id_overrides.vercel_model_id,
        updated_at: vercel_model_id_overrides.updated_at,
      })
      .from(vercel_model_id_overrides)
      .orderBy(asc(vercel_model_id_overrides.openrouter_model_id));
    return {
      items: rows.map(row => ({
        openrouter_model_id: row.openrouter_model_id,
        vercel_model_id: row.vercel_model_id,
        builtin_vercel_model_id: mapResolvedModelIdToVercel(row.openrouter_model_id),
        updated_at: new Date(row.updated_at).toISOString(),
      })),
    };
  }),

  upsert: adminProcedure.input(VercelModelIdOverrideSchema).mutation(async ({ input }) => {
    await db
      .insert(vercel_model_id_overrides)
      .values(input)
      .onConflictDoUpdate({
        target: vercel_model_id_overrides.openrouter_model_id,
        set: { vercel_model_id: input.vercel_model_id, updated_at: sql`now()` },
      });
    return input;
  }),

  delete: adminProcedure
    .input(VercelModelIdOverrideSchema.pick({ openrouter_model_id: true }))
    .mutation(async ({ input }) => {
      const result = await db
        .delete(vercel_model_id_overrides)
        .where(eq(vercel_model_id_overrides.openrouter_model_id, input.openrouter_model_id));
      if ((result.rowCount ?? 0) === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No override exists for "${input.openrouter_model_id}"`,
        });
      }
      return { success: true };
    }),
});
