import { PageLayout } from '@/components/PageLayout';
import { OrganizationSetupWizard } from '@/components/organizations/welcome/OrganizationSetupWizard';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

type OrganizationStartPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationStartPage({ params }: OrganizationStartPageProps) {
  const { organization, canonicalRouteIdentifier } =
    await requireCanonicalOrganizationRouteContext(params);

  return (
    <PageLayout title="Organization setup">
      <OrganizationSetupWizard
        organizationId={organization.id}
        organizationRouteIdentifier={canonicalRouteIdentifier}
      />
    </PageLayout>
  );
}
