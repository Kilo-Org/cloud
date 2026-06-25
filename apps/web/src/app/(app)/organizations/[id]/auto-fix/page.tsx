import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { notFound } from 'next/navigation';
import { AutoFixPageClient } from './AutoFixPageClient';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

type AutoFixPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function AutoFixPage({ params, searchParams }: AutoFixPageProps) {
  const search = await searchParams;

  return (
    <OrganizationByPageLayout
      params={params}
      render={async ({ organization }) => {
        const isAutoTriageFeatureEnabled = await isFeatureFlagEnabled(
          'auto-triage-feature',
          organization.id
        );
        const isDevelopment = process.env.NODE_ENV === 'development';

        if (!isAutoTriageFeatureEnabled && !isDevelopment) {
          return notFound();
        }

        return (
          <AutoFixPageClient
            organizationId={organization.id}
            organizationName={organization.name}
            successMessage={search.success}
            errorMessage={search.error}
          />
        );
      }}
    />
  );
}
