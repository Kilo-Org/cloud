module.exports = {
  Chat: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    registerSingleton: jest.fn(),
    getAdapter: jest.fn(() => ({
      getInstallation: jest.fn(),
      postMessage: jest.fn(),
      fetchThread: jest.fn(),
      removeReaction: jest.fn(),
      addReaction: jest.fn(),
      withBotToken: jest.fn(async (_token, fn) => fn()),
    })),
    getState: jest.fn(),
    onNewMention: jest.fn(),
  })),
  emoji: { eyes: 'eyes', check: 'white_check_mark' },
};
