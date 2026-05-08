import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { AutoTriagePageClient } from './AutoTriagePageClient';

type AutoTriagePageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function AutoTriagePage({ params, searchParams }: AutoTriagePageProps) {
  const { id: organizationId } = await params;
  const search = await searchParams;

  // Feature flags - use server-side check with organization ID as distinct ID
  const isAutoTriageFeatureEnabled = await isFeatureFlagEnabled(
    'auto-triage-feature',
    organizationId
  );
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAutoTriageFeatureEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <OrganizationByPageLayout
      params={params}
      render={org => (
        <AutoTriagePageClient
          organizationId={org.organization.id}
          organizationName={org.organization.name}
          successMessage={search.success}
          errorMessage={search.error}
        />
      )}
    />
  );
}
