import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organization-sso-policy'
  ) as object),
  resolveSsoAuthorityForDomain: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, passkey_management_authorizations, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  approvePasskeyManagementSsoRequest,
  createPasskeyManagementSsoRequest,
  validatePasskeyManagementAuthorization,
} from '@/lib/auth/passkey-management';
import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockResolveAuthority = jest.mocked(resolveSsoAuthorityForDomain);

const ORGANIZATION_ID = 'org_sso_required';

function createRequest(requestId: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/management/sso/collect', {
    method: 'POST',
    body: JSON.stringify({ requestId }),
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer session-token' },
  });
}

async function insertNativeSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId, user_agent: 'Kilo-Code/1.0.0 (android)' })
    .returning({ id: device_sessions.id });
  if (!row) {
    throw new Error('device session insert returned no row');
  }
  return row.id;
}

function authenticate(user: User, deviceSessionId: string | undefined) {
  mockGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    credential: 'human_bearer' as never,
    deviceSessionId,
  } as never);
}

async function startRequest(kiloUserId: string, deviceSessionId: string): Promise<string> {
  const started = await createPasskeyManagementSsoRequest({
    userId: kiloUserId,
    deviceSessionId,
    operation: 'rename',
    ssoOrganizationId: ORGANIZATION_ID,
  });
  return started.requestId;
}

describe('POST /api/auth/passkey/management/sso/collect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAuthority.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: ORGANIZATION_ID,
    });
  });

  it('answers pending until the browser approves', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const requestId = await startRequest(user.id, deviceSessionId);

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(425);
    await expect(response.json()).resolves.toEqual({ error: 'SSO_APPROVAL_PENDING' });
  });

  it('issues the grant once and never again', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const requestId = await startRequest(user.id, deviceSessionId);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorization: string;
      operation: string;
      expiresIn: number;
    };
    expect(body.operation).toBe('rename');
    expect(body.expiresIn).toBe(300);
    await expect(
      validatePasskeyManagementAuthorization({
        token: body.authorization,
        userId: user.id,
        deviceSessionId,
        operation: 'rename',
      })
    ).resolves.toBe(true);

    const replay = await POST(createRequest(requestId));
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toEqual({ error: 'SSO_APPROVAL_INVALID' });
  });

  it('refuses collection from another session of the same account', async () => {
    const user = await insertTestUser();
    const requestingSession = await insertNativeSession(user.id);
    const otherSession = await insertNativeSession(user.id);
    const requestId = await startRequest(user.id, requestingSession);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    authenticate(user, otherSession);

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'SSO_APPROVAL_INVALID' });
  });

  it.each([
    ['no longer requires SSO', { status: 'not_required', domain: 'example.com' } as const],
    [
      'requires another organization',
      { status: 'required', domain: 'example.com', sourceOrganizationId: 'org_other' } as const,
    ],
  ])('refuses collection once the domain %s', async (_label, authority) => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const requestId = await startRequest(user.id, deviceSessionId);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    mockResolveAuthority.mockResolvedValue(authority);

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'SSO_APPROVAL_INVALID' });
    // Nothing was issued, so the row stays collectible if policy returns.
    const [row] = await db
      .select({ state: passkey_management_authorizations.state })
      .from(passkey_management_authorizations)
      .where(eq(passkey_management_authorizations.id, requestId));
    expect(row?.state).toBe('approved');
  });

  it('refuses collection of an expired request', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const requestId = await startRequest(user.id, deviceSessionId);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    await db
      .update(passkey_management_authorizations)
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(passkey_management_authorizations.id, requestId));

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'SSO_APPROVAL_INVALID' });
  });

  it('refuses collection once the device session is revoked', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    const requestId = await startRequest(user.id, deviceSessionId);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, deviceSessionId));

    const response = await POST(createRequest(requestId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED',
    });
  });

  it('rejects a request id that is not a uuid', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);

    const response = await POST(createRequest('not-a-request-id'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_REQUEST' });
  });
});
