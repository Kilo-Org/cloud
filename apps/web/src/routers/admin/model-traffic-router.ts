import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getModelTraffic } from '@/lib/ai-gateway/model-traffic';

export const adminModelTrafficRouter = createTRPCRouter({
  get: adminProcedure.input(z.object({ excludeByok: z.boolean() })).query(async ({ input }) => {
    try {
      return await getModelTraffic({ now: new Date(), excludeByok: input.excludeByok });
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to query model traffic from Analytics Engine',
        cause: error,
      });
    }
  }),
});
