import type { Metadata } from 'next';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { loadAppShellOrganization } from '@/lib/app-shell/guards';
import { AppShellSsoCard } from '../../../components/organization-cards';
import { ShellOutcome } from '../../../components/shell-outcome';

export const metadata: Metadata = {
  title: 'SSO and domain',
  robots: { index: false, follow: false },
};

/** The organization's SSO card, without the billing surfaces of its dashboard. */
export default async function AppShellOrganizationSsoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  return (
    <>
      <header className="space-y-1">
        <p className="text-muted-foreground text-sm">{access.organization.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">SSO and domain</h1>
      </header>
      <AppShellSsoCard organizationId={access.organization.id} role={access.role} />
    </>
  );
}
