import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { OnboardingWizardClient } from './OnboardingWizardClient';

export default async function GastownOnboardingPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown/onboarding');

  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <OnboardingWizardClient />;
}
