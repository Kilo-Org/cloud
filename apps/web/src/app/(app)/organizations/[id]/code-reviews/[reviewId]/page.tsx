import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { CodeReviewDetailClient } from '@/app/(app)/code-reviews/[reviewId]/CodeReviewDetailClient';

export default async function OrgCodeReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string; reviewId: string }>;
}) {
  const { reviewId } = await params;

  return (
    <OrganizationByPageLayout
      params={params}
      render={() => <CodeReviewDetailClient reviewId={reviewId} />}
    />
  );
}
