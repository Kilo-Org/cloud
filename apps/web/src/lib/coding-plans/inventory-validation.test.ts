import { createGateway, generateText } from 'ai';

import { validateCodingPlanCredential } from '@/lib/coding-plans/inventory-validation';

const mockDirectModel = jest.fn((modelId: string) => ({ directModelId: modelId }));

jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  createAiSdkProvider: jest.fn(() => mockDirectModel),
}));

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

describe('validateCodingPlanCredential', () => {
  it('tests MiniMax inventory credentials through ordinary BYOK routing with a minimal request', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'minimax-inventory-key',
        planId: 'minimax-token-plan-plus',
        providerId: 'minimax',
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
      validateCodingPlanCredential({
        apiKey: 'limited-key',
        planId: 'minimax-token-plan-max',
        providerId: 'minimax',
        upstreamPlanId: 'provider-issued-plan-123',
      })
    ).resolves.toBe(true);
  });

  it('rejects unsuccessful model completions', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'error' } as never);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'failed-key',
        planId: 'minimax-token-plan-ultra',
        providerId: 'minimax',
        upstreamPlanId: 'minimax-token-plan-ultra-123',
      })
    ).resolves.toBe(false);
  });

  it('rejects provider request failures without throwing', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('credential rejected'));

    await expect(
      validateCodingPlanCredential({
        apiKey: 'invalid-key',
        planId: 'minimax-token-plan-plus',
        providerId: 'minimax',
        upstreamPlanId: 'minimax-token-plan-plus-123',
      })
    ).resolves.toBe(false);
  });

  it('treats upstream plan IDs as opaque operational metadata', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'opaque-plan-key',
        planId: 'minimax-token-plan-ultra',
        providerId: 'minimax',
        upstreamPlanId: 'provider-plan-without-tier-marker',
      })
    ).resolves.toBe(true);

    expect(mockedGenerateText).toHaveBeenCalled();
  });

  it('tests BytePlus credentials with its direct provider and validation model', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'byteplus-inventory-key',
        planId: 'byteplus-coding-plan-team-lite',
        providerId: 'byteplus-coding',
        upstreamPlanId: 'byteplus-plan-123',
      })
    ).resolves.toBe(true);

    expect(mockDirectModel).toHaveBeenCalledWith('bytedance-seed-code');
    expect(mockedGenerateText).toHaveBeenCalledWith({
      model: { directModelId: 'bytedance-seed-code' },
      prompt: 'Say hi',
      maxOutputTokens: 1,
    });
  });

  it('accepts BytePlus Pro credentials through the same direct provider validation', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'byteplus-pro-inventory-key',
        planId: 'byteplus-coding-plan-team-pro',
        providerId: 'byteplus-coding',
        upstreamPlanId: 'byteplus-pro-plan-123',
      })
    ).resolves.toBe(true);

    expect(mockDirectModel).toHaveBeenCalledWith('bytedance-seed-code');
  });
});
