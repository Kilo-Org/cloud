import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isFeatureFlagEnabledOrDevelopment } from '@/lib/posthog-feature-flags';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

export default async function OrganizationCloudPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={async ({ organization }) => {
        const isDevcontainerAvailable = await isFeatureFlagEnabledOrDevelopment(
          'cloud-agent-devcontainer',
          organization.id
        );
        return (
          <NewSessionPanel
            organizationId={organization.id}
            isDevcontainerAvailable={isDevcontainerAvailable}
          />
        );
      }}
    />
  );
}
