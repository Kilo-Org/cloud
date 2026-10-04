import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  AUTO_FREE_FALLBACK_CONFIG,
  getIneligibleAutoFreeModelIds,
} from '@/lib/ai-gateway/auto-model/auto-free-config';
import { db } from '@/lib/drizzle';
import { ai_gateway_config } from '@kilocode/db/schema';
import { AutoFreeConfigSchema } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
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
    return { config: row?.auto_free ?? null, fallback: AUTO_FREE_FALLBACK_CONFIG };
  }),

  set: adminProcedure.input(SetAutoFreeConfigSchema).mutation(async ({ input }) => {
    const ineligibleModelIds = input.config ? getIneligibleAutoFreeModelIds(input.config) : [];
    if (ineligibleModelIds.length > 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Not eligible for kilo-auto/free (must be a free model that uses the default AI SDK provider): ${ineligibleModelIds.join(', ')}`,
      });
    }

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
