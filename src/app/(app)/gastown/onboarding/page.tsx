import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { OnboardingWizardClient } from './OnboardingWizardClient';

export default async function GastownOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const queryString = new URLSearchParams(params).toString();
  const callbackPath = queryString ? `/gastown/onboarding?${queryString}` : '/gastown/onboarding';

  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <OnboardingWizardClient />;
}
