import type { SlackEvent } from '@chat-adapter/slack';
import type { Thread, Message } from 'chat';

export function isChannelLevelMessage(thread: Thread, message: Message): boolean {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack': {
      const raw = (message as Message<SlackEvent>).raw;
      return !raw.thread_ts || raw.thread_ts === raw.ts;
    }
    default:
      return false;
  }
}
