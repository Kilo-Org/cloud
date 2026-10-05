import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { AutoFixPageClient } from './AutoFixPageClient';
import { isFeatureFlagEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { notFound } from 'next/navigation';

type AutoFixPageProps = {
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function PersonalAutoFixPage({ searchParams }: AutoFixPageProps) {
  const search = await searchParams;
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/auto-fix');

  // Feature flags - use server-side check with user ID as distinct ID
  const isAutoTriageFeatureEnabled = await isFeatureFlagEnabled('auto-triage-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAutoTriageFeatureEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <AutoFixPageClient
      userId={user.id}
      userName={user.google_user_name}
      successMessage={search.success}
      errorMessage={search.error}
    />
  );
}
