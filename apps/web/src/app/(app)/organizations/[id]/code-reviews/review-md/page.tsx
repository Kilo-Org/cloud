import { ReviewMdGuideContent } from '@/components/code-reviews/ReviewMdGuideContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

type OrganizationReviewMdGuidePageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationReviewMdGuidePage({
  params,
}: OrganizationReviewMdGuidePageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <ReviewMdGuideContent
          backHref={`/organizations/${organization.id}/code-reviews`}
          backLabel="Back to organization Code Reviewer"
        />
      )}
    />
  );
}
