import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { DeployPageClient } from '../DeployPageClient';
import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';

export default async function OrgDeploymentDetailPage({
  params,
}: {
  params: Promise<{ id: string; deploymentId: string }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in');

  if (!ENABLE_DEPLOY_FEATURE) {
    return notFound();
  }

  const { deploymentId } = await params;

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <DeployPageClient organizationId={organization.id} initialDeploymentId={deploymentId} />
      )}
    />
  );
}
