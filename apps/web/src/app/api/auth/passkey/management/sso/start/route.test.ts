import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/auth/native-admission', () => ({
  ...(jest.requireActual('@/lib/auth/native-admission') as object),
  verifyAdmissionAsync: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organization-sso-policy'
  ) as object),
  resolveSsoAuthorityForDomain: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { verifyAdmissionAsync } from '@/lib/auth/native-admission';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, passkey_management_authorizations, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { POST } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockVerifyAdmissionAsync = jest.mocked(verifyAdmissionAsync);
const mockResolveAuthority = jest.mocked(resolveSsoAuthorityForDomain);

const ORGANIZATION_ID = 'org_sso_required';
const admission = {
  platform: 'android',
  kind: 'assertion',
  challenge: 'challenge',
  payload: 'integrity-token',
};

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/management/sso/start', {
    method: 'POST',
    body: JSON.stringify(body),
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

function authenticate(
  user: User,
  deviceSessionId: string | undefined,
  credential = 'human_bearer'
) {
  mockGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    credential: credential as never,
    deviceSessionId,
  } as never);
}

async function requestCount(kiloUserId: string): Promise<number> {
  const rows = await db
    .select({ id: passkey_management_authorizations.id })
    .from(passkey_management_authorizations)
    .where(eq(passkey_management_authorizations.kilo_user_id, kiloUserId));
  return rows.length;
}

describe('POST /api/auth/passkey/management/sso/start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true } as never);
    mockResolveAuthority.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: ORGANIZATION_ID,
    });
  });

  it('starts a pending request and returns the approval URL', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);

    const response = await POST(createRequest({ operation: 'enroll', admission }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      requestId: string;
      approvalUrl: string;
      expiresIn: number;
    };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL(body.approvalUrl).pathname).toBe('/passkey-approval');
    expect(new URL(body.approvalUrl).searchParams.get('request')).toBe(body.requestId);
    expect(body.expiresIn).toBe(600);

    const [row] = await db
      .select({
        state: passkey_management_authorizations.state,
        operation: passkey_management_authorizations.operation,
        tokenHash: passkey_management_authorizations.token_hash,
        ssoOrganizationId: passkey_management_authorizations.sso_organization_id,
        deviceSessionId: passkey_management_authorizations.device_session_id,
      })
      .from(passkey_management_authorizations)
      .where(eq(passkey_management_authorizations.id, body.requestId));
    expect(row).toEqual({
      state: 'pending',
      operation: 'enroll',
      tokenHash: null,
      ssoOrganizationId: ORGANIZATION_ID,
      deviceSessionId,
    });
  });

  it('refuses SSO when the domain does not require it', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    mockResolveAuthority.mockResolvedValue({ status: 'not_required', domain: 'example.com' });

    const response = await POST(createRequest({ operation: 'remove', admission }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'SSO_NOT_REQUIRED' });
    await expect(requestCount(user.id)).resolves.toBe(0);
  });

  it('refuses a cookie session', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId, 'session');

    const response = await POST(createRequest({ operation: 'enroll', admission }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED',
    });
    await expect(requestCount(user.id)).resolves.toBe(0);
  });

  it('refuses an ordinary API key without a device session', async () => {
    const user = await insertTestUser();
    authenticate(user, undefined);

    const response = await POST(createRequest({ operation: 'enroll', admission }));

    expect(response.status).toBe(403);
    await expect(requestCount(user.id)).resolves.toBe(0);
  });

  it('requires a device proof before writing anything', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);

    const response = await POST(createRequest({ operation: 'enroll' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'ADMISSION_REQUIRED' });
    await expect(requestCount(user.id)).resolves.toBe(0);
    expect(mockVerifyAdmissionAsync).not.toHaveBeenCalled();
  });

  it('refuses a revoked device session', async () => {
    const user = await insertTestUser();
    const deviceSessionId = await insertNativeSession(user.id);
    authenticate(user, deviceSessionId);
    await db
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(device_sessions.id, deviceSessionId));

    const response = await POST(createRequest({ operation: 'enroll', admission }));

    expect(response.status).toBe(403);
    await expect(requestCount(user.id)).resolves.toBe(0);
  });
});
