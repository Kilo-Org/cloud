import { bot } from '@/lib/bot';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import type { PlatformIdentity } from '@/lib/bot-identity';
import { captureException } from '@sentry/nextjs';
import type { User } from '@kilocode/db';
import type { Message, Thread } from 'chat';

export async function reprocessLinkedMessage(params: {
  identity: PlatformIdentity;
  thread: Thread;
  message: Message;
  user: User;
  op: string;
}): Promise<void> {
  const { identity, thread, message, user, op } = params;
  try {
    const platformIntegration = await getPlatformIntegration(identity);
    if (!platformIntegration) return;

    await botPlatforms.require(platformIntegration.platform).withAuthContext({
      platformIntegration,
      fn: async () => {
        await processLinkedMessage({
          thread,
          message,
          platformIntegration,
          user,
        });
      },
    });
  } catch (error) {
    console.error('[Bot] Failed to reprocess linked message:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op },
      extra: {
        threadId: thread.id,
        messageId: message.id,
        userId: user.id,
      },
    });
  }
}

export async function initializeBotForLinkReplay() {
  await bot.initialize();
  return bot;
}
