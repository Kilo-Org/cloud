import { notFound } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

type Props = {
  params: Promise<{ id: string; projectId: string }>;
};

export default async function OrgAppBuilderProjectPage({ params }: Props) {
  const [{ projectId }, { user, organization, canonicalRouteIdentifier }] = await Promise.all([
    params,
    requireCanonicalOrganizationRouteContext(params),
  ]);

  const isAppBuilderEnabled = await isFeatureFlagEnabled('app-builder-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAppBuilderEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <AppBuilderPage
      organizationId={organization.id}
      organizationRouteIdentifier={canonicalRouteIdentifier}
      projectId={projectId}
    />
  );
}
