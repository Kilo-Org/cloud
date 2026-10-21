import jwt from 'jsonwebtoken';
import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import {
  device_sessions,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { isResourceTokenIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { POST } from './route';

// Exercise the real control issuer, JWT policy and PostgreSQL authorization state.
// Substitute the outer auth resolver and secret; the issuer revalidates the bearer.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'cloud-agent-exchange-test-secret',
  isResourceTokenIssuanceEnabled: jest.fn(() => true),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-auth', () => ({
  getAuthorizedOrgContext: jest.fn(),
}));

const secret = 'cloud-agent-exchange-test-secret';
const cleanupUsers: string[] = [];
let user: User;

async function createUser() {
  const created = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
  cleanupUsers.push(created.id);
  return created;
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(isResourceTokenIssuanceEnabled).mockReturnValue(true);
  user = await createUser();
  jest.mocked(getUserFromAuth).mockResolvedValue({ user, authFailedResponse: null });
});

afterEach(async () => {
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, cleanupUsers));
  cleanupUsers.length = 0;
});

function sourceToken(claims: Record<string, unknown> = {}, signingSecret = secret) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      version: 3,
      env: process.env.NODE_ENV,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      deviceAuthRequestCode: 'synthetic-cli-pairing-code',
      iat: now,
      exp: now + 157_680_000,
      ...claims,
    },
    signingSecret,
    { algorithm: 'HS256' }
  );
}

function modernSourceToken(claims: Record<string, unknown> = {}) {
  return sourceToken({
    deviceAuthRequestCode: undefined,
    aud: 'kilo-api',
    tokenPurpose: 'human-api',
    credentialExchange: true,
    exp: Math.floor(Date.now() / 1000) + 1800,
    ...claims,
  });
}

function request(token = sourceToken(), body: unknown = {}) {
  return new NextRequest('https://example.test/api/cloud-agent-next/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function verifyToken(token: unknown) {
  if (typeof token !== 'string') throw new Error('Expected token response');
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (typeof claims === 'string') throw new Error('Expected JWT claims');
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new Error('Expected bounded token lifetime');
  }
  return { ...claims, exp: claims.exp, iat: claims.iat };
}

async function organizationForCurrentUser() {
  const [organization] = await db
    .insert(organizations)
    .values({
      name: `Cloud Agent exchange ${crypto.randomUUID()}`,
      created_by_kilo_user_id: user.id,
      require_seats: false,
    })
    .returning();
  await db.insert(organization_memberships).values({
    kilo_user_id: user.id,
    organization_id: organization.id,
    role: 'member',
  });
  return organization;
}

it('exchanges a legacy CLI credential for a bounded modern Cloud Agent control token', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);
  const claims = verifyToken(body.token);
  expect(claims).toMatchObject({
    kiloUserId: user.id,
    apiTokenPepper: user.api_token_pepper,
    aud: 'cloud-agent-next',
    tokenPurpose: 'human-api',
    credentialExchange: false,
    tokenSource: 'cloud-agent',
    runtimeAdmission: {
      source: 'user',
      authorizationUserId: user.id,
      authorizationPepper: user.api_token_pepper,
    },
  });
  expect(claims.exp - claims.iat).toBe(900);
  expect(body.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
  expect(claims).not.toHaveProperty('organizationId');
  expect(claims).not.toHaveProperty('runtimeAuthorization');
  expect(claims).not.toHaveProperty('deviceAuthRequestCode');
});

it('returns a token the Worker runtime-admission consumer accepts', async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  const body = await response.json();
  const result = await createRuntimeAuthorization({
    token: body.token,
    secret,
    connectionString: 'unused-test-adapter',
    resourceKind: 'cloud-agent-next',
    resourceId: 'workspace_token-exchange-test',
    adapters: {
      getPrincipal: async ({ userId }) =>
        userId === user.id
          ? {
              id: user.id,
              apiTokenPepper: user.api_token_pepper,
              blockedAt: null,
              blockedReason: null,
              isBot: false,
            }
          : null,
    },
  });
  expect(result.authorization).toMatchObject({
    userId: user.id,
    resourceKind: 'cloud-agent-next',
    resourceId: 'workspace_token-exchange-test',
    state: 'active',
  });
});

it('does not exchange the returned control token again', async () => {
  const issued = await POST(request());
  expect(issued.status).toBe(200);
  const body = await issued.json();
  const repeated = await POST(request(body.token));
  expect(repeated.status).toBe(401);
  expect(await repeated.json()).not.toHaveProperty('token');
});

it('rejects a short-lived legacy token without a device session', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const response = await POST(request(sourceToken({ exp })));
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty('token');
});

it('bounds the control token by the source credential expiry', async () => {
  const exp = Math.floor(Date.now() / 1000) + 45;
  const response = await POST(
    request(modernSourceToken({ exp, deviceAuthRequestCode: undefined }))
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(verifyToken(body.token).exp).toBe(exp);
});

it('scopes organization issuance to the authenticated member', async () => {
  const organization = await organizationForCurrentUser();
  const response = await POST(request(sourceToken(), { organizationId: organization.id }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(verifyToken(body.token)).toMatchObject({
    kiloUserId: user.id,
    organizationId: organization.id,
    aud: 'cloud-agent-next',
  });
});

it.each(['removed membership', 'deleted organization'])(
  'rejects organization issuance after %s',
  async state => {
    const organization = await organizationForCurrentUser();
    if (state === 'removed membership') {
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organization.id));
    } else {
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));
    }
    const response = await POST(request(sourceToken(), { organizationId: organization.id }));
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('token');
  }
);

it('accepts an active modern device credential and preserves its device identity', async () => {
  const [device] = await db.insert(device_sessions).values({ kilo_user_id: user.id }).returning();
  const response = await POST(
    request(
      modernSourceToken({
        tokenPurpose: 'device-access',
        credentialExchange: false,
        deviceSessionId: device.id,
        deviceAuthRequestCode: undefined,
      })
    )
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(verifyToken(body.token)).toMatchObject({
    tokenPurpose: 'device-access',
    deviceSessionId: device.id,
  });
});

it.each(['revoked', 'another user'])(
  'rejects a device credential whose session is %s',
  async state => {
    const owner = state === 'another user' ? await createUser() : user;
    const [device] = await db
      .insert(device_sessions)
      .values({
        kilo_user_id: owner.id,
        ...(state === 'revoked' ? { revoked_at: new Date().toISOString() } : {}),
      })
      .returning();
    const response = await POST(
      request(
        modernSourceToken({
          tokenPurpose: 'device-access',
          credentialExchange: false,
          deviceSessionId: device.id,
          deviceAuthRequestCode: undefined,
        })
      )
    );
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('token');
  }
);

it.each([
  { name: 'expired', claims: { exp: 1 } },
  { name: 'wrong environment', claims: { env: 'another-environment' } },
  { name: 'stale pepper', claims: { apiTokenPepper: 'stale' } },
  { name: 'wrong audience', claims: { aud: 'kilo-gateway' } },
])('rejects a source with $name', async ({ claims }) => {
  const response = await POST(request(sourceToken(claims)));
  expect(response.status).toBe(401);
  expect(await response.json()).not.toHaveProperty('token');
});

it('rejects an invalid signature', async () => {
  const response = await POST(request(sourceToken({}, 'untrusted-signing-key')));
  expect(response.status).toBe(401);
  expect(await response.json()).not.toHaveProperty('token');
});

it('rejects a source belonging to another user', async () => {
  const other = await createUser();
  const response = await POST(
    request(sourceToken({ kiloUserId: other.id, apiTokenPepper: other.api_token_pepper }))
  );
  expect(response.status).toBe(401);
  expect(await response.json()).not.toHaveProperty('token');
});

it('rechecks the current user state before issuance', async () => {
  await db
    .update(kilocode_users)
    .set({ blocked_at: new Date().toISOString() })
    .where(eq(kilocode_users.id, user.id));
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(await response.json()).not.toHaveProperty('token');
});

it('rejects delegated workload credentials', async () => {
  const response = await POST(
    request(
      modernSourceToken({
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        deviceAuthRequestCode: undefined,
      })
    )
  );
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty('token');
});

it.each([{ organizationId: crypto.randomUUID() }, { botId: 'bot-test' }, { isAdmin: true }])(
  'rejects restricted legacy credentials: %j',
  async claims => {
    const response = await POST(request(sourceToken(claims)));
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('token');
  }
);

it.each([undefined, '', 'Basic synthetic', 'Bearer '])(
  'requires bearer authentication without cookie fallback: %s',
  async authorization => {
    const headers = new Headers({ cookie: 'synthetic-session-cookie=value' });
    if (authorization !== undefined) headers.set('authorization', authorization);
    const response = await POST(
      new NextRequest('https://example.test/api/cloud-agent-next/token', {
        method: 'POST',
        headers,
        body: '{}',
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getUserFromAuth).not.toHaveBeenCalled();
    expect(getUserFromSessionForCredentialIssuance).not.toHaveBeenCalled();
  }
);

it('preserves authentication failures without caching them', async () => {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    ),
  });
  const response = await POST(request());
  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).not.toHaveProperty('token');
});

it.each([
  null,
  [],
  { organizationId: 'invalid-id' },
  { audience: 'kilo-api' },
  { expiresIn: 157_680_000 },
  { userId: 'someone-else' },
  { runtimeAdmission: { source: 'automation' } },
])('rejects invalid or extra request fields: %j', async body => {
  const response = await POST(request(sourceToken(), body));
  expect(response.status).toBe(400);
  expect(await response.json()).not.toHaveProperty('token');
});

it('rejects malformed JSON', async () => {
  const response = await POST(
    new NextRequest('https://example.test/api/cloud-agent-next/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${sourceToken()}` },
      body: '{',
    })
  );
  expect(response.status).toBe(400);
  expect(await response.json()).not.toHaveProperty('token');
});

it.each(['legacy', 'modern'])('never falls back to legacy issuance for a %s source', async kind => {
  jest.mocked(isResourceTokenIssuanceEnabled).mockReturnValue(false);
  const token = kind === 'legacy' ? sourceToken() : modernSourceToken();
  const response = await POST(request(token));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).not.toHaveProperty('token');
});
