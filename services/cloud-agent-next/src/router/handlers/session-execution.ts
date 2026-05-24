/**
 * Legacy V2 execution handlers — thin proxies over the shared `queueMessage`
 * helper.
 *
 * `initiateFromKilocodeSessionV2` queues the first message on a session that
 * was registered via `prepareSession`. Callers do not pass a prompt, so the
 * handler calls the retained prepared-initial admission adapter, which resolves
 * the stored initial turn before invoking current durable admission.
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
import { admitLegacyPreparedInitialMessage } from '../../session/legacy-prepared-admission.js';
import type {
  AgentSelectionOverride,
  ExecutionTurnSubmission,
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

          const ack = await admitLegacyPreparedInitialMessage(
            { cloudAgentSessionId: input.cloudAgentSessionId },
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

          const commandPayload =
            'payload' in input && input.payload.type === 'command' ? input.payload : undefined;
          const promptPayload =
            'prompt' in input
              ? {
                  prompt: input.prompt,
                  mode: input.mode,
                  model: input.model,
                  variant: input.variant,
                }
              : 'payload' in input && input.payload.type === 'prompt'
                ? input.payload
                : undefined;
          let turn: ExecutionTurnSubmission;
          let agent: AgentSelectionOverride | undefined;
          if (commandPayload) {
            turn = {
              type: 'command',
              id: input.messageId ?? undefined,
              command: commandPayload.command,
              arguments: commandPayload.arguments,
              images: input.images,
            };
          } else if (promptPayload) {
            turn = {
              type: 'prompt',
              id: input.messageId ?? undefined,
              prompt: promptPayload.prompt,
              images: input.images,
            };
            agent = {
              mode: promptPayload.mode,
              model: promptPayload.model,
              variant: promptPayload.variant,
            };
          } else {
            throw new Error('sendMessageV2 payload is missing a prompt or command turn');
          }

          const ack = await queueMessage(
            {
              cloudAgentSessionId: input.cloudAgentSessionId,
              turn,
              agent,
              finalization: {
                autoCommit: input.autoCommit,
                condenseOnComplete: input.condenseOnComplete,
              } satisfies TurnFinalization,
            },
            { env: ctx.env, userId: ctx.userId, botId: ctx.botId }
          );
          return withLegacyExecutionId(ack);
        });
      }),
  };
}
