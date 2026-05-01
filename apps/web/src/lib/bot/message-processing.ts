import { processMessage } from '@/lib/bot/run';
import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';

export async function processAuthenticatedBotMessage(params: {
  thread: Thread;
  message: Message;
  platformIntegration: PlatformIntegration;
  user: User;
}): Promise<void> {
  const platform = params.thread.id.split(':')[0];
  const botRequestId = await createBotRequest({
    createdBy: params.user.id,
    organizationId: params.platformIntegration.owned_by_organization_id ?? null,
    platformIntegrationId: params.platformIntegration.id,
    platform,
    platformThreadId: params.thread.id,
    platformMessageId: params.message.id,
    userMessage: params.message.text,
    modelUsed: undefined,
  });

  await params.thread.startTyping('Thinking...');

  try {
    await processMessage({
      thread: params.thread,
      message: params.message,
      platformIntegration: params.platformIntegration,
      user: params.user,
      botRequestId,
    });
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    if (botRequestId) {
      const errMsg = error instanceof Error ? error.message : String(error);
      updateBotRequest(botRequestId, {
        status: 'error',
        errorMessage: errMsg.slice(0, 2000),
      });
    }
    await params.thread.post({
      markdown: 'Sorry, something went wrong while processing your message.',
    });
  }
}
