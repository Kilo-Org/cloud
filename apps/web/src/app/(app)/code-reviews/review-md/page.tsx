import { PageContainer } from '@/components/layouts/PageContainer';
import { ReviewMdGuideContent } from '@/components/code-reviews/ReviewMdGuideContent';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

export default async function PersonalReviewMdGuidePage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/code-reviews/review-md');

  return (
    <PageContainer>
      <ReviewMdGuideContent />
    </PageContainer>
  );
}
