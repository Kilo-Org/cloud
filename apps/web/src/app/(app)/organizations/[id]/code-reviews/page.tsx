import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ReviewAgentPageClient } from './ReviewAgentPageClient';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

type ReviewAgentPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    success?: string;
    error?: string;
    platform?: string;
    returnTo?: string;
  }>;
};

export default async function ReviewAgentPage({ params, searchParams }: ReviewAgentPageProps) {
  const search = await searchParams;
  const platform = search.platform === 'gitlab' ? 'gitlab' : 'github';
  const returnTo = search.returnTo ? validateReturnPath(search.returnTo) : null;

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
          returnTo={returnTo ?? undefined}
        />
      )}
    />
  );
}
