jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { captureMessage } from '@sentry/nextjs';
import {
  adminNetworkDecision,
  adminNetworkRefusal,
  resetAdminNetworkConfigForTest,
} from '@kilocode/web-shared/lib/admin/admin-network';

type EnvKey = 'VERCEL' | 'VERCEL_ENV' | 'NODE_ENV' | 'ADMIN_ALLOWED_NETWORKS';
const env: Record<string, string | undefined> = process.env;
const ENV_KEYS: EnvKey[] = ['VERCEL', 'VERCEL_ENV', 'NODE_ENV', 'ADMIN_ALLOWED_NETWORKS'];
const originalEnv = new Map(ENV_KEYS.map(key => [key, env[key]]));

function setEnv(key: EnvKey, value: string | undefined) {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function onVercel(networks: string | undefined) {
  setEnv('VERCEL', '1');
  setEnv('ADMIN_ALLOWED_NETWORKS', networks);
}

function fromAddress(address: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ 'x-vercel-forwarded-for': address, ...extra });
}

const request = { route: '/admin', kiloUserId: 'user-1' };
const mockCaptureMessage = jest.mocked(captureMessage);

function reportedMessages(): string[] {
  return mockCaptureMessage.mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
  resetAdminNetworkConfigForTest();
  mockCaptureMessage.mockClear();
  setEnv('VERCEL', undefined);
  setEnv('VERCEL_ENV', undefined);
  setEnv('NODE_ENV', 'test');
});

afterEach(() => {
  for (const [key, value] of originalEnv) setEnv(key, value);
  resetAdminNetworkConfigForTest();
});

describe('adminNetworkDecision', () => {
  test.each([undefined, 'development'])(
    'skips the check in a local runtime (VERCEL_ENV %j), even with no list or address',
    vercelEnv => {
      setEnv('VERCEL_ENV', vercelEnv);
      setEnv('ADMIN_ALLOWED_NETWORKS', undefined);

      expect(adminNetworkDecision(new Headers())).toEqual({ kind: 'skipped' });
      expect(reportedMessages()).toEqual([]);
    }
  );

  test.each([
    ['VERCEL_ENV is set', 'VERCEL_ENV', 'preview'],
    ['NODE_ENV is production', 'NODE_ENV', 'production'],
  ] as const)('enforces without VERCEL when %s, and reports it once', (_label, key, value) => {
    setEnv(key, value);
    setEnv('ADMIN_ALLOWED_NETWORKS', '203.0.113.7');

    expect(adminNetworkDecision(new Headers())).toEqual({
      kind: 'denied',
      reason: 'no-client-address',
    });
    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({ kind: 'allowed' });
    expect(reportedMessages()).toEqual([expect.stringContaining('outside-vercel')]);
  });

  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['198.51.100.0/24', '198.51.100.200'],
    ['2001:db8::/32', '2001:db8:abcd::1'],
    ['198.51.100.0/24', '::ffff:198.51.100.9'],
    ['0.0.0.0/0,::/0', '192.0.2.1'],
  ])('allows a client inside %s (%s)', (networks, address) => {
    onVercel(networks);

    expect(adminNetworkDecision(fromAddress(address))).toEqual({ kind: 'allowed' });
  });

  test('reads only the first hop of x-vercel-forwarded-for', () => {
    onVercel('203.0.113.7');

    expect(adminNetworkDecision(fromAddress('203.0.113.7, 192.0.2.1'))).toEqual({
      kind: 'allowed',
    });
    expect(adminNetworkDecision(fromAddress('192.0.2.1, 203.0.113.7'))).toEqual({
      kind: 'denied',
      reason: 'outside-allowlist',
    });
  });

  test('denies a client outside the list', () => {
    onVercel('203.0.113.0/24,2001:db8::/32');

    expect(adminNetworkDecision(fromAddress('198.51.100.1'))).toEqual({
      kind: 'denied',
      reason: 'outside-allowlist',
    });
    expect(adminNetworkDecision(fromAddress('2001:db9::1'))).toEqual({
      kind: 'denied',
      reason: 'outside-allowlist',
    });
  });

  test('ignores client-settable forwarding headers that name an allowed address', () => {
    onVercel('203.0.113.7');

    const spoofed = fromAddress('198.51.100.1', {
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
    });

    expect(adminNetworkDecision(spoofed)).toEqual({ kind: 'denied', reason: 'outside-allowlist' });
  });

  test.each([
    ['missing', new Headers({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.7' })],
    ['empty', fromAddress('')],
    ['unparseable', fromAddress('unknown')],
  ])('denies when x-vercel-forwarded-for is %s', (_label, headersList) => {
    onVercel('203.0.113.7');

    expect(adminNetworkDecision(headersList)).toEqual({
      kind: 'denied',
      reason: 'no-client-address',
    });
  });

  test.each([undefined, '', ' '])('fails closed when the list is %j', networks => {
    onVercel(networks);

    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({
      kind: 'denied',
      reason: 'not-configured',
    });
  });

  test('fails closed on an invalid list instead of dropping the bad entry', () => {
    onVercel('203.0.113.7,203.0.113.0/40');

    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({
      kind: 'denied',
      reason: 'invalid-config',
    });
  });

  test('parses the list once per process until reset', () => {
    onVercel('203.0.113.7');
    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({ kind: 'allowed' });

    process.env.ADMIN_ALLOWED_NETWORKS = '198.51.100.1';
    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({ kind: 'allowed' });

    resetAdminNetworkConfigForTest();
    expect(adminNetworkDecision(fromAddress('203.0.113.7'))).toEqual({
      kind: 'denied',
      reason: 'outside-allowlist',
    });
  });

  test.each([
    ['0.0.0.0/0', 'denied'],
    ['::/0', 'allowed'],
    ['203.0.113.7,0.0.0.0/0,::/0', 'allowed'],
    ['0.0.0.0/1', 'denied'],
    ['::/1', 'allowed'],
    ['10.0.0.0/7', 'denied'],
  ] as const)('reports a broad list %j once without echoing it', (networks, ipv6Outcome) => {
    onVercel(networks);

    expect(adminNetworkDecision(fromAddress('2001:db8::1'))).toMatchObject({
      kind: ipv6Outcome,
    });
    adminNetworkDecision(fromAddress('198.51.100.1'));

    const messages = reportedMessages();
    expect(messages).toEqual([expect.stringContaining('broad-range')]);
    expect(messages[0]).not.toContain('0.0.0.0');
    expect(messages[0]).not.toContain('10.0.0.0');
    expect(messages[0]).not.toContain('::/');
    expect(messages[0]).not.toContain('203.0.113.7');
    expect(mockCaptureMessage).toHaveBeenCalledWith(expect.any(String), {
      level: 'error',
      tags: { source: 'admin_network' },
    });
  });

  test.each(['203.0.113.0/24,2001:db8::/32', '192.0.2.0/24', '2001:db8::/32', '10.0.0.0/8'])(
    'does not report %j, which is no broader than /8 or /32',
    networks => {
      onVercel(networks);

      adminNetworkDecision(fromAddress('203.0.113.7'));

      expect(reportedMessages()).toEqual([]);
    }
  );
});

describe('adminNetworkRefusal', () => {
  test('returns null when allowed or skipped', () => {
    expect(adminNetworkRefusal(new Headers(), request)).toBeNull();

    onVercel('203.0.113.7');
    expect(adminNetworkRefusal(fromAddress('203.0.113.7'), request)).toBeNull();
  });

  test('tells an off-network admin to connect to WARP and retry', () => {
    onVercel('203.0.113.7');

    expect(adminNetworkRefusal(fromAddress('198.51.100.1'), request)).toEqual({
      reason: 'outside-allowlist',
      retryable: true,
      code: 'ADMIN_NETWORK_DENIED',
      message: expect.stringContaining('Cloudflare WARP'),
    });
  });

  test('reports a missing list as not configured, not retryable, once per process', () => {
    onVercel(undefined);

    const first = adminNetworkRefusal(fromAddress('203.0.113.7'), request);
    adminNetworkRefusal(fromAddress('203.0.113.8'), request);

    expect(first).toEqual({
      reason: 'not-configured',
      retryable: false,
      code: 'ADMIN_NETWORK_NOT_CONFIGURED',
      message: expect.stringContaining('allowlist is not configured'),
    });
    expect(reportedMessages()).toEqual([expect.stringContaining('not-configured')]);
  });

  test('reports an invalid list by entry position only', () => {
    onVercel('203.0.113.7,192.0.2.10/24');

    expect(adminNetworkRefusal(fromAddress('203.0.113.7'), request)?.reason).toBe('invalid-config');
    expect(reportedMessages()).toEqual([expect.stringContaining('entry 2: host bits set')]);
    expect(reportedMessages()[0]).not.toContain('192.0.2.10');
  });
});
