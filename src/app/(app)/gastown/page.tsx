import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { TownListPageClient } from './TownListPageClient';

export default async function GastownPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!(await isFeatureFlagEnabled(GASTOWN_ACCESS_FLAG, user.id))) {
    return notFound();
  }

  return <TownListPageClient />;
}
