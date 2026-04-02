import { updateBotRequest } from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { emoji } from 'chat';

export async function processMessage({
  thread,
  message,
  platformIntegration,
  user,
  botRequestId,
}: {
  thread: Thread;
  message: Message;
  platformIntegration: PlatformIntegration;
  user: User;
  botRequestId: string | undefined;
}) {
  const startedAt = Date.now();

  try {
    const result = await runBotAgent({
      thread,
      message,
      rawMessage: message,
      platformIntegration,
      user,
      botRequestId,
      prompt: message.text,
    });

    if (botRequestId) {
      updateBotRequest(botRequestId, {
        ...(result.startedCloudAgentSession ? {} : { status: 'completed' }),
        steps: [...result.collectedSteps],
        responseTimeMs: result.responseTimeMs,
      });
    }

    if (!result.startedCloudAgentSession) {
      const received = thread.createSentMessageFromMessage(message);
      await thread.post({ markdown: result.finalText });
      await Promise.all([received.removeReaction(emoji.eyes), received.addReaction(emoji.check)]);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    if (botRequestId) {
      updateBotRequest(botRequestId, {
        status: 'error',
        errorMessage: errMsg.slice(0, 2000),
        responseTimeMs: Date.now() - startedAt,
      });
    }

    console.error(`[KiloBot] Error during bot run:`, errMsg, error);

    const received = thread.createSentMessageFromMessage(message);
    await Promise.all([
      received.removeReaction(emoji.eyes).catch(() => {}),
      thread.post(`Sorry, there was an error calling the AI service: ${errMsg.slice(0, 200)}`),
    ]);
  }
}
