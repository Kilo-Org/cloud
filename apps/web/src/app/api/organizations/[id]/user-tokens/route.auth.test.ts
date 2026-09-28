const mockHeaders = jest.fn();
const mockSession = jest.fn();
jest.mock('next/headers', () => ({ headers: () => mockHeaders(), cookies: jest.fn() }));
jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockSession(...args),
}));

import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { db } from '@/lib/drizzle';
import {
  device_sessions,
  organizations,
  organization_memberships,
  organization_audit_logs,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { generateApiToken } from '@/lib/tokens';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import {
  canIssueLegacyOrganizationToken,
  createControlTokenForRequest,
} from '@/lib/auth/resource-delegation';
import { POST } from './route';
jest.mock('../../../../../../../../services/ai-attribution/src/util/logger', () => ({
  logger: {},
}));
const { validateKiloToken } = jest.requireActual<{
  validateKiloToken: (header: string, secret: string) => Promise<{ success: boolean }>;
}>('../../../../../../../../services/ai-attribution/src/util/auth');

let user: User;
let orgId: string;
const userIds: string[] = [];
const parentIds: string[] = [];
const originalShared = process.env.SHARED_RESOURCE_TOKENS_ENABLED;
const originalFamily = process.env.DELEGATED_RESOURCE_TOKENS_ENABLED;

beforeEach(async () => {
  user = await insertTestUser({
    api_token_pepper: crypto.randomUUID(),
    web_session_pepper: crypto.randomUUID(),
  });
  userIds.push(user.id);
  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Legacy token compatibility',
      created_by_kilo_user_id: user.id,
      require_seats: false,
    })
    .returning();
  orgId = org.id;
  await db.insert(organization_memberships).values({
    organization_id: orgId,
    kilo_user_id: user.id,
    role: 'member',
  });
  mockSession.mockResolvedValue({ kiloUserId: user.id, webSessionPepper: user.web_session_pepper });
});

afterEach(async () => {
  await db
    .delete(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, orgId));
  await db
    .delete(organization_memberships)
    .where(eq(organization_memberships.organization_id, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  if (parentIds.length) {
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, parentIds));
    await db.delete(organizations).where(inArray(organizations.id, parentIds));
    parentIds.length = 0;
  }
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  userIds.length = 0;
  if (originalShared === undefined) delete process.env.SHARED_RESOURCE_TOKENS_ENABLED;
  else process.env.SHARED_RESOURCE_TOKENS_ENABLED = originalShared;
  if (originalFamily === undefined) delete process.env.DELEGATED_RESOURCE_TOKENS_ENABLED;
  else process.env.DELEGATED_RESOURCE_TOKENS_ENABLED = originalFamily;
  jest.clearAllMocks();
});

function setIssuance(enabled: boolean) {
  process.env.SHARED_RESOURCE_TOKENS_ENABLED = String(enabled);
  process.env.DELEGATED_RESOURCE_TOKENS_ENABLED = String(enabled);
}

function request(headers: Headers, body?: string) {
  mockHeaders.mockResolvedValue(headers);
  return POST(
    new NextRequest(`https://example.test/api/organizations/${orgId}/user-tokens`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve({ id: orgId }) }
  );
}

function bearer(token: string) {
  return new Headers({ authorization: `Bearer ${token}` });
}

function signedClaims(extra: Record<string, unknown>, secret = NEXTAUTH_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      version: 3,
      env: process.env.NODE_ENV,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      iat: now,
      exp: now + 3600,
      ...extra,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

async function auditLogs() {
  return db
    .select()
    .from(organization_audit_logs)
    .where(eq(organization_audit_logs.organization_id, orgId));
}

for (const enabled of [false, true]) {
  describe(`legacy organization issuance with resource flags ${enabled}`, () => {
    beforeEach(() => setIssuance(enabled));

    test.each(['cookie', 'empty-header-cookie', 'legacy-1h', 'legacy-5y'] as const)(
      'preserves %s for absent, empty, malformed and empty-object bodies',
      async auth => {
        const headers = auth.startsWith('legacy')
          ? bearer(
              generateApiToken(
                user,
                undefined,
                auth === 'legacy-1h' ? { expiresIn: 3600 } : undefined
              )
            )
          : new Headers({ cookie: 'next-auth.session-token=test-session' });
        if (auth === 'empty-header-cookie') headers.set('authorization', '');
        for (const body of [undefined, '', '{', '{}']) {
          const response = await request(headers, body);
          expect(response.status).toBe(200);
          const result = await response.json();
          const claims = jwt.verify(result.token, NEXTAUTH_SECRET) as jwt.JwtPayload;
          expect(claims).toMatchObject({
            kiloUserId: user.id,
            organizationId: orgId,
            organizationRole: 'member',
          });
          expect(claims.exp! - claims.iat!).toBe(900);
          expect(claims).not.toHaveProperty('aud');
          expect(claims).not.toHaveProperty('tokenPurpose');
          expect(result.organizationId).toBe(orgId);
          expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
        }
        const logs = await auditLogs();
        expect(logs).toHaveLength(4);
        expect(logs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'organization.token.generate',
              actor_id: user.id,
            }),
          ])
        );
      }
    );

    test.each([900, 3600, 7200])(
      'preserves legacy human tokens with deviceAuthRequestCode and %s-second lifetime',
      async expiresIn => {
        const response = await request(
          bearer(generateApiToken(user, { deviceAuthRequestCode: 'legacy-login' }, { expiresIn }))
        );
        expect(response.status).toBe(200);
        expect(jwt.verify((await response.json()).token, NEXTAUTH_SECRET)).toMatchObject({
          organizationId: orgId,
        });
      }
    );

    test.each(['active', 'revoked', 'foreign'] as const)(
      'checks %s legacy native device sessions',
      async state => {
        let ownerId = user.id;
        if (state === 'foreign') {
          const other = await insertTestUser();
          userIds.push(other.id);
          ownerId = other.id;
        }
        const [session] = await db
          .insert(device_sessions)
          .values({
            kilo_user_id: ownerId,
            user_agent: 'legacy-native-test',
            ...(state === 'revoked' ? { revoked_at: new Date().toISOString() } : {}),
          })
          .returning();
        const headers = bearer(
          generateApiToken(user, { deviceSessionId: session.id }, { expiresIn: 3600 })
        );
        await expect(canIssueLegacyOrganizationToken(headers, user)).resolves.toBe(
          state === 'active'
        );
        const response = await request(headers);
        expect(response.status).toBe(state === 'active' ? 200 : 403);
        if (state !== 'active') expect(await auditLogs()).toEqual([]);
      }
    );

    test('does not initialize an absent API pepper', async () => {
      await db
        .update(kilocode_users)
        .set({ api_token_pepper: null })
        .where(eq(kilocode_users.id, user.id));
      user = { ...user, api_token_pepper: null };
      const response = await request(
        bearer(generateApiToken(user, undefined, { expiresIn: 3600 }))
      );
      expect(response.status).toBe(200);
      const stored = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(stored?.api_token_pepper).toBeNull();
    });

    test.each(['owner', 'admin', 'billing_manager'] as const)(
      'retains legacy %s role',
      async role => {
        await db
          .update(organization_memberships)
          .set({ role })
          .where(eq(organization_memberships.organization_id, orgId));
        const response = await request(
          bearer(generateApiToken(user, undefined, { expiresIn: 3600 }))
        );
        expect(response.status).toBe(200);
        const claims = jwt.verify((await response.json()).token, NEXTAUTH_SECRET);
        expect(claims).toMatchObject({ organizationRole: role });
      }
    );

    test.each([
      'audience-only',
      'modern',
      'scoped-modern',
      'exchange-only',
      'organization',
      'service',
      'runtime',
      'device',
      'admin',
      'internal',
      'unknown-claim',
    ])('rejects %s claims without minting or auditing', async kind => {
      const modern = { aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: false };
      const extras: Record<string, Record<string, unknown>> = {
        'audience-only': { aud: 'kilo-api' },
        modern,
        'scoped-modern': { ...modern, organizationId: orgId, organizationRole: 'member' },
        'exchange-only': { credentialExchange: false },
        organization: { organizationId: orgId, organizationRole: 'member' },
        service: { tokenSource: 'cloud-agent' },
        admin: { isAdmin: true },
        internal: { internalApiUse: true },
        runtime: {
          aud: 'kilo-api',
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
          runtimeAuthorization: {
            id: crypto.randomUUID(),
            resourceKind: 'cloud-agent-next',
            resourceId: 'restricted-runtime',
          },
        },
        device: { deviceSessionId: crypto.randomUUID() },
        'unknown-claim': { futureScope: 'restricted' },
      };
      const token = signedClaims(extras[kind]);
      if (kind !== 'exchange-only') {
        await expect(
          verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
            audience: 'kilo-api',
            mode: 'allow-legacy',
          })
        ).resolves.toMatchObject({ userId: user.id });
      }
      const headers = bearer(token);
      await expect(canIssueLegacyOrganizationToken(headers, user)).resolves.toBe(false);
      const response = await request(headers);
      expect([401, 403]).toContain(response.status);
      expect(await response.json()).not.toHaveProperty('token');
      expect(await auditLogs()).toEqual([]);
    });

    test.each([
      'invalid-signature',
      'expired',
      'wrong-user',
      'revoked-pepper',
      'wrong-env',
      'malformed-header',
    ])('fails closed for %s even with a valid ambient session', async kind => {
      let token = signedClaims({});
      if (kind === 'invalid-signature') token = signedClaims({}, 'wrong-signing-secret');
      if (kind === 'expired') token = signedClaims({ iat: 1, exp: 2 });
      if (kind === 'wrong-env') token = signedClaims({ env: 'different-environment' });
      if (kind === 'wrong-user') {
        const other = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
        userIds.push(other.id);
        token = generateApiToken(other);
      }
      if (kind === 'revoked-pepper') {
        const pepper = crypto.randomUUID();
        await db
          .update(kilocode_users)
          .set({ api_token_pepper: pepper })
          .where(eq(kilocode_users.id, user.id));
        user = { ...user, api_token_pepper: pepper };
      }
      const headers =
        kind === 'malformed-header'
          ? new Headers({ authorization: 'Basic invalid' })
          : bearer(token);
      await expect(canIssueLegacyOrganizationToken(headers, user)).resolves.toBe(false);
      const response = await request(headers);
      expect([401, 403, 404]).toContain(response.status);
      expect(await response.json()).not.toHaveProperty('token');
      expect(await auditLogs()).toEqual([]);
    });

    test.each(['{"resource":null}', '{"resource":"unknown"}'])(
      'rejects unsupported resource %s',
      async body => {
        expect((await request(bearer(generateApiToken(user)), body)).status).toBe(400);
        expect(await auditLogs()).toEqual([]);
      }
    );

    test('keeps explicit delegation gated and separate from legacy issuance', async () => {
      const response = await request(bearer(generateApiToken(user)), '{"resource":"api"}');
      expect(response.status).toBe(enabled ? 200 : 503);
      const result = await response.json();
      if (enabled) {
        expect(jwt.verify(result.token, NEXTAUTH_SECRET)).toMatchObject({
          aud: 'kilo-api',
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
          organizationId: orgId,
        });
      } else {
        expect(result).not.toHaveProperty('token');
        expect(await auditLogs()).toEqual([]);
      }
    });
  });
}

describe('explicit organization access', () => {
  beforeEach(() => setIssuance(true));

  async function inherited(role: 'owner' | 'admin' | 'member' | 'billing_manager') {
    const [parent] = await db
      .insert(organizations)
      .values({ name: 'Delegation parent', require_seats: false })
      .returning();
    parentIds.push(parent.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, orgId));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, orgId));
    await db
      .insert(organization_memberships)
      .values({ organization_id: parent.id, kilo_user_id: user.id, role });
  }

  test.each(['owner', 'admin'] as const)(
    'issues child organization tokens for inherited %s',
    async role => {
      await inherited(role);
      for (const headers of [new Headers(), bearer(generateApiToken(user))]) {
        const response = await request(headers, '{"resource":"api"}');
        expect(response.status).toBe(200);
        const claims = jwt.verify((await response.json()).token, NEXTAUTH_SECRET) as jwt.JwtPayload;
        expect(claims).toMatchObject({
          organizationId: orgId,
          organizationRole: role,
          aud: 'kilo-api',
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
        });
        expect(claims.exp! - claims.iat!).toBe(900);
      }
      expect(await auditLogs()).toHaveLength(2);
    }
  );

  test.each(['member', 'billing_manager'] as const)(
    'denies inherited %s explicit issuance',
    async role => {
      await inherited(role);
      const response = await request(new Headers(), '{"resource":"api"}');
      expect(response.status).toBe(role === 'member' ? 404 : 403);
      expect(await auditLogs()).toEqual([]);
    }
  );

  test('denies unrelated organizations', async () => {
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, orgId));
    expect((await request(bearer(generateApiToken(user)), '{"resource":"api"}')).status).toBe(404);
    expect(await auditLogs()).toEqual([]);
  });

  test.each([false, true])('denies deleted organizations for global admin %s', async isAdmin => {
    await inherited('owner');
    await db
      .update(kilocode_users)
      .set({ is_admin: isAdmin })
      .where(eq(kilocode_users.id, user.id));
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, orgId));
    expect((await request(new Headers(), '{"resource":"api"}')).status).toBe(404);
    expect(await auditLogs()).toEqual([]);
  });

  test('retains global-admin explicit issuance without membership', async () => {
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, orgId));
    await db.update(kilocode_users).set({ is_admin: true }).where(eq(kilocode_users.id, user.id));
    for (const headers of [new Headers(), bearer(generateApiToken(user))]) {
      const response = await request(headers, '{"resource":"api"}');
      expect(response.status).toBe(200);
      expect(jwt.verify((await response.json()).token, NEXTAUTH_SECRET)).toMatchObject({
        organizationId: orgId,
        organizationRole: 'owner',
      });
    }
  });

  test.each(['owner', 'admin'] as const)(
    'preserves inherited %s attribution policy',
    async role => {
      await inherited(role);
      const response = await request(new Headers(), '{"resource":"attribution"}');
      expect(response.status).toBe(role === 'owner' ? 200 : 403);
      if (role === 'owner') {
        const { token } = await response.json();
        expect(jwt.verify(token, NEXTAUTH_SECRET)).toMatchObject({
          organizationRole: 'owner',
          aud: 'ai-attribution',
        });
        expect(await validateKiloToken(`Bearer ${token}`, NEXTAUTH_SECRET)).toMatchObject({
          success: true,
          organizationId: orgId,
          organizationRole: 'owner',
        });
      }
    }
  );

  test('does not widen runtime control-token organization authorization', async () => {
    await inherited('owner');
    await expect(
      createControlTokenForRequest(user, 'cloud-agent-next', {
        headers: bearer(generateApiToken(user)),
        organizationId: orgId,
      })
    ).rejects.toThrow('Unauthorized resource delegation request');
  });

  test('still rejects scoped credentials for inherited access', async () => {
    await inherited('owner');
    const headers = bearer(
      signedClaims({
        aud: 'kilo-api',
        tokenPurpose: 'human-api',
        credentialExchange: false,
        organizationId: orgId,
      })
    );
    const response = await request(headers, '{"resource":"api"}');
    expect([401, 403]).toContain(response.status);
    expect(await auditLogs()).toEqual([]);
  });
});
