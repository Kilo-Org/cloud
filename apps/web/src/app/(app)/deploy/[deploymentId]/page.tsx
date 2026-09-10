import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from '../DeployPageClient';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const user = await getUserFromAuthOrRedirect();

  const isDeployEnabled = await isFeatureFlagEnabled('deploy-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isDeployEnabled && !isDevelopment) {
    return notFound();
  }

  const { deploymentId } = await params;

  return <DeployPageClient initialDeploymentId={deploymentId} />;
}
