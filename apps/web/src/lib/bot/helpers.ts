import type { SlackEvent } from '@chat-adapter/slack';
import type { Thread, Message } from 'chat';

type SlackMessageLike = Pick<Message, 'id' | 'raw'>;
type ThreadLike = Pick<Thread, 'channelId' | 'id' | 'isDM'>;

export type SlackDmReplyThreadParams = {
  channelId: string;
  isDM: true;
  threadId: string;
};

function slackChannelFromChannelId(channelId: string): string | undefined {
  const [platform, channel] = channelId.split(':');
  if (platform !== 'slack' || !channel) return undefined;
  return channel;
}

export function getSlackDmReplyThreadParams(
  thread: ThreadLike,
  message: SlackMessageLike
): SlackDmReplyThreadParams | null {
  const platform = thread.id.split(':')[0];
  if (platform !== 'slack' || !thread.isDM) return null;

  const raw = (message as Pick<Message<SlackEvent>, 'id' | 'raw'>).raw;
  if (raw.channel_type && raw.channel_type !== 'im') return null;
  if (raw.thread_ts) return null;

  const channel = raw.channel ?? slackChannelFromChannelId(thread.channelId);
  const messageTs = raw.ts ?? message.id;
  if (!channel || !messageTs) return null;

  const threadId = `slack:${channel}:${messageTs}`;
  if (thread.id === threadId) return null;

  return {
    channelId: `slack:${channel}`,
    isDM: true,
    threadId,
  };
}

export function isChannelLevelMessage(thread: Thread, message: Message): boolean {
  const platform = thread.id.split(':')[0];

  switch (platform) {
    case 'slack': {
      if (thread.isDM) return false;

      const raw = (message as Message<SlackEvent>).raw;
      return !raw.thread_ts || raw.thread_ts === raw.ts;
    }
    default:
      return false;
  }
}
