import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId, Env } from '../../types.js';
import { fetchSessionMetadata } from '../../session/metadata.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import type { ControlPlaneAnswerReply } from '../../shared/control-plane-protocol.js';
import { withDORetry } from '../../utils/do-retry.js';

/**
 * Forwards one question/permission reply to the control-plane Session DO and
 * projects its dispatch result onto the public `{success}` contract. The DO
 * reports `sent` only when the reply reached the live turn or was admitted as a
 * continuation, so `not_connected` is the public `success: false`.
 */
async function answerControlPlane(
  env: Env,
  userId: string,
  sessionId: SessionId,
  reply: ControlPlaneAnswerReply
): Promise<{ success: boolean }> {
  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  const dispatch = await withDORetry(
    () => getSandboxSessionStub(env, userId, sessionId),
    current => current.answer({ sessionId, reply }),
    'answer'
  );
  return { success: dispatch === 'sent' };
}

export function createSessionQuestionHandlers() {
  return {
    answerQuestion: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
          answers: z.array(z.array(z.string())),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'answerQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          try {
            await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(env, userId, sessionId, {
              action: 'answer',
              questionId: input.questionId,
              answers: input.answers,
            });
            logger
              .withFields({ questionId: input.questionId, success: result.success })
              .info('Question answer forwarded to session');
            return { success: result.success };
          } catch (error) {
            if (error instanceof TRPCError) throw error;
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Failed to answer question');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to answer question: ${errorMsg}`,
            });
          }
        });
      }),

    rejectQuestion: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'rejectQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          try {
            await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(env, userId, sessionId, {
              action: 'reject',
              questionId: input.questionId,
            });
            logger
              .withFields({ questionId: input.questionId, success: result.success })
              .info('Question rejection forwarded to session');
            return { success: result.success };
          } catch (error) {
            if (error instanceof TRPCError) throw error;
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Failed to reject question');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to reject question: ${errorMsg}`,
            });
          }
        });
      }),

    answerPermission: protectedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          permissionId: z.string().min(1),
          response: z.enum(['once', 'always', 'reject']),
        })
      )
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'answerPermission' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          try {
            await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(env, userId, sessionId, {
              action: 'permission',
              permissionId: input.permissionId,
              response: input.response,
            });
            logger
              .withFields({ permissionId: input.permissionId, success: result.success })
              .info('Permission answer forwarded to session');
            return { success: result.success };
          } catch (error) {
            if (error instanceof TRPCError) throw error;
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: errorMsg }).error('Failed to answer permission');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to answer permission: ${errorMsg}`,
            });
          }
        });
      }),

    /**
     * Read the interactions a session currently waits on. A caller must own the
     * session: an unauthorized read fails rather than reporting an empty pending
     * set.
     */
    getPendingInteractions: protectedProcedure
      .input(z.object({ cloudAgentSessionId: sessionIdSchema }))
      .output(
        z.object({
          questions: z.array(z.unknown()),
          permissions: z.array(z.unknown()),
        })
      )
      .query(async ({ input, ctx }) => {
        const { userId, env } = ctx;
        const sessionId = input.cloudAgentSessionId as SessionId;
        await requireCurrentSessionAccess({
          env,
          kiloUserId: userId,
          cloudAgentSessionId: sessionId,
        });
        return await withDORetry(
          () => getSandboxSessionStub(env, userId, sessionId),
          session => session.getPendingInteractions(),
          'getPendingInteractions'
        );
      }),
  };
}
