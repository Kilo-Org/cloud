import { authOptions } from '@/lib/user/next-auth-options';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import {
  acceptOrganizationInvite,
  ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { ensureHasValidStytch } from '@/lib/user';
import { InviteSignOutButton } from './InviteSignOutButton';

type AcceptInvitePageProps = {
  params: Promise<{ token: string }>;
};

export default async function AcceptInvitePage({ params }: AcceptInvitePageProps) {
  const { token } = await params;
  const callbackPath = `/users/accept-invite/${encodeURIComponent(token)}`;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  const session = await getServerSession(authOptions);
  const result = await acceptOrganizationInvite(user.id, token, {
    provider: session?.authProvider,
    ssoSourceOrganizationId: session?.ssoSourceOrganizationId,
  });

  if (result.success) {
    // we need to set user to be styched if they're not so they don't get styched since they were invited to an org
    await ensureHasValidStytch(user.id);
    // now that the user has signed up (or in) redirect to the standard after sign up page
    // for possible stitch validation etc
    const redirectTo = `/organizations/${result.organizationId}`;
    redirect(redirectTo);
  }

  const requiresSso = result.error === ORGANIZATION_INVITATION_SSO_AUTHENTICATION_REQUIRED;

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-red-800">
          {requiresSso ? 'Organization SSO required' : 'Invitation Error'}
        </h1>
        <p className="text-red-600">
          {requiresSso
            ? 'Sign out and sign in through your organization SSO to accept this invitation.'
            : 'Unable to find or process the invitation. It may have expired or already been used.'}
        </p>
        <InviteSignOutButton callbackPath={callbackPath} requireSso={requiresSso} />
      </div>
    </div>
  );
}
