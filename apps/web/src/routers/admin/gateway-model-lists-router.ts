import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { GatewayModelListConfigSchema } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const GatewayModelListSchema = z.enum(['preferred_models', 'unavailable_models']);

export type GatewayModelList = z.infer<typeof GatewayModelListSchema>;

async function getCurrentModels(list: GatewayModelList): Promise<string[]> {
  switch (list) {
    case 'preferred_models':
      return getPreferredModels();
    case 'unavailable_models':
      return getUnavailableModelIds();
  }
}

export const adminGatewayModelListsRouter = createTRPCRouter({
  get: adminProcedure.input(z.object({ list: GatewayModelListSchema })).query(async ({ input }) => {
    const [[row], current] = await Promise.all([
      db
        .select({ config: ai_gateway_config[input.list] })
        .from(ai_gateway_config)
        .where(eq(ai_gateway_config.id, 1))
        .limit(1),
      getCurrentModels(input.list),
    ]);
    return { config: row?.config ?? null, current };
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
