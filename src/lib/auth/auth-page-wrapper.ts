import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';

export type AuthPageProps = {
  params: Record<string, string>;
  error: string | undefined;
};

/**
 * Shared server-side logic for auth pages (sign in and sign up).
 * Checks if user is already logged in and redirects if so.
 * Returns the search params for use in the page component.
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
    const redirectPath = loggedInRedirectPath ?? '/users/after-sign-in';
    redirect(`${redirectPath}?${new URLSearchParams(params).toString()}`);
  }

  return { params, error: params['error'] };
}
