jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organization-sso-policy'
  ) as object),
  resolveSsoAuthorityForDomain: jest.fn(),
}));

import { eq } from 'drizzle-orm';

import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, passkey_management_authorizations } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  createPasskeyManagementSsoRequest,
  readPasskeyManagementSsoRequestForApproval,
} from '@/lib/auth/passkey-management';
import { POST } from './route';

const mockSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockResolveAuthority = jest.mocked(resolveSsoAuthorityForDomain);

const ORGANIZATION_ID = 'org_sso_required';
const APPROVE_URL = 'http://localhost:3000/api/auth/passkey/management/approve';

function approveRequest(
  requestId: string,
  options: { origin?: string; authorization?: string } = {}
): Request {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    origin: options.origin ?? 'http://localhost:3000',
  });
  if (options.authorization) {
    headers.set('authorization', options.authorization);
  }
  return new Request(APPROVE_URL, {
    method: 'POST',
    body: new URLSearchParams({ request: requestId }).toString(),
    headers,
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

async function startRequest(kiloUserId: string, ssoOrganizationId = ORGANIZATION_ID) {
  const deviceSessionId = await insertNativeSession(kiloUserId);
  return createPasskeyManagementSsoRequest({
    userId: kiloUserId,
    deviceSessionId,
    operation: 'enroll',
    ssoOrganizationId,
  });
}

function signedIn(options: {
  userId: string;
  email: string;
  authenticatedAt?: number;
  ssoSourceOrganizationId?: string;
}) {
  mockSession.mockResolvedValue({
    user: { id: options.userId, google_user_email: options.email } as never,
    authFailedResponse: null,
    authenticatedAt: options.authenticatedAt ?? Math.floor(Date.now() / 1000),
    ssoSourceOrganizationId: options.ssoSourceOrganizationId ?? ORGANIZATION_ID,
  } as never);
}

function redirectTarget(response: Response): URL {
  return new URL(response.headers.get('location') ?? '');
}

describe('POST /api/auth/passkey/management/approve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({
      user: null,
      authFailedResponse: null,
    } as never);
    mockResolveAuthority.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: ORGANIZATION_ID,
    });
  });

  it('approves for the owning account with fresh SSO provenance', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({ userId: user.id, email: user.google_user_email });

    const response = await POST(approveRequest(started.requestId));

    expect(response.status).toBe(303);
    const target = redirectTarget(response);
    expect(target.pathname).toBe('/passkey-approval');
    expect(target.searchParams.get('request')).toBe(started.requestId);
    expect(target.searchParams.get('status')).toBe('approved');
    await expect(
      readPasskeyManagementSsoRequestForApproval(started.requestId)
    ).resolves.toMatchObject({ state: 'approved' });
  });

  it('refuses a form posted from another origin', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({ userId: user.id, email: user.google_user_email });

    const response = await POST(
      approveRequest(started.requestId, { origin: 'https://evil.example' })
    );

    expect(response.status).toBe(400);
    await expect(
      readPasskeyManagementSsoRequestForApproval(started.requestId)
    ).resolves.not.toBeNull();
  });

  it('refuses a bearer credential on the browser path', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({ userId: user.id, email: user.google_user_email });

    const response = await POST(
      approveRequest(started.requestId, { authorization: 'Bearer session-token' })
    );

    expect(response.status).toBe(400);
  });

  it('does not approve a stale browser session', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({
      userId: user.id,
      email: user.google_user_email,
      authenticatedAt: Math.floor(
        (Date.now() - STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS - 60_000) / 1000
      ),
    });

    const response = await POST(approveRequest(started.requestId));

    expect(response.status).toBe(303);
    expect(redirectTarget(response).searchParams.get('error')).toBe('stale');
    await expect(
      readPasskeyManagementSsoRequestForApproval(started.requestId)
    ).resolves.not.toBeNull();
  });

  it('refuses an approval from another account', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    const started = await startRequest(owner.id);
    signedIn({ userId: other.id, email: other.google_user_email });

    const response = await POST(approveRequest(started.requestId));

    expect(redirectTarget(response).searchParams.get('error')).toBe('wrong_account');
    await expect(
      readPasskeyManagementSsoRequestForApproval(started.requestId)
    ).resolves.not.toBeNull();
  });

  it('refuses a session that did not sign in through the required SSO', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({
      userId: user.id,
      email: user.google_user_email,
      ssoSourceOrganizationId: 'org_other',
    });

    const response = await POST(approveRequest(started.requestId));

    expect(redirectTarget(response).searchParams.get('error')).toBe('sso_required');
  });

  it('refuses once the domain no longer requires the organization', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({ userId: user.id, email: user.google_user_email });
    mockResolveAuthority.mockResolvedValue({ status: 'not_required', domain: 'example.com' });

    const response = await POST(approveRequest(started.requestId));

    expect(redirectTarget(response).searchParams.get('error')).toBe('organization_not_required');
  });

  it('refuses an expired request', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);
    signedIn({ userId: user.id, email: user.google_user_email });
    await db
      .update(passkey_management_authorizations)
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(passkey_management_authorizations.id, started.requestId));

    const response = await POST(approveRequest(started.requestId));

    expect(redirectTarget(response).searchParams.get('error')).toBe('expired');
  });

  it('sends an anonymous reader to sign in, leaving the request pending', async () => {
    const user = await insertTestUser();
    const started = await startRequest(user.id);

    const response = await POST(approveRequest(started.requestId));

    expect(response.status).toBe(303);
    expect(redirectTarget(response).searchParams.get('error')).toBe('sign_in');
    await expect(
      readPasskeyManagementSsoRequestForApproval(started.requestId)
    ).resolves.not.toBeNull();
  });
});
