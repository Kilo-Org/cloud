import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { runBotAgent } from '@/lib/bot/agent-runner';
import {
  discardUploadedAttachments,
  extractAndUploadAttachments,
  type UploadedBotAttachments,
} from '@/lib/bot/attachments';
import { botPlatforms } from '@/lib/bot/platforms';
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
  const botPlatform = botPlatforms.requireByAdapter(thread.adapter);

  const authorization = await botPlatform.authorizeBotActions?.({
    thread,
    message,
    platformIntegration,
  });
  if (authorization && !authorization.allowed) {
    await botPlatform.withAuthContext({
      platformIntegration,
      fn: () => thread.post({ markdown: authorization.markdown }),
    });
    return;
  }

  const stopProcessingIndicator = await botPlatform.startProcessingIndicator({
    thread,
    messageId: message.id,
    status: 'Thinking...',
    platformIntegration,
  });

  let handedOff = false;
  try {
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
      await botPlatform.withAuthContext({
        platformIntegration,
        fn: () =>
          thread.post({
            markdown:
              'Sorry, I could not start processing your message because of an internal error. Please try again in a moment.',
          }),
      });
      return;
    }

    handedOff = await processMessage({
      thread,
      message,
      platformIntegration,
      user,
      botRequestId,
    });
  } finally {
    await stopProcessingIndicator({ handedOff });
  }
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
}): Promise<boolean> {
  const startedAt = Date.now();
  const botPlatform = botPlatforms.requireByAdapter(thread.adapter);

  // Upload all supported files through the canonical attachments contract so
  // mixed image/document messages share one path and one five-file limit.
  let uploadedAttachments: UploadedBotAttachments | undefined;
  try {
    uploadedAttachments = await extractAndUploadAttachments(message, user.id);
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
      attachments: uploadedAttachments?.attachments,
      actorLogin: message.author.userName,
    });

    updateBotRequest(botRequestId, {
      ...(result.startedCloudAgentSession ? {} : { status: 'completed' }),
      steps: [...result.collectedSteps],
      responseTimeMs: result.responseTimeMs,
    });

    if (!result.startedCloudAgentSession) {
      // The run never handed these files to a session, so release their
      // pending rows and objects now. The reclaim starts before the reply and
      // is still awaited before returning, so the user is not held behind
      // storage work and the invocation does not leave it behind.
      const discarded = discardUploadedAttachments(user.id, uploadedAttachments);
      await botPlatform.withAuthContext({
        platformIntegration,
        fn: () => thread.post({ markdown: result.finalText }),
      });
      await discarded;
    }

    return result.startedCloudAgentSession;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // A started session's rows are already linked, so this only reclaims the
    // uploads of a run that failed before a session took them. Start it before
    // the error reply and await it at the end of the branch.
    const discarded = discardUploadedAttachments(user.id, uploadedAttachments);

    updateBotRequest(botRequestId, {
      status: 'error',
      errorMessage: errMsg.slice(0, 2000),
      responseTimeMs: Date.now() - startedAt,
    });

    console.error(`[KiloBot] Error during bot run:`, errMsg, error);

    await botPlatform.withAuthContext({
      platformIntegration,
      fn: () =>
        thread.post(`Sorry, there was an error calling the AI service: ${errMsg.slice(0, 200)}`),
    });
    await discarded;

    return false;
  }
}
