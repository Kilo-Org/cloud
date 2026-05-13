import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ReviewClient } from '@/app/(app)/wasteland/[wastelandId]/review/ReviewClient';

export default async function OrgReviewPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <ReviewClient wastelandId={wastelandId} />}
    />
  );
}
