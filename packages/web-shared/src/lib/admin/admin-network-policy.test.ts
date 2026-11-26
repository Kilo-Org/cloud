import { describe, expect, test } from '@jest/globals';
import {
  ADMIN_EDGE_PATH_PATTERNS,
  adminNetworkFirewallRule,
  checkAdminAllowedNetworksForDeployment,
  isAdminEdgePath,
  normalizeClientAddress,
  parseAdminAllowedNetworks,
} from '@kilocode/web-shared/lib/admin/admin-network-policy';

describe('parseAdminAllowedNetworks', () => {
  test('parses IPv4 and IPv6 addresses and CIDR ranges', () => {
    expect(
      parseAdminAllowedNetworks('192.0.2.10,198.51.100.0/24,2001:db8::1,2001:db8:1::/48')
    ).toEqual({
      kind: 'valid',
      entries: [
        { family: 'ipv4', address: '192.0.2.10', prefix: null },
        { family: 'ipv4', address: '198.51.100.0', prefix: 24 },
        { family: 'ipv6', address: '2001:db8::1', prefix: null },
        { family: 'ipv6', address: '2001:db8:1::', prefix: 48 },
      ],
    });
  });

  test('trims whitespace around entries', () => {
    expect(parseAdminAllowedNetworks(' 192.0.2.10 ,\t203.0.113.0/24 ')).toEqual({
      kind: 'valid',
      entries: [
        { family: 'ipv4', address: '192.0.2.10', prefix: null },
        { family: 'ipv4', address: '203.0.113.0', prefix: 24 },
      ],
    });
  });

  test('reads an IPv4-mapped IPv6 entry as IPv4', () => {
    expect(parseAdminAllowedNetworks('::ffff:192.0.2.10,::ffff:198.51.100.0/120')).toEqual({
      kind: 'valid',
      entries: [
        { family: 'ipv4', address: '192.0.2.10', prefix: null },
        { family: 'ipv4', address: '198.51.100.0', prefix: 24 },
      ],
    });
  });

  test('accepts the break-glass ranges', () => {
    expect(parseAdminAllowedNetworks('0.0.0.0/0,::/0')).toMatchObject({ kind: 'valid' });
  });

  test.each([undefined, '', '   '])('treats %j as empty', value => {
    expect(parseAdminAllowedNetworks(value)).toEqual({ kind: 'empty' });
  });

  test.each([
    ['192.0.2.10,not-an-ip', 'entry 2'],
    ['192.0.2.10,', 'entry 2'],
    ['192.0.2.0/33', 'entry 1'],
    ['2001:db8::/129', 'entry 1'],
    ['192.0.2.0/-1', 'entry 1'],
    ['192.0.2.0/', 'entry 1'],
    ['192.0.2.256', 'entry 1'],
    ['::ffff:192.0.2.0/64', 'entry 1'],
  ])('rejects the whole value %j', (value, position) => {
    const parsed = parseAdminAllowedNetworks(value);
    expect(parsed.kind).toBe('invalid');
    expect(parsed.kind === 'invalid' && parsed.message).toContain(position);
  });

  test('never echoes an invalid entry', () => {
    const parsed = parseAdminAllowedNetworks('203.0.113.999');
    expect(parsed.kind === 'invalid' && parsed.message).not.toContain('203.0.113.999');
  });

  test.each([
    ['192.0.2.10/24', 'entry 1: host bits set'],
    ['203.0.113.0/24,2001:db8::1/64', 'entry 2: host bits set'],
    ['198.51.100.128/24', 'entry 1: host bits set'],
    ['2001:db8:0:1::/48', 'entry 1: host bits set'],
    ['::ffff:192.0.2.1/120', 'entry 1: host bits set'],
  ])('rejects %j because a range has host bits set', (value, message) => {
    const parsed = parseAdminAllowedNetworks(value);
    expect(parsed).toEqual({ kind: 'invalid', message });
  });

  test.each(['192.0.2.10/32', '198.51.100.128/25', '2001:db8::1/128', '2001:db8:0:1::/64'])(
    'accepts the network address %j',
    value => {
      expect(parseAdminAllowedNetworks(value).kind).toBe('valid');
    }
  );

  test('rejects an IPv6 zone index', () => {
    expect(parseAdminAllowedNetworks('fe80::1%eth0').kind).toBe('invalid');
  });
});

describe('checkAdminAllowedNetworksForDeployment', () => {
  test.each([
    ['a local build', {}],
    ['a CI build', { CI: 'true', NODE_ENV: 'production' }],
    ['a development vercel build', { VERCEL: '1', VERCEL_ENV: 'development' }],
    ['VERCEL_ENV without VERCEL', { VERCEL_ENV: 'production' }],
  ])('skips %s, even with no list', (_label, env) => {
    expect(checkAdminAllowedNetworksForDeployment(env)).toEqual({ kind: 'skipped' });
  });

  test.each(['production', 'preview'])('accepts a valid list on a %s deployment', vercelEnv => {
    expect(
      checkAdminAllowedNetworksForDeployment({
        VERCEL: '1',
        VERCEL_ENV: vercelEnv,
        ADMIN_ALLOWED_NETWORKS: '203.0.113.7,2001:db8::/32',
      })
    ).toEqual({ kind: 'valid' });
  });

  test.each([undefined, '', ' '])('refuses a deployment whose list is %j', networks => {
    expect(
      checkAdminAllowedNetworksForDeployment({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        ADMIN_ALLOWED_NETWORKS: networks,
      })
    ).toEqual({
      kind: 'refused',
      message: expect.stringContaining('ADMIN_ALLOWED_NETWORKS is unset or empty'),
    });
  });

  test('refuses an invalid list by entry position, without echoing any entry', () => {
    const check = checkAdminAllowedNetworksForDeployment({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      ADMIN_ALLOWED_NETWORKS: '203.0.113.7,192.0.2.10/24,not-an-address',
    });

    expect(check).toEqual({
      kind: 'refused',
      message: expect.stringContaining(
        'entry 2: host bits set; entry 3: not an IP address or CIDR range'
      ),
    });
    const message = check.kind === 'refused' ? check.message : '';
    expect(message).not.toContain('203.0.113.7');
    expect(message).not.toContain('192.0.2.10');
    expect(message).not.toContain('not-an-address');
  });
});

describe('normalizeClientAddress', () => {
  test.each([
    ['192.0.2.10', { family: 'ipv4', address: '192.0.2.10' }],
    ['2001:db8::1', { family: 'ipv6', address: '2001:db8::1' }],
    ['::ffff:192.0.2.10', { family: 'ipv4', address: '192.0.2.10' }],
    ['::FFFF:c000:20a', { family: 'ipv4', address: '192.0.2.10' }],
    ['0:0:0:0:0:ffff:192.0.2.10', { family: 'ipv4', address: '192.0.2.10' }],
  ])('normalizes %s', (value, expected) => {
    expect(normalizeClientAddress(value)).toEqual(expected);
  });

  test.each(['', 'unknown', '192.0.2.10:443'])('rejects %j', value => {
    expect(normalizeClientAddress(value)).toBeNull();
  });
});

describe('admin edge path patterns', () => {
  test.each([
    '/admin',
    '/admin/',
    '/admin/users',
    '/admin/api/users',
    '/ADMIN/api/users',
    '/api/trpc/admin.users.list',
    '/api/trpc/user.getMe,admin.users.list',
    '/api/trpc/user.getMe%2Cadmin.users.list',
    '/api/trpc/user.getMe%2cadmin.users.list',
    '/api/trpc/organizations.admin.list',
    '/api/trpc/user.getMe,codeIndexing.admin.getSummaryStats',
    '/api/trpc/codingPlans.adminListSubscriptions',
    '/api/trpc/debug.unhandledError',
    '/api/trpc/organizations.updatePlan',
    '/api/trpc/organizations.list,organizations.seatPurchases',
    '/api/trpc/organizations.seatPurchases?batch=1&input=%7B%7D',
    '/api/trpc/organizations.sso.createConfig%2Corganizations.list',
    '/api/trpc/organizations.sso.deleteConfig',
    '/api/trpc/test.adminHello',
    '/api/trpc/Admin.users.list',
    '/api/trpc/organizations.updatePlan,user.getMe',
    '/api/trpc/organizations.updatePlan%2Cuser.getMe',
    '/api/trpc/user.getMe,organizations.sso.createConfig,organizations.list',
    '/api/trpc/organizations.sso.generateAdminPortalLink',
    '/api/trpc/organizations.sso.generateAdminPortalLink?batch=1&input=%7B%7D',
    '/api/trpc/organizations.sso.generateAdminPortalLink,user.getMe',
    '/api/trpc/organizations.sso.generateAdminPortalLink%2Cuser.getMe',
    '/api/trpc/organizations.reviewAgent.triggerBitbucketCodeReview?batch=1',
  ])('matches %s', pathname => {
    expect(isAdminEdgePath(pathname)).toBe(true);
  });

  test.each([
    '/administrator',
    '/admins',
    '/api/admin',
    '/api/trpc/user.getMe',
    '/api/trpc/user.getMe,cliSessionsV2.list',
    '/api/trpc/organizations.list',
    '/api/trpc/organizations.getById,organizations.members.list',
    '/api/trpc/codeIndexing.search',
    '/api/trpc/codingPlans.listPlans',
    '/api/trpc/stepUp.getStatus',
    '/api/trpc/stepUp.getStatus,user.getMe',
    '/api/trpc/organizations.sso.getConfig',
    '/api/trpc/organizations.sso.generateAdminPortalLinkX',
    '/api/trpc/organizations.updatePlanDraft',
    '/api/trpc/organizations.updatePlanFoo',
    '/api/trpc/organizations.sso.createConfigX',
    '/api/trpc/user.getMe,organizations.sso.createConfigX',
    '/api/trpc/organizations.seatPurchasesSummary,user.getMe',
    '/api/trpc/user.getMe?input=organizations.updatePlan',
    '/api/trpc/organizations.reviewAgent.getBitbucketReadiness,organizations.reviewAgent.getReviewConfig',
    '/api/trpc/user.admin',
    '/app-shell/api/trpc/admin.x',
    '/api/trpc-mobile/admin.users.list',
    '/api/trpc/cliSessionsV2.list?batch=1&input=%7B%22repo%22%3A%22x-admin.git%22%7D',
    '/api/trpc/user.getMe?batch=1&input=a,admin.b',
    '/api/trpc/user.getMe?batch=1&input=a%2Cadmin.b',
  ])('does not match %s', pathname => {
    expect(isAdminEdgePath(pathname)).toBe(false);
  });
});

describe('adminNetworkFirewallRule', () => {
  test('denies each admin path pattern outside the normalized list', () => {
    const parsed = parseAdminAllowedNetworks('203.0.113.7, 2001:db8::/32,::ffff:192.0.2.1');
    if (parsed.kind !== 'valid') throw new Error('fixture must parse');

    const ipCondition = {
      type: 'ip_address',
      op: 'ninc',
      value: ['203.0.113.7', '2001:db8::/32', '192.0.2.1'],
    };
    expect(adminNetworkFirewallRule(parsed.entries)).toEqual({
      name: 'Admin network allowlist',
      description: 'Deny admin paths outside ADMIN_ALLOWED_NETWORKS',
      active: true,
      conditionGroup: ADMIN_EDGE_PATH_PATTERNS.map(pattern => ({
        conditions: [{ type: 'path', op: 're', value: pattern }, ipCondition],
      })),
      action: { mitigate: { action: 'deny' } },
    });
  });
});
