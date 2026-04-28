import { updateBotRequest } from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import { extractAndUploadImages } from '@/lib/bot/images';
import type { PlatformIntegration, User } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { captureException } from '@sentry/nextjs';

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

  // Extract and upload any image attachments from the Slack message to R2.
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
