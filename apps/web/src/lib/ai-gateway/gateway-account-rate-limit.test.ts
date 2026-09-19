import { describe, expect, it, beforeEach } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import type { NextRequest } from 'next/server';
import { isGatewayAccountRateLimited } from './gateway-account-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const request = {} as NextRequest;

describe('isGatewayAccountRateLimited', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts the account, not the address', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });

    await isGatewayAccountRateLimited(request, 'user-123');

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'gateway-inference',
      expect.objectContaining({ rateLimitKey: 'gateway-inference:user-123' })
    );
  });

  it('reports the verdict', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(isGatewayAccountRateLimited(request, 'user-123')).resolves.toBe(true);
  });

  it('reports a missing rule to Sentry rather than failing open in silence', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await expect(isGatewayAccountRateLimited(request, 'user-123')).resolves.toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('gateway-inference'),
      expect.objectContaining({ level: 'error' })
    );
  });
});
