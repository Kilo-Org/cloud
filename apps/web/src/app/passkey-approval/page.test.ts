import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// @swc/jest compiles JSX with the classic runtime, so the page's
// `React.createElement` calls need React on the global.
Object.assign(globalThis, { React });

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organization-sso-policy'
  ) as object),
  resolveSsoAuthorityForDomain: jest.fn(),
}));

import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { device_sessions } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  approvePasskeyManagementSsoRequest,
  createPasskeyManagementSsoRequest,
} from '@/lib/auth/passkey-management';
import PasskeyManagementApprovePage from './page';

const mockSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockResolveAuthority = jest.mocked(resolveSsoAuthorityForDomain);

const ORGANIZATION_ID = 'org_sso_required';

async function startRequest(kiloUserId: string): Promise<string> {
  const [session] = await db
    .insert(device_sessions)
    .values({ kilo_user_id: kiloUserId, user_agent: 'Kilo-Code/1.0.0 (android)' })
    .returning({ id: device_sessions.id });
  if (!session) {
    throw new Error('device session insert returned no row');
  }
  const started = await createPasskeyManagementSsoRequest({
    userId: kiloUserId,
    deviceSessionId: session.id,
    operation: 'remove',
    ssoOrganizationId: ORGANIZATION_ID,
  });
  return started.requestId;
}

async function renderPage(searchParams: Record<string, string>): Promise<string> {
  const element = await PasskeyManagementApprovePage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

describe('passkey approval page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAuthority.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: ORGANIZATION_ID,
    });
  });

  it('never discloses the requesting account when the reader is another account', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    const requestId = await startRequest(owner.id);
    mockSession.mockResolvedValue({
      user: { id: other.id, google_user_email: other.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: requestId });

    expect(html).toContain(other.google_user_email);
    expect(html).not.toContain(owner.google_user_email);
    // The switch-account link carries no target address at all.
    expect(html).not.toContain('email=');
    expect(html).toContain('Sign in with another account');
  });

  it('never claims approval from the redirect flag alone', async () => {
    const owner = await insertTestUser();
    const requestId = await startRequest(owner.id);
    mockSession.mockResolvedValue({
      user: { id: owner.id, google_user_email: owner.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    // The request is real but still pending: the flag cannot skip the form.
    const pendingHtml = await renderPage({ request: requestId, status: 'approved' });
    expect(pendingHtml).not.toContain('Change approved');
    expect(pendingHtml).toContain('Approve');

    // An id that never existed is expired, whatever the flag says.
    const expiredHtml = await renderPage({
      request: '11111111-1111-4111-8111-111111111111',
      status: 'approved',
    });
    expect(expiredHtml).not.toContain('Change approved');
  });

  it('reports the stored approval for the owning reader', async () => {
    const owner = await insertTestUser();
    const requestId = await startRequest(owner.id);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: owner.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    mockSession.mockResolvedValue({
      user: { id: owner.id, google_user_email: owner.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: requestId, status: 'approved' });

    expect(html).toContain('Change approved');
  });

  it('does not claim approval for an approved request read by another account', async () => {
    const owner = await insertTestUser();
    const other = await insertTestUser();
    const requestId = await startRequest(owner.id);
    await approvePasskeyManagementSsoRequest({
      requestId,
      userId: owner.id,
      ssoOrganizationId: ORGANIZATION_ID,
    });
    mockSession.mockResolvedValue({
      user: { id: other.id, google_user_email: other.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: requestId, status: 'approved' });

    expect(html).not.toContain('Change approved');
    expect(html).not.toContain(owner.google_user_email);
    expect(html).toContain('This request belongs to another account');
  });

  it('renders the expired view for a malformed request id without touching the database', async () => {
    mockSession.mockResolvedValue({ user: null, authFailedResponse: null } as never);

    const html = await renderPage({ request: 'abc' });

    expect(html).toContain('This approval link expired');
    expect(html).not.toContain('Approve passkey change');
  });

  it('renders the expired view for a malformed request id even when signed in', async () => {
    const owner = await insertTestUser();
    mockSession.mockResolvedValue({
      user: { id: owner.id, google_user_email: owner.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: '1111-not-a-uuid' });

    expect(html).toContain('This approval link expired');
    expect(html).not.toContain('Approve passkey change');
  });

  it('shows a known error code for a malformed request id instead of throwing', async () => {
    const owner = await insertTestUser();
    mockSession.mockResolvedValue({
      user: { id: owner.id, google_user_email: owner.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: 'not-a-uuid', error: 'invalid_request' });

    expect(html).toContain('This approval link is incomplete');
    expect(html).not.toContain('Approve passkey change');
  });

  it.each(['__proto__', 'constructor', 'toString', 'not-a-code'])(
    'ignores an unusable error code (%s) and keeps the pending approval',
    async code => {
      const owner = await insertTestUser();
      const requestId = await startRequest(owner.id);
      mockSession.mockResolvedValue({
        user: { id: owner.id, google_user_email: owner.google_user_email } as never,
        authFailedResponse: null,
        authenticatedAt: Math.floor(Date.now() / 1000),
        ssoSourceOrganizationId: ORGANIZATION_ID,
      } as never);

      const html = await renderPage({ request: requestId, error: code });

      expect(html).toContain('Approve passkey change');
      expect(html).not.toContain('This approval link is incomplete');
      expect(html).not.toContain('undefined');
    }
  );

  it('names the account on the approval itself for the matching reader', async () => {
    const owner = await insertTestUser();
    const requestId = await startRequest(owner.id);
    mockSession.mockResolvedValue({
      user: { id: owner.id, google_user_email: owner.google_user_email } as never,
      authFailedResponse: null,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ssoSourceOrganizationId: ORGANIZATION_ID,
    } as never);

    const html = await renderPage({ request: requestId });

    expect(html).toContain(owner.google_user_email);
    expect(html).toContain('Approve');
  });

  it('asks a signed-out reader to sign in without naming the account', async () => {
    const owner = await insertTestUser();
    const requestId = await startRequest(owner.id);
    mockSession.mockResolvedValue({
      user: null,
      authFailedResponse: null,
    } as never);

    const html = await renderPage({ request: requestId });

    expect(html).toContain('Sign in with SSO');
    expect(html).not.toContain(owner.google_user_email);
  });
});
