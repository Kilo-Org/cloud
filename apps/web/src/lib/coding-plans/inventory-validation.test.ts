import { createGateway, generateText } from 'ai';

import { validateTokenPlanPlusCredential } from '@/lib/coding-plans/inventory-validation';

jest.mock('ai', () => ({
  createGateway: jest.fn(() => jest.fn((modelId: string) => ({ modelId }))),
  generateText: jest.fn(),
}));

jest.mock('@/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => jest.fn()),
}));

const mockedGenerateText = jest.mocked(generateText);

afterEach(() => {
  jest.clearAllMocks();
});

describe('validateTokenPlanPlusCredential', () => {
  it('tests MiniMax inventory credentials through ordinary BYOK routing with a minimal request', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(validateTokenPlanPlusCredential('minimax-inventory-key')).resolves.toBe(true);

    expect(createGateway).toHaveBeenCalled();
    expect(mockedGenerateText).toHaveBeenCalledWith({
      model: { modelId: 'minimax/minimax-m2.5' },
      prompt: 'Say hi',
      maxOutputTokens: 1,
      providerOptions: {
        gateway: {
          only: ['minimax'],
          byok: { minimax: [{ apiKey: 'minimax-inventory-key' }] },
        },
      },
    });
  });

  it('accepts a token-limited response after successful MiniMax routing', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'length' } as never);

    await expect(validateTokenPlanPlusCredential('limited-key')).resolves.toBe(true);
  });

  it('rejects unsuccessful model completions', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'error' } as never);

    await expect(validateTokenPlanPlusCredential('failed-key')).resolves.toBe(false);
  });

  it('rejects provider request failures without throwing', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('credential rejected'));

    await expect(validateTokenPlanPlusCredential('invalid-key')).resolves.toBe(false);
  });
});
