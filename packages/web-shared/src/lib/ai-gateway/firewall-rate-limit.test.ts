import { describe, expect, it, beforeEach } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { NextRequest } from 'next/server';
import { checkFirewallRateLimit } from './firewall-rate-limit';

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

describe('checkFirewallRateLimit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts the key within the rule and passes on no credentials', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(
      checkFirewallRateLimit(request, { id: 'rule-a', key: 'ip:192.0.2.1', sentrySource: 'a' })
    ).resolves.toBe('limited');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('rule-a', {
      headers: {
        host: 'gateway.example.com',
        'x-forwarded-for': '192.0.2.1',
        'x-real-ip': '192.0.2.1',
      },
      rateLimitKey: 'rule-a:ip:192.0.2.1',
    });
  });

  it('reports a passing request as allowed', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });

    await expect(
      checkFirewallRateLimit(request, { id: 'rule-a', key: 'k1', sentrySource: 'a' })
    ).resolves.toBe('allowed');
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('reports an absent rule as rule-missing', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await expect(
      checkFirewallRateLimit(request, { id: 'rule-d', key: 'k1', sentrySource: 'd' })
    ).resolves.toBe('rule-missing');
  });

  it('throttles missing-rule reports per rule, so one missing rule cannot hide another', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await checkFirewallRateLimit(request, { id: 'rule-b', key: 'k1', sentrySource: 'b' });
    await checkFirewallRateLimit(request, { id: 'rule-b', key: 'k2', sentrySource: 'b' });
    await checkFirewallRateLimit(request, { id: 'rule-c', key: 'k1', sentrySource: 'c' });

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
