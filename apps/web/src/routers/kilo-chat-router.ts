import 'server-only';
import { createKiloChatTokenResponse } from '@/lib/kilo-chat/token';
import { kiloChatTokenResponseSchema } from '@/lib/kilo-chat/token-schema';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';

export const kiloChatRouter = createTRPCRouter({
  getToken: baseProcedure
    .output(kiloChatTokenResponseSchema)
    .query(({ ctx }) => createKiloChatTokenResponse(ctx.user)),
});
