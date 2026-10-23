import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { mapResolvedModelIdToVercelWithoutOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT,
  VercelModelIdOverrideSchema,
  VercelModelIdOverridesConfigSchema,
  type VercelModelIdOverride,
} from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

/**
 * Locks the singleton config row (creating it if needed) so concurrent edits of
 * different overrides cannot overwrite each other.
 */
async function updateOverrides(
  update: (overrides: VercelModelIdOverride[]) => VercelModelIdOverride[]
): Promise<void> {
  await db.transaction(async tx => {
    await tx.insert(ai_gateway_config).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx
      .select({ config: ai_gateway_config.vercel_model_id_overrides })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .for('update');
    const overrides = update(row?.config?.overrides ?? []);
    await tx
      .update(ai_gateway_config)
      .set({
        vercel_model_id_overrides:
          overrides.length === 0 ? null : VercelModelIdOverridesConfigSchema.parse({ overrides }),
      })
      .where(eq(ai_gateway_config.id, 1));
  });
}

export const adminVercelModelIdOverridesRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.vercel_model_id_overrides })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    const overrides = row?.config?.overrides ?? [];
    return {
      items: overrides
        .map(override => ({
          ...override,
          builtin_vercel_model_id: mapResolvedModelIdToVercelWithoutOverrides(
            override.openrouter_model_id
          ),
        }))
        .sort((a, b) => a.openrouter_model_id.localeCompare(b.openrouter_model_id)),
    };
  }),

  upsert: adminProcedure.input(VercelModelIdOverrideSchema).mutation(async ({ input }) => {
    await updateOverrides(overrides => {
      if (!overrides.some(override => override.openrouter_model_id === input.openrouter_model_id)) {
        if (overrides.length >= VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `At most ${VERCEL_MODEL_ID_OVERRIDES_MAX_COUNT} overrides are allowed`,
          });
        }
        return [...overrides, input];
      }
      return overrides.map(override =>
        override.openrouter_model_id === input.openrouter_model_id ? input : override
      );
    });
    return input;
  }),

  delete: adminProcedure
    .input(VercelModelIdOverrideSchema.pick({ openrouter_model_id: true }))
    .mutation(async ({ input }) => {
      await updateOverrides(overrides => {
        if (
          !overrides.some(override => override.openrouter_model_id === input.openrouter_model_id)
        ) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No override exists for "${input.openrouter_model_id}"`,
          });
        }
        return overrides.filter(
          override => override.openrouter_model_id !== input.openrouter_model_id
        );
      });
      return { success: true };
    }),
});
