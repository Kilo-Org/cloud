import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import { extractAndUploadImages } from '@/lib/bot/images';
import { botPlatforms } from '@/lib/bot/platforms';
import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { captureException } from '@sentry/nextjs';

/**
 * Replay a user's original mention after their account is linked. Shared
 * between the Slack single-hop link route and the GitHub OAuth callback so
 * the experience is identical: link, then immediately pick up the message.
 */
export async function reprocessLinkedMessage({
  platformIntegration,
  thread,
  message,
  user,
}: {
  platformIntegration: PlatformIntegration;
  thread: Thread;
  message: Message;
  user: User;
}): Promise<void> {
  try {
    await botPlatforms.require(platformIntegration.platform).withAuthContext({
      platformIntegration,
      fn: async () => {
        await processLinkedMessage({ thread, message, platformIntegration, user });
      },
    });
  } catch (error) {
    console.error('[Bot] Failed to reprocess linked message:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'link-account-reprocess-message' },
      extra: {
        platform: platformIntegration.platform,
        threadId: thread.id,
        messageId: message.id,
        userId: user.id,
      },
    });
  }
}

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

  const botRequestId = await createBotRequest({
    createdBy: user.id,
    organizationId: platformIntegration.owned_by_organization_id ?? null,
    platformIntegrationId: platformIntegration.id,
    platform: thread.adapter.name,
    platformThreadId: thread.id,
    platformMessageId: message.id,
    userMessage: message.text,
    modelUsed: undefined,
  });

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
  botRequestId: string | undefined;
}) {
  const startedAt = Date.now();

  // Extract and upload any image attachments from the chat message to R2.
  // This runs before the agent loop so the images are ready when a Cloud Agent
  // session is spawned. Failures are non-fatal — we log and continue without images.
  let images: Awaited<ReturnType<typeof extractAndUploadImages>>;
  try {
    images = await extractAndUploadImages(message, user.id);
  } catch (error) {
    console.error('[KiloBot] Failed to extract/upload images, continuing without them:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'extract-upload-images' },
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
      images,
    });

    if (botRequestId) {
      updateBotRequest(botRequestId, {
        ...(result.startedCloudAgentSession ? {} : { status: 'completed' }),
        steps: [...result.collectedSteps],
        responseTimeMs: result.responseTimeMs,
      });
    }

    if (!result.startedCloudAgentSession) {
      await thread.post({ markdown: result.finalText });
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

    await Promise.all([
      thread.post(`Sorry, there was an error calling the AI service: ${errMsg.slice(0, 200)}`),
    ]);
  }
}
