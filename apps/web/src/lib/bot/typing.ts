import { emoji, type EmojiValue, type Message, type Thread } from 'chat';

type BotTypingIndicatorOptions = {
  message?: Pick<Message, 'id'>;
  messageId?: string;
  status?: string;
};

export type BotTypingIndicator = {
  complete(): Promise<void>;
};

const GITHUB_ADAPTER_NAME = 'github';
const GITHUB_COMPLETE_REACTION = '+1';

const noopTypingIndicator: BotTypingIndicator = {
  complete: async () => undefined,
};

export async function startTyping(
  thread: Thread,
  options: BotTypingIndicatorOptions = {}
): Promise<BotTypingIndicator> {
  const messageId = options.messageId ?? options.message?.id;

  if (thread.adapter.name !== GITHUB_ADAPTER_NAME || !messageId) {
    await startSdkTyping(thread, options.status);
    return noopTypingIndicator;
  }

  await addGitHubReaction(thread, messageId, emoji.eyes, 'start');

  return {
    complete: async () => {
      await addGitHubReaction(thread, messageId, GITHUB_COMPLETE_REACTION, 'complete');
    },
  };
}

async function startSdkTyping(thread: Thread, status: string | undefined): Promise<void> {
  await thread.startTyping(status);
}

async function addGitHubReaction(
  thread: Thread,
  messageId: string,
  reaction: EmojiValue | string,
  stage: 'start' | 'complete'
): Promise<void> {
  try {
    await thread.adapter.addReaction(thread.id, messageId, reaction);
  } catch (error) {
    console.warn('[KiloBot] Failed to update GitHub bot progress reaction:', {
      error,
      messageId,
      stage,
      threadId: thread.id,
    });
  }
}
