import { randomUUID } from 'crypto';

import { eq } from 'drizzle-orm';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

import {
  approvePasskeyManagementSsoRequest,
  createPasskeyManagementSsoRequest,
} from './passkey-management';
import { evaluatePasskeyManagementApproval } from './passkey-management-approval';

jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organization-sso-policy'
  ) as object),
  resolveSsoAuthorityForDomain: jest.fn(),
}));

const mockResolveAuthority = jest.mocked(resolveSsoAuthorityForDomain);
const ORGANIZATION_ID = 'org_sso_required';

async function insertNativeSession(kiloUserId: string): Promise<string> {
  const [row] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId, user_agent: 'Kilo-Code/1.0.0 (ios)' })
    .returning({ id: device_sessions.id });
  if (!row) {
    throw new Error('device session insert returned no row');
  }
  return row.id;
}

async function startRequest(kiloUserId: string): Promise<string> {
  const deviceSessionId = await insertNativeSession(kiloUserId);
  const started = await createPasskeyManagementSsoRequest({
    userId: kiloUserId,
    deviceSessionId,
    operation: 'remove',
    ssoOrganizationId: ORGANIZATION_ID,
  });
  return started.requestId;
}

function freshSession(userId: string, email: string, ssoSourceOrganizationId: string) {
  return {
    userId,
    email,
    authenticatedAt: Math.floor(Date.now() / 1000),
    ssoSourceOrganizationId,
  };
}

describe('evaluatePasskeyManagementApproval', () => {
  const domain = 'example.com';

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAuthority.mockResolvedValue({
      status: 'required',
      domain,
      sourceOrganizationId: ORGANIZATION_ID,
    });
  });

  it('reports an unknown or already-approved request as expired', async () => {
    await expect(
      evaluatePasskeyManagementApproval({
        requestId: '11111111-1111-4111-8111-111111111111',
        session: null,
      })
    ).resolves.toEqual({ status: 'expired' });
  });

  it('asks for a sign-in when the reader has no session', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);

    await expect(evaluatePasskeyManagementApproval({ requestId, session: null })).resolves.toEqual({
      status: 'sign_in',
    });
  });

  it('refuses a session of another account without naming that account', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    const requestId = await startRequest(owner.id);

    const state = await evaluatePasskeyManagementApproval({
      requestId,
      session: freshSession(other.id, other.google_user_email, ORGANIZATION_ID),
    });

    expect(state).toEqual({ status: 'wrong_account', signedInEmail: other.google_user_email });
    // The request id is public, so a reader of the link must learn nothing
    // about the account that started it.
    expect(JSON.stringify(state)).not.toContain(owner.google_user_email);
  });

  it('refuses a session that signed in too long ago', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);

    const state = await evaluatePasskeyManagementApproval({
      requestId,
      session: {
        userId: user.id,
        email: user.google_user_email,
        authenticatedAt: Math.floor(
          (Date.now() - STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS - 60_000) / 1000
        ),
        ssoSourceOrganizationId: ORGANIZATION_ID,
      },
    });

    expect(state).toEqual({ status: 'stale' });
  });

  it('refuses a fresh session that did not sign in through the required SSO', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);

    await expect(
      evaluatePasskeyManagementApproval({
        requestId,
        session: freshSession(user.id, user.google_user_email, 'org_other'),
      })
    ).resolves.toEqual({ status: 'sso_required' });
  });

  it('refuses once the domain no longer requires the organization', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);
    mockResolveAuthority.mockResolvedValue({ status: 'not_required', domain });

    await expect(
      evaluatePasskeyManagementApproval({
        requestId,
        session: freshSession(user.id, user.google_user_email, ORGANIZATION_ID),
      })
    ).resolves.toEqual({ status: 'organization_not_required' });
  });

  it('is ready for the owning account with fresh SSO provenance', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);

    await expect(
      evaluatePasskeyManagementApproval({
        requestId,
        session: freshSession(user.id, user.google_user_email, ORGANIZATION_ID),
      })
    ).resolves.toEqual({
      status: 'ready',
      requestId,
      operation: 'remove',
      accountEmail: user.google_user_email,
      requiredOrganizationId: ORGANIZATION_ID,
    });
  });

  it('reports expired once account recovery rotates the pepper', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);
    await db
      .update(kilocode_users)
      .set({ web_session_pepper: randomUUID() })
      .where(eq(kilocode_users.id, user.id));

    await expect(
      evaluatePasskeyManagementApproval({
        requestId,
        session: freshSession(user.id, user.google_user_email, ORGANIZATION_ID),
      })
    ).resolves.toEqual({ status: 'expired' });
  });

  it('reports the stored approval instead of a pending form', async () => {
    const user = await insertTestUser();
    const requestId = await startRequest(user.id);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: user.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });

    await expect(
      evaluatePasskeyManagementApproval({
        requestId,
        session: freshSession(user.id, user.google_user_email, ORGANIZATION_ID),
      })
    ).resolves.toEqual({
      status: 'approved',
      operation: 'remove',
      accountEmail: user.google_user_email,
    });
  });
});
