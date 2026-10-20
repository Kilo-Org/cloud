import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import {
  CustomPricingConfigSchema,
  type CustomPricingModelConfig,
} from '@kilocode/db/schema-types';
import { customPricingByModelId } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

function builtInCustomPricing(): CustomPricingModelConfig[] {
  return Object.entries(customPricingByModelId).map(([model, customPricing]) => ({
    model,
    pricing: customPricing.pricing[0].pricing,
    discountPercentage: customPricing.discountPercentage,
    fallbackOnly: customPricing.fallbackOnly ?? false,
  }));
}

export const adminGatewayCustomPricingRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const [row] = await db
      .select({ config: ai_gateway_config.custom_pricing })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    return { config: row?.config ?? null, builtIn: builtInCustomPricing() };
  }),

  set: adminProcedure
    .input(z.object({ config: CustomPricingConfigSchema.nullable() }))
    .mutation(async ({ input }) => {
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
