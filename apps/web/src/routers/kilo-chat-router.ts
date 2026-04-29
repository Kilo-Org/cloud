import 'server-only';
import * as z from 'zod';
import { generateApiToken } from '@/lib/tokens';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';

const KILO_CHAT_TOKEN_TTL_S = 60 * 60;

export const kiloChatRouter = createTRPCRouter({
  getToken: baseProcedure
    .output(z.object({ token: z.string(), expiresAt: z.iso.datetime() }))
    .query(({ ctx }) => {
      const token = generateApiToken(
        ctx.user,
        { tokenSource: 'kilo-chat' },
        { expiresIn: KILO_CHAT_TOKEN_TTL_S }
      );
      const expiresAt = new Date(Date.now() + KILO_CHAT_TOKEN_TTL_S * 1000).toISOString();
      return { token, expiresAt };
    }),
});
