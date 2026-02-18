import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { CloudNextSessionsPage } from '@/components/cloud-agent-next/CloudNextSessionsPage';
import { CloudSessionsPage } from '@/components/cloud-agent/CloudSessionsPage';

export default async function OrganizationCloudPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/cloud');
  const isDevelopment = process.env.NODE_ENV === 'development';
  const useNextAgent = isDevelopment || (await isFeatureFlagEnabled('cloud-agent-next', user.id));

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) =>
        useNextAgent ? (
          <CloudNextSessionsPage organizationId={organization.id} />
        ) : (
          <CloudSessionsPage organizationId={organization.id} />
        )
      }
    />
  );
}
