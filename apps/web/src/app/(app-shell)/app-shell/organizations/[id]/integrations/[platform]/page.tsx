import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { loadAppShellOrganization, readSearchParam } from '@/lib/app-shell/guards';
import {
  APP_SHELL_PLATFORM_LABELS,
  APP_SHELL_PREFIX,
  isAppShellPlatform,
} from '@/lib/app-shell/shell-paths';
import { AppShellIntegrationDetails } from '../../../../components/integration-detail';
import { ShellOutcome } from '../../../../components/shell-outcome';

export const metadata: Metadata = {
  title: 'Organization integration',
  robots: { index: false, follow: false },
};

type PageProps = {
  params: Promise<{ id: string; platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** An organization-owned provider connection, managed inside the shell. */
export default async function AppShellOrganizationIntegrationPage({
  params,
  searchParams,
}: PageProps) {
  const { id, platform } = await params;
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

  const access = await loadAppShellOrganization(user, id);
  if (!access) {
    return (
      <ShellOutcome
        kind="failure"
        title="No access to this organization"
        description="You are not a member of this organization. Close this window and start again from the Kilo App."
      />
    );
  }

  const label = APP_SHELL_PLATFORM_LABELS[platform];
  const success = readSearchParam(search, 'success') !== undefined;
  const error = readSearchParam(search, 'error');

  if (success || error) {
    return (
      <ShellOutcome
        kind={success ? 'success' : 'failure'}
        title={success ? `${label} connected` : `${label} not connected`}
        description={
          success
            ? `${access.organization.name} can now use this ${label} connection.`
            : `The ${label} connection did not complete. Close this window and try again from the Kilo App.`
        }
      />
    );
  }

  return (
    <>
      <header className="space-y-1">
        <p className="text-muted-foreground text-sm">{access.organization.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{label}</h1>
        <p className="text-muted-foreground text-sm">Connect or manage this integration.</p>
      </header>
      <AppShellIntegrationDetails
        platform={platform}
        organizationId={access.organization.id}
        canManage={canManageOrganization(access.role)}
        success={false}
        selfPath={`${APP_SHELL_PREFIX}/organizations/${access.organization.id}/integrations/${platform}`}
      />
    </>
  );
}
