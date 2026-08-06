import { createGateway, generateText } from 'ai';

import { listBytePlusSeatsByUsername } from '@/lib/coding-plans/byteplus-control-plane';
import { validateCodingPlanCredential } from '@/lib/coding-plans/inventory-validation';

jest.mock('@/lib/config.server', () => ({
  BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID: 'test-byteplus-access',
  BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY: 'test-byteplus-secret',
}));

const mockDirectModel = jest.fn((modelId: string) => ({ directModelId: modelId }));

jest.mock('@/lib/coding-plans/byteplus-control-plane', () => ({
  BytePlusControlPlaneError: class BytePlusControlPlaneError extends Error {
    code = 'application';
  },
  listBytePlusSeatsByUsername: jest.fn(),
}));

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
const mockedListBytePlusSeatsByUsername = jest.mocked(listBytePlusSeatsByUsername);
const mockedSentryLogger = jest.mocked(
  jest.requireMock('@/lib/utils.server').sentryLogger as () => jest.Mock
);
const mockLogWarning = mockedSentryLogger.mock.results[0]?.value as jest.Mock;

beforeEach(() => {
  mockedListBytePlusSeatsByUsername.mockResolvedValue([
    {
      seatId: 'seat-lite',
      bizInfo: 'Lite',
      seatStatus: 2,
      billingStatus: 2,
      apiKey: 'byteplus-inventory-key',
    },
  ]);
});

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
    ).resolves.toEqual({ valid: true });

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
    ).resolves.toEqual({ valid: true });
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
    ).resolves.toEqual({ valid: false });
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
    ).resolves.toEqual({ valid: false });
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
    ).resolves.toEqual({ valid: true });

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
    ).resolves.toEqual({ valid: true, upstreamUsageId: 'seat-lite' });

    expect(mockDirectModel).toHaveBeenCalledWith('bytedance-seed-code');
    expect(mockedGenerateText).toHaveBeenCalledWith({
      model: { directModelId: 'bytedance-seed-code' },
      prompt: 'Say hi',
      maxOutputTokens: 1,
    });
    expect(mockedListBytePlusSeatsByUsername).toHaveBeenCalledWith({
      username: 'byteplus-plan-123',
      bizInfo: 'Lite',
    });
  });

  it('accepts BytePlus Pro credentials through the same direct provider validation', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    mockedListBytePlusSeatsByUsername.mockResolvedValueOnce([
      {
        seatId: 'seat-pro',
        bizInfo: 'Pro',
        seatStatus: 2,
        billingStatus: 2,
        apiKey: 'byteplus-pro-inventory-key',
      },
    ]);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'byteplus-pro-inventory-key',
        planId: 'byteplus-coding-plan-team-pro',
        providerId: 'byteplus-coding',
        upstreamPlanId: 'byteplus-pro-plan-123',
      })
    ).resolves.toEqual({ valid: true, upstreamUsageId: 'seat-pro' });

    expect(mockDirectModel).toHaveBeenCalledWith('bytedance-seed-code');
    expect(mockedListBytePlusSeatsByUsername).toHaveBeenCalledWith({
      username: 'byteplus-pro-plan-123',
      bizInfo: 'Pro',
    });
  });

  it.each([
    [[], 'no_matching_seat', 0],
    [
      [
        {
          seatId: 'seat-one',
          bizInfo: 'Lite' as const,
          seatStatus: 2 as const,
          billingStatus: 2 as const,
          apiKey: 'byteplus-inventory-key',
        },
        {
          seatId: 'seat-two',
          bizInfo: 'Lite' as const,
          seatStatus: 2 as const,
          billingStatus: 2 as const,
          apiKey: 'byteplus-inventory-key',
        },
      ],
      'multiple_matching_seats',
      2,
    ],
  ])('logs a safe %s seat-count diagnostic', async (seats, reason, returnedSeatCount) => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    mockedListBytePlusSeatsByUsername.mockResolvedValueOnce(seats);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'byteplus-inventory-key',
        planId: 'byteplus-coding-plan-team-lite',
        providerId: 'byteplus-coding',
        upstreamPlanId: 'byteplus-plan-123',
      })
    ).resolves.toEqual({ valid: false });

    expect(mockLogWarning).toHaveBeenCalledWith(
      'BytePlus coding plan inventory validation failed',
      {
        providerId: 'byteplus-coding',
        stage: 'seat_match',
        reason,
        expectedTier: 'Lite',
        returnedSeatCount,
      }
    );
    const serializedLog = JSON.stringify(mockLogWarning.mock.calls);
    expect(serializedLog).not.toContain('byteplus-inventory-key');
    expect(serializedLog).not.toContain('byteplus-plan-123');
    expect(serializedLog).not.toContain('seat-one');
    expect(serializedLog).not.toContain('seat-two');
  });

  it('rejects a BytePlus seat without a verifiable matching inference key', async () => {
    mockedGenerateText.mockResolvedValueOnce({ finishReason: 'stop' } as never);
    mockedListBytePlusSeatsByUsername.mockResolvedValueOnce([
      {
        seatId: 'seat-mismatch',
        bizInfo: 'Lite',
        seatStatus: 2,
        billingStatus: 2,
        apiKey: 'different-key',
      },
    ]);

    await expect(
      validateCodingPlanCredential({
        apiKey: 'byteplus-inventory-key',
        planId: 'byteplus-coding-plan-team-lite',
        providerId: 'byteplus-coding',
        upstreamPlanId: 'byteplus-plan-123',
      })
    ).resolves.toEqual({ valid: false });

    expect(mockLogWarning).toHaveBeenCalledWith(
      'BytePlus coding plan inventory validation failed',
      {
        providerId: 'byteplus-coding',
        stage: 'seat_match',
        reason: 'seat_api_key_mismatch',
      }
    );
    const serializedLog = JSON.stringify(mockLogWarning.mock.calls);
    expect(serializedLog).not.toContain('byteplus-inventory-key');
    expect(serializedLog).not.toContain('different-key');
    expect(serializedLog).not.toContain('seat-mismatch');
    expect(serializedLog).not.toContain('byteplus-plan-123');
  });
});
