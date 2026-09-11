import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from './DeployPageClient';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

export default async function DeployPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/deploy');

  const isDeployEnabled = await isFeatureFlagEnabled('deploy-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isDeployEnabled && !isDevelopment) {
    return notFound();
  }

  return <DeployPageClient />;
}
