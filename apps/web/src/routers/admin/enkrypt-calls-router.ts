import 'server-only';

import { TRPCError } from '@trpc/server';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { getEnkryptCallCounts } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/call-counter';

export const adminEnkryptCallsRouter = createTRPCRouter({
  perMinute: adminProcedure.query(async () => {
    try {
      return await getEnkryptCallCounts();
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to read Enkrypt call counts from Redis',
        cause: error,
      });
    }
  }),
});
