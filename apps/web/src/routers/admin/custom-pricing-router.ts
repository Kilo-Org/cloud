import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { CustomPricingConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const SetCustomPricingConfigSchema = z.object({
  config: CustomPricingConfigSchema.nullable(),
});

export const adminCustomPricingRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.custom_pricing })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    if (!row?.config) return { config: null };
    // jsonb sorts object keys; parsing restores the schema's key order for the editor.
    const parsed = CustomPricingConfigSchema.safeParse(row.config);
    return { config: parsed.success ? parsed.data : row.config };
  }),

  set: adminProcedure.input(SetCustomPricingConfigSchema).mutation(async ({ input }) => {
    await db
      .insert(ai_gateway_config)
      .values({ custom_pricing: input.config })
      .onConflictDoUpdate({
        target: ai_gateway_config.id,
        set: { custom_pricing: input.config },
      });
    return { config: input.config };
  }),
});
