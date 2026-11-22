import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId, Env } from '../../types.js';
import { fetchSessionMetadata } from '../../session/metadata.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { answerWithAdmission } from '../../session/answer-admission.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import type { ControlPlaneAnswerReply } from '../../shared/control-plane-protocol.js';
import { withDORetry } from '../../utils/do-retry.js';

/**
 * Forwards one question/permission reply through the shared answer admission.
 * A live turn answers inside its own paid turn. An answer that would become a
 * new turn passes the balance and model preflight first, so a refusal reaches
 * the client as the same error the prompt mutation returns, and the pending
 * interaction stays answerable.
 */
async function answerControlPlane(
  env: Env,
  userId: string,
  authToken: string | undefined,
  sessionId: SessionId,
  reply: ControlPlaneAnswerReply
): Promise<{ success: boolean }> {
  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  const outcome = await answerWithAdmission({
    env,
    userId,
    ...(authToken === undefined ? {} : { authToken }),
    cloudAgentSessionId: sessionId,
    reply,
  });
  switch (outcome.outcome) {
    case 'sent':
      return { success: true };
    case 'not_pending':
      return { success: false };
    case 'unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Durable prompt admission is unavailable',
      });
    case 'balance':
      throw new TRPCError({
        code: outcome.status === 402 ? 'PAYMENT_REQUIRED' : 'INTERNAL_SERVER_ERROR',
        message: outcome.message,
      });
  }
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
            const result = await answerControlPlane(env, userId, ctx.authToken, sessionId, {
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
            const result = await answerControlPlane(env, userId, ctx.authToken, sessionId, {
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
            const result = await answerControlPlane(env, userId, ctx.authToken, sessionId, {
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
