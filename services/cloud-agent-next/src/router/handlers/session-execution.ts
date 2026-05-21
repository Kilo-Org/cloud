/**
 * Legacy V2 execution handlers — thin proxies over the shared `queueMessage`
 * helper.
 *
 * `initiateFromKilocodeSessionV2` queues the first message on a session that
 * was registered via `prepareSession`. Callers do not pass a prompt, so the
 * handler sends an explicit `registered-initial` command.
 *
 * `sendMessageV2` queues follow-up messages with full configuration
 * overrides (mode, model, variant, autoCommit, etc.).
 *
 * New callers should prefer the unified `start` / `send` endpoints.
 */
import { protectedProcedure } from '../auth.js';
import { logger, withLogTags } from '../../logger.js';
import {
  InitiateFromPreparedSessionInput,
  SendMessageV2Input,
  LegacyExecutionResponse,
} from '../schemas.js';
import type { SessionId } from '../../types/ids.js';
import { queueMessage } from '../../session/queue-message.js';
import type {
  AgentSelectionOverride,
  PromptSubmission,
  RepositoryAuthOverrides,
  TurnFinalization,
} from '../../execution/types.js';
import type { QueueAckResponse } from '../schemas.js';

function withLegacyExecutionId(ack: QueueAckResponse): LegacyExecutionResponse {
  return {
    ...ack,
    executionId: ack.messageId,
  };
}

export function createSessionExecutionV2Handlers() {
  return {
    initiateFromKilocodeSessionV2: protectedProcedure
      .input(InitiateFromPreparedSessionInput)
      .output(LegacyExecutionResponse)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'initiateFromKilocodeSessionV2' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          logger.setTags({ userId: ctx.userId, sessionId, preparedSession: true });
          logger.info('Initiating V2 session from prepared session');

          const ack = await queueMessage(
            {
              kind: 'registered-initial',
              cloudAgentSessionId: input.cloudAgentSessionId,
            },
            { env: ctx.env, userId: ctx.userId, botId: ctx.botId }
          );
          return withLegacyExecutionId(ack);
        });
      }),

    sendMessageV2: protectedProcedure
      .input(SendMessageV2Input)
      .output(LegacyExecutionResponse)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'sendMessageV2' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          logger.setTags({ userId: ctx.userId, sessionId });
          logger.info('Sending V2 message to existing session');

          const ack = await queueMessage(
            {
              kind: 'user-message',
              cloudAgentSessionId: input.cloudAgentSessionId,
              message: {
                id: input.messageId ?? undefined,
                prompt: input.prompt,
                images: input.images,
              } satisfies PromptSubmission,
              agent: {
                mode: input.mode,
                model: input.model,
                variant: input.variant,
              } satisfies AgentSelectionOverride,
              finalization: {
                autoCommit: input.autoCommit,
                condenseOnComplete: input.condenseOnComplete,
              } satisfies TurnFinalization,
              tokenOverrides: {
                githubToken: input.githubToken,
                gitToken: input.gitToken,
              } satisfies RepositoryAuthOverrides,
            },
            { env: ctx.env, userId: ctx.userId, botId: ctx.botId }
          );
          return withLegacyExecutionId(ack);
        });
      }),
  };
}
