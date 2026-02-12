import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { DeployPageClient } from '../DeployPageClient';
import { notFound } from 'next/navigation';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/deploy');

  if (!ENABLE_DEPLOY_FEATURE) {
    return notFound();
  }

  const { deploymentId } = await params;

  return <DeployPageClient initialDeploymentId={deploymentId} />;
}
