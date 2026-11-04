import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { __test__ as rateLimitTest } from '@kilocode/web-shared/lib/firewall-rate-limit';
import { isFirewallRateLimited } from './firewall-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const request = new NextRequest('https://gateway.example.com/api/gateway/chat/completions', {
  headers: {
    authorization: 'Bearer token',
    host: 'gateway.example.com',
    'x-forwarded-for': '192.0.2.1',
    'x-real-ip': '192.0.2.1',
  },
});

describe('isFirewallRateLimited', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    rateLimitTest.resetReportThrottle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts the key within the rule and passes on no credentials', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(
      isFirewallRateLimited(request, { id: 'rule-a', key: 'ip:192.0.2.1', sentrySource: 'a' })
    ).resolves.toBe(true);

    expect(mockCheckRateLimit).toHaveBeenCalledWith('rule-a', {
      headers: {
        host: 'gateway.example.com',
        'x-forwarded-for': '192.0.2.1',
        'x-real-ip': '192.0.2.1',
      },
      rateLimitKey: 'rule-a:ip:192.0.2.1',
    });
  });

  it.each([
    { rateLimited: false },
    { rateLimited: false, error: 'not-found' as const },
    { rateLimited: true, error: 'blocked' as const },
  ])('fails open unless the firewall returned a genuine limit: %j', async result => {
    mockCheckRateLimit.mockResolvedValue(result);

    await expect(
      isFirewallRateLimited(request, { id: 'rule-a', key: 'k1', sentrySource: 'a' })
    ).resolves.toBe(false);
  });

  it('fails open when the firewall check rejects', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('firewall unavailable'));

    await expect(
      isFirewallRateLimited(request, { id: 'rule-a', key: 'k1', sentrySource: 'a' })
    ).resolves.toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'rule-a' could not be evaluated",
      { level: 'error', tags: { source: 'a' } }
    );
  });

  it('fails open after 300ms when the firewall check does not settle', async () => {
    jest.useFakeTimers();
    mockCheckRateLimit.mockReturnValue(new Promise(() => {}));
    const result = isFirewallRateLimited(request, {
      id: 'rule-a',
      key: 'k1',
      sentrySource: 'a',
    });
    const settled = jest.fn();
    void result.then(settled);

    await jest.advanceTimersByTimeAsync(299);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith("Firewall rate limit 'rule-a' timed out", {
      level: 'error',
      tags: { source: 'a' },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('throttles missing-rule reports per rule, so one missing rule cannot hide another', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await isFirewallRateLimited(request, { id: 'rule-b', key: 'k1', sentrySource: 'b' });
    await isFirewallRateLimited(request, { id: 'rule-b', key: 'k2', sentrySource: 'b' });
    await isFirewallRateLimited(request, { id: 'rule-c', key: 'k1', sentrySource: 'c' });

    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'rule-b' is not configured",
      { level: 'error', tags: { source: 'b' } }
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'rule-c' is not configured",
      { level: 'error', tags: { source: 'c' } }
    );
  });
});
