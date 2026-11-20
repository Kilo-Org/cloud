import { z } from 'zod';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import {
  cloudWakeupReplySchema,
  cloudWakeupSchema,
  type CloudWakeupReply,
} from '../../shared/cloud-wakeup.js';
import type { SessionId } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';

const inputSchema = z.object({ sessionId: sessionIdSchema });
const wakeupProcedure = protectedProcedure.input(inputSchema).use(async ({ input, ctx, next }) => {
  const sessionId = input.sessionId as SessionId;
  await requireCurrentSessionAccess({
    env: ctx.env,
    kiloUserId: ctx.userId,
    cloudAgentSessionId: sessionId,
    validatedSessionAccess: ctx.validatedSessionAccess,
  });
  return next({
    ctx: { wakeupSession: () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId) },
  });
});

export const getWakeup = wakeupProcedure
  .output(cloudWakeupSchema.nullable())
  .query(({ ctx }) => withDORetry(ctx.wakeupSession, stub => stub.getWakeup(), 'getWakeup'));

export const cancelWakeup = wakeupProcedure
  .input(z.object({ id: z.string().min(1).max(128) }))
  .output(cloudWakeupReplySchema)
  .mutation(({ input, ctx }) =>
    withDORetry(
      ctx.wakeupSession,
      async (stub): Promise<CloudWakeupReply> =>
        await stub.changeWakeup({ action: 'cancel', id: input.id }),
      'cancelWakeup'
    )
  );
