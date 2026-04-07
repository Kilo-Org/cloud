import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawChangelogClient } from './OrgClawChangelogClient';

type OrgClawChangelogPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawChangelogPage({ params }: OrgClawChangelogPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawChangelogClient organizationId={org.organization.id} />}
    />
  );
}
