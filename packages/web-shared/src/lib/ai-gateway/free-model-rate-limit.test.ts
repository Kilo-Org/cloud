import { beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { NextRequest } from 'next/server';
import { captureMessage } from '@sentry/nextjs';
import { __test__ as rateLimitTest } from '@kilocode/web-shared/lib/firewall-rate-limit';
import { isFreeModelRateLimited, type FreeModelRateLimitSubject } from './free-model-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);

describe('isFreeModelRateLimited', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    rateLimitTest.resetReportThrottle();
  });

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

  describe.each<{
    subject: FreeModelRateLimitSubject;
    ruleId: string;
    source: string;
  }>([
    {
      subject: { kind: 'account', kiloUserId: 'user-123' },
      ruleId: 'free-model-inference-user',
      source: 'free_model_inference_user',
    },
    {
      subject: { kind: 'ip', ipAddress: '203.0.113.7' },
      ruleId: 'free-model-inference',
      source: 'free_model_inference',
    },
  ])('$ruleId', ({ subject, ruleId, source }) => {
    const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions');

    it('retains genuine rate limits', async () => {
      mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

      await expect(isFreeModelRateLimited(request, subject)).resolves.toBe(true);
    });

    it('fails open when the firewall library marks a failed check as blocked', async () => {
      mockCheckRateLimit.mockResolvedValue({ rateLimited: true, error: 'blocked' });

      await expect(isFreeModelRateLimited(request, subject)).resolves.toBe(false);
      expect(captureMessage).toHaveBeenCalledWith(
        `Firewall rate limit '${ruleId}' could not be evaluated`,
        { level: 'error', tags: { source } }
      );
    });

    it('fails open when the firewall check rejects', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('firewall unavailable'));

      await expect(isFreeModelRateLimited(request, subject)).resolves.toBe(false);
    });

    it('fails open when the rule is missing', async () => {
      mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

      await expect(isFreeModelRateLimited(request, subject)).resolves.toBe(false);
    });
  });
});
