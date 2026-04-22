module.exports = {
  createSlackAdapter: jest.fn(() => ({
    getInstallation: jest.fn(),
    postMessage: jest.fn(),
    fetchThread: jest.fn(),
    removeReaction: jest.fn(),
    addReaction: jest.fn(),
    withBotToken: jest.fn(async (_token, fn) => fn()),
  })),
};
