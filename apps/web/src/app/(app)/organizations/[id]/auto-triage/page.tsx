import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { AutoTriagePageClient } from './AutoTriagePageClient';

type AutoTriagePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function AutoTriagePage({ params, searchParams }: AutoTriagePageProps) {
  const search = await searchParams;

  return (
    <OrganizationByPageLayout
      params={params}
      render={async ({ organization, organizationRouteIdentifier }) => {
        const isAutoTriageFeatureEnabled = await isFeatureFlagEnabled(
          'auto-triage-feature',
          organization.id
        );
        const isDevelopment = process.env.NODE_ENV === 'development';

        if (!isAutoTriageFeatureEnabled && !isDevelopment) {
          return notFound();
        }

        return (
          <AutoTriagePageClient
            organizationId={organization.id}
            organizationRouteIdentifier={organizationRouteIdentifier}
            organizationName={organization.name}
            successMessage={search.success}
            errorMessage={search.error}
          />
        );
      }}
    />
  );
}
