import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { allow_fake_login } from '@kilocode/web-shared/lib/constants';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { SignInForm } from '@/components/auth/SignInForm';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { APP_SHELL_PREFIX } from '@/lib/app-shell/shell-paths';
import { ShellOutcome } from '../components/shell-outcome';

export const metadata: Metadata = {
  title: 'Enterprise SSO',
  robots: { index: false, follow: false },
};

/**
 * Device auth runs before the app has a session, so it cannot mint a hand-off
 * token. This is the one shell page that starts from an unauthenticated
 * browser: the SSO form, with no marketing aside and no link that leaves the
 * shell, and a callback path restricted to the device-auth page.
 */
const ALLOWED_CALLBACK_ROOTS = [APP_SHELL_PREFIX, '/device-auth'];

function isAllowedCallbackPath(callbackPath: string | null): callbackPath is string {
  if (!callbackPath) return false;
  return ALLOWED_CALLBACK_ROOTS.some(
    root =>
      callbackPath === root ||
      callbackPath.startsWith(`${root}/`) ||
      callbackPath.startsWith(`${root}?`)
  );
}

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AppShellSignInPage({ searchParams }: PageProps) {
  const search = await searchParams;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params[key] = first;
  }

  const callbackPath = validateReturnPath(params.callbackPath ?? '');
  if (!isAllowedCallbackPath(callbackPath)) {
    return (
      <ShellOutcome
        kind="failure"
        title="Start again from the Kilo App"
        description="This sign-in link is not valid. Close this window and start again from the Kilo App."
      />
    );
  }

  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });
  if (user) redirect(callbackPath);

  return (
    <div className="flex flex-col items-center">
      <SignInForm
        searchParams={params}
        error={params.error}
        isSignUp={false}
        allowFakeLogin={allow_fake_login}
        title="Enterprise SSO"
        subtitle="Enter your work email address to sign in with your organization's Single Sign-On"
        ssoMode
        emailOnly
        shell
      />
    </div>
  );
}
