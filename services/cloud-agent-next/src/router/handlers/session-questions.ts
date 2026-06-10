import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { createAgentSandbox } from '../../agent-sandbox/factory.js';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId, Env } from '../../types.js';
import { fetchSessionMetadata } from '../../session-service.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import type { WrapperClient } from '../../kilo/wrapper-client.js';

async function resolveWrapperClient(opts: {
  sessionId: SessionId;
  userId: string;
  env: Env;
}): Promise<WrapperClient> {
  const { sessionId, userId, env } = opts;
  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }

  const wrapperClient = await createAgentSandbox(env, metadata).getRunningWrapper();
  if (!wrapperClient) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No wrapper found for session' });
  }
  return wrapperClient;
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
            const wrapperClient = await resolveWrapperClient({ sessionId, userId, env });
            const result = await wrapperClient.answerQuestion(input.questionId, input.answers);
            logger
              .withFields({ questionId: input.questionId, success: result.success })
              .info('Question answer forwarded to wrapper');
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
            const wrapperClient = await resolveWrapperClient({ sessionId, userId, env });
            const result = await wrapperClient.rejectQuestion(input.questionId);
            logger
              .withFields({ questionId: input.questionId, success: result.success })
              .info('Question rejection forwarded to wrapper');
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
            const wrapperClient = await resolveWrapperClient({ sessionId, userId, env });
            const result = await wrapperClient.answerPermission(input.permissionId, input.response);
            logger
              .withFields({ permissionId: input.permissionId, success: result.success })
              .info('Permission answer forwarded to wrapper');
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
  };
}
