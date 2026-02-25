import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
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
