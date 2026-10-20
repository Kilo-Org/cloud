import { describe, expect, it } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { NextRequest } from 'next/server';
import { isFreeModelRateLimited } from './free-model-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);

describe('isFreeModelRateLimited', () => {
  it('counts against the free-model firewall rule', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });
    const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions');

    await expect(isFreeModelRateLimited(request, 'user:user-123')).resolves.toBe(true);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'free-model-inference',
      expect.objectContaining({ rateLimitKey: 'free-model-inference:user:user-123' })
    );
  });

  it('keeps admitting free models when the rule is missing, since it is not an admission cap', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });
    const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions');

    await expect(isFreeModelRateLimited(request, 'user:user-123')).resolves.toBe(false);
  });
});
