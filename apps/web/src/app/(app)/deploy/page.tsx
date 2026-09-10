import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from './DeployPageClient';
import { notFound } from 'next/navigation';
import { isDeployFeatureEnabled } from '@/lib/user-deployments/is-deploy-feature-enabled';

export default async function DeployPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/deploy');

  if (!(await isDeployFeatureEnabled(user.id, { type: 'user', id: user.id }))) {
    return notFound();
  }

  return <DeployPageClient />;
}
