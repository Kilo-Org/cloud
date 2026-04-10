import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawSettingsClient } from './OrgClawSettingsClient';

type OrgClawSettingsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawSettingsPage({ params }: OrgClawSettingsPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => (
        <OrgClawSettingsClient
          organizationId={org.organization.id}
          organizationName={org.organization.name}
        />
      )}
    />
  );
}
