import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptOrganizationInvite } from '@/lib/organizations/organizations';
import { ensureHasValidStytch } from '@/lib/user';

type AcceptInvitePageProps = {
  params: Promise<{ token: string }>;
};

export default async function AcceptInvitePage({ params }: AcceptInvitePageProps) {
  const { token } = await params;
  const headersList = await headers();
  const pathname = headersList.get('x-pathname') || `/users/accept-invite/${token}`;
  // if there is no user, they have to sign up/in first and then redirect here
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(pathname)}`
  );

  // Accept the organization invitation
  const result = await acceptOrganizationInvite(user.id, token);

  if (result.success) {
    // we need to set user to be styched if they're not so they don't get styched since they were invited to an org
    await ensureHasValidStytch(user.id);
    // now that the user has signed up (or in) redirect to the standard after sign up page
    // for possible stitch validation etc
    const redirectTo = `/organizations/${result.organizationId}`;
    redirect(redirectTo);
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <h1 className="mb-2 text-lg font-semibold text-red-800">Invitation Error</h1>
        <p className="text-red-600">
          {'Unable to find or process the invitation. It may have expired or already been used.'}
        </p>
      </div>
    </div>
  );
}
