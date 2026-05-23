import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { ReviewAgentPageClient } from './ReviewAgentPageClient';

type ReviewAgentPageProps = {
  searchParams: Promise<{ success?: string; error?: string; platform?: string; tab?: string }>;
};

export default async function PersonalReviewAgentPage({ searchParams }: ReviewAgentPageProps) {
  const search = await searchParams;
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/code-reviews');
  const platform = search.platform === 'gitlab' ? 'gitlab' : 'github';
  const tab = search.tab === 'memory' || search.tab === 'jobs' ? search.tab : 'config';

  return (
    <ReviewAgentPageClient
      userId={user.id}
      userName={user.google_user_name}
      successMessage={search.success}
      errorMessage={search.error}
      initialPlatform={platform}
      initialTab={tab}
    />
  );
}
