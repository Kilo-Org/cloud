import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  elevateViaKiloAdmin,
  emitPrivilegedAccessEvent,
  organizationTarget,
  organizationsTarget,
  recordKiloAdminElevation,
  recordKiloAdminElevationForRequest,
  methodFromHeaders,
  routeFromHeaders,
  serviceTarget,
  setAdminAccessSinkForTest,
  userTarget,
  userAgentProductFromHeaders,
  UNSCOPED_TARGET,
  type AdminAccessEvent,
  type AdminAuditContext,
} from './admin-access-log';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

describe('clientIpFromHeaders', () => {
  test('prefers x-vercel-forwarded-for when both headers are present', () => {
    expect(
      clientIpFromHeaders(
        new Headers({
          'x-forwarded-for': '203.0.113.7, 10.0.0.1',
          'x-vercel-forwarded-for': '198.51.100.5, 10.0.0.2',
        })
      )
    ).toBe('198.51.100.5');
  });

  test('returns the first hop of x-forwarded-for when it is the only forwarding header', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7'
    );
  });

  test('trims surrounding whitespace', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '  203.0.113.9 , 10.0.0.1' }))
    ).toBe('203.0.113.9');
  });

  test('returns the first hop of x-vercel-forwarded-for when x-forwarded-for is absent', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-vercel-forwarded-for': '198.51.100.5' }))).toBe(
      '198.51.100.5'
    );
  });

  test('returns null when no forwarding header is present', () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  test('returns null for an empty x-forwarded-for header', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '' }))).toBeNull();
  });

  test('falls back to x-forwarded-for when x-vercel-forwarded-for is empty', () => {
    expect(
      clientIpFromHeaders(
        new Headers({ 'x-vercel-forwarded-for': '   ', 'x-forwarded-for': '203.0.113.7' })
      )
    ).toBe('203.0.113.7');
  });
});

describe('authViaTokenFromHeaders', () => {
  test('is true when an Authorization header is present', () => {
    expect(authViaTokenFromHeaders(new Headers({ Authorization: 'Bearer abc' }))).toBe(true);
  });

  test('is false when no Authorization header is present', () => {
    expect(authViaTokenFromHeaders(new Headers())).toBe(false);
  });

  test('is true for an empty Authorization header (the header still selects the bearer branch)', () => {
    expect(authViaTokenFromHeaders(new Headers({ Authorization: '' }))).toBe(true);
  });
});

describe('routeFromHeaders', () => {
  test('prefers the concrete pathname set by proxy.ts', () => {
    expect(
      routeFromHeaders(
        new Headers({ 'x-pathname': '/admin/api/users/abc', 'x-matched-path': '/admin/api/users' })
      )
    ).toBe('/admin/api/users/abc');
  });

  test('falls back to the matched route pattern', () => {
    expect(routeFromHeaders(new Headers({ 'x-matched-path': '/admin/api/users/[id]' }))).toBe(
      '/admin/api/users/[id]'
    );
  });

  test('returns null when neither header is present', () => {
    expect(routeFromHeaders(new Headers())).toBeNull();
  });
});

describe('methodFromHeaders', () => {
  test('reads the method forwarded by proxy.ts', () => {
    expect(methodFromHeaders(new Headers({ 'x-http-method': 'post' }))).toBe('POST');
  });

  test('returns null when the proxy did not forward a method', () => {
    expect(methodFromHeaders(new Headers())).toBeNull();
    expect(methodFromHeaders(new Headers({ 'x-http-method': '' }))).toBeNull();
  });
});

describe('userAgentProductFromHeaders', () => {
  test('keeps only the first product token', () => {
    expect(
      userAgentProductFromHeaders(
        new Headers({ 'user-agent': 'kilo-cli/1.2.3 (darwin; arm64) another/1.0' })
      )
    ).toBe('kilo-cli/1.2.3');
  });

  test('returns null without a User-Agent', () => {
    expect(userAgentProductFromHeaders(new Headers())).toBeNull();
  });
});

describe('target builders', () => {
  test('organizationTarget/userTarget/serviceTarget use a <type>:<id> reference', () => {
    expect(organizationTarget('org-1')).toBe('organization:org-1');
    expect(userTarget('user-1')).toBe('user:user-1');
    expect(serviceTarget('cloud-agent')).toBe('service:cloud-agent');
    expect(UNSCOPED_TARGET).toBe('*');
  });

  test('organizationsTarget names the org when the batch holds exactly one', () => {
    expect(organizationsTarget(['org-1', 'org-1'])).toBe('organization:org-1');
  });

  test('organizationsTarget records the deduplicated breadth for larger batches', () => {
    expect(organizationsTarget(['org-1', 'org-2', 'org-2'])).toBe('organizations:2');
  });

  test('organizationsTarget reports a zero-length batch rather than throwing', () => {
    expect(organizationsTarget([])).toBe('organizations:0');
  });
});

describe('kilo admin elevation telemetry', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  function ctxFor(overrides: Partial<AdminAuditContext> = {}): AdminAuditContext {
    return {
      user: defineTestUser({ is_admin: true, is_super_admin: false }),
      authViaToken: false,
      tokenSource: null,
      ip: '203.0.113.7',
      trpcPath: 'organizations.getSettings',
      trpcType: 'query',
      ...overrides,
    };
  }

  test('recordKiloAdminElevation attributes the event to the exact procedure', async () => {
    const ctx = ctxFor();

    await recordKiloAdminElevation(ctx, {
      reason: 'organization_access',
      target: organizationTarget('org-1'),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'admin_access',
      surface: 'trpc',
      kind: 'kilo_admin_elevation',
      kiloUserId: ctx.user.id,
      email: ctx.user.google_user_email,
      adminTier: 'platform_admin',
      authVia: 'session',
      tokenSource: null,
      credential: 'session',
      membershipRole: null,
      wouldPassWithoutAdmin: null,
      wouldBlock: false,
      userAgentProduct: null,
      route: 'organizations.getSettings',
      method: 'query',
      ip: '203.0.113.7',
      reason: 'organization_access',
      target: 'organization:org-1',
      supportDecision: null,
      supportGrantId: null,
      supportActionId: null,
      inventoryId: null,
      issuanceId: null,
    });
  });

  test('carries the token discriminator so a stolen admin token is separable', async () => {
    await recordKiloAdminElevation(ctxFor({ authViaToken: true, tokenSource: 'cloud-agent' }), {
      reason: 'cli_session_cross_org_query',
      target: UNSCOPED_TARGET,
    });

    expect(events[0]).toMatchObject({ authVia: 'token', tokenSource: 'cloud-agent' });
  });

  test('attributes a context without the tRPC middleware to the request surface', async () => {
    // `ensureOrganizationAccess` and friends are shared with REST route handlers
    // that hand-roll `{ user }`. Those elevations must not be labelled `trpc`,
    // and must derive `authVia` from the request rather than assuming a session.
    await recordKiloAdminElevation(
      { user: defineTestUser({ is_admin: true }) },
      { reason: 'organization_fetch', target: UNSCOPED_TARGET }
    );

    expect(events[0]).toMatchObject({
      surface: 'rest',
      route: null,
      method: null,
      ip: null,
      target: UNSCOPED_TARGET,
    });
  });

  test('a tokenSource on a non-tRPC context survives the REST fallback', async () => {
    await recordKiloAdminElevation(
      { user: defineTestUser({ is_admin: true }), tokenSource: 'cloud-agent' },
      { reason: 'organization_access', target: organizationTarget('org-1') }
    );

    expect(events[0]).toMatchObject({ surface: 'rest', tokenSource: 'cloud-agent' });
  });

  test('elevateViaKiloAdmin returns the grant and emits exactly one event', async () => {
    const granted = await elevateViaKiloAdmin(ctxFor(), {
      reason: 'organization_access',
      target: organizationTarget('org-1'),
      grant: 'owner',
    });

    expect(granted).toBe('owner');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_access',
    });
  });

  test('a throwing sink never propagates into the admin action', async () => {
    setAdminAccessSinkForTest(() => {
      throw new Error('drain unavailable');
    });

    await expect(
      elevateViaKiloAdmin(ctxFor(), {
        reason: 'organization_access',
        target: organizationTarget('org-1'),
        grant: 'owner',
      })
    ).resolves.toBe('owner');
  });

  test('recordKiloAdminElevationForRequest still emits when no header store exists', async () => {
    // `headers()` throws outside a request scope; the event must survive that.
    await recordKiloAdminElevationForRequest({
      user: defineTestUser({ is_admin: true, is_super_admin: true }),
      reason: 'service_token_mint',
      target: serviceTarget('cloud-agent'),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: 'rest',
      kind: 'kilo_admin_elevation',
      adminTier: 'super_admin',
      authVia: 'session',
      route: null,
      method: null,
      ip: null,
      reason: 'service_token_mint',
      target: 'service:cloud-agent',
    });
  });

  test('a server-component caller is labelled as such, not as a route handler', async () => {
    await recordKiloAdminElevationForRequest({
      user: defineTestUser({ is_admin: true }),
      reason: 'organization_access_rest',
      target: organizationTarget('org-1'),
      surface: 'server-component',
    });

    expect(events[0]).toMatchObject({
      surface: 'server-component',
      kind: 'kilo_admin_elevation',
      // Still no fabricated HTTP method: a render carries no trustworthy one.
      method: null,
      reason: 'organization_access_rest',
      target: 'organization:org-1',
    });
  });
});

describe('privileged access telemetry', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(() => {
    setAdminAccessSinkForTest(null);
  });

  test('emits the bearer discriminator, action class, and outcome without request secrets', () => {
    emitPrivilegedAccessEvent({
      surface: 'rest',
      user: defineTestUser({ is_admin: true }),
      credential: 'human_bearer',
      outcome: 'succeeded',
      actionClass: 'sensitive_write',
      actionId: 'rest.admin.users',
      target: 'user:user-1',
      tokenSource: null,
      route: '/admin/api/users',
      method: null,
      ip: '203.0.113.7',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'admin_access',
      kind: 'privileged_access',
      credential: 'human_bearer',
      outcome: 'succeeded',
      actionClass: 'sensitive_write',
      actionId: 'rest.admin.users',
      target: 'user:user-1',
      authVia: 'token',
      route: '/admin/api/users',
      ip: '203.0.113.7',
    });
    expect(JSON.stringify(events[0])).not.toMatch(/authorization|cookie|bearer /i);
  });

  test('records a refused credential even when no user could be resolved', () => {
    emitPrivilegedAccessEvent({
      surface: 'rest',
      credential: 'human_bearer',
      outcome: 'denied',
      actionClass: 'support_read',
      tokenSource: null,
      route: '/admin/api/users',
      method: null,
      ip: null,
    });

    expect(events[0]).toMatchObject({
      kind: 'privileged_access',
      kiloUserId: null,
      email: null,
      adminTier: null,
      outcome: 'denied',
    });
  });

  test('records real membership and the planned-policy wouldBlock signal', async () => {
    await recordKiloAdminElevation(
      {
        user: defineTestUser({ is_admin: true }),
        authViaToken: true,
        tokenSource: 'cloud-agent',
        trpcPath: 'organizations.getSettings',
        trpcType: 'query',
      },
      {
        reason: 'organization_access',
        target: organizationTarget('org-1'),
        membershipRole: 'member',
        wouldPassWithoutAdmin: false,
      }
    );

    expect(events[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      credential: 'delegated_workload',
      membershipRole: 'member',
      wouldPassWithoutAdmin: false,
      wouldBlock: true,
    });
    expect(events[1]).toMatchObject({ kind: 'privileged_access', wouldBlock: true });
  });

  test('derives delegated workload and service assertion credentials separately', () => {
    emitPrivilegedAccessEvent({
      surface: 'trpc',
      credential: 'delegated_workload',
      outcome: 'succeeded',
      actionClass: 'support_read',
      tokenSource: 'cloud-agent',
      route: 'organizations.getSettings',
      method: 'query',
      ip: null,
    });
    emitPrivilegedAccessEvent({
      surface: 'rest',
      credential: 'service_assertion',
      outcome: 'succeeded',
      actionClass: 'platform_read',
      tokenSource: null,
      route: '/admin/api/users',
      method: null,
      ip: null,
    });

    expect(events.map(event => event.kind === 'privileged_access' && event.credential)).toEqual([
      'delegated_workload',
      'service_assertion',
    ]);
  });
});
