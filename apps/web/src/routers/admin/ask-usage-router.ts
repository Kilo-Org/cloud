import 'server-only';

import { startAskUsageSession } from '@/modules/ask-usage/server/start-ask-usage-session';
import { startAskUsageSessionInputSchema } from '@/modules/ask-usage/server/usage-analyst-config';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';

export const adminAskUsageRouter = createTRPCRouter({
  start: adminProcedure.input(startAskUsageSessionInputSchema).mutation(async ({ ctx, input }) => {
    return startAskUsageSession({ user: ctx.user, input });
  }),
});
