import { notFound } from 'next/navigation';
import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function OrgAppBuilderPage({ params }: Props) {
  const { user, organization, canonicalRouteIdentifier } =
    await requireCanonicalOrganizationRouteContext(params);

  const isAppBuilderEnabled = await isFeatureFlagEnabled('app-builder-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAppBuilderEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <AppBuilderPage
      organizationId={organization.id}
      organizationRouteIdentifier={canonicalRouteIdentifier}
      projectId={undefined}
    />
  );
}
