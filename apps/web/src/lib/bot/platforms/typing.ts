import type { Message, Thread } from 'chat';

export type BotStartTypingParams = {
  message?: Pick<Message, 'id'>;
  messageId?: string;
  status?: string;
  thread: Thread;
};

export type BotTypingIndicator = {
  complete(): Promise<void>;
};

export const noopBotTypingIndicator: BotTypingIndicator = {
  complete: async () => undefined,
};

export async function startSdkTypingIndicator({
  status,
  thread,
}: BotStartTypingParams): Promise<BotTypingIndicator> {
  await thread.startTyping(status);
  return noopBotTypingIndicator;
}
