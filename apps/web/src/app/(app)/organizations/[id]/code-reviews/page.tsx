import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ReviewAgentPageClient } from './ReviewAgentPageClient';

type ReviewAgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string; platform?: string; tab?: string }>;
};

export default async function ReviewAgentPage({ params, searchParams }: ReviewAgentPageProps) {
  const search = await searchParams;
  const platform = search.platform === 'gitlab' ? 'gitlab' : 'github';
  const tab = search.tab === 'memory' || search.tab === 'jobs' ? search.tab : 'config';

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <ReviewAgentPageClient
          organizationId={organization.id}
          organizationName={organization.name}
          successMessage={search.success}
          errorMessage={search.error}
          initialPlatform={platform}
          initialTab={tab}
        />
      )}
    />
  );
}
