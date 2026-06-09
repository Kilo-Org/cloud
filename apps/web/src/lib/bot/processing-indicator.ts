import type { Message, Thread } from 'chat';
import { captureException } from '@sentry/nextjs';

export type StopProcessingIndicator = () => Promise<void>;

const NOOP: StopProcessingIndicator = async () => {};

/**
 * Signal that the bot is processing the user's message.
 *
 * Slack/Linear use the platform-native typing indicator (which decays on
 * its own). GitHub has no typing indicator, so we react to the triggering
 * comment instead: 👀 while running, 👍 once `stop()` is called.
 */
export async function startProcessingIndicator(
  thread: Thread,
  message: Message,
  status?: string
): Promise<StopProcessingIndicator> {
  try {
    if (thread.adapter.name === 'github') {
      await thread.adapter.addReaction(thread.id, message.id, 'eyes');
      return async () => {
        try {
          await Promise.all([
            thread.adapter.removeReaction(thread.id, message.id, 'eyes'),
            thread.adapter.addReaction(thread.id, message.id, 'thumbs_up'),
          ]);
        } catch (error) {
          captureException(error, {
            tags: { component: 'kilo-bot', op: 'stop-processing-indicator' },
            extra: {
              platform: thread.adapter.name,
              threadId: thread.id,
              messageId: message.id,
            },
          });
        }
      };
    }

    await thread.startTyping(status);
    return NOOP;
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'start-processing-indicator' },
      extra: {
        platform: thread.adapter.name,
        threadId: thread.id,
        messageId: message.id,
      },
    });
    return NOOP;
  }
}
