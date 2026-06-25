import { PylonSupportButton } from '@/components/pylon-support-button';
import { PylonWidget } from '@/components/pylon-widget';
import { OrgInstancePresenceMount } from './components/OrgInstancePresenceMount';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

export default async function OrgClawLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { organization } = await requireCanonicalOrganizationRouteContext(params);

  return (
    <>
      <OrgInstancePresenceMount organizationId={organization.id} />
      {children}
      <PylonWidget>
        <PylonSupportButton />
      </PylonWidget>
    </>
  );
}
