import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';
import { CloudSessionsPage } from '@/components/cloud-agent/CloudSessionsPage';

export default async function PersonalCloudPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const useNextAgent = isDevelopment || (await isFeatureFlagEnabled('cloud-agent-next', user.id));
  const isDevcontainerAvailable =
    isDevelopment || (await isFeatureFlagEnabled('cloud-agent-devcontainer', user.id));

  if (useNextAgent) {
    return <NewSessionPanel isDevcontainerAvailable={isDevcontainerAvailable} />;
  }

  return <CloudSessionsPage />;
}
