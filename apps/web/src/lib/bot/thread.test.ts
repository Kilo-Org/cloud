jest.mock('@/lib/bot', () => ({
  bot: {
    getAdapter: jest.fn(),
    initialize: jest.fn(),
    registerSingleton: jest.fn(),
  },
}));

jest.mock(
  'chat',
  () => ({
    ThreadImpl: class ThreadImpl {
      readonly channelId: string;
      readonly id: string;
      readonly isDM: boolean;

      constructor(config: { channelId: string; id: string; isDM?: boolean }) {
        this.channelId = config.channelId;
        this.id = config.id;
        this.isDM = config.isDM ?? false;
      }
    },
  }),
  { virtual: true }
);

import { getBotThread } from '@/lib/bot/thread';

type MockBotModule = {
  bot: {
    getAdapter: jest.Mock;
    initialize: jest.Mock;
    registerSingleton: jest.Mock;
  };
};

const mockBotModule: MockBotModule = jest.requireMock('@/lib/bot');

describe('getBotThread', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockBotModule.bot.getAdapter.mockReturnValue({
      channelIdFromThreadId: jest.fn(() => 'slack:T123:C456'),
      getChannelVisibility: jest.fn(() => 'private'),
      isDM: jest.fn(() => false),
    });
  });

  it('constructs a Chat SDK thread for Slack thread ids', async () => {
    const thread = await getBotThread('slack:T123:C456:1710000000.000000');

    expect(mockBotModule.bot.initialize).toHaveBeenCalledTimes(1);
    expect(mockBotModule.bot.registerSingleton).toHaveBeenCalledTimes(1);
    expect(mockBotModule.bot.getAdapter).toHaveBeenCalledWith('slack');
    expect(thread.id).toBe('slack:T123:C456:1710000000.000000');
    expect(thread.channelId).toBe('slack:T123:C456');
    expect(thread.isDM).toBe(false);
  });

  it('rejects thread ids without an adapter prefix', async () => {
    await expect(getBotThread('')).rejects.toThrow('Bot thread id is missing an adapter prefix');
  });

  it('rejects unsupported adapter prefixes', async () => {
    await expect(getBotThread('discord:guild:channel:thread')).rejects.toThrow(
      'No chat SDK adapter registered for platform discord'
    );
  });
});
