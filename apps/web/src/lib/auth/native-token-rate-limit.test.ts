import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({ NEXTAUTH_SECRET: 'test-secret' }));

import {
  isNativeTokenAddressRateLimited,
  isNativeTokenUserRateLimited,
} from './native-token-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/auth/native/token', { method: 'POST', headers });
}

describe('native token rate limits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  it('counts the address limit on the first forwarded hop', async () => {
    const request = createRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });

    await isNativeTokenAddressRateLimited(request);

    expect(mockCheckRateLimit).toHaveBeenCalledWith('native-token-address', {
      request,
      rateLimitKey: 'native-token-address:203.0.113.7',
    });
  });

  it('falls back to the real-ip header, then to an opaque key', async () => {
    const realIp = createRequest({ 'x-real-ip': '198.51.100.4' });
    await isNativeTokenAddressRateLimited(realIp);
    expect(mockCheckRateLimit).toHaveBeenLastCalledWith('native-token-address', {
      request: realIp,
      rateLimitKey: 'native-token-address:198.51.100.4',
    });

    const bare = createRequest();
    await isNativeTokenAddressRateLimited(bare);
    expect(mockCheckRateLimit).toHaveBeenLastCalledWith('native-token-address', {
      request: bare,
      rateLimitKey: 'native-token-address:unknown',
    });
  });

  it('reports the address verdict', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    expect(await isNativeTokenAddressRateLimited(createRequest())).toBe(true);
  });

  it('keys the account limit on an opaque digest of the user id', async () => {
    const request = createRequest();
    const digest = createHmac('sha256', NEXTAUTH_SECRET).update('user-1').digest('base64url');

    await isNativeTokenUserRateLimited(request, 'user-1');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('native-token-user', {
      request,
      rateLimitKey: `native-token-user:${digest}`,
    });
    expect(mockCheckRateLimit.mock.calls[0][1]?.rateLimitKey).not.toContain('user-1');
  });

  it('keeps distinct accounts on distinct buckets', async () => {
    await isNativeTokenUserRateLimited(createRequest(), 'user-1');
    await isNativeTokenUserRateLimited(createRequest(), 'user-2');

    const [first, second] = mockCheckRateLimit.mock.calls.map(call => call[1]?.rateLimitKey);
    expect(first).not.toBe(second);
  });

  it('reports a missing address rule instead of refusing the sign-in', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    expect(await isNativeTokenAddressRateLimited(createRequest())).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'native-token-address' is not configured",
      { level: 'error', tags: { source: 'native_token_rate_limit' } }
    );
  });

  it('reports a missing account rule instead of refusing the sign-in', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    expect(await isNativeTokenUserRateLimited(createRequest(), 'user-1')).toBe(false);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'native-token-user' is not configured",
      { level: 'error', tags: { source: 'native_token_rate_limit' } }
    );
  });
});
