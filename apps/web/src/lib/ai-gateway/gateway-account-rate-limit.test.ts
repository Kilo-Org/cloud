import { describe, expect, it, beforeEach } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@/lib/tokens', () => ({ validateAuthorizationHeader: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { validateAuthorizationHeader } from '@/lib/tokens';
import type { NextRequest } from 'next/server';
import { gatewayRateLimitKey, isGatewayAccountRateLimited } from './gateway-account-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const mockValidateAuthorizationHeader = jest.mocked(validateAuthorizationHeader);
const request = {} as NextRequest;

const authed = (token: string) => new Headers({ authorization: `Bearer ${token}` });

describe('gatewayRateLimitKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keys on the signed account id, so rotating the address does not buy an allowance', () => {
    mockValidateAuthorizationHeader.mockReturnValue({ kiloUserId: 'user-123' } as ReturnType<
      typeof validateAuthorizationHeader
    >);

    expect(gatewayRateLimitKey(authed('t'), '1.1.1.1')).toBe('user-123');
    expect(gatewayRateLimitKey(authed('t'), '2.2.2.2')).toBe('user-123');
  });

  it('never resolves the account, so the cap costs no database read', () => {
    mockValidateAuthorizationHeader.mockReturnValue({ kiloUserId: 'user-123' } as ReturnType<
      typeof validateAuthorizationHeader
    >);

    gatewayRateLimitKey(authed('t'), '1.1.1.1');

    // The signature check is the whole account lookup. Anything more would be a
    // query, which is the cost this cap exists to avoid.
    expect(mockValidateAuthorizationHeader).toHaveBeenCalledTimes(1);
  });

  it('counts an unsigned request as the address', () => {
    expect(gatewayRateLimitKey(new Headers(), '1.1.1.1')).toBe('anon:1.1.1.1');
    expect(mockValidateAuthorizationHeader).not.toHaveBeenCalled();
  });

  it('counts a token that fails validation as the address', () => {
    mockValidateAuthorizationHeader.mockReturnValue({ error: 'Invalid token' } as ReturnType<
      typeof validateAuthorizationHeader
    >);

    expect(gatewayRateLimitKey(authed('forged'), '1.1.1.1')).toBe('anon:1.1.1.1');
  });

  it('survives a request with no address', () => {
    expect(gatewayRateLimitKey(new Headers(), undefined)).toBe('anon:');
  });
});

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

  it('reports a missing rule to Sentry, but not once per request', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await expect(isGatewayAccountRateLimited(request, 'user-123')).resolves.toBe(false);
    await isGatewayAccountRateLimited(request, 'user-123');
    await isGatewayAccountRateLimited(request, 'user-456');

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('gateway-inference'),
      expect.objectContaining({ level: 'error' })
    );
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });
});
