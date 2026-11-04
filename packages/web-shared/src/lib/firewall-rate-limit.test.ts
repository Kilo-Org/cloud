import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import {
  __test__,
  checkFirewallRateLimit,
  reportFirewallRateLimitIssue,
} from '@kilocode/web-shared/lib/firewall-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const options = { source: 'test', headers: { host: 'gateway.example.com' }, rateLimitKey: 'key' };

describe('checkFirewallRateLimit', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers({ now: 0 });
    __test__.resetReportThrottle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    { rateLimited: false, expected: 'allowed' },
    { rateLimited: true, expected: 'limited' },
  ])('returns $expected for a confirmed answer', async ({ rateLimited, expected }) => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited });

    await expect(checkFirewallRateLimit('rule', options)).resolves.toBe(expected);

    expect(mockCheckRateLimit).toHaveBeenCalledWith('rule', {
      headers: options.headers,
      rateLimitKey: options.rateLimitKey,
    });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { rateLimited: false, error: 'not-found' as const, message: 'is not configured' },
    { rateLimited: false, error: 'blocked' as const, message: 'could not be evaluated' },
    { rateLimited: true, error: 'blocked' as const, message: 'could not be evaluated' },
  ])('returns unavailable for $error with rateLimited=$rateLimited', async result => {
    mockCheckRateLimit.mockResolvedValue(result);

    await expect(checkFirewallRateLimit('rule', options)).resolves.toBe('unavailable');

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      `Firewall rate limit 'rule' ${result.message}`,
      {
        level: 'error',
        tags: { source: 'test' },
      }
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a rejected check as unavailable without exposing its error', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('unexpected status with sensitive details'));

    await expect(checkFirewallRateLimit('rule', options)).resolves.toBe('unavailable');

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'rule' could not be evaluated",
      { level: 'error', tags: { source: 'test' } }
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('recovers from a synchronous check failure', async () => {
    mockCheckRateLimit.mockImplementation(() => {
      throw new Error('check failed');
    });

    await expect(checkFirewallRateLimit('rule', options)).resolves.toBe('unavailable');

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns unavailable after 300ms even when the check never settles', async () => {
    mockCheckRateLimit.mockReturnValue(new Promise(() => {}));
    const result = checkFirewallRateLimit('rule', options);
    const settled = jest.fn();
    void result.then(settled);

    await jest.advanceTimersByTimeAsync(299);
    expect(settled).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('unavailable');
    expect(mockCaptureMessage).toHaveBeenCalledWith("Firewall rate limit 'rule' timed out", {
      level: 'error',
      tags: { source: 'test' },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'safely handles a late %s after the deadline',
    async action => {
      let resolveCheck: ((value: { rateLimited: boolean }) => void) | undefined;
      let rejectCheck: ((error: Error) => void) | undefined;
      mockCheckRateLimit.mockReturnValue(
        new Promise((resolve, reject) => {
          resolveCheck = resolve;
          rejectCheck = reject;
        })
      );
      const result = checkFirewallRateLimit('rule', options);
      await jest.advanceTimersByTimeAsync(300);
      await expect(result).resolves.toBe('unavailable');

      if (action === 'resolve') {
        resolveCheck?.({ rateLimited: true });
      } else {
        rejectCheck?.(new Error('late failure'));
      }
      await jest.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toBe('unavailable');
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    }
  );

  it('shares a per-rule, per-instance report throttle across failure kinds and callers', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ rateLimited: false, error: 'not-found' });
    await checkFirewallRateLimit('rule', options);
    mockCheckRateLimit.mockRejectedValueOnce(new Error('failed'));
    await checkFirewallRateLimit('rule', { ...options, source: 'another-caller' });
    reportFirewallRateLimitIssue('rule', 'direct-caller', 'another issue');
    mockCheckRateLimit.mockResolvedValueOnce({ rateLimited: true, error: 'blocked' });
    await checkFirewallRateLimit('other-rule', options);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(59_999);
    reportFirewallRateLimitIssue('rule', 'test', 'still unavailable');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    reportFirewallRateLimitIssue('rule', 'test', 'still unavailable');
    expect(mockCaptureMessage).toHaveBeenCalledTimes(3);
  });
});
