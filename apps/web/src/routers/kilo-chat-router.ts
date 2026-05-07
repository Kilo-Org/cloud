import 'server-only';
import { createKiloChatTokenResponse } from '@/lib/kilo-chat/token';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';

export const kiloChatRouter = createTRPCRouter({
  getToken: baseProcedure.query(({ ctx }) => createKiloChatTokenResponse(ctx.user)),
});
