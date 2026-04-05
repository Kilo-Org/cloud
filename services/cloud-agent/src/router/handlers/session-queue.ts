import { TRPCError } from '@trpc/server';
import { protectedProcedure } from '../auth.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { SessionId } from '../../types/ids.js';
import type { StartExecutionV2Request, StartExecutionV2Result } from '../../queue/types.js';
import { logger, withLogTags } from '../../logger.js';
import {
  InitiateFromPreparedSessionInput,
  SendMessageV2Input,
  type QueueAckResponse,
} from '../schemas.js';
import type { CloudAgentSession } from '../../persistence/CloudAgentSession.js';

function throwStartExecutionError(
  result: Extract<StartExecutionV2Result, { success: false }>
): never {
  const code =
    result.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : result.code === 'BAD_REQUEST'
        ? 'BAD_REQUEST'
        : 'INTERNAL_SERVER_ERROR';
  throw new TRPCError({
    code,
    message: result.error,
  });
}

/**
 * Get a typed DO stub for CloudAgentSession.
 */
function getSessionStub(
  env: { CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession> },
  doId: DurableObjectId
): DurableObjectStub<CloudAgentSession> {
  return env.CLOUD_AGENT_SESSION.get(doId);
}

/**
 * These handlers use DO-managed command queues for execution ordering.
 */
export function createSessionQueueV2Handlers() {
  return {
    /**
     * V2: Initialize from a prepared session.
     *
     * Uses a session created via prepareSession (for backend-to-backend flows).
     * The session must be in 'prepared' state (not yet initiated).
     * Calls DO.enqueueExecution() to start the first execution.
     */
    initiateFromKilocodeSessionV2: protectedProcedure
      .input(InitiateFromPreparedSessionInput)
      .mutation(async ({ input, ctx }): Promise<QueueAckResponse> => {
        return withLogTags({ source: 'initiateFromKilocodeSessionV2' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;

          logger.setTags({
            userId: ctx.userId,
            sessionId,
            preparedSession: true,
          });

          logger.info('Initiating V2 session from prepared session');

          // Get DO stub
          const doKey = `${ctx.userId}:${sessionId}`;
          const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey);

          const startRequest: StartExecutionV2Request = {
            kind: 'initiatePrepared',
            userId: ctx.userId as `user_${string}`,
            botId: ctx.botId,
            authToken: ctx.authToken,
          };

          const startResult = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            StartExecutionV2Result
          >(
            () => getSessionStub(ctx.env, doId),
            stub => stub.startExecutionV2(startRequest),
            'startExecutionV2'
          );

          if (!startResult.success) {
            throwStartExecutionError(startResult);
          }

          logger.info(`V2 prepared session enqueued: ${startResult.status}`);

          return {
            executionId: startResult.executionId,
            cloudAgentSessionId: sessionId,
            status: startResult.status,
            streamUrl: `/stream?cloudAgentSessionId=${sessionId}`,
          };
        });
      }),

    /**
     * V2: Send a message to an existing session.
     *
     * Enqueues a follow-up message to an established session.
     * If current execution is running, message is queued.
     * If no active execution, message starts immediately.
     */
    sendMessageV2: protectedProcedure
      .input(SendMessageV2Input)
      .mutation(async ({ input, ctx }): Promise<QueueAckResponse> => {
        return withLogTags({ source: 'sendMessageV2' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;

          logger.setTags({
            userId: ctx.userId,
            sessionId,
          });

          logger.info('Sending V2 message to existing session');

          // Get DO stub
          const doKey = `${ctx.userId}:${sessionId}`;
          const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey);

          const startRequest: StartExecutionV2Request = {
            kind: 'followup',
            userId: ctx.userId as `user_${string}`,
            botId: ctx.botId,
            prompt: input.prompt,
            mode: input.mode,
            model: input.model,
            autoCommit: input.autoCommit,
            condenseOnComplete: input.condenseOnComplete,
            tokenOverrides: {
              githubToken: input.githubToken,
              gitToken: input.gitToken,
            },
          };

          const startResult = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            StartExecutionV2Result
          >(
            () => getSessionStub(ctx.env, doId),
            stub => stub.startExecutionV2(startRequest),
            'startExecutionV2'
          );

          if (!startResult.success) {
            throwStartExecutionError(startResult);
          }

          logger.info(`V2 follow-up message enqueued: ${startResult.status}`);

          return {
            executionId: startResult.executionId,
            cloudAgentSessionId: sessionId,
            status: startResult.status,
            streamUrl: `/stream?cloudAgentSessionId=${sessionId}`,
          };
        });
      }),
  };
}
