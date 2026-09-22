import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeployPageClient } from './DeployPageClient';
import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

export default async function OrganizationDeployPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');

  const isDeployEnabled = await isFeatureFlagEnabled('deploy-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isDeployEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <DeployPageClient organizationId={organization.id} />}
    />
  );
}
