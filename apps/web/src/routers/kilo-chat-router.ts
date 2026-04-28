import 'server-only';

import * as z from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { generateApiToken } from '@/lib/tokens';

const ONE_HOUR_SECONDS = 60 * 60;

export const kiloChatRouter = createTRPCRouter({
  getToken: baseProcedure
    .output(z.object({ token: z.string(), expiresAt: z.string() }))
    .query(({ ctx }) => {
      const token = generateApiToken(
        ctx.user,
        { tokenSource: 'kilo-chat' },
        { expiresIn: ONE_HOUR_SECONDS }
      );
      const expiresAt = new Date(Date.now() + ONE_HOUR_SECONDS * 1000).toISOString();
      return { token, expiresAt };
    }),
});
