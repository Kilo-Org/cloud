import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId, Env } from '../../types.js';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { fetchSessionMetadata } from '../../session/metadata.js';
import { cloudAgentManagedProcedure, protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { answerWithAdmission } from '../../session/answer-admission.js';
import type { ResolvedPayer } from '../../session/prompt-balance.js';
import {
  pendingQueueFullAdmissionFailure,
  throwAdmissionError,
} from '../../session/queue-message.js';
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
  reply: ControlPlaneAnswerReply,
  /** The payer the mutation's own access gate already resolved. */
  resolvedPayer: ResolvedPayer,
  ctx?: SecretsExecutionContext
): Promise<{ success: boolean }> {
  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  const outcome = await answerWithAdmission({
    env,
    ctx,
    userId,
    ...(authToken === undefined ? {} : { authToken }),
    cloudAgentSessionId: sessionId,
    resolvedPayer,
    reply,
  });
  switch (outcome.outcome) {
    case 'sent':
      return { success: true };
    case 'not_pending':
      return { success: false };
    case 'queue-full':
      // The same retryable capacity refusal a prompt reports.
      return throwAdmissionError(pendingQueueFullAdmissionFailure());
    case 'invalid':
      // The reply carries nothing to send. The interaction still waits, so this
      // is a malformed request, not a dead interaction.
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The answer carries no text; reply again',
      });
    case 'retryable':
      // The interaction still waits; only the session moved on. `CONFLICT` is
      // not a terminal client code, and the cause marks the retry explicitly.
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The session moved on; send the answer again',
        cause: { error: 'ANSWER_RETRY_REQUIRED', retryable: true },
      });
    case 'unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Durable prompt admission is unavailable',
      });
    case 'balance':
      // Mirror the facade projection: a payer scope the caller cannot reach is a
      // hidden root, and a read failure is retryable.
      throw new TRPCError({
        code:
          outcome.status === 402
            ? 'PAYMENT_REQUIRED'
            : outcome.status === 404
              ? 'NOT_FOUND'
              : outcome.status === 503
                ? 'SERVICE_UNAVAILABLE'
                : 'INTERNAL_SERVER_ERROR',
        message: outcome.message,
      });
  }
}

export function createSessionQuestionHandlers() {
  return {
    answerQuestion: cloudAgentManagedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
          organizationId: z.string().optional(),
          answers: z.array(z.array(z.string())),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'answerQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          try {
            const access = await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(
              env,
              userId,
              ctx.authToken,
              sessionId,
              {
                action: 'answer',
                questionId: input.questionId,
                answers: input.answers,
              },
              { organizationId: access.organizationId },
              ctx.executionCtx
            );
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

    rejectQuestion: cloudAgentManagedProcedure
      .input(
        z.object({
          sessionId: sessionIdSchema,
          questionId: z.string().min(1),
          organizationId: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'rejectQuestion' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;

          logger.setTags({ userId, sessionId });
          try {
            const access = await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(
              env,
              userId,
              ctx.authToken,
              sessionId,
              {
                action: 'reject',
                questionId: input.questionId,
              },
              { organizationId: access.organizationId },
              ctx.executionCtx
            );
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
            const access = await requireCurrentSessionAccess({
              env,
              kiloUserId: userId,
              cloudAgentSessionId: sessionId,
            });
            const result = await answerControlPlane(
              env,
              userId,
              ctx.authToken,
              sessionId,
              {
                action: 'permission',
                permissionId: input.permissionId,
                response: input.response,
              },
              { organizationId: access.organizationId },
              ctx.executionCtx
            );
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
    getPendingInteractions: cloudAgentManagedProcedure
      .input(
        z.object({ cloudAgentSessionId: sessionIdSchema, organizationId: z.string().optional() })
      )
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
        const pending = await withDORetry(
          () => getSandboxSessionStub(env, userId, sessionId),
          (session): Promise<{ questions: unknown[]; permissions: unknown[] }> =>
            session.getPendingInteractions(),
          'getPendingInteractions'
        );
        return ctx.cloudAgentAuthority ? { ...pending, permissions: [] } : pending;
      }),
  };
}
