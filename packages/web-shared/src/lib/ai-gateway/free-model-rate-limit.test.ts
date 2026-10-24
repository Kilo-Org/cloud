import { describe, expect, it } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { NextRequest } from 'next/server';
import { isFreeModelRateLimited } from './free-model-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);

describe('isFreeModelRateLimited', () => {
  it('counts signed-in callers against the per-account free-model rule', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });
    const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions');

    await expect(
      isFreeModelRateLimited(request, { kind: 'account', kiloUserId: 'user-123' })
    ).resolves.toBe(true);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'free-model-inference-user',
      expect.objectContaining({ rateLimitKey: 'free-model-inference-user:user:user-123' })
    );
  });

  it('counts anonymous callers against the per-IP free-model rule', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions');

    await expect(
      isFreeModelRateLimited(request, { kind: 'ip', ipAddress: '203.0.113.7' })
    ).resolves.toBe(false);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'free-model-inference',
      expect.objectContaining({ rateLimitKey: 'free-model-inference:ip:203.0.113.7' })
    );
  });
});
