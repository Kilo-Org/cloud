import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from './DeployPageClient';
import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isDeployFeatureEnabled } from '@/lib/user-deployments/is-deploy-feature-enabled';

export default async function OrganizationDeployPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const { id } = await params;
  const organizationId = decodeURIComponent(id);

  if (!(await isDeployFeatureEnabled(user.id, { type: 'org', id: organizationId }))) {
    return notFound();
  }

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <DeployPageClient organizationId={organization.id} />}
    />
  );
}
