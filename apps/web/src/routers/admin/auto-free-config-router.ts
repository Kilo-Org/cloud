import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { autoFreeModels } from '@kilocode/web-shared/lib/ai-gateway/models';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const SetAutoFreeConfigSchema = z.object({
  config: AutoFreeConfigSchema.nullable(),
});

export const adminAutoFreeConfigRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const [row] = await db
      .select({ auto_free: ai_gateway_config.auto_free })
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1))
      .limit(1);
    const defaults: AutoFreeConfig = { models: [...autoFreeModels] };
    return { config: row?.auto_free ?? null, defaults };
  }),

  set: adminProcedure.input(SetAutoFreeConfigSchema).mutation(async ({ input }) => {
    await db
      .insert(ai_gateway_config)
      .values({ auto_free: input.config })
      .onConflictDoUpdate({
        target: ai_gateway_config.id,
        set: { auto_free: input.config },
      });
    return { config: input.config };
  }),
});
