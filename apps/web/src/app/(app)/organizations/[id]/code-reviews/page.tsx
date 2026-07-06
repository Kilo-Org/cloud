import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isLocalCodeReviewDevelopmentEnabled } from '@/lib/config.server';
import { ReviewAgentPageClient } from './ReviewAgentPageClient';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

type ReviewAgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    success?: string;
    error?: string;
    platform?: string;
    returnTo?: string;
    view?: string;
  }>;
};

export default async function ReviewAgentPage({ params, searchParams }: ReviewAgentPageProps) {
  const search = await searchParams;
  const localCodeReviewDevelopmentEnabled = isLocalCodeReviewDevelopmentEnabled();
  const returnTo = search.returnTo ? validateReturnPath(search.returnTo) : null;
  const platform =
    search.platform === 'gitlab' || search.platform === 'bitbucket' ? search.platform : 'github';
  const bitbucketView = search.view === 'jobs' ? 'jobs' : 'config';

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
          returnTo={returnTo ?? undefined}
          initialBitbucketView={bitbucketView}
        />
      )}
    />
  );
}
