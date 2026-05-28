import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import { extractAndUploadAttachments } from '@/lib/bot/attachments';
import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { captureException } from '@sentry/nextjs';

export async function processLinkedMessage({
  thread,
  message,
  platformIntegration,
  user,
}: {
  thread: Thread;
  message: Message;
  platformIntegration: PlatformIntegration;
  user: User;
}) {
  await thread.startTyping('Thinking...');

  let botRequestId: string;
  try {
    botRequestId = await createBotRequest({
      createdBy: user.id,
      organizationId: platformIntegration.owned_by_organization_id ?? null,
      platformIntegrationId: platformIntegration.id,
      platform: thread.adapter.name,
      platformThreadId: thread.id,
      platformMessageId: message.id,
      userMessage: message.text,
      modelUsed: undefined,
    });
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'create-bot-request' },
      extra: {
        platform: thread.adapter.name,
        platformIntegrationId: platformIntegration.id,
        userId: user.id,
        threadId: thread.id,
        messageId: message.id,
      },
    });
    await thread.post({
      markdown:
        'Sorry, I could not start processing your message because of an internal error. Please try again in a moment.',
    });
    return;
  }

  await processMessage({ thread, message, platformIntegration, user, botRequestId });
}

async function processMessage({
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
  botRequestId: string;
}) {
  const startedAt = Date.now();

  // Upload all supported files through the canonical attachments contract so
  // mixed image/document messages share one path and one five-file limit.
  let attachments: Awaited<ReturnType<typeof extractAndUploadAttachments>>;
  try {
    attachments = await extractAndUploadAttachments(message, user.id);
  } catch (error) {
    console.error(
      '[KiloBot] Failed to extract/upload attachments, continuing without them:',
      error
    );
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'extract-upload-attachments' },
    });
  }

  try {
    const result = await runBotAgent({
      thread,
      message,
      rawMessage: message,
      platformIntegration,
      user,
      botRequestId,
      prompt: message.text,
      attachments,
    });

    updateBotRequest(botRequestId, {
      ...(result.startedCloudAgentSession ? {} : { status: 'completed' }),
      steps: [...result.collectedSteps],
      responseTimeMs: result.responseTimeMs,
    });

    if (!result.startedCloudAgentSession) {
      await thread.post({ markdown: result.finalText });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    updateBotRequest(botRequestId, {
      status: 'error',
      errorMessage: errMsg.slice(0, 2000),
      responseTimeMs: Date.now() - startedAt,
    });

    console.error(`[KiloBot] Error during bot run:`, errMsg, error);

    await Promise.all([
      thread.post(`Sorry, there was an error calling the AI service: ${errMsg.slice(0, 200)}`),
    ]);
  }
}
