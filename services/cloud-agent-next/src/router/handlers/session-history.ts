import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure } from '../auth.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import {
  decodeSessionHistoryCursor,
  sessionHistoryPageInputSchema,
} from '../../control-plane/session/history.js';

export const getSessionMessagesPage = protectedProcedure
  .input(
    sessionHistoryPageInputSchema
      .omit({ expectedRootKiloSessionId: true })
      .extend({ sessionId: z.templateLiteral(['workspace_', z.uuid()]) })
  )
  .query(async ({ input, ctx }) => {
    const access = await requireCurrentSessionAccess({
      env: ctx.env,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: input.sessionId,
      validatedSessionAccess: ctx.validatedSessionAccess,
    });
    if (input.cursor !== undefined) {
      let cursor: ReturnType<typeof decodeSessionHistoryCursor>;
      try {
        cursor = decodeSessionHistoryCursor(input.cursor);
      } catch {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid session history cursor' });
      }
      if (
        cursor.sessionId !== input.sessionId ||
        cursor.rootKiloSessionId !== access.kiloSessionId ||
        cursor.kiloSessionId !== (input.kiloSessionId ?? access.kiloSessionId)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Session history cursor belongs to another session',
        });
      }
    }
    try {
      return await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, input.sessionId),
        stub =>
          stub.getSessionMessagesPage({
            cursor: input.cursor,
            limit: input.limit,
            kiloSessionId: input.kiloSessionId,
            expectedRootKiloSessionId: access.kiloSessionId,
          }),
        'getSessionMessagesPage'
      );
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session history is temporarily unavailable',
      });
    }
  });
