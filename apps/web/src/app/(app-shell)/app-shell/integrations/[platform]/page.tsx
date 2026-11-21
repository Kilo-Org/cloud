import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { readSearchParam } from '@/lib/app-shell/guards';
import {
  APP_SHELL_PLATFORM_LABELS,
  APP_SHELL_PREFIX,
  isAppShellPlatform,
} from '@/lib/app-shell/shell-paths';
import { AppShellIntegrationDetails } from '../../components/integration-detail';
import { ShellOutcome } from '../../components/shell-outcome';

export const metadata: Metadata = {
  title: 'Integration',
  robots: { index: false, follow: false },
};

type PageProps = {
  params: Promise<{ platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * A provider's connect/manage page inside the shell. The provider's OAuth
 * callback returns here with `success`/`error`, which ends the flow by closing
 * the in-app browser.
 */
export default async function AppShellIntegrationPage({ params, searchParams }: PageProps) {
  const { platform } = await params;
  if (!isAppShellPlatform(platform)) notFound();
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

  const success = readSearchParam(search, 'success') !== undefined;
  const error = readSearchParam(search, 'error');
  const label = APP_SHELL_PLATFORM_LABELS[platform];

  if (success || error) {
    return (
      <ShellOutcome
        kind={success ? 'success' : 'failure'}
        title={success ? `${label} connected` : `${label} not connected`}
        description={
          success
            ? `Kilo can now use your ${label} connection.`
            : `The ${label} connection did not complete. Close this window and try again from the Kilo App.`
        }
      />
    );
  }

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
        <p className="text-muted-foreground text-sm">Connect or manage this integration.</p>
      </header>
      <AppShellIntegrationDetails
        platform={platform}
        canManage
        canManageBilling
        success={false}
        selfPath={`${APP_SHELL_PREFIX}/integrations/${platform}`}
      />
    </>
  );
}
