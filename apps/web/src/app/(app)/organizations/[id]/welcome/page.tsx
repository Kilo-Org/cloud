import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { OrganizationWelcomePageClient } from './OrganizationWelcomePageClient';

type OrganizationStartPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationStartPage({ params }: OrganizationStartPageProps) {
  const { organization } = await requireCanonicalOrganizationRouteContext(params);
  return <OrganizationWelcomePageClient organizationId={organization.id} />;
}
