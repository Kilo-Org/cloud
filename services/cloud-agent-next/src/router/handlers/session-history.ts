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
import {
  toolPartDetailInputSchema,
  type ToolPartDetail,
} from '../../control-plane/session/tool-detail.js';

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
            toolDisplay: input.toolDisplay,
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

/**
 * Complete stored details for one tool call shown as a preview. Authorized on
 * every read like a history page; a client's cached marker is only a lookup hint.
 */
export const getSessionToolPartDetail = protectedProcedure
  .input(
    toolPartDetailInputSchema
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
    let detail: ToolPartDetail | null;
    try {
      // Stored JSON values do not narrow through the RPC stub's serializable types.
      detail = await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, input.sessionId),
        async stub => {
          const result: unknown = await stub.getSessionToolPartDetail({
            kiloSessionId: input.kiloSessionId,
            expectedRootKiloSessionId: access.kiloSessionId,
            messageId: input.messageId,
            partId: input.partId,
            callId: input.callId,
          });
          return result as ToolPartDetail | null;
        },
        'getSessionToolPartDetail'
      );
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Tool details are temporarily unavailable',
      });
    }
    if (detail === null) throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    return detail;
  });
