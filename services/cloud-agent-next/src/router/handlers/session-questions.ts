import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { createAgentSandbox } from '../../agent-sandbox/factory.js';
import { AgentSandboxUnavailableError } from '../../agent-sandbox/protocol.js';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId, Env } from '../../types.js';
import { fetchSessionMetadata } from '../../session-service.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import type { WrapperClient } from '../../kilo/wrapper-client.js';
import { WrapperError } from '../../kilo/wrapper-client.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { sessionPlaneFromId } from '../../session-plane.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';

type InteractiveSessionTarget =
  | { kind: 'control'; stub: ReturnType<typeof getSandboxSessionStub> }
  | { kind: 'legacy'; wrapper: WrapperClient };

async function resolveInteractiveSession(opts: {
  sessionId: SessionId;
  userId: string;
  env: Env;
}): Promise<InteractiveSessionTarget> {
  const { sessionId, userId, env } = opts;
  await requireCurrentSessionAccess({
    env,
    kiloUserId: userId,
    cloudAgentSessionId: sessionId,
  });
  const metadata = await fetchSessionMetadata(env, userId, sessionId);
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }

  if (sessionPlaneFromId(sessionId) === 'control') {
    return { kind: 'control', stub: getSandboxSessionStub(env, userId, sessionId) };
  }

  let wrapperClient: WrapperClient | null;
  try {
    wrapperClient = await createAgentSandbox(env, metadata).getRunningWrapper();
  } catch (error) {
    if (error instanceof AgentSandboxUnavailableError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message });
    }
    throw error;
  }
  if (!wrapperClient) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No wrapper found for session' });
  }
  return { kind: 'legacy', wrapper: wrapperClient };
}

/**
 * A legacy (`agent_*`) session's pending set, read from its wrapper: that plane
 * keeps none in a Durable Object, so the wrapper's live Kilo state is the only
 * read there is. Returns null when the wrapper cannot answer — it is not
 * running, it has no session bound yet, or it predates the read route — which
 * the caller reports as nothing pending: the answer this query gave for a
 * legacy session before the wrapper could be read at all, so the press still
 * hands the user to the app instead of dead-ending on an error.
 */
async function readLegacyPendingInteractions(opts: {
  sessionId: SessionId;
  userId: string;
  env: Env;
}): Promise<{ questions: unknown[]; permissions: unknown[] } | null> {
  try {
    const target = await resolveInteractiveSession(opts);
    return target.kind === 'legacy' ? await target.wrapper.getPendingInteractions() : null;
  } catch (error) {
    // Ownership still fails the read. An absent or unreachable wrapper, and a
    // wrapper too old to have the read route, have nothing to report: the
    // answer they leave is "nothing pending", not an error.
    if (
      error instanceof TRPCError &&
      (error.code === 'NOT_FOUND' || error.code === 'PRECONDITION_FAILED')
    ) {
      return null;
    }
    // A wrapper that is running but has no Kilo session bound yet answers
    // `NO_SESSION` (400). It has nothing to report for the same reason an old
    // wrapper without the route does, so it folds into the empty set too.
    if (
      error instanceof WrapperError &&
      (error.code === 'NO_SESSION' || error.statusCode === 404 || error.statusCode === 405)
    ) {
      return null;
    }
    throw error;
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
            const target = await resolveInteractiveSession({ sessionId, userId, env });
            const result =
              target.kind === 'control'
                ? await target.stub.answerQuestion({
                    questionId: input.questionId,
                    answers: input.answers,
                  })
                : await target.wrapper.answerQuestion(input.questionId, input.answers);
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
            const target = await resolveInteractiveSession({ sessionId, userId, env });
            const result =
              target.kind === 'control'
                ? await target.stub.rejectQuestion({ questionId: input.questionId })
                : await target.wrapper.rejectQuestion(input.questionId);
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
            const target = await resolveInteractiveSession({ sessionId, userId, env });
            const result =
              target.kind === 'control'
                ? await target.stub.answerPermission({
                    permissionId: input.permissionId,
                    response: input.response,
                  })
                : await target.wrapper.answerPermission(input.permissionId, input.response);
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

    /**
     * Read the interactions a session currently waits on. A caller must own the
     * session: an unauthorized read fails rather than reporting an empty pending
     * set. A control-plane session keeps its pending set in its Durable Object;
     * a legacy `agent_*` session keeps none, so its read comes from the wrapper.
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
        if (sessionPlaneFromId(sessionId) === 'control') {
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });
          return await withDORetry(
            () => getSandboxSessionStub(env, userId, sessionId),
            stub => stub.getPendingInteractions(),
            'getPendingInteractions'
          );
        }
        const pending = await readLegacyPendingInteractions({ sessionId, userId, env });
        return pending ?? { questions: [], permissions: [] };
      }),
  };
}
