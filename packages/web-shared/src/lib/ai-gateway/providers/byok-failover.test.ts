jest.mock('./upstream-attempt', () => ({
  sendUpstreamAttempt: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextResponse } from 'next/server';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GetProviderProviderResult } from './get-provider';
import type { Provider } from './types';
import { sendUpstreamAttemptWithByokFailover } from './byok-failover';
import { sendUpstreamAttempt, type SendUpstreamAttemptInput } from './upstream-attempt';
import { UPSTREAM_DURATION_BUDGET_MS } from './upstream-request';

const mockedSendUpstreamAttempt = jest.mocked(sendUpstreamAttempt);

function route(apiKey: string): GetProviderProviderResult {
  return {
    kind: 'provider',
    provider: { type: 'direct-byok', apiKey } as Provider,
    userByok: [{ decryptedAPIKey: apiKey, providerId: 'openai' }],
    isFree: false,
    bypassAccessCheck: false,
  };
}

function failedAttempt(status: number) {
  return {
    type: 'error' as const,
    response: NextResponse.json({ error: 'failed' }, { status }),
  };
}

function input(providerContext: GetProviderProviderResult): SendUpstreamAttemptInput {
  return {
    providerContext,
    requestedModel: 'openai/gpt-4o',
    request: { kind: 'chat_completions', body: { model: 'openai/gpt-4o', messages: [] } },
    fraudHeaders: EmptyFraudDetectionHeaders,
    userId: 'user-1',
    organizationId: null,
    sessionId: null,
    taskId: null,
    isNonTrialEnterprise: false,
    search: '',
    method: 'POST',
    dataRegion: null,
  };
}

describe('sendUpstreamAttemptWithByokFailover upstream budget', () => {
  let now = 0;

  beforeEach(() => {
    jest.clearAllMocks();
    now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gives a failover attempt only what the earlier attempts left of the budget', async () => {
    const failover = route('failover-key');
    const primary = {
      ...route('primary-key'),
      byokFailovers: [{ providerId: 'anthropic' as const, resolve: async () => failover }],
    };
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += 120_000.4;
      return failedAttempt(503);
    });
    mockedSendUpstreamAttempt.mockResolvedValueOnce(failedAttempt(500));

    const nextByokFailover = jest
      .fn(async (): Promise<GetProviderProviderResult | null> => null)
      .mockResolvedValueOnce(failover);

    const result = await sendUpstreamAttemptWithByokFailover(input(primary), nextByokFailover);

    expect(result.providerContext).toBe(failover);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(2);
    expect(mockedSendUpstreamAttempt.mock.calls[0]?.[0].upstreamDurationBudgetMs).toBeUndefined();
    expect(mockedSendUpstreamAttempt.mock.calls[1]?.[0].upstreamDurationBudgetMs).toBe(
      UPSTREAM_DURATION_BUDGET_MS - 120_001
    );
  });

  it('returns the failure without failing over when too little of the budget is left', async () => {
    const failover = route('failover-key');
    const nextByokFailover = jest.fn(async () => failover);
    const primary = {
      ...route('primary-key'),
      byokFailovers: [{ providerId: 'anthropic' as const, resolve: nextByokFailover }],
    };
    mockedSendUpstreamAttempt.mockImplementationOnce(async () => {
      now += UPSTREAM_DURATION_BUDGET_MS - 1_000;
      return failedAttempt(503);
    });

    const result = await sendUpstreamAttemptWithByokFailover(input(primary), nextByokFailover);

    expect(result.providerContext).toBe(primary);
    expect(result.attempt.type === 'error' && result.attempt.response.status).toBe(503);
    expect(mockedSendUpstreamAttempt).toHaveBeenCalledTimes(1);
    expect(nextByokFailover).not.toHaveBeenCalled();
  });
});
