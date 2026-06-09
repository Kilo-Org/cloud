import type { BotPlatform, BotTypingIndicator } from '@/lib/bot/platforms/types';
import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';

export const noopTypingIndicator: BotTypingIndicator = {
  async done() {},
};

export async function startTyping(params: {
  botPlatform: BotPlatform;
  thread: Thread;
  message: Message;
  platformIntegration: PlatformIntegration;
  text?: string;
}): Promise<BotTypingIndicator> {
  const text = params.text ?? 'Thinking...';
  const platformIndicator = await params.botPlatform.startTyping?.({
    thread: params.thread,
    message: params.message,
    platformIntegration: params.platformIntegration,
    text,
  });

  if (platformIndicator) return platformIndicator;

  await params.thread.startTyping(text);
  return noopTypingIndicator;
}
