import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { AutoTriagePageClient } from './AutoTriagePageClient';

type AutoTriagePageProps = {
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function PersonalAutoTriagePage({ searchParams }: AutoTriagePageProps) {
  const search = await searchParams;
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/auto-triage');

  const isAutoTriageFeatureEnabled = await isFeatureFlagEnabled('auto-triage-feature', user.id);
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isAutoTriageFeatureEnabled && !isDevelopment) {
    return notFound();
  }

  return (
    <AutoTriagePageClient
      userId={user.id}
      userName={user.google_user_name}
      successMessage={search.success}
      errorMessage={search.error}
    />
  );
}
