import { SubOrganizationsPage } from '../SubOrganizationsPage';

export default async function OrganizationDistributeFundsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SubOrganizationsPage organizationId={id} activeSection="distribute-funds" />;
}
