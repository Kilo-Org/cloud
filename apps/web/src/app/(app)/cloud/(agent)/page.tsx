import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { isFeatureFlagEnabledOrDevelopment } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

export default async function PersonalCloudPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud');
  const isDevcontainerAvailable = await isFeatureFlagEnabledOrDevelopment(
    'cloud-agent-devcontainer',
    user.id
  );

  return (
    <NewSessionPanel currentUserId={user.id} isDevcontainerAvailable={isDevcontainerAvailable} />
  );
}
