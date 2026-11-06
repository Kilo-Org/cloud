import * as React from 'react';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import {
  acceptOrganizationInvite,
  ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { getServerSession } from 'next-auth';
import AcceptInvitePage from './page';

jest.mock('@/lib/user/next-auth-options', () => ({ authOptions: {} }));
jest.mock('@/lib/user', () => ({ ensureHasValidStytch: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuthOrRedirect: jest.fn() }));
jest.mock('next-auth', () => ({ getServerSession: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  acceptOrganizationInvite: jest.fn(),
  ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED: 'sso-session-required',
}));

describe('accept invite page', () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    jest.mocked(getUserFromAuthOrRedirect).mockResolvedValue({ id: 'user-id' } as never);
    jest.mocked(getServerSession).mockResolvedValue(null as never);
  });

  test.each([
    [ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED, true],
    ['Invitation is for a different email address', false],
    ['Invitation has expired', false],
  ])('uses the acceptance reason to select the sign-in action', async (error, requireSso) => {
    jest.mocked(acceptOrganizationInvite).mockResolvedValue({ success: false, error });
    const page = await AcceptInvitePage({ params: Promise.resolve({ token: 'invite-token' }) });
    const card = page.props.children;
    const button = card.props.children[2];
    expect(button.props).toEqual({ callbackPath: '/users/accept-invite/invite-token', requireSso });
    expect(getUserFromAuthOrRedirect).toHaveBeenCalledWith(
      '/users/sign_in?callbackPath=%2Fusers%2Faccept-invite%2Finvite-token'
    );
  });
});
