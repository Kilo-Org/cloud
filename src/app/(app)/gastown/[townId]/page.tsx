import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
import { TownOverviewPageClient } from './TownOverviewPageClient';

export default async function TownOverviewPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}`);

  if (!(await isFeatureFlagEnabled(GASTOWN_ACCESS_FLAG, user.id))) {
    return notFound();
  }

  return <TownOverviewPageClient townId={townId} />;
}
