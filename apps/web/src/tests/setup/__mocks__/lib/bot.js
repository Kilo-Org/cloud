const mockInitialize = jest.fn();
const mockRegisterSingleton = jest.fn();
const mockGetAdapter = jest.fn(() => ({
  getInstallation: jest.fn(),
  postMessage: jest.fn(),
  fetchThread: jest.fn(),
  removeReaction: jest.fn(),
  addReaction: jest.fn(),
  withBotToken: jest.fn(async (_token, fn) => fn()),
}));
const mockGetState = jest.fn();
const mockOnNewMention = jest.fn();

const mockBot = {
  initialize: mockInitialize,
  registerSingleton: mockRegisterSingleton,
  getAdapter: mockGetAdapter,
  getState: mockGetState,
  onNewMention: mockOnNewMention,
};

module.exports = {
  bot: mockBot,
};
