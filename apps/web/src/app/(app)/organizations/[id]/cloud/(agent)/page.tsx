import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isFeatureFlagEnabledOrDevelopment } from '@/lib/posthog-feature-flags';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

export default async function OrganizationCloudPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(`/organizations/${organizationId}/cloud`)}`
  );
  const isDevcontainerAvailable = await isFeatureFlagEnabledOrDevelopment(
    'cloud-agent-devcontainer',
    organizationId
  );

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
