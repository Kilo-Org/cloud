import { createGateway, generateText } from 'ai';

import { validateMiniMaxCodingPlanCredential } from '@/lib/coding-plans/inventory-validation';

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

describe('validateMiniMaxCodingPlanCredential', () => {
  it('tests MiniMax inventory credentials through ordinary BYOK routing with a minimal request', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateMiniMaxCodingPlanCredential({
        apiKey: 'minimax-inventory-key',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: 'minimax-token-plan-plus-123',
      })
    ).resolves.toBe(true);

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

    await expect(
      validateMiniMaxCodingPlanCredential({
        apiKey: 'limited-key',
        planId: 'minimax-token-plan-max',
        upstreamPlanId: 'provider-issued-plan-123',
      })
    ).resolves.toBe(true);
  });

  it('rejects unsuccessful model completions', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'error' } as never);

    await expect(
      validateMiniMaxCodingPlanCredential({
        apiKey: 'failed-key',
        planId: 'minimax-token-plan-ultra',
        upstreamPlanId: 'minimax-token-plan-ultra-123',
      })
    ).resolves.toBe(false);
  });

  it('rejects provider request failures without throwing', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('credential rejected'));

    await expect(
      validateMiniMaxCodingPlanCredential({
        apiKey: 'invalid-key',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: 'minimax-token-plan-plus-123',
      })
    ).resolves.toBe(false);
  });

  it('treats upstream plan IDs as opaque operational metadata', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateMiniMaxCodingPlanCredential({
        apiKey: 'opaque-plan-key',
        planId: 'minimax-token-plan-ultra',
        upstreamPlanId: 'provider-plan-without-tier-marker',
      })
    ).resolves.toBe(true);

    expect(mockedGenerateText).toHaveBeenCalled();
  });
});
