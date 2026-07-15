import 'server-only';

import { TRPCError } from '@trpc/server';

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  LocalRuntimeControlClient,
  LocalRuntimeControlRequestError,
  type LocalRuntimeList,
} from '@/lib/local-runtime-control/client';

export const localRuntimeControlRouter = createTRPCRouter({
  list: baseProcedure.query(async ({ ctx }): Promise<LocalRuntimeList> => {
    try {
      return await LocalRuntimeControlClient.list(ctx.user.id);
    } catch (err) {
      if (err instanceof LocalRuntimeControlRequestError) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'Local runtime control request failed',
        });
      }
      throw err;
    }
  }),
});
