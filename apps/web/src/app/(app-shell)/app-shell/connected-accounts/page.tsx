import type { Metadata } from 'next';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { readSearchParam } from '@/lib/app-shell/guards';
import { LoginMethodsWrapper } from '@/components/profile/LoginMethodsWrapper';
import { APP_SHELL_PREFIX } from '@/lib/app-shell/shell-paths';
import { ShellOutcome } from '../components/shell-outcome';

export const metadata: Metadata = {
  title: 'Connected accounts',
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Link or unlink sign-in providers inside the shell. The link round trip comes
 * back here with `linked` (or `error`), which is the end of the flow.
 */
export default async function AppShellConnectedAccountsPage({ searchParams }: PageProps) {
  const search = await searchParams;
  const user = await requireAppShellUser();
  if (!user) {
    return (
      <ShellOutcome
        kind="failure"
        title="Start again from the Kilo App"
        description="This page's session has ended. Close this window and start again from the Kilo App."
      />
    );
  }

  const linked = readSearchParam(search, 'linked');
  const error = readSearchParam(search, 'error');

  if (linked || error) {
    return (
      <ShellOutcome
        kind={linked ? 'success' : 'failure'}
        title={linked ? 'Sign-in method linked' : 'Sign-in method not linked'}
        description={
          linked
            ? 'You can use this method to sign in to Kilo App.'
            : 'The sign-in method was not linked. Close this window and try again from the Kilo App.'
        }
      />
    );
  }

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connected accounts</h1>
        <p className="text-muted-foreground text-sm">
          Manage your primary email and connected sign-in providers.
        </p>
      </header>
      <LoginMethodsWrapper
        primaryEmail={user.google_user_email}
        callbackPath={`${APP_SHELL_PREFIX}/connected-accounts`}
        shell
      />
    </>
  );
}
