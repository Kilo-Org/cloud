import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from '../DeployPageClient';
import { notFound } from 'next/navigation';
import { isDeployFeatureEnabled } from '@/lib/user-deployments/is-deploy-feature-enabled';

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const user = await getUserFromAuthOrRedirect();

  if (!(await isDeployFeatureEnabled(user.id, { type: 'user', id: user.id }))) {
    return notFound();
  }

  const { deploymentId } = await params;

  return <DeployPageClient initialDeploymentId={deploymentId} />;
}
