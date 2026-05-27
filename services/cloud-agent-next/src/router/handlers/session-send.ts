/**
 * New primary public surface for sending a message to an existing
 * cloud-agent session.
 *
 * `send` always enqueues through the shared `queueMessage` helper. The
 * alarm-driven flusher handles cold-start runtime restoration and delivery.
 *
 * Auth: user-protected (same as `sendMessageV2`).
 */
import { protectedProcedure } from '../auth.js';
import { logger, withLogTags } from '../../logger.js';
import { SendMessageInput, ExecutionResponse } from '../schemas.js';
import { queueMessage, replayMessageIfAlreadyAdmitted } from '../../session/queue-message.js';
import type { SessionId } from '../../types/ids.js';
import { preflightExistingPromptModel } from '../../session/model-preflight.js';

type SessionSendHandlers = {
  send: typeof sendMessageHandler;
};

export function createSessionSendHandlers(): SessionSendHandlers {
  return { send: sendMessageHandler };
}

const sendMessageHandler = protectedProcedure
  .input(SendMessageInput)
  .output(ExecutionResponse)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'send' }, async () => {
      const sessionId = input.cloudAgentSessionId as SessionId;
      logger.setTags({ userId: ctx.userId, sessionId });
      logger.info('Sending message via unified send endpoint');
      const queuedMessage = {
        cloudAgentSessionId: input.cloudAgentSessionId,
        turn: {
          type: 'prompt' as const,
          id: input.message.id ?? undefined,
          prompt: input.message.prompt,
          images: input.message.images,
        },
        agent: input.agent,
        finalization: input.finalization,
      };
      const admissionContext = { env: ctx.env, userId: ctx.userId, botId: ctx.botId };
      const replay = await replayMessageIfAlreadyAdmitted(queuedMessage, admissionContext);
      if (replay) return replay;

      await preflightExistingPromptModel({
        env: ctx.env,
        userId: ctx.userId,
        cloudAgentSessionId: input.cloudAgentSessionId,
        requestedModel: input.agent?.model,
        procedure: 'send',
      });

      const ack = await queueMessage(queuedMessage, admissionContext);
      return ack;
    });
  });
