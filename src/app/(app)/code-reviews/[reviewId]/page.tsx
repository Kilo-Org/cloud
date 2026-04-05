import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { CodeReviewDetailClient } from './CodeReviewDetailClient';

export default async function CodeReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/code-reviews/${reviewId}`);

  return <CodeReviewDetailClient reviewId={reviewId} />;
}
