import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { GATEWAY_MODEL_LISTS } from '@kilocode/web-shared/lib/ai-gateway/gateway-model-lists';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const GatewayModelListSchema = z.enum(GATEWAY_MODEL_LISTS);

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
      return { config: input.config };
    }),
});
