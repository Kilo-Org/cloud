import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  adminNetworkDecision,
  adminNetworkRefusal,
  resetAdminNetworkConfigForTest,
} from '@kilocode/web-shared/lib/admin/admin-network';

const originalVercel = process.env.VERCEL;
const originalNetworks = process.env.ADMIN_ALLOWED_NETWORKS;

function restoreEnv(key: 'VERCEL' | 'ADMIN_ALLOWED_NETWORKS', value: string | undefined) {
  const env: Record<string, string | undefined> = process.env;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function onVercel(networks: string | undefined) {
  process.env.VERCEL = '1';
  restoreEnv('ADMIN_ALLOWED_NETWORKS', networks);
}

function fromAddress(address: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ 'x-vercel-forwarded-for': address, ...extra });
}

beforeEach(() => {
  resetAdminNetworkConfigForTest();
});

afterEach(() => {
  restoreEnv('VERCEL', originalVercel);
  restoreEnv('ADMIN_ALLOWED_NETWORKS', originalNetworks);
  resetAdminNetworkConfigForTest();
});

describe('adminNetworkDecision', () => {
  test('skips the check off Vercel, even with no list or address', () => {
    delete process.env.VERCEL;
    delete process.env.ADMIN_ALLOWED_NETWORKS;

    expect(adminNetworkDecision(new Headers())).toEqual({ kind: 'skipped' });
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
});

describe('adminNetworkRefusal', () => {
  test('returns null when allowed or skipped', () => {
    delete process.env.VERCEL;
    expect(adminNetworkRefusal(new Headers(), '/admin')).toBeNull();

    onVercel('203.0.113.7');
    expect(adminNetworkRefusal(fromAddress('203.0.113.7'), '/admin')).toBeNull();
  });

  test('tells an off-network admin to connect to WARP and retry', () => {
    onVercel('203.0.113.7');

    expect(adminNetworkRefusal(fromAddress('198.51.100.1'), '/admin')).toEqual({
      reason: 'outside-allowlist',
      retryable: true,
      message: expect.stringContaining('Cloudflare WARP'),
    });
  });

  test('reports a missing list as not configured and not retryable', () => {
    onVercel(undefined);

    expect(adminNetworkRefusal(fromAddress('203.0.113.7'), '/admin')).toEqual({
      reason: 'not-configured',
      retryable: false,
      message: expect.stringContaining('allowlist is not configured'),
    });
  });
});
