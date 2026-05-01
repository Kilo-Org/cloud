import { bot } from '@/lib/bot';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { ThreadImpl, type Thread } from 'chat';

export async function getBotThread(threadId: string): Promise<Thread> {
  await bot.initialize();
  bot.registerSingleton();

  const adapterName = threadId.split(':', 1)[0];
  if (!adapterName) {
    throw new Error(`Bot thread id is missing an adapter prefix: ${threadId}`);
  }

  switch (adapterName) {
    case PLATFORM.SLACK: {
      const adapter = bot.getAdapter(PLATFORM.SLACK);
      return new ThreadImpl({
        adapterName,
        channelId: adapter.channelIdFromThreadId(threadId),
        channelVisibility: adapter.getChannelVisibility?.(threadId),
        id: threadId,
        isDM: adapter.isDM?.(threadId) ?? false,
      });
    }
    default:
      throw new Error(`No chat SDK adapter registered for platform ${adapterName}`);
  }
}
