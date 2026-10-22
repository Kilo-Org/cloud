import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { PreferredProviderOrderConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const SetPreferredProviderOrderConfigSchema = z.object({
  config: PreferredProviderOrderConfigSchema.nullable(),
});

export const adminPreferredProviderOrderRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.preferred_provider_order })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    return { config: row?.config ?? null, fallback: PREFERRED_PROVIDER_ORDER_FALLBACK_CONFIG };
  }),

  set: adminProcedure.input(SetPreferredProviderOrderConfigSchema).mutation(async ({ input }) => {
    await db
      .insert(ai_gateway_config)
      .values({ preferred_provider_order: input.config })
      .onConflictDoUpdate({
        target: ai_gateway_config.id,
        set: { preferred_provider_order: input.config },
      });
    return { config: input.config };
  }),
});
