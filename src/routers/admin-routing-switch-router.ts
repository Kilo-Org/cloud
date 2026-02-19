import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  isUniversalVercelRoutingEnabled,
  setUniversalVercelRouting,
} from '@/lib/edge-config';
import * as z from 'zod';

export const adminRoutingSwitchRouter = createTRPCRouter({
  getStatus: adminProcedure.query(async () => {
    const enabled = await isUniversalVercelRoutingEnabled();
    return { enabled };
  }),

  setStatus: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[routing-switch] Admin ${ctx.user.id} (${ctx.user.google_user_email}) setting universal Vercel routing to ${input.enabled}`
      );
      await setUniversalVercelRouting(input.enabled);
      return { enabled: input.enabled };
    }),
});
