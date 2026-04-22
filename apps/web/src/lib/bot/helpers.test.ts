import { getSlackDmReplyThreadParams } from '@/lib/bot/helpers';
import type { SlackEvent } from '@chat-adapter/slack';
import type { Message, Thread } from 'chat';

type ThreadLike = Pick<Thread, 'channelId' | 'id' | 'isDM'>;
type MessageLike = Pick<Message, 'id' | 'raw'>;

function slackThread(overrides: Partial<ThreadLike> = {}): ThreadLike {
  return {
    channelId: 'slack:D123',
    id: 'slack:D123:',
    isDM: true,
    ...overrides,
  };
}

function slackMessage(raw: SlackEvent): MessageLike {
  return {
    id: raw.ts ?? '1710000000.000100',
    raw,
  };
}

describe('getSlackDmReplyThreadParams', () => {
  it('roots top-level Slack DM responses at the triggering message timestamp', () => {
    const result = getSlackDmReplyThreadParams(
      slackThread(),
      slackMessage({
        channel: 'D123',
        channel_type: 'im',
        team: 'T123',
        text: 'hello',
        ts: '1710000000.000100',
        type: 'message',
        user: 'U123',
      })
    );

    expect(result).toEqual({
      channelId: 'slack:D123',
      isDM: true,
      threadId: 'slack:D123:1710000000.000100',
    });
  });

  it('leaves Slack DM thread replies unchanged', () => {
    const result = getSlackDmReplyThreadParams(
      slackThread({ id: 'slack:D123:1710000000.000100' }),
      slackMessage({
        channel: 'D123',
        channel_type: 'im',
        team: 'T123',
        text: 'reply',
        thread_ts: '1710000000.000100',
        ts: '1710000001.000200',
        type: 'message',
        user: 'U123',
      })
    );

    expect(result).toBeNull();
  });

  it('leaves Slack channel messages unchanged', () => {
    const result = getSlackDmReplyThreadParams(
      slackThread({ channelId: 'slack:C123', id: 'slack:C123:1710000000.000100', isDM: false }),
      slackMessage({
        channel: 'C123',
        channel_type: 'channel',
        team: 'T123',
        text: '<@BOT> hello',
        ts: '1710000000.000100',
        type: 'app_mention',
        user: 'U123',
      })
    );

    expect(result).toBeNull();
  });
});
