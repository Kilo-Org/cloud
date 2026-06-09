jest.mock(
  'chat',
  () => ({
    emoji: {
      eyes: { name: 'eyes' },
    },
  }),
  { virtual: true }
);

import { emoji, type Thread } from 'chat';
import { startTyping } from '@/lib/bot/typing';

function makeThread({
  adapterName,
  addReaction = jest.fn(),
  startTyping: startSdkTyping = jest.fn(),
}: {
  adapterName: string;
  addReaction?: jest.Mock;
  startTyping?: jest.Mock;
}) {
  return {
    id: `${adapterName}:thread-1`,
    adapter: {
      name: adapterName,
      addReaction,
    },
    startTyping: startSdkTyping,
  } as unknown as Thread;
}

describe('bot typing indicator', () => {
  it('uses chat-sdk typing for non-GitHub platforms', async () => {
    const addReaction = jest.fn();
    const startSdkTyping = jest.fn();
    const thread = makeThread({ adapterName: 'slack', addReaction, startTyping: startSdkTyping });

    const indicator = await startTyping(thread, {
      messageId: 'message-1',
      status: 'Thinking...',
    });
    await indicator.complete();

    expect(startSdkTyping).toHaveBeenCalledWith('Thinking...');
    expect(addReaction).not.toHaveBeenCalled();
  });

  it('uses GitHub reactions for start and completion', async () => {
    const addReaction = jest.fn();
    const startSdkTyping = jest.fn();
    const thread = makeThread({ adapterName: 'github', addReaction, startTyping: startSdkTyping });

    const indicator = await startTyping(thread, {
      messageId: '123',
      status: 'Thinking...',
    });
    await indicator.complete();

    expect(startSdkTyping).not.toHaveBeenCalled();
    expect(addReaction).toHaveBeenNthCalledWith(1, 'github:thread-1', '123', emoji.eyes);
    expect(addReaction).toHaveBeenNthCalledWith(2, 'github:thread-1', '123', '+1');
  });

  it('does not fail the bot when GitHub reactions fail', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const addReaction = jest.fn().mockRejectedValue(new Error('reaction failed'));
    const thread = makeThread({ adapterName: 'github', addReaction });

    const indicator = await startTyping(thread, { messageId: '123', status: 'Thinking...' });
    await indicator.complete();

    expect(addReaction).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
