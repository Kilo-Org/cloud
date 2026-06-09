import type { BotPlatform } from '@/lib/bot/platforms/types';
import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { startTyping } from './typing';

function createThread(): Thread {
  return {
    startTyping: jest.fn(async () => undefined),
  } as unknown as Thread;
}

const message = {} as Message;
const platformIntegration = {} as PlatformIntegration;

describe('startTyping', () => {
  it('defaults to chat-sdk thread typing when the platform has no override', async () => {
    const botPlatform = {} as BotPlatform;
    const thread = createThread();

    const indicator = await startTyping({ botPlatform, thread, message, platformIntegration });
    await indicator.done();

    expect(thread.startTyping).toHaveBeenCalledWith('Thinking...');
  });

  it('uses the platform typing override when provided', async () => {
    const done = jest.fn(async () => undefined);
    const botPlatform = {
      startTyping: jest.fn(async () => ({ done })),
    } as unknown as BotPlatform;
    const thread = createThread();

    const indicator = await startTyping({ botPlatform, thread, message, platformIntegration });
    await indicator.done();

    expect(botPlatform.startTyping).toHaveBeenCalledWith({
      thread,
      message,
      platformIntegration,
      text: 'Thinking...',
    });
    expect(thread.startTyping).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });
});
