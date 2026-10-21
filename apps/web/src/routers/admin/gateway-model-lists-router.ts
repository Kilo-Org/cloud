import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { publishAiGatewayConfigSnapshot } from '@kilocode/web-shared/lib/ai-gateway/ai-gateway-config-snapshot';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const GatewayModelListSchema = z.enum(['preferred_models', 'unavailable_models']);

export type GatewayModelList = z.infer<typeof GatewayModelListSchema>;

export const adminGatewayModelListsRouter = createTRPCRouter({
  get: adminProcedure.input(z.object({ list: GatewayModelListSchema })).query(async ({ input }) => {
    const [row] = await db
      .select({ config: ai_gateway_config[input.list] })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    return { config: row?.config ?? null };
  }),

  set: adminProcedure
    .input(
      z.object({
        list: GatewayModelListSchema,
        config: GatewayModelListConfigSchema.nullable(),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .insert(ai_gateway_config)
        .values({ [input.list]: input.config })
        .onConflictDoUpdate({
          target: ai_gateway_config.id,
          set: { [input.list]: input.config },
        });
      await publishAiGatewayConfigSnapshot();
      return { config: input.config };
    }),
});
