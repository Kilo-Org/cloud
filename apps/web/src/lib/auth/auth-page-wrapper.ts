import { getUserFromAuth } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { detectSsoAccountMismatch, type SsoAccountMismatch } from '@/lib/auth/sso-account-mismatch';

export type AuthPageProps = {
  params: Record<string, string>;
  error: string | undefined;
  accountMismatch?: SsoAccountMismatch;
};

/**
 * Shared server-side logic for auth pages (sign in and sign up).
 * Checks if user is already logged in and redirects if so.
 * Returns the search params for use in the page component.
 *
 * An Enterprise SSO request that names a different address than the signed-in
 * session must not redirect: the page renders a mismatch notice so the visitor
 * can sign out and continue as the address the app asked for. A missing or
 * matching `email`, or a signed-out visitor, keeps the existing redirect.
 */
export async function getAuthPageProps(
  searchParams: Promise<Record<string, string>>,
  loggedInRedirectPath?: string
): Promise<AuthPageProps> {
  const params = await searchParams;
  const currentUser = (
    await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true })
  ).user;

  if (currentUser) {
    const accountMismatch = detectSsoAccountMismatch(params, currentUser.google_user_email);
    if (accountMismatch) {
      return { params, error: params['error'], accountMismatch };
    }

    const redirectPath = loggedInRedirectPath ?? '/users/after-sign-in';
    redirect(`${redirectPath}?${new URLSearchParams(params).toString()}`);
  }

  return { params, error: params['error'] };
}
