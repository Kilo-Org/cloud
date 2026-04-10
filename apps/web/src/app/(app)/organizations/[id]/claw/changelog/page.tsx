import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ClawChangelogPage } from '@/app/(app)/claw/components/ClawChangelogPage';

type OrgClawChangelogPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawChangelogPage({ params }: OrgClawChangelogPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <ClawChangelogPage organizationId={org.organization.id} />}
    />
  );
}
