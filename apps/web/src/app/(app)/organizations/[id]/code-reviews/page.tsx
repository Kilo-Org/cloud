import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isLocalCodeReviewDevelopmentEnabled } from '@/lib/config.server';
import { ReviewAgentPageClient } from './ReviewAgentPageClient';

type ReviewAgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string; platform?: string }>;
};

export default async function ReviewAgentPage({ params, searchParams }: ReviewAgentPageProps) {
  const search = await searchParams;
  const platform = search.platform === 'gitlab' ? 'gitlab' : 'github';
  const localCodeReviewDevelopmentEnabled = isLocalCodeReviewDevelopmentEnabled();

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
          localCodeReviewDevelopmentEnabled={localCodeReviewDevelopmentEnabled}
        />
      )}
    />
  );
}
