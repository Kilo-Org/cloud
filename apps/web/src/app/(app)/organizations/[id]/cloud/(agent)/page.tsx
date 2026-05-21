import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

export default async function OrganizationCloudPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/organizations/${organizationId}/cloud`)}`
  );
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isDevcontainerAvailable =
    isDevelopment || (await isFeatureFlagEnabled('cloud-agent-devcontainer', user.id));

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <NewSessionPanel
          organizationId={organization.id}
          isDevcontainerAvailable={isDevcontainerAvailable}
        />
      )}
    />
  );
}
